/**
 * SwarmCustomPageServer is a real 127.0.0.1 HTTP host for the narrator's custom page. Every request goes through fetch,
 * board changes arrive through explicit `source.refresh()` calls, and every board is a real temporary directory, so the
 * tests need no clock.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReadableStreamReadResult } from "node:stream/web";
import type { NarratorAction } from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import { SwarmBoardSource } from "../../src/modes/swarm-board-runtime";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SwarmCustomPageServer } from "../../src/swarm/custom-page";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { membersSchema } from "../../src/swarm/types";
import { SYMLINKS_USABLE } from "../helpers/symlink-support";
import { addWorker, type BoardFixture, createBoardFixture } from "./fixtures";

const PAGE = '<section data-narrator-id="ws-draft"><h2>Draft</h2><p>Two of five files done.</p></section>';
const NEXT_PAGE = "<p>Second revision</p>";
const PAGE_REVISION = createHash("sha256").update(PAGE).digest("hex");
const NEXT_REVISION = createHash("sha256").update(NEXT_PAGE).digest("hex");
const IFRAME = { "Sec-Fetch-Dest": "iframe" };
/** Why a page that could embed a document or contain a native link is refused. */
const EMBEDDED_DOCUMENT_ERROR = "view.html contains embedded-document or native-link markup";

const fixtures: BoardFixture[] = [];
const runtimes: Array<{ runtime: SwarmRuntime; lifecycle: AgentLifecycleManager }> = [];
const sources: SwarmBoardSource[] = [];
const servers: SwarmCustomPageServer[] = [];
const scratch: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.dispose();
	for (const reader of sources.splice(0)) reader.dispose();
	for (const item of runtimes.splice(0)) {
		item.runtime.dispose();
		await item.lifecycle.dispose();
	}
	vi.restoreAllMocks();
	for (const board of fixtures.splice(0)) board[Symbol.dispose]();
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	SwarmRuntime.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

/** The board's capability lives in members.json; the runtime stays closed so the source reads the file anew. */
function setCustomPage(board: BoardFixture, enabled: boolean): void {
	const members = membersSchema.assert(JSON.parse(board.text("members.json")));
	fs.writeFileSync(
		board.file("members.json"),
		JSON.stringify({ ...members, capabilities: { ...members.capabilities, customPage: enabled } }),
	);
}

/** A board with the roster coordinator and alice and one post, read by a source over a runtime that holds no board. */
function createBoard(options: { customPage?: boolean; html?: string } = {}) {
	const board = createBoardFixture();
	fixtures.push(board);
	addWorker(board.store, "alice");
	board.store.append("coordinator", "Evidence");
	setCustomPage(board, options.customPage ?? true);
	if (options.html !== undefined) fs.writeFileSync(path.join(board.dir, "view.html"), options.html);
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const runtime = new SwarmRuntime(registry, lifecycle);
	runtimes.push({ runtime, lifecycle });
	const source = new SwarmBoardSource({ artifactsDir: board.root, runtime });
	sources.push(source);
	return { board, source };
}

/** A server whose handler records each navigation after a microtask, so a 204 proves the handler was awaited. */
function serve(source: SwarmBoardSource, appearance?: "dark" | "light") {
	const navigated: NarratorAction[] = [];
	const server = new SwarmCustomPageServer({
		source,
		appearance,
		onNavigate: async action => {
			await Promise.resolve();
			navigated.push(action);
		},
	});
	servers.push(server);
	return { server, navigated };
}

/** The host page with the paths its script is given. */
async function hostPage(server: SwarmCustomPageServer) {
	const response = await fetch(server.url);
	const html = await response.text();
	const config: { events: string; navigate: string; frame: string; reducedMotion: boolean } = JSON.parse(
		/const config = (\{.*\});/.exec(html)![1]!,
	);
	return { response, html, config };
}

/** POST a navigation with the headers the host page sends, unless `headers` replaces them. */
function navigate(server: SwarmCustomPageServer, body: string, headers?: Record<string, string>) {
	return fetch(new URL("navigate", server.url), {
		method: "POST",
		headers: headers ?? {
			Origin: new URL(server.url).origin,
			"Content-Type": "application/json",
			"X-OMP-Swarm": "navigate",
		},
		body,
	});
}

