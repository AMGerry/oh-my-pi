import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SwarmBoardSource } from "../../src/modes/swarm-board-runtime";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { BOARD_FILES, type BoardFixture, createBoardFixture } from "./fixtures";
import { BoardStore } from "../../src/swarm/board-store";
import { membersSchema } from "../../src/swarm/types";

const fixtures: BoardFixture[] = [];
const runtimes: Array<{ runtime: SwarmRuntime; lifecycle: AgentLifecycleManager }> = [];
const sources: SwarmBoardSource[] = [];

function fixture(live = false) {
	const board = createBoardFixture();
	fixtures.push(board);
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const runtime = new SwarmRuntime(registry, lifecycle);
	runtimes.push({ runtime, lifecycle });
	if (live) runtime.open(board.dir);
	return { board, runtime };
}

function source(board: BoardFixture, runtime: SwarmRuntime, maxBytes?: number) {
	const reader = new SwarmBoardSource({ artifactsDir: board.root, runtime, maxBytes });
	sources.push(reader);
	return reader;
}

function view(headline: string) {
	return {
		version: 1,
		as_of_seq: 0,
		updated_at: "2026-10-06T04:20:00Z",
		headline,
		phase: { label: "Build", index: 1, total: 2 },
		attention: [],
		workstreams: [],
		milestones: [],
		risks: [],
	};
}