interface PageEvent {
	title: string;
	head: number;
	view?: { headline: string; as_of_seq: number };
	revision?: string;
	error?: string;
}

/** Read server-sent events one at a time; the stream ends when the server closes it. */
function eventStream(response: Response) {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	return {
		async next(): Promise<PageEvent | undefined> {
			while (!pending.includes("\n\n")) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch {
					return undefined;
				}
				if (chunk.done) return undefined;
				pending += decoder.decode(chunk.value, { stream: true });
			}
			const end = pending.indexOf("\n\n");
			const frame = pending.slice(0, end);
			pending = pending.slice(end + 2);
			expect(frame.startsWith("data: ")).toBe(true);
			return JSON.parse(frame.slice("data: ".length));
		},
	};
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

describe("SwarmCustomPageServer start", () => {
	it("refuses to start without an available page: capability off, no view.html, or a refused view.html", () => {
		const off = createBoard({ customPage: false, html: PAGE });
		const missing = createBoard();
		const blank = createBoard({ html: "  \n" });
		const framed = createBoard({ html: '<p>Report</p><iframe src="https://example.com"></iframe>' });
		const transfer = createBoard({ html: '<div srcdoc="<script>alert(1)</script>"></div>' });
		const hinted = createBoard({ html: '<p>Report</p><link rel="preconnect" href="https://example.invalid">' });
		const anchored = createBoard({ html: '<p>Report</p><a href="https://example.invalid/">link</a>' });
		for (const { source } of [off, missing, blank, framed, transfer, hinted, anchored]) {
			expect(() => new SwarmCustomPageServer({ source, onNavigate: () => {} })).toThrow(/no available custom page/);
		}
	});

	it("listens on loopback under unguessable, distinct host and frame tokens", async () => {
		const { source } = createBoard({ html: PAGE });
		const { server } = serve(source);
		const other = serve(source).server;
		const url = new URL(server.url);
		expect(url.hostname).toBe("127.0.0.1");
		expect(Number(url.port)).toBeGreaterThan(0);
		const { config } = await hostPage(server);
		const hostToken = /^\/page\/([0-9a-f]{48})\/$/.exec(url.pathname)?.[1];
		const frameToken = /^\/frame\/([0-9a-f]{48})$/.exec(config.frame)?.[1];
		expect(hostToken).toBeDefined();
		expect(frameToken).toBeDefined();
		expect(frameToken).not.toBe(hostToken);
		expect(new URL(other.url).pathname).not.toBe(url.pathname);
		expect(config.events).toBe(`${url.pathname}events`);
		expect(config.navigate).toBe(`${url.pathname}navigate`);
	});
});

describe("SwarmCustomPageServer host page", () => {
	it("serves a nonce-locked page whose only frame is sandboxed to scripts and the narrator's token", async () => {
		const { source } = createBoard({ html: PAGE });
		const { server } = serve(source, "dark");
		const origin = new URL(server.url).origin;
		const { response, html, config } = await hostPage(server);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
		expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		const permissions = response.headers.get("permissions-policy")?.split(", ");
		expect(permissions).toEqual(
			expect.arrayContaining(["camera=()", "microphone=()", "geolocation=()", "payment=()"]),
		);
		const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
		expect(nonce).toMatch(/^[A-Za-z0-9+/]{32}$/);
		expect(html).toContain(`<style nonce="${nonce}">`);
		expect(response.headers.get("content-security-policy")?.split("; ")).toEqual([
			"default-src 'none'",
			`script-src 'nonce-${nonce}'`,
			`style-src 'nonce-${nonce}'`,
			"connect-src 'self'",
			`frame-src ${origin}${config.frame}`,
			"frame-ancestors 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			"object-src 'none'",
		]);
		expect(html).toContain('<html lang="en" data-theme="dark">');
		expect(html).toMatch(/<iframe[^>]* sandbox="allow-scripts"[^>]* referrerpolicy="no-referrer"/);
		expect(html).not.toContain("allow-same-origin");
		expect(html).not.toContain("Two of five files done.");
		const plain = await hostPage(serve(source).server);
		expect(plain.html).toContain('<html lang="en">');
		expect(plain.config.reducedMotion).toBe(false);
		const still = new SwarmCustomPageServer({ source, onNavigate: () => {}, reducedMotion: true });
		servers.push(still);
		expect((await hostPage(still)).config.reducedMotion).toBe(true);
		// The host starts no frame in a browser without Trusted Types, the Sanitizer or Element.setHTML.
		const guard = html.indexOf("typeof Element.prototype.setHTML");
		expect(html).toContain("window.trustedTypes");
		expect(html).toContain("typeof window.Sanitizer");
		expect(guard).toBeGreaterThan(-1);
		expect(html.indexOf("frame.src =")).toBeGreaterThan(guard);
	});

	it("answers 403 to a foreign Host or Origin on every route and 404 to unknown routes and methods", async () => {
		const { source } = createBoard({ html: PAGE });
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const own = new URL(server.url);
		const targets = [
			server.url,
			new URL(config.events, own).href,
			new URL(config.frame, own).href,
			new URL(config.navigate, own).href,
		];
		const foreign: Array<Record<string, string>> = [
			{ Host: "evil.example" },
			{ Host: `localhost:${own.port}` },
			{ Host: "127.0.0.1" },
			{ Origin: "http://evil.example" },
			{ Origin: "null" },
			{ Origin: `http://localhost:${own.port}` },
		];
		for (const target of targets) {
			for (const headers of foreign) {
				const response = await fetch(target, { headers: { ...IFRAME, ...headers } });
				expect(response.status, `${target} ${JSON.stringify(headers)}`).toBe(403);
				expect(await response.text()).toBe("Forbidden");
				expect(response.headers.get("content-security-policy")).toBe(
					"default-src 'none'; frame-ancestors 'none'; sandbox",
				);
				expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
				expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
			}
		}
		expect((await fetch(server.url, { headers: { Origin: own.origin } })).status).toBe(200);
		expect((await fetch(new URL("/", own))).status).toBe(404);
		expect((await fetch(new URL(`/page/${"0".repeat(48)}/`, own))).status).toBe(404);
		expect((await fetch(server.url, { method: "POST" })).status).toBe(404);
		expect((await fetch(new URL(config.navigate, own))).status).toBe(404);
		expect((await fetch(new URL(config.frame, own), { method: "POST", headers: IFRAME })).status).toBe(404);
	});
});