afterEach(async () => {
	for (const reader of sources.splice(0)) reader.dispose();
	for (const item of runtimes.splice(0)) {
		item.runtime.dispose();
		await item.lifecycle.dispose();
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const board of fixtures.splice(0)) board[Symbol.dispose]();
	resetRegisteredArtifactDirsForTests();
	SwarmRuntime.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("SwarmBoardSource", () => {
	it("renders a native post synchronously and preserves the persisted read cursor", async () => {
		const { board, runtime } = fixture(true);
		const before = BOARD_FILES.map(name => board.bytes(name).toString("base64"));
		const reader = source(board, runtime);
		const changed = vi.fn();
		const unsubscribe = reader.subscribe(changed);
		reader.refresh();
		expect(BOARD_FILES.map(name => board.bytes(name).toString("base64"))).toEqual(before);
		const started = performance.now();
		await runtime.post({ id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" }, "Live board proof");
		expect(reader.getState().head).toBe(1);
		expect(reader.getState().posts[0]?.text).toBe("Live board proof");
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(changed).toHaveBeenCalledTimes(1);
		const committed = BOARD_FILES.map(name => board.bytes(name).toString("base64"));
		reader.refresh();
		reader.resolveAction({ type: "board_post", target: 1, label: "#1" });
		expect(BOARD_FILES.map(name => board.bytes(name).toString("base64"))).toEqual(committed);
		unsubscribe();
		await runtime.post({ id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" }, "After close");
		expect(changed).toHaveBeenCalledTimes(1);
		expect(reader.getState().head).toBe(1);
	});

	it("observes persisted posts from directory events", async () => {
		const { board, runtime } = fixture();
		const reader = source(board, runtime);
		const changed = Promise.withResolvers<void>();
		reader.subscribe(() => {
			if (reader.getState().head === 1) changed.resolve();
		});
		board.store.append("coordinator", "Persisted writer");
		await changed.promise;
		expect(reader.getState().posts[0]?.text).toBe("Persisted writer");
		expect(reader.getState().members[0]?.state).toBe("stopped");
	});

	it("keeps the last good overview through malformed and oversized writes, then accepts replacement and deletion", async () => {
		const { board, runtime } = fixture();
		const target = path.join(board.dir, "view.json");
		fs.writeFileSync(target, JSON.stringify(view("First accepted view")));
		const reader = source(board, runtime, 1_024);
		const good = reader.getState().view;
		expect(good?.headline).toBe("First accepted view");
		const rejected = Promise.withResolvers<void>();
		const stop = reader.subscribe(() => {
			if (reader.getState().viewError) rejected.resolve();
		});
		fs.writeFileSync(target, "{broken");
		await rejected.promise;
		expect(reader.getState().view).toBe(good);
		expect(reader.getState().viewError).toBeTruthy();
		stop();
		fs.writeFileSync(target, JSON.stringify(view("x".repeat(2_048))));
		reader.refresh();
		expect(reader.getState().view).toBe(good);
		expect(reader.getState().viewError).toBeTruthy();
		const accepted = Promise.withResolvers<void>();
		const stopAccepted = reader.subscribe(() => {
			if (reader.getState().view?.headline === "Replacement") accepted.resolve();
		});
		fs.writeFileSync(`${target}.tmp`, JSON.stringify(view("Replacement")));
		fs.renameSync(`${target}.tmp`, target);
		await accepted.promise;
		expect(reader.getState().viewError).toBeUndefined();
		stopAccepted();
		fs.unlinkSync(target);
		reader.refresh();
		expect(reader.getState().view).toBeUndefined();
		expect(reader.getState().viewError).toBeUndefined();
	});

	it("stays timer-free with a directory watcher and stops its fallback clock on close", () => {
		vi.useFakeTimers();
		const { board, runtime } = fixture();
		const reader = source(board, runtime);
		const stop = reader.subscribe(() => {});
		expect(vi.getTimerCount()).toBe(0);
		stop();
		vi.spyOn(fs, "watch").mockImplementation(() => {
			throw new Error("Watch unavailable for this filesystem");
		});
		const changed = vi.fn();
		const stopFallback = reader.subscribe(changed);
		expect(vi.getTimerCount()).toBe(1);
		board.store.append("coordinator", "Fallback update");
		vi.advanceTimersByTime(499);
		expect(reader.getState().head).toBe(0);
		vi.advanceTimersByTime(1);
		expect(reader.getState().head).toBe(1);
		expect(changed).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2_000);
		expect(changed).toHaveBeenCalledTimes(1);
		stopFallback();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps other subscribers updating when one observer throws", async () => {
		const { board, runtime } = fixture(true);
		const reader = source(board, runtime);
		reader.subscribe(() => {
			throw new Error("Broken observer");
		});
		const changed = vi.fn();
		reader.subscribe(changed);
		await runtime.post({ id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" }, "Still updates");
		expect(changed).toHaveBeenCalledTimes(1);
		expect(reader.getState().head).toBe(1);
	});

	it("validates citations, members, HTTPS URLs and artifact file containment", () => {
		const { board, runtime } = fixture();
		board.store.append("coordinator", "Evidence");
		const reader = source(board, runtime);
		const file = path.join(board.root, "report.txt");
		fs.writeFileSync(file, "report");
		expect(reader.resolveAction({ type: "file", target: file, label: "Report" }).target).toBe(fs.realpathSync(file));
		expect(() =>
			reader.resolveAction({ type: "file", target: path.join(board.root, ".."), label: "Outside" }),
		).toThrow(/artifacts/);
		expect(() => reader.resolveAction({ type: "file", target: board.dir, label: "Directory" })).toThrow(/file/);
		expect(reader.resolveAction({ type: "board_post", target: 1, label: "#1" }).target).toBe(1);
		expect(() => reader.resolveAction({ type: "board_post", target: 9, label: "#9" })).toThrow(/unavailable/);
		expect(reader.resolveAction({ type: "open_conv", target: "coordinator", label: "Coordinator" }).target).toBe(
			"coordinator",
		);
		expect(() => reader.resolveAction({ type: "open_conv", target: "unknown", label: "Unknown" })).toThrow(/member/);
		expect(reader.resolveAction({ type: "url", target: "https://example.com/report", label: "Web" }).target).toBe(
			"https://example.com/report",
		);
		for (const target of ["http://example.com", "javascript:alert(1)", "https://user:secret@example.com"]) {
			expect(() => reader.resolveAction({ type: "url", target, label: "Rejected" })).toThrow(/HTTPS/);
		}
	});
});

it.each([undefined, "test-swarm"])("refreshes only the selected board (%s)", id => {
	const { board, runtime } = fixture();
	const { board: other } = fixture();
	fs.writeFileSync(other.file("swarm.json"), JSON.stringify({ ...other.store.metadata, id: "other-swarm" }));
	registerArtifactsDir(other.root);
	const opened = vi.spyOn(BoardStore, "open");
	const reader = new SwarmBoardSource({ artifactsDir: board.root, runtime, id });
	sources.push(reader);
	reader.subscribe(() => {});
	reader.refresh();
	expect(reader.getState().id).toBe("test-swarm");
	expect(opened.mock.calls.map(call => path.resolve(call[0]))).not.toContain(path.resolve(other.dir));
});

const PAGE = '<section data-narrator-id="ws-draft"><h2>Draft</h2><p>Two of five files done.</p></section>';
const NEXT_PAGE = "<p>Second revision</p>";
const PAGE_REVISION = createHash("sha256").update(PAGE).digest("hex");
const NEXT_REVISION = createHash("sha256").update(NEXT_PAGE).digest("hex");

/** Pages whose text could embed another document: refused whatever the parser would make of them. */
const UNSAFE_PAGES = [
	'<iframe src="https://example.com"></iframe>',
	"<IFRAME SRC=x></IFRAME>",
	"<IFrame src=x>",
	"< iframe src=x>",
	"</iframe>",
	"<iframe/src=x>",
	"<iframe\nsrc=x>",
	"<frameset><frame src=x></frameset>",
	"<object data=x></object>",
	"<embed src=x>",
	"<portal src=x></portal>",
	"<fencedframe src=x></fencedframe>",
	"<svg:iframe src=x></svg:iframe>",
	"<x.y-z:object data=x>",
	"<template><iframe src=x></iframe></template>",
	"<noscript><iframe src=x></iframe></noscript>",
	"<svg><foreignObject><iframe src=x></iframe></foreignObject></svg>",
	'<math><annotation-xml encoding="text/html"><iframe src=x></iframe></annotation-xml></math>',
	"<!-- <iframe src=x></iframe> -->",
	'<p title="<iframe src=x>">x</p>',
	'<script>document.body.innerHTML = "<iframe src=x></iframe>";</script>',
	'<div srcdoc="<p>x</p>"></div>',
	"<p SRCDOC=x>x</p>",
	'<script>const attribute = "srcdoc";</script>',
	'<template shadowrootmode="open"><p>x</p></template>',
	"<div ShadowRootMode=closed></div>",
	'<link rel="preconnect" href="https://example.invalid">',
	"<LINK REL=dns-prefetch HREF=//example.invalid>",
	"<link/rel=preload href=x>",
	"< link rel=preconnect href=x>",
	"</link>",
	"<svg:link rel=preconnect href=x>",
	"<template><link rel=preconnect href=x></template>",
	"<noscript><link rel=preconnect href=x></noscript>",
	'<p title="<link rel=preconnect href=x>">x</p>',
	'<script>const hint = "<link rel=preconnect href=x>";</script>',
	"<link\nrel=preconnect href=x>",
	'<head><link rel="stylesheet" href="https://example.invalid/a.css"></head>',
	"<!-- <link rel=preconnect> -->",
	'<a href="https://example.invalid/">x</a>',
	"<A HREF=//example.invalid>x</A>",
	'<a data-narrator-id="x">no href yet</a>',
	"</a>",
	"< a href=x>x</a>",
	"<a\nhref=x>x</a>",
	"<a/href=x>x</a>",
	'<area href="https://example.invalid/" shape=rect coords="0,0,1,1">',
	"<map name=m><area shape=default href=x></map>",
	'<svg><a href="https://example.invalid/"><text>x</text></a></svg>',
	"<svg:a href=x>x</svg:a>",
	"<x:area href=x>",
	"<template><a href=x>x</a></template>",
	"<noscript><a href=x>x</a></noscript>",
	'<p title="<a href=x>">x</p>',
	'<script>host.innerHTML = "<a href=x>x</a>";</script>',
];

/** Pages that only resemble the unsafe ones: scripts, styles, text and names that merely start like a frame element. */
const BENIGN_PAGES = [
	PAGE,
	'<script>window.narrator.onData(view => { document.title = view.headline; });</script><p data-narrator-id="x">ok</p>',
	'<style>.card { color: var(--foreground); border: 1px solid var(--border); }</style><div class="card">Styled</div>',
	"<p>frame rate, object model, embed codes and portal hours</p>",
	'<frame-card data-narrator-id="f">Card</frame-card><objective>Goal</objective><embedded-chart></embedded-chart>',
	'<template id="t"><p data-narrator-id="in">in</p></template>',
	"<noscript><p>fallback</p></noscript>",
	'<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
	"<p>&lt;iframe&gt; is shown as text</p>",
	'<button type="button" data-narrator-id="open-1" onclick="narrator.navigate({ type: \'board_post\', target: 1 })">Open #1</button>',
	'<abbr title="x">ab</abbr><article data-narrator-id="x"><aside>side</aside></article><address>addr</address><audio></audio>',
	'<a-badge data-narrator-id="b">Badge</a-badge><area-chart></area-chart>',
	"<p>Use the a element, the area element and link text.</p>",
	"<p>&lt;a href=x&gt;x&lt;/a&gt; is shown as text</p>",
	'<link-card data-narrator-id="l">Card</link-card><linkedin-badge></linkedin-badge>',
	"<p>Use the link element to hint resources: link rel preconnect.</p>",
	"<p>&lt;link rel=preconnect&gt; is shown as text</p>",
	'<span data-id="link">links</span>',
	"<!doctype html><html><head><style>body{margin:0}</style></head><body><p>Report</p></body></html>",
];

/** Why a page that could embed a document or contain a native link is refused. */
const EMBEDDED_DOCUMENT_ERROR = "view.html contains embedded-document or native-link markup";

/** The board's capability lives in members.json; the runtime stays closed, so the source reads the file anew. */
function setCustomPage(board: BoardFixture, enabled: boolean): void {
	const members = membersSchema.assert(JSON.parse(board.text("members.json")));
	fs.writeFileSync(
		board.file("members.json"),
		JSON.stringify({ ...members, capabilities: { ...members.capabilities, customPage: enabled } }),
	);
}

describe("SwarmBoardSource custom page", () => {
	it("exposes view.html only while the board's customPage capability is on", () => {
		const { board, runtime } = fixture();
		const pageFile = path.join(board.dir, "view.html");
		fs.writeFileSync(pageFile, PAGE);
		const reader = source(board, runtime);
		expect(reader.customPageHtml).toBeUndefined();
		expect(reader.getState().customPageRevision).toBeUndefined();
		expect(reader.getState().customPageError).toBeUndefined();

		// A refused page is just as invisible while the capability is off.
		fs.writeFileSync(pageFile, "  \n");
		reader.refresh();
		expect(reader.getState().customPageError).toBeUndefined();

		setCustomPage(board, true);
		reader.refresh();
		expect(reader.customPageHtml).toBeUndefined();
		expect(reader.getState().customPageError).toMatch(/view\.html/);

		fs.writeFileSync(pageFile, PAGE);
		reader.refresh();
		expect(reader.customPageHtml).toBe(PAGE);
		expect(reader.getState().customPageRevision).toBe(PAGE_REVISION);
		expect(reader.getState().customPageError).toBeUndefined();

		setCustomPage(board, false);
		reader.refresh();
		expect(reader.customPageHtml).toBeUndefined();
		expect(reader.getState().customPageRevision).toBeUndefined();
		expect(reader.getState().customPageError).toBeUndefined();

		setCustomPage(board, true);
		reader.refresh();
		expect(reader.customPageHtml).toBe(PAGE);
	});

	it("derives the revision from the page's content hash and notifies only on a real change", () => {
		const { board, runtime } = fixture();
		setCustomPage(board, true);
		const pageFile = path.join(board.dir, "view.html");
		fs.writeFileSync(pageFile, PAGE);
		const reader = source(board, runtime);
		const changed = vi.fn();
		reader.subscribe(changed);
		expect(reader.getState().customPageRevision).toBe(PAGE_REVISION);

		fs.writeFileSync(pageFile, PAGE);
		reader.refresh();
		expect(changed).not.toHaveBeenCalled();

		fs.writeFileSync(pageFile, NEXT_PAGE);
		reader.refresh();
		expect(changed).toHaveBeenCalledTimes(1);
		expect(reader.customPageHtml).toBe(NEXT_PAGE);
		expect(NEXT_REVISION).not.toBe(PAGE_REVISION);
		expect(reader.getState().customPageRevision).toBe(NEXT_REVISION);
	});

	it("watches view.html in the board directory: creation, atomic replacement and removal reach subscribers", async () => {
		const { board, runtime } = fixture();
		setCustomPage(board, true);
		const pageFile = path.join(board.dir, "view.html");
		const reader = source(board, runtime);
		expect(reader.getState().customPageRevision).toBeUndefined();

		const created = Promise.withResolvers<void>();
		const stopCreated = reader.subscribe(() => {
			if (reader.getState().customPageRevision === PAGE_REVISION) created.resolve();
		});
		fs.writeFileSync(pageFile, PAGE);
		await created.promise;
		stopCreated();
		expect(reader.customPageHtml).toBe(PAGE);

		const replaced = Promise.withResolvers<void>();
		const stopReplaced = reader.subscribe(() => {
			if (reader.getState().customPageRevision === NEXT_REVISION) replaced.resolve();
		});
		fs.writeFileSync(`${pageFile}.tmp`, NEXT_PAGE);
		fs.renameSync(`${pageFile}.tmp`, pageFile);
		await replaced.promise;
		stopReplaced();
		expect(reader.customPageHtml).toBe(NEXT_PAGE);

		const removed = Promise.withResolvers<void>();
		const stopRemoved = reader.subscribe(() => {
			if (reader.getState().customPageRevision === undefined) removed.resolve();
		});
		fs.unlinkSync(pageFile);
		await removed.promise;
		stopRemoved();
		expect(reader.customPageHtml).toBeUndefined();
		expect(reader.getState().customPageError).toBeUndefined();
	});

	it("keeps the last accepted page through empty, oversized and undecodable replacements and recovers with the next good page", () => {
		const { board, runtime } = fixture();
		setCustomPage(board, true);
		const pageFile = path.join(board.dir, "view.html");
		fs.writeFileSync(pageFile, PAGE);
		const reader = source(board, runtime);
		const changed = vi.fn();
		reader.subscribe(changed);
		const refusals: Array<[string, string | Buffer, RegExp]> = [
			["empty", "  \n", /empty or holds only whitespace/],
			["oversized", "x".repeat(48 * 1024 + 1), /larger than 49152 bytes/],
			["not UTF-8", Buffer.from([0x3c, 0xff, 0xfe]), /not valid UTF-8/],
		];
		for (const [label, content, reason] of refusals) {
			fs.writeFileSync(pageFile, content);
			reader.refresh();
			expect(reader.customPageHtml, label).toBe(PAGE);
			expect(reader.getState().customPageRevision, label).toBe(PAGE_REVISION);
			expect(reader.getState().customPageError, label).toMatch(reason);
			expect(reader.getState().viewError, label).toBeUndefined();
		}
		expect(changed).toHaveBeenCalledTimes(3);

		fs.writeFileSync(pageFile, NEXT_PAGE);
		reader.refresh();
		expect(changed).toHaveBeenCalledTimes(4);
		expect(reader.customPageHtml).toBe(NEXT_PAGE);
		expect(reader.getState().customPageRevision).toBe(NEXT_REVISION);
		expect(reader.getState().customPageError).toBeUndefined();
	});

	it("refuses a page that could embed another document, from the first read and as an update, and keeps the last accepted page", () => {
		const { board, runtime } = fixture();
		setCustomPage(board, true);
		const pageFile = path.join(board.dir, "view.html");
		fs.writeFileSync(pageFile, UNSAFE_PAGES[0]!);
		const reader = source(board, runtime);

		// Nothing accepted yet: an unsafe text leaves no page to serve.
		for (const page of UNSAFE_PAGES) {
			fs.writeFileSync(pageFile, page);
			reader.refresh();
			expect(reader.customPageHtml, page).toBeUndefined();
			expect(reader.getState().customPageRevision, page).toBeUndefined();
			expect(reader.getState().customPageError, page).toBe(EMBEDDED_DOCUMENT_ERROR);
			expect(reader.getState().viewError, page).toBeUndefined();
		}

		// With an accepted page, the same texts leave that page in place.
		fs.writeFileSync(pageFile, PAGE);
		reader.refresh();
		expect(reader.customPageHtml).toBe(PAGE);
		expect(reader.getState().customPageError).toBeUndefined();
		for (const page of UNSAFE_PAGES) {
			fs.writeFileSync(pageFile, page);
			reader.refresh();
			expect(reader.customPageHtml, page).toBe(PAGE);
			expect(reader.getState().customPageRevision, page).toBe(PAGE_REVISION);
			expect(reader.getState().customPageError, page).toBe(EMBEDDED_DOCUMENT_ERROR);
			expect(reader.getState().viewError, page).toBeUndefined();
		}

		fs.writeFileSync(pageFile, NEXT_PAGE);
		reader.refresh();
		expect(reader.customPageHtml).toBe(NEXT_PAGE);
		expect(reader.getState().customPageRevision).toBe(NEXT_REVISION);
		expect(reader.getState().customPageError).toBeUndefined();
	});

	it("accepts scripts, styles, data-narrator-id markup and text that only resemble frames", () => {
		const { board, runtime } = fixture();
		setCustomPage(board, true);
		const pageFile = path.join(board.dir, "view.html");
		fs.writeFileSync(pageFile, PAGE);
		const reader = source(board, runtime);
		for (const page of BENIGN_PAGES) {
			fs.writeFileSync(pageFile, page);
			reader.refresh();
			expect(reader.customPageHtml, page).toBe(page);
			expect(reader.getState().customPageError, page).toBeUndefined();
		}
	});

	it("parses navigation requests of any shape and supplies the compact label", () => {
		const { board, runtime } = fixture();
		board.store.append("coordinator", "Evidence");
		const reader = source(board, runtime);
		expect(reader.resolveAction({ type: "board_post", target: 1 })).toEqual({
			type: "board_post",
			target: 1,
			label: "1",
		});
		expect(reader.resolveAction({ type: "open_conv", target: "coordinator" })).toEqual({
			type: "open_conv",
			target: "coordinator",
			label: "coordinator",
		});
		const report = path.join(board.root, "report.txt");
		fs.writeFileSync(report, "report");
		const withExtras: unknown[] = [
			{ type: "board_post", target: 1, extra: "x" },
			{ type: "open_conv", target: "coordinator", href: "javascript:alert(1)" },
			{ type: "url", target: "https://example.com/report", nested: { deep: 1 } },
			{ type: "file", target: report, extra: [1] },
		];
		for (const request of withExtras) {
			expect(Object.keys(reader.resolveAction(request)).sort(), JSON.stringify(request)).toEqual([
				"label",
				"target",
				"type",
			]);
		}
		const rejected: unknown[] = [
			undefined,
			null,
			"board_post",
			1,
			[],
			{},
			{ type: "exec", target: "calc" },
			{ type: "board_post", target: "1" },
			{ type: "board_post", target: 1.5 },
			{ type: "board_post", target: 1, label: 3 },
			{ type: "url", target: 7 },
			{ type: "file", target: "relative.txt" },
		];
		for (const request of rejected) expect(() => reader.resolveAction(request), JSON.stringify(request)).toThrow();
	});
});