describe("SwarmCustomPageServer narrator frame", () => {
	it("serves the page only to an iframe, sealed by a sandboxing CSP and bridged to the host origin", async () => {
		const { source } = createBoard({ html: PAGE });
		const { server } = serve(source, "light");
		const { config } = await hostPage(server);
		const frameUrl = new URL(config.frame, server.url);
		const origin = frameUrl.origin;
		for (const dest of [undefined, "document", "empty", "script", "frame"]) {
			const response = await fetch(frameUrl, { headers: dest === undefined ? {} : { "Sec-Fetch-Dest": dest } });
			expect(response.status, String(dest)).toBe(403);
			expect(await response.text()).toBe("Embedded page required");
		}
		const response = await fetch(frameUrl, { headers: IFRAME });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
		expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		expect(response.headers.get("content-security-policy")?.split("; ")).toEqual([
			"default-src 'none'",
			"script-src 'unsafe-inline'",
			"style-src 'unsafe-inline'",
			"img-src data:",
			"font-src 'none'",
			"connect-src 'none'",
			"frame-src 'none'",
			"child-src 'none'",
			"worker-src 'none'",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			"require-trusted-types-for 'script'",
			"trusted-types 'none'",
			"sandbox allow-scripts",
			`frame-ancestors ${origin}`,
		]);
		const body = await response.text();
		expect(body.startsWith('<!doctype html><html data-theme="light">')).toBe(true);
		expect(body.endsWith(`${PAGE}</body></html>`)).toBe(true);
		expect(body).toContain(`const hostOrigin = ${JSON.stringify(origin)};`);
		expect(body).not.toContain("__OMP_HOST_ORIGIN__");
		expect(body).toContain("RTCPeerConnection");
		expect(body).toContain("setHTML");
	});

	it("serves accepted markup exactly as written: scripts, styles, data-narrator-id and text that only resemble frames", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const pageFile = path.join(board.dir, "view.html");
		const pages = [
			PAGE,
			'<script>window.narrator.onData(view => { document.title = view.headline; });</script><p data-narrator-id="x">ok</p>',
			'<style>.card { color: var(--foreground); }</style><div class="card">Styled</div>',
			"<p>frame rate, object model, embed codes and portal hours</p>",
			'<frame-card data-narrator-id="f">Card</frame-card><objective>Goal</objective><embedded-chart></embedded-chart>',
			'<template id="t"><p data-narrator-id="in">in</p></template>',
			"<noscript><p>fallback</p></noscript>",
			'<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
			"<p>&lt;iframe&gt; is shown as text</p>",
			'<button type="button" data-narrator-id="open-1" onclick="narrator.navigate({ type: \'board_post\', target: 1 })">Open #1</button>',
			'<abbr title="x">ab</abbr><article data-narrator-id="x"><aside>side</aside></article><a-badge>Badge</a-badge>',
			'<link-card data-narrator-id="l">Card</link-card><area-chart></area-chart><p>Use the a, area and link elements.</p>',
		];
		for (const page of pages) {
			fs.writeFileSync(pageFile, page);
			source.refresh();
			const response = await fetch(new URL(config.frame, server.url), { headers: IFRAME });
			const body = await response.text();
			expect(response.status, page).toBe(200);
			const rendered = body.slice(body.indexOf("<body>") + "<body>".length, body.length - "</body></html>".length);
			expect(rendered, page).toBe(page);
		}
	});

	it("keeps the last accepted page, in the stream and in the frame, when a replacement could embed another document", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const frameUrl = new URL(config.frame, server.url);
		const pageFile = path.join(board.dir, "view.html");
		const stream = eventStream(await fetch(new URL(config.events, server.url)));
		expect((await stream.next())?.revision).toBe(PAGE_REVISION);

		fs.writeFileSync(pageFile, '<p>Hijacked</p><iframe src="https://example.com"></iframe>');
		source.refresh();
		const refused = await stream.next();
		expect(refused?.revision).toBe(PAGE_REVISION);
		expect(refused?.error).toBe(EMBEDDED_DOCUMENT_ERROR);

		const unsafe = [
			'<div srcdoc="<script>alert(1)</script>">Hijacked</div>',
			'<template shadowrootmode="open"><p>Hijacked</p></template>',
			"<object data=x>Hijacked</object>",
			'<link rel="preconnect" href="https://example.invalid"><p>Hijacked</p>',
			"<LINK REL=dns-prefetch HREF=//example.invalid>Hijacked",
			'<a href="https://example.invalid/">Hijacked</a>',
			'<a data-narrator-id="x">Hijacked</a>',
			"<map name=m><area shape=default href=x>Hijacked</map>",
			'<svg><a href="https://example.invalid/"><text>Hijacked</text></a></svg>',
		];
		for (const page of unsafe) {
			fs.writeFileSync(pageFile, page);
			source.refresh();
			const body = await (await fetch(frameUrl, { headers: IFRAME })).text();
			expect(body, page).toContain(PAGE);
			expect(body, page).not.toContain("Hijacked");
		}

		// A refusal that repeats the same reason sends no event; the next accepted page does.
		fs.writeFileSync(pageFile, NEXT_PAGE);
		source.refresh();
		let accepted = await stream.next();
		while (accepted?.revision !== NEXT_REVISION) accepted = await stream.next();
		expect(accepted.error).toBeUndefined();
		expect(await (await fetch(frameUrl, { headers: IFRAME })).text()).toContain(NEXT_PAGE);
	});

	it("keeps the host token and the frame token apart", async () => {
		const { source } = createBoard({ html: PAGE });
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const own = new URL(server.url);
		const hostToken = /\/page\/([0-9a-f]{48})\//.exec(own.pathname)![1];
		const frameToken = /\/frame\/([0-9a-f]{48})/.exec(config.frame)![1];
		expect((await fetch(new URL(`/frame/${hostToken}`, own), { headers: IFRAME })).status).toBe(404);
		expect((await fetch(new URL(`/page/${frameToken}/`, own), { headers: IFRAME })).status).toBe(404);
		const host = await fetch(server.url, { headers: IFRAME });
		expect(await host.text()).not.toContain("Two of five files done.");
	});
});

describe("SwarmCustomPageServer event stream", () => {
	it("streams the board on connect and pushes view, page revision and last-good changes from source events", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const viewFile = path.join(board.dir, "view.json");
		const pageFile = path.join(board.dir, "view.html");
		fs.writeFileSync(viewFile, JSON.stringify(view("First")));
		source.refresh();
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const response = await fetch(new URL(config.events, server.url));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
		expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		const stream = eventStream(response);
		const first = await stream.next();
		expect(first).toMatchObject({
			title: "Test swarm",
			head: 1,
			revision: PAGE_REVISION,
			view: { headline: "First" },
		});
		expect(first?.error).toBeUndefined();

		fs.writeFileSync(viewFile, JSON.stringify(view("Second")));
		source.refresh();
		expect(await stream.next()).toMatchObject({ view: { headline: "Second" }, revision: PAGE_REVISION });

		// A refused view.json keeps the last good view and reports why.
		fs.writeFileSync(viewFile, "{broken");
		source.refresh();
		const refused = await stream.next();
		expect(refused?.view?.headline).toBe("Second");
		expect(refused?.error).toMatch(/view\.json/);

		// A new page text is a new revision, whatever else is refused.
		fs.writeFileSync(pageFile, NEXT_PAGE);
		source.refresh();
		const revised = await stream.next();
		expect(revised?.revision).toBe(NEXT_REVISION);
		expect(revised?.error).toMatch(/view\.json/);

		fs.writeFileSync(viewFile, JSON.stringify(view("Third")));
		source.refresh();
		const healed = await stream.next();
		expect(healed?.view?.headline).toBe("Third");
		expect(healed?.error).toBeUndefined();

		// A refused view.html keeps the last good page, in the stream and in the frame.
		fs.writeFileSync(pageFile, "   \n");
		source.refresh();
		const blank = await stream.next();
		expect(blank?.revision).toBe(NEXT_REVISION);
		expect(blank?.error).toMatch(/view\.html/);
		const frame = await fetch(new URL(config.frame, server.url), { headers: IFRAME });
		expect(await frame.text()).toContain(NEXT_PAGE);

		fs.writeFileSync(pageFile, PAGE);
		source.refresh();
		const restored = await stream.next();
		expect(restored?.revision).toBe(PAGE_REVISION);
		expect(restored?.error).toBeUndefined();

		// A client that connects later starts from the current state.
		const late = await eventStream(await fetch(new URL(config.events, server.url))).next();
		expect(late).toMatchObject({ view: { headline: "Third" }, revision: PAGE_REVISION });
	});

	it.each([
		{
			cause: "the capability turns off",
			withdraw: (board: BoardFixture) => setCustomPage(board, false),
			restore: (board: BoardFixture) => setCustomPage(board, true),
		},
		{
			cause: "view.html is removed",
			withdraw: (board: BoardFixture) => fs.unlinkSync(path.join(board.dir, "view.html")),
			restore: (board: BoardFixture) => fs.writeFileSync(path.join(board.dir, "view.html"), PAGE),
		},
	])(
		"withdraws the frame, the revision and navigation when $cause, and restores them with the page",
		async ({ withdraw, restore }) => {
			const { board, source } = createBoard({ html: PAGE });
			const { server, navigated } = serve(source);
			const { config } = await hostPage(server);
			const frameUrl = new URL(config.frame, server.url);
			const stream = eventStream(await fetch(new URL(config.events, server.url)));
			expect((await stream.next())?.revision).toBe(PAGE_REVISION);

			withdraw(board);
			source.refresh();
			const withdrawn = await stream.next();
			expect(withdrawn?.revision).toBeUndefined();
			expect(withdrawn?.error).toBeUndefined();
			const frame = await fetch(frameUrl, { headers: IFRAME });
			expect(frame.status).toBe(404);
			expect(await frame.text()).toBe("Custom page unavailable");
			const rejected = await navigate(server, JSON.stringify({ type: "board_post", target: 1 }));
			expect(rejected.status).toBe(400);
			expect(await rejected.text()).toBe("Custom page unavailable");
			expect(navigated).toEqual([]);

			restore(board);
			source.refresh();
			expect((await stream.next())?.revision).toBe(PAGE_REVISION);
			expect((await fetch(frameUrl, { headers: IFRAME })).status).toBe(200);
			expect((await navigate(server, JSON.stringify({ type: "board_post", target: 1 }))).status).toBe(204);
			expect(navigated).toHaveLength(1);
		},
	);
});

describe("SwarmCustomPageServer slow readers", () => {
	const CHANGES = 300;

	/** A view of about 58 KB (the contract keeps view.json under 64 KB) whose as_of_seq names the change. */
	function heavyView(marker: number) {
		return {
			...view(`marker ${marker} ${"h".repeat(28_000)}`),
			as_of_seq: marker,
			running_summary: "s".repeat(28_000),
		};
	}

	it("hands a reader that stopped reading the newest state, not a queue of every change", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const viewFile = path.join(board.dir, "view.json");
		fs.writeFileSync(viewFile, JSON.stringify(heavyView(0)));
		source.refresh();
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const stream = eventStream(await fetch(new URL(config.events, server.url)));
		const first = await stream.next();
		expect(first?.view?.as_of_seq).toBe(0);
		expect(JSON.stringify(first).length).toBeGreaterThan(30_000);

		// The reader rests while the board changes; each change carries its own marker.
		for (let marker = 1; marker <= CHANGES; marker++) {
			fs.writeFileSync(viewFile, JSON.stringify(heavyView(marker)));
			source.refresh();
		}

		const seen: number[] = [];
		for (let event = await stream.next(); event; event = await stream.next()) {
			seen.push(event.view!.as_of_seq);
			if (event.view!.as_of_seq === CHANGES) break;
		}
		expect(seen.at(-1)).toBe(CHANGES);
		expect(seen.length).toBeLessThan(CHANGES / 2);
		expect(seen).toEqual([...new Set(seen)].sort((left, right) => left - right));
		expect(source.getState().view?.as_of_seq).toBe(CHANGES);
	});

	it("keeps a reader that keeps up current on every change while another reader rests", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const viewFile = path.join(board.dir, "view.json");
		fs.writeFileSync(viewFile, JSON.stringify(heavyView(0)));
		source.refresh();
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const active = eventStream(await fetch(new URL(config.events, server.url)));
		const resting = eventStream(await fetch(new URL(config.events, server.url)));
		expect((await active.next())?.view?.as_of_seq).toBe(0);
		expect((await resting.next())?.view?.as_of_seq).toBe(0);

		const changes = 25;
		const received: number[] = [];
		for (let marker = 1; marker <= changes; marker++) {
			fs.writeFileSync(viewFile, JSON.stringify(heavyView(marker)));
			source.refresh();
			received.push((await active.next())!.view!.as_of_seq);
		}
		expect(received).toEqual(Array.from({ length: changes }, (_, index) => index + 1));

		// The resting reader missed nothing it needs: whatever it receives is ordered and ends at the newest state.
		const caught: number[] = [];
		for (let event = await resting.next(); event; event = await resting.next()) {
			caught.push(event.view!.as_of_seq);
			if (event.view!.as_of_seq === changes) break;
		}
		expect(caught.at(-1)).toBe(changes);
		expect(caught).toEqual([...new Set(caught)].sort((left, right) => left - right));
	});
});

describe("SwarmCustomPageServer navigation", () => {
	it("hands validated board posts, roster members, HTTPS links and artifact files to onNavigate and answers 204", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const { server, navigated } = serve(source);
		const report = path.join(board.root, "report.txt");
		fs.writeFileSync(report, "report");
		const requests = [
			{ type: "board_post", target: 1, label: "Evidence" },
			{ type: "open_conv", target: "alice", label: "Alice" },
			{ type: "url", target: "https://Example.com:443/report?x=1#frag", label: "Web" },
			{ type: "file", target: report, label: "Report" },
			{ type: "board_post", target: 1 },
		];
		for (const request of requests) {
			const response = await navigate(server, JSON.stringify(request));
			expect(response.status, JSON.stringify(request)).toBe(204);
			expect(await response.text()).toBe("");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
			expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		}
		expect(navigated).toEqual([
			{ type: "board_post", target: 1, label: "Evidence" },
			{ type: "open_conv", target: "alice", label: "Alice" },
			{ type: "url", target: "https://example.com/report?x=1#frag", label: "Web" },
			{ type: "file", target: fs.realpathSync(report), label: "Report" },
			{ type: "board_post", target: 1, label: "1" },
		]);
	});

	it("delivers exactly type, target and label, whatever else the request carries", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const { server, navigated } = serve(source);
		const report = path.join(board.root, "report.txt");
		fs.writeFileSync(report, "report");
		const extras = { extra: "x", href: "javascript:alert(1)", handler: "none", nested: { deep: [1, 2] } };
		const requests = [
			{ type: "board_post", target: 1, label: "Evidence" },
			{ type: "open_conv", target: "alice" },
			{ type: "url", target: "https://example.com/report", label: "Web" },
			{ type: "file", target: report, label: "Report" },
		];
		for (const request of requests) {
			const response = await navigate(server, JSON.stringify({ ...request, ...extras }));
			expect(response.status, JSON.stringify(request)).toBe(204);
		}
		expect(navigated).toEqual([
			{ type: "board_post", target: 1, label: "Evidence" },
			{ type: "open_conv", target: "alice", label: "alice" },
			{ type: "url", target: "https://example.com/report", label: "Web" },
			{ type: "file", target: fs.realpathSync(report), label: "Report" },
		]);
		for (const action of navigated) expect(Object.keys(action).sort()).toEqual(["label", "target", "type"]);
	});

	it("accepts a navigation only from the host page's own origin, marker and content type, within the size limit", async () => {
		const { source } = createBoard({ html: PAGE });
		const { server, navigated } = serve(source);
		const origin = new URL(server.url).origin;
		const body = JSON.stringify({ type: "board_post", target: 1 });
		const good = { Origin: origin, "Content-Type": "application/json", "X-OMP-Swarm": "navigate" };
		const forged: Array<[string, Record<string, string>]> = [
			["no origin", { "Content-Type": "application/json", "X-OMP-Swarm": "navigate" }],
			["foreign origin", { ...good, Origin: "http://evil.example" }],
			["opaque origin", { ...good, Origin: "null" }],
			["no marker", { Origin: origin, "Content-Type": "application/json" }],
			["wrong marker", { ...good, "X-OMP-Swarm": "open" }],
			["plain content type", { ...good, "Content-Type": "text/plain" }],
			["form content type", { ...good, "Content-Type": "application/x-www-form-urlencoded" }],
			["json-like content type", { ...good, "Content-Type": "application/jsonx" }],
			["json hidden in a parameter", { ...good, "Content-Type": "text/plain; boundary=application/json" }],
		];
		for (const [label, headers] of forged) {
			const response = await navigate(server, body, headers);
			expect(response.status, label).toBe(403);
			expect(await response.text(), label).toBeTruthy();
		}
		const oversized = JSON.stringify({ type: "url", target: `https://example.com/${"a".repeat(9_000)}` });
		expect((await navigate(server, oversized)).status).toBe(413);
		expect(navigated).toEqual([]);
		for (const contentType of ["application/json", "application/json; charset=utf-8"]) {
			const response = await navigate(server, body, { ...good, "Content-Type": contentType });
			expect(response.status, contentType).toBe(204);
		}
		expect(navigated).toHaveLength(2);
	});

	it("rejects malformed, unknown and hostile navigation targets with 400 and never calls onNavigate", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const { server, navigated } = serve(source);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-outside-"));
		scratch.push(outside);
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(secret, "secret");
		fs.writeFileSync(path.join(board.root, "report.txt"), "report");
		const objects: unknown[] = [
			{},
			{ type: "exec", target: "calc" },
			{ target: 1 },
			{ type: "board_post" },
			{ type: "board_post", target: "1" },
			{ type: "board_post", target: 0 },
			{ type: "board_post", target: -1 },
			{ type: "board_post", target: 1.5 },
			{ type: "board_post", target: 2 ** 53 },
			{ type: "board_post", target: 9 },
			{ type: "board_post", target: 1, label: 7 },
			{ type: "open_conv", target: "nobody" },
			{ type: "open_conv", target: "Alice" },
			{ type: "open_conv", target: "../alice" },
			{ type: "open_conv", target: 1 },
			{ type: "url", target: "http://example.com/" },
			{ type: "url", target: "javascript:alert(1)" },
			{ type: "url", target: "data:text/html,x" },
			{ type: "url", target: "file:///etc/passwd" },
			{ type: "url", target: "https://user:secret@example.com/" },
			{ type: "url", target: "https://example.com/a b" },
			{ type: "url", target: "https://example.com/\u0007" },
			{ type: "url", target: `https://example.com/${"a".repeat(2_100)}` },
			{ type: "url", target: 7 },
			{ type: "file", target: "" },
			{ type: "file", target: "report.txt" },
			{ type: "file", target: path.join(board.root, "missing.txt") },
			{ type: "file", target: board.dir },
			{ type: "file", target: secret },
			{ type: "file", target: `${board.root}${path.sep}nested${path.sep}..${path.sep}report.txt` },
			{ type: "file", target: path.join(board.root, "re\u0000port.txt") },
		];
		if (SYMLINKS_USABLE) {
			fs.symlinkSync(secret, path.join(board.root, "link.txt"), "file");
			objects.push({ type: "file", target: path.join(board.root, "link.txt") });
		}
		const bodies = ["{nope", "null", "[]", "42", '"board_post"', ...objects.map(value => JSON.stringify(value))];
		for (const body of bodies) {
			const response = await navigate(server, body);
			expect(response.status, body).toBe(400);
			expect(await response.text(), body).toBeTruthy();
		}
		expect(navigated).toEqual([]);
	});

	it("answers 400 with the handler's message when onNavigate refuses", async () => {
		const { source } = createBoard({ html: PAGE });
		const server = new SwarmCustomPageServer({
			source,
			onNavigate: () => {
				throw new Error("The host refused this navigation");
			},
		});
		servers.push(server);
		const response = await navigate(server, JSON.stringify({ type: "board_post", target: 1 }));
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("The host refused this navigation");
	});
});

describe("SwarmCustomPageServer dispose", () => {
	it("closes open streams, drops its source subscription, stops listening and disposes once", async () => {
		const { source } = createBoard({ html: PAGE });
		const subscribe = source.subscribe.bind(source);
		let stopped = 0;
		vi.spyOn(source, "subscribe").mockImplementation(listener => {
			const stop = subscribe(listener);
			return () => {
				stopped++;
				stop();
			};
		});
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const stream = eventStream(await fetch(new URL(config.events, server.url)));
		expect(await stream.next()).toBeDefined();
		await server.dispose();
		expect(await stream.next()).toBeUndefined();
		expect(stopped).toBe(1);
		await expect(fetch(server.url)).rejects.toThrow();
		await server.dispose();
		expect(stopped).toBe(1);
	});

	it("disposes cleanly after its source closed and sends no further events", async () => {
		const { board, source } = createBoard({ html: PAGE });
		const { server } = serve(source);
		const { config } = await hostPage(server);
		const stream = eventStream(await fetch(new URL(config.events, server.url)));
		expect(await stream.next()).toBeDefined();
		source.dispose();
		fs.writeFileSync(path.join(board.dir, "view.html"), NEXT_PAGE);
		source.refresh();
		await server.dispose();
		expect(await stream.next()).toBeUndefined();
	});

	it("starts no server and holds no listener when the source is already closed", async () => {
		const { source } = createBoard({ html: PAGE });
		source.dispose();
		const bind = vi.spyOn(Bun, "serve");
		expect(() => new SwarmCustomPageServer({ source, onNavigate: () => {} })).toThrow(/closed/);
		for (const result of bind.mock.results) {
			if (result.type === "return") await expect(fetch(result.value.url)).rejects.toThrow();
		}
	});

	it("releases its source subscription when the server cannot bind", () => {
		const { source } = createBoard({ html: PAGE });
		const subscribe = source.subscribe.bind(source);
		let subscribed = 0;
		let released = 0;
		vi.spyOn(source, "subscribe").mockImplementation(listener => {
			subscribed++;
			const stop = subscribe(listener);
			return () => {
				released++;
				stop();
			};
		});
		vi.spyOn(Bun, "serve").mockImplementation(() => {
			throw new Error("bind failed");
		});
		expect(() => new SwarmCustomPageServer({ source, onNavigate: () => {} })).toThrow("bind failed");
		expect(released).toBe(subscribed);
	});
});
