/**
 * SwarmViewStore reads view.json and plan.json from a board directory. Every test runs against real
 * files in a temporary directory; reads are explicit calls, so every test is deterministic.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NarratorView, SwarmPlan } from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import { SwarmViewStore } from "../../src/swarm/view-store";

const LIMIT = 64 * 1024;
const HTML_LIMIT = 48 * 1024;
const FRAGMENT = '<section data-narrator-id="ws-draft"><h2>Draft</h2><p>Two of five files done.</p></section>';
const DOCUMENT =
	"<!doctype html>\n<html><head><style>body { color: var(--foreground); }</style></head>\n<body><p>Report</p></body></html>\n";
const EMPTY_PAGE_ERROR = "view.html is empty or holds only whitespace";

const VIEW: NarratorView = {
	version: 1,
	as_of_seq: 4,
	updated_at: "2026-10-06T04:20:00Z",
	headline: "Drafting the design doc.",
	phase: { label: "Draft", index: 2, total: 4 },
	attention: [
		{
			id: "att-scope",
			kind: "decision",
			severity: "med",
			title: "Decide the scope",
			refs: [{ seq: 3 }],
			actions: [{ type: "open_conv", target: "coordinator", label: "Open coordinator" }],
		},
	],
	workstreams: [{ id: "ws-draft", title: "Draft the doc", owners: ["writer"], state: "active", refs: [{ seq: 3 }] }],
	milestones: [],
	risks: [],
};

const PLAN: SwarmPlan = {
	goal: { title: "Draft the design doc", line: "Research, draft, then review." },
	tasks: { writer: "Write the draft" },
	threads: [{ id: "t-doc", title: "Design doc", tasks: ["writer"] }],
};

function headlineView(headline: string): NarratorView {
	return { ...VIEW, headline };
}

/** A view whose JSON text is exactly `bytes` UTF-8 bytes long; the padding mixes 2-byte and 1-byte characters. */
function viewOfBytes(bytes: number): string {
	const base = Buffer.byteLength(JSON.stringify(headlineView("")));
	const padding = bytes - base;
	const headline = "\u00e9".repeat(Math.floor(padding / 2)) + (padding % 2 === 1 ? "e" : "");
	const text = JSON.stringify(headlineView(headline));
	expect(Buffer.byteLength(text)).toBe(bytes);
	return text;
}

/** A page whose text is exactly `bytes` UTF-8 bytes long; the padding mixes 2-byte and 1-byte characters. */
function htmlOfBytes(bytes: number): string {
	const padding = bytes - Buffer.byteLength("<p></p>");
	const text = `<p>${"\u00e9".repeat(Math.floor(padding / 2))}${padding % 2 === 1 ? "e" : ""}</p>`;
	expect(Buffer.byteLength(text)).toBe(bytes);
	return text;
}

/** A board directory inside a temporary root; the root also holds a sibling directory outside the board. */
class ViewDirFixture implements Disposable {
	readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-view-"));
	readonly dir = path.join(this.root, "swarm_view");
	readonly outside = path.join(this.root, "elsewhere");
	readonly store: SwarmViewStore;

	constructor() {
		fs.mkdirSync(this.dir);
		fs.mkdirSync(this.outside);
		this.store = new SwarmViewStore(this.dir);
	}

	file(name: string): string {
		return path.join(this.dir, name);
	}

	write(name: string, content: string | Uint8Array): void {
		fs.writeFileSync(this.file(name), content);
	}

	writeView(view: NarratorView): void {
		this.write("view.json", JSON.stringify(view));
	}

	writePlan(plan: SwarmPlan): void {
		this.write("plan.json", JSON.stringify(plan));
	}

	remove(name: string): void {
		fs.rmSync(this.file(name), { force: true });
	}

	/** Remove the whole temporary tree; Windows may hold a handle briefly, so the removal retries. */
	[Symbol.dispose](): void {
		fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
	}
}

function canCreateSymlinks(): boolean {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-view-probe-"));
	try {
		fs.writeFileSync(path.join(root, "target"), "x");
		fs.symlinkSync(path.join(root, "target"), path.join(root, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
	}
}

const SYMLINKS = canCreateSymlinks();

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SwarmViewStore reading", () => {
	test("returns an empty result for an empty directory", () => {
		using fx = new ViewDirFixture();
		expect(fx.store.read()).toEqual({});
	});

	test("returns an empty result for a missing directory", () => {
		using fx = new ViewDirFixture();
		const store = new SwarmViewStore(path.join(fx.root, "never-created"));
		expect(store.read()).toEqual({});
	});

	test("parses a complete view and plan", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.writePlan(PLAN);

		expect(fx.store.read()).toEqual({ view: VIEW, plan: PLAN });
	});

	test("accepts the minimal narrator contract", () => {
		using fx = new ViewDirFixture();
		const minimal = { ...VIEW, attention: [], workstreams: [] };
		fx.writeView(minimal);

		expect(fx.store.read()).toEqual({ view: minimal });
	});

	test("exposes the directory it reads", () => {
		using fx = new ViewDirFixture();
		expect(fx.store.dir).toBe(fx.dir);
	});

	test("reads a file that starts with a byte order mark", () => {
		using fx = new ViewDirFixture();
		fx.write("view.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(VIEW))]));

		expect(fx.store.read().view).toEqual(VIEW);
	});

	test("returns the same objects while the file content is unchanged", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.writePlan(PLAN);

		const first = fx.store.read();
		const second = fx.store.read();
		expect(second.view).toBe(first.view);
		expect(second.plan).toBe(first.plan);
	});

	test("picks up an atomic replacement by rename", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		expect(fx.store.read().view?.headline).toBe("Drafting the design doc.");

		fx.write("view.json.tmp", JSON.stringify(headlineView("Reviewing the draft.")));
		fs.renameSync(fx.file("view.json.tmp"), fx.file("view.json"));

		expect(fx.store.read().view?.headline).toBe("Reviewing the draft.");
	});

	test("drops unusable actions and keeps the view", () => {
		using fx = new ViewDirFixture();
		const withActions = {
			...VIEW,
			attention: [
				{
					...VIEW.attention[0],
					actions: [
						{ type: "url", target: "http://example.com/", label: "Plain http" },
						{ type: "open_conv", target: "coordinator", label: "Open coordinator" },
						{ type: "exec", target: "rm", label: "Run" },
					],
				},
			],
		};
		fx.write("view.json", JSON.stringify(withActions));

		const read = fx.store.read();
		expect(read.error).toBeUndefined();
		expect(read.view?.attention[0].actions).toEqual([
			{ type: "open_conv", target: "coordinator", label: "Open coordinator" },
		]);
	});
});

describe("SwarmViewStore last good value", () => {
	test("keeps the last good view while a rewrite is half written", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const good = fx.store.read().view;
		expect(good).toEqual(VIEW);

		const text = JSON.stringify(headlineView("Reviewing the draft."));
		fx.write("view.json", text.slice(0, Math.floor(text.length / 2)));

		const partial = fx.store.read();
		expect(partial.view).toBe(good);
		expect(partial.error).toMatch(/^view\.json is not valid JSON: /);

		fx.write("view.json", text);
		const complete = fx.store.read();
		expect(complete.error).toBeUndefined();
		expect(complete.view?.headline).toBe("Reviewing the draft.");
	});

	test("keeps reporting the same refusal for unchanged broken content", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const good = fx.store.read().view;
		fx.write("view.json", '{"version": 1, "headline"');

		const first = fx.store.read();
		const second = fx.store.read();
		expect(second.error).toBe(first.error);
		expect(second.view).toBe(good);
	});

	test("keeps the last good view when the file is truncated to zero bytes", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const good = fx.store.read().view;
		fx.write("view.json", "");

		const read = fx.store.read();
		expect(read.view).toBe(good);
		expect(read.error).toMatch(/not valid JSON/);
	});

	test("keeps the last good view when the content breaks the schema", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const good = fx.store.read().view;

		fx.write("view.json", JSON.stringify({ ...VIEW, attention: [{ ...VIEW.attention[0], kind: "blocker" }] }));
		const badEnum = fx.store.read();
		expect(badEnum.view).toBe(good);
		expect(badEnum.error).toMatch(/^view\.json: invalid narrator view: .*kind/s);

		fx.write("view.json", JSON.stringify({ ...VIEW, phase: { label: "Draft", index: 5, total: 4 } }));
		const badPhase = fx.store.read();
		expect(badPhase.view).toBe(good);
		expect(badPhase.error).toMatch(/^view\.json: phase\.index/);

		fx.write("view.json", JSON.stringify([VIEW]));
		expect(fx.store.read().view).toBe(good);
	});

	test("keeps the last good view when the bytes are invalid UTF-8", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const good = fx.store.read().view;
		fx.write("view.json", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));

		const read = fx.store.read();
		expect(read.view).toBe(good);
		expect(read.error).toBe("view.json is not valid UTF-8");
	});

	test("a broken first write yields an error and an absent view", () => {
		using fx = new ViewDirFixture();
		fx.write("view.json", "{ nope");

		const read = fx.store.read();
		expect(read.view).toBeUndefined();
		expect(read.error).toMatch(/not valid JSON/);
	});

	test("a good rewrite replaces the value and clears the error", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.store.read();
		fx.write("view.json", "{ nope");
		expect(fx.store.read().error).toBeDefined();

		fx.writeView(headlineView("Back on track."));
		const read = fx.store.read();
		expect(read.error).toBeUndefined();
		expect(read.view?.headline).toBe("Back on track.");
	});
});

describe("SwarmViewStore size limit", () => {
	test("accepts a file of exactly 64 KB and refuses one more byte", () => {
		using fx = new ViewDirFixture();
		fx.write("view.json", viewOfBytes(LIMIT));
		const atLimit = fx.store.read();
		expect(atLimit.error).toBeUndefined();
		expect(atLimit.view?.headline.length).toBeGreaterThan(30_000);

		fx.write("view.json", viewOfBytes(LIMIT + 1));
		const over = fx.store.read();
		expect(over.error).toBe(`view.json is larger than ${LIMIT} bytes`);
		expect(over.view).toBe(atLimit.view);
	});

	test("measures the limit in UTF-8 bytes", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const good = fx.store.read().view;
		const text = viewOfBytes(LIMIT + 1);
		expect(text.length).toBeLessThan(LIMIT);
		fx.write("view.json", text);

		const read = fx.store.read();
		expect(read.error).toMatch(/larger than 65536 bytes/);
		expect(read.view).toBe(good);
	});

	test("recovers when an oversized file shrinks to a valid one", () => {
		using fx = new ViewDirFixture();
		fx.write("view.json", viewOfBytes(LIMIT + 1));
		const refused = fx.store.read();
		expect(refused.view).toBeUndefined();
		expect(refused.error).toMatch(/larger than/);

		fx.writeView(VIEW);
		expect(fx.store.read()).toEqual({ view: VIEW });
	});

	test("reads at most one byte past the limit from a huge file", () => {
		using fx = new ViewDirFixture();
		fx.write("view.json", Buffer.alloc(2_000_000, 0x20));
		const reads = vi.spyOn(fs, "readSync");

		const read = fx.store.read();
		expect(read.error).toBe(`view.json is larger than ${LIMIT} bytes`);
		const calls: readonly (readonly unknown[])[] = reads.mock.calls;
		const requested = calls.map(call => Number(call[3]));
		expect(requested.length).toBeGreaterThan(0);
		expect(requested.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(LIMIT + 1);
	});

	test("honors a smaller limit", () => {
		using fx = new ViewDirFixture();
		const store = new SwarmViewStore(fx.dir, 256);
		fx.writeView(VIEW);

		const read = store.read();
		expect(read.view).toBeUndefined();
		expect(read.error).toBe("view.json is larger than 256 bytes");
	});

	test("caps a larger limit at 64 KB", () => {
		using fx = new ViewDirFixture();
		const store = new SwarmViewStore(fx.dir, 10_000_000);
		fx.write("view.json", viewOfBytes(LIMIT + 1));

		expect(store.read().error).toBe(`view.json is larger than ${LIMIT} bytes`);
	});

	test("applies the limit to plan.json on its own", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.write("plan.json", JSON.stringify({ ...PLAN, goal: { title: "Goal", line: "x".repeat(LIMIT) } }));

		const read = fx.store.read();
		expect(read.view).toEqual(VIEW);
		expect(read.error).toBeUndefined();
		expect(read.plan).toBeUndefined();
		expect(read.planError).toBe(`plan.json is larger than ${LIMIT} bytes`);
	});

	test("refuses limits other than positive integers", () => {
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => new SwarmViewStore("unused", limit)).toThrow(RangeError);
		}
	});
});

describe("SwarmViewStore removal", () => {
	test("forgets the view and its error once the file is gone", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		expect(fx.store.read().view).toEqual(VIEW);

		fx.remove("view.json");
		expect(fx.store.read()).toEqual({});

		fx.write("view.json", "{ nope");
		expect(fx.store.read().error).toBeDefined();
		fx.remove("view.json");
		expect(fx.store.read()).toEqual({});
	});

	test("accepts a new valid file after a removal", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.store.read();
		fx.remove("view.json");
		expect(fx.store.read().view).toBeUndefined();

		fx.writeView(headlineView("A fresh start."));
		expect(fx.store.read()).toEqual({ view: headlineView("A fresh start.") });
	});

	test("parses a restored file afresh after a removal", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const first = fx.store.read().view;
		fx.remove("view.json");
		fx.store.read();

		fx.writeView(VIEW);
		const again = fx.store.read();
		expect(again.view).toEqual(VIEW);
		expect(again.view).not.toBe(first);
	});

	test("forgets everything when the directory disappears", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.writePlan(PLAN);
		expect(fx.store.read().view).toBeDefined();

		fs.rmSync(fx.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
		expect(fx.store.read()).toEqual({});
	});
});

describe("SwarmViewStore plan.json", () => {
	test("tracks the plan independently of the view", () => {
		using fx = new ViewDirFixture();
		fx.writePlan(PLAN);
		expect(fx.store.read()).toEqual({ plan: PLAN });

		fx.writeView(VIEW);
		expect(fx.store.read()).toEqual({ view: VIEW, plan: PLAN });
	});

	test("a broken plan leaves the view and reports planError", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.writePlan(PLAN);
		fx.store.read();

		fx.write("plan.json", JSON.stringify({ ...PLAN, threads: [] }));
		const read = fx.store.read();
		expect(read.view).toEqual(VIEW);
		expect(read.error).toBeUndefined();
		expect(read.plan).toEqual(PLAN);
		expect(read.planError).toMatch(/^plan\.json: invalid swarm plan: /);
	});

	test("a broken view leaves the plan and reports error", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.writePlan(PLAN);
		fx.store.read();

		fx.write("view.json", "{ nope");
		const read = fx.store.read();
		expect(read.plan).toEqual(PLAN);
		expect(read.planError).toBeUndefined();
		expect(read.view).toEqual(VIEW);
		expect(read.error).toMatch(/^view\.json is not valid JSON/);
	});

	test("removing the plan keeps the view", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.writePlan(PLAN);
		fx.store.read();

		fx.remove("plan.json");
		expect(fx.store.read()).toEqual({ view: VIEW });
	});

	test("keeps the last good plan while its rewrite is half written", () => {
		using fx = new ViewDirFixture();
		fx.writePlan(PLAN);
		const good = fx.store.read().plan;

		const text = JSON.stringify({ ...PLAN, tasks: { writer: "Write and review the draft" } });
		fx.write("plan.json", text.slice(0, 20));
		const partial = fx.store.read();
		expect(partial.plan).toBe(good);
		expect(partial.planError).toMatch(/^plan\.json is not valid JSON/);

		fx.write("plan.json", text);
		expect(fx.store.read().plan?.tasks.writer).toBe("Write and review the draft");
	});
});

describe("SwarmViewStore file system boundaries", () => {
	test.skipIf(!SYMLINKS)("refuses a symlink that leads outside the board directory", () => {
		using fx = new ViewDirFixture();
		const target = path.join(fx.outside, "view.json");
		fs.writeFileSync(target, JSON.stringify(VIEW));
		fs.symlinkSync(target, fx.file("view.json"), "file");

		const read = fx.store.read();
		expect(read.view).toBeUndefined();
		expect(read.error).toBe("view.json resolves to a path outside the board directory");
	});

	test.skipIf(!SYMLINKS)("refuses an outside plan symlink while the view still loads", () => {
		using fx = new ViewDirFixture();
		const target = path.join(fx.outside, "plan.json");
		fs.writeFileSync(target, JSON.stringify(PLAN));
		fs.symlinkSync(target, fx.file("plan.json"), "file");
		fx.writeView(VIEW);

		const read = fx.store.read();
		expect(read.view).toEqual(VIEW);
		expect(read.plan).toBeUndefined();
		expect(read.planError).toBe("plan.json resolves to a path outside the board directory");
	});

	test.skipIf(!SYMLINKS)("keeps the last good view when the file turns into an outside symlink", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const good = fx.store.read().view;

		const target = path.join(fx.outside, "view.json");
		fs.writeFileSync(target, JSON.stringify(headlineView("Smuggled in.")));
		fs.rmSync(fx.file("view.json"));
		fs.symlinkSync(target, fx.file("view.json"), "file");

		const read = fx.store.read();
		expect(read.view).toBe(good);
		expect(read.error).toMatch(/outside the board directory/);
	});

	test.skipIf(!SYMLINKS)("follows a symlink that stays inside the board directory", () => {
		using fx = new ViewDirFixture();
		fs.writeFileSync(fx.file("view.2026.json"), JSON.stringify(VIEW));
		fs.symlinkSync(fx.file("view.2026.json"), fx.file("view.json"), "file");

		expect(fx.store.read()).toEqual({ view: VIEW });
	});

	test("refuses a directory in place of the file", () => {
		using fx = new ViewDirFixture();
		fs.mkdirSync(fx.file("view.json"));

		const read = fx.store.read();
		expect(read.view).toBeUndefined();
		expect(read.error).toBe("view.json is not a regular file");
	});
});

describe("SwarmViewStore instances", () => {
	test("keeps the cache of each instance to its own directory", () => {
		using first = new ViewDirFixture();
		using second = new ViewDirFixture();
		first.writeView(VIEW);
		second.writeView(headlineView("The other board."));

		expect(first.store.read().view?.headline).toBe("Drafting the design doc.");
		expect(second.store.read().view?.headline).toBe("The other board.");

		first.remove("view.json");
		expect(first.store.read()).toEqual({});
		expect(second.store.read().view?.headline).toBe("The other board.");
	});

	test("a second store over the same directory reads independently", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		const other = new SwarmViewStore(fx.dir);

		expect(fx.store.read().view).toEqual(VIEW);
		fx.write("view.json", "{ nope");
		expect(other.read().view).toBeUndefined();
		expect(fx.store.read().view).toEqual(VIEW);
	});
});

describe("SwarmViewStore view.html", () => {
	test("returns a fragment exactly as written", () => {
		using fx = new ViewDirFixture();
		fx.write("view.html", FRAGMENT);

		expect(fx.store.read()).toEqual({ html: FRAGMENT });
	});

	test("returns a full document exactly as written", () => {
		using fx = new ViewDirFixture();
		fx.write("view.html", DOCUMENT);

		expect(fx.store.read()).toEqual({ html: DOCUMENT });
	});

	test("keeps the whitespace around the page", () => {
		using fx = new ViewDirFixture();
		fx.write("view.html", "\n  <p>x</p>\n\n");

		expect(fx.store.read().html).toBe("\n  <p>x</p>\n\n");
	});

	test("accepts every text the browser can parse", () => {
		using fx = new ViewDirFixture();
		for (const page of [
			"plain words",
			"<p>unclosed",
			"</div>",
			"<custom-element></custom-element>",
			"<!-- a comment -->",
			"<html>",
		]) {
			fx.write("view.html", page);
			expect(fx.store.read()).toEqual({ html: page });
		}
	});

	test("reads a page that starts with a byte order mark", () => {
		using fx = new ViewDirFixture();
		fx.write("view.html", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>x</p>")]));

		expect(fx.store.read()).toEqual({ html: "<p>x</p>" });
	});

	test("reads the view, the plan and the page together", () => {
		using fx = new ViewDirFixture();
		fx.writeView(VIEW);
		fx.writePlan(PLAN);
		fx.write("view.html", FRAGMENT);

		expect(fx.store.read()).toEqual({ view: VIEW, plan: PLAN, html: FRAGMENT });
	});

	test("keeps its result stable while the file stays the same", () => {
		using fx = new ViewDirFixture();
		fx.write("view.html", FRAGMENT);
		const first = fx.store.read();

		expect(fx.store.read()).toEqual(first);
		expect(fx.store.read()).toEqual(first);
	});

	test("replaces the page when the file changes", () => {
		using fx = new ViewDirFixture();
		fx.write("view.html", FRAGMENT);
		expect(fx.store.read().html).toBe(FRAGMENT);

		fx.write("view.html", DOCUMENT);
		expect(fx.store.read()).toEqual({ html: DOCUMENT });
	});

	describe("empty and refused content", () => {
		test("keeps the last accepted page while a rewrite is empty", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();

			fx.write("view.html", "");
			expect(fx.store.read()).toEqual({ html: FRAGMENT, htmlError: EMPTY_PAGE_ERROR });
		});

		test("treats whitespace, a lone byte order mark and non-breaking spaces as empty", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();

			for (const blank of ["   ", "\n\t \r\n", "\u00a0\u2003", "\ufeff"]) {
				fx.write("view.html", blank);
				expect(fx.store.read()).toEqual({ html: FRAGMENT, htmlError: EMPTY_PAGE_ERROR });
			}
			fx.write("view.html", Buffer.from([0xef, 0xbb, 0xbf]));
			expect(fx.store.read()).toEqual({ html: FRAGMENT, htmlError: EMPTY_PAGE_ERROR });
		});

		test("keeps reporting the same reason for unchanged blank content", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();
			fx.write("view.html", " \n ");

			const first = fx.store.read();
			expect(fx.store.read()).toEqual(first);
		});

		test("a blank first page yields the reason and an absent page", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", "\n");

			const read = fx.store.read();
			expect(read.html).toBeUndefined();
			expect(read.htmlError).toBe(EMPTY_PAGE_ERROR);
		});

		test("accepts the next page and clears the reason", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();
			fx.write("view.html", "");
			expect(fx.store.read().htmlError).toBe(EMPTY_PAGE_ERROR);

			fx.write("view.html", DOCUMENT);
			expect(fx.store.read()).toEqual({ html: DOCUMENT });
		});

		test("keeps the last accepted page when the bytes are invalid UTF-8", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();
			fx.write("view.html", Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]));

			expect(fx.store.read()).toEqual({ html: FRAGMENT, htmlError: "view.html is not valid UTF-8" });
		});

		test("an invalid first page yields the reason and an absent page", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", Buffer.from([0xc3, 0x28]));

			const read = fx.store.read();
			expect(read.html).toBeUndefined();
			expect(read.htmlError).toBe("view.html is not valid UTF-8");
		});
	});

	describe("size limit", () => {
		test("accepts a page of exactly 48 KB and refuses one more byte", () => {
			using fx = new ViewDirFixture();
			const atLimit = htmlOfBytes(HTML_LIMIT);
			fx.write("view.html", atLimit);
			expect(fx.store.read()).toEqual({ html: atLimit });

			fx.write("view.html", htmlOfBytes(HTML_LIMIT + 1));
			expect(fx.store.read()).toEqual({ html: atLimit, htmlError: `view.html is larger than ${HTML_LIMIT} bytes` });
		});

		test("measures the limit in UTF-8 bytes", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();
			const page = htmlOfBytes(HTML_LIMIT + 1);
			expect(page.length).toBeLessThan(HTML_LIMIT);
			fx.write("view.html", page);

			expect(fx.store.read()).toEqual({ html: FRAGMENT, htmlError: `view.html is larger than ${HTML_LIMIT} bytes` });
		});

		test("an oversized first page yields the reason and an absent page, then recovers", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", htmlOfBytes(HTML_LIMIT + 1));
			const refused = fx.store.read();
			expect(refused.html).toBeUndefined();
			expect(refused.htmlError).toMatch(/larger than 49152 bytes/);

			fx.write("view.html", FRAGMENT);
			expect(fx.store.read()).toEqual({ html: FRAGMENT });
		});

		test("holds the page to a lower ceiling than the JSON files", () => {
			using fx = new ViewDirFixture();
			fx.write("view.json", viewOfBytes(HTML_LIMIT + 1));
			fx.write("view.html", htmlOfBytes(HTML_LIMIT + 1));

			const read = fx.store.read();
			expect(read.error).toBeUndefined();
			expect(read.view?.headline.length).toBeGreaterThan(20_000);
			expect(read.html).toBeUndefined();
			expect(read.htmlError).toBe(`view.html is larger than ${HTML_LIMIT} bytes`);
		});

		test("caps a larger limit at 48 KB for the page and at 64 KB for the JSON files", () => {
			using fx = new ViewDirFixture();
			const store = new SwarmViewStore(fx.dir, 10_000_000);
			fx.write("view.json", viewOfBytes(LIMIT));
			fx.write("view.html", htmlOfBytes(HTML_LIMIT + 1));

			const read = store.read();
			expect(read.error).toBeUndefined();
			expect(read.view).toBeDefined();
			expect(read.htmlError).toBe(`view.html is larger than ${HTML_LIMIT} bytes`);
		});

		test("honors a smaller limit for the page as well", () => {
			using fx = new ViewDirFixture();
			const store = new SwarmViewStore(fx.dir, 40);
			const fits = `<p>${"x".repeat(33)}</p>`;
			expect(Buffer.byteLength(fits)).toBe(40);
			fx.write("view.html", fits);
			expect(store.read()).toEqual({ html: fits });

			fx.write("view.html", `${fits}!`);
			expect(store.read()).toEqual({ html: fits, htmlError: "view.html is larger than 40 bytes" });
		});

		test("reads at most one byte past the limit from a huge page", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", Buffer.alloc(2_000_000, 0x20));
			const reads = vi.spyOn(fs, "readSync");

			const read = fx.store.read();
			expect(read.htmlError).toBe(`view.html is larger than ${HTML_LIMIT} bytes`);
			const calls: readonly (readonly unknown[])[] = reads.mock.calls;
			const requested = calls.map(call => Number(call[3]));
			expect(requested.length).toBeGreaterThan(0);
			expect(requested.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(HTML_LIMIT + 1);
		});
	});

	describe("removal", () => {
		test("drops the page and its reason once the file is gone", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			expect(fx.store.read().html).toBe(FRAGMENT);

			fx.remove("view.html");
			expect(fx.store.read()).toEqual({});

			fx.write("view.html", "");
			expect(fx.store.read().htmlError).toBe(EMPTY_PAGE_ERROR);
			fx.remove("view.html");
			expect(fx.store.read()).toEqual({});
		});

		test("accepts a new page after a removal, also with the same text", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();
			fx.remove("view.html");
			expect(fx.store.read().html).toBeUndefined();

			fx.write("view.html", FRAGMENT);
			expect(fx.store.read()).toEqual({ html: FRAGMENT });
			fx.remove("view.html");
			fx.write("view.html", DOCUMENT);
			expect(fx.store.read()).toEqual({ html: DOCUMENT });
		});

		test("leaves the view and the plan in place", () => {
			using fx = new ViewDirFixture();
			fx.writeView(VIEW);
			fx.writePlan(PLAN);
			fx.write("view.html", FRAGMENT);
			fx.store.read();

			fx.remove("view.html");
			expect(fx.store.read()).toEqual({ view: VIEW, plan: PLAN });
		});

		test("forgets the page when the directory disappears", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			expect(fx.store.read().html).toBe(FRAGMENT);

			fs.rmSync(fx.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
			expect(fx.store.read()).toEqual({});
		});
	});

	describe("containment", () => {
		test.skipIf(!SYMLINKS)("refuses a symlink that leads outside the board directory", () => {
			using fx = new ViewDirFixture();
			const target = path.join(fx.outside, "view.html");
			fs.writeFileSync(target, FRAGMENT);
			fs.symlinkSync(target, fx.file("view.html"), "file");

			const read = fx.store.read();
			expect(read.html).toBeUndefined();
			expect(read.htmlError).toBe("view.html resolves to a path outside the board directory");
		});

		test.skipIf(!SYMLINKS)("keeps the last accepted page when the file turns into an outside symlink", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);
			fx.store.read();

			const target = path.join(fx.outside, "view.html");
			fs.writeFileSync(target, "<p>smuggled</p>");
			fs.rmSync(fx.file("view.html"));
			fs.symlinkSync(target, fx.file("view.html"), "file");

			expect(fx.store.read()).toEqual({
				html: FRAGMENT,
				htmlError: "view.html resolves to a path outside the board directory",
			});
		});

		test.skipIf(!SYMLINKS)("follows a symlink that stays inside the board directory", () => {
			using fx = new ViewDirFixture();
			fs.writeFileSync(fx.file("page.2026.html"), FRAGMENT);
			fs.symlinkSync(fx.file("page.2026.html"), fx.file("view.html"), "file");

			expect(fx.store.read()).toEqual({ html: FRAGMENT });
		});

		test("refuses a directory in place of the file", () => {
			using fx = new ViewDirFixture();
			fs.mkdirSync(fx.file("view.html"));

			const read = fx.store.read();
			expect(read.html).toBeUndefined();
			expect(read.htmlError).toBe("view.html is not a regular file");
		});
	});

	describe("next to the JSON files", () => {
		test("a refused page leaves the view and the plan untouched", () => {
			using fx = new ViewDirFixture();
			fx.writeView(VIEW);
			fx.writePlan(PLAN);
			fx.write("view.html", FRAGMENT);
			fx.store.read();

			fx.write("view.html", "  ");
			const read = fx.store.read();
			expect(read.view).toEqual(VIEW);
			expect(read.plan).toEqual(PLAN);
			expect(read.error).toBeUndefined();
			expect(read.planError).toBeUndefined();
			expect(read.html).toBe(FRAGMENT);
			expect(read.htmlError).toBe(EMPTY_PAGE_ERROR);
		});

		test("a broken view keeps its last good value and leaves the page alone", () => {
			using fx = new ViewDirFixture();
			fx.writeView(VIEW);
			fx.write("view.html", FRAGMENT);
			const good = fx.store.read().view;

			fx.write("view.json", "{ nope");
			const read = fx.store.read();
			expect(read.view).toBe(good);
			expect(read.error).toMatch(/^view\.json is not valid JSON/);
			expect(read.html).toBe(FRAGMENT);
			expect(read.htmlError).toBeUndefined();

			fx.writeView(headlineView("Repaired."));
			const repaired = fx.store.read();
			expect(repaired.error).toBeUndefined();
			expect(repaired.view?.headline).toBe("Repaired.");
			expect(repaired.html).toBe(FRAGMENT);
		});

		test("a broken plan keeps its last good value and leaves the page alone", () => {
			using fx = new ViewDirFixture();
			fx.writePlan(PLAN);
			fx.write("view.html", FRAGMENT);
			fx.store.read();

			fx.write("plan.json", JSON.stringify({ ...PLAN, threads: [] }));
			const read = fx.store.read();
			expect(read.plan).toEqual(PLAN);
			expect(read.planError).toMatch(/^plan\.json: invalid swarm plan: /);
			expect(read.html).toBe(FRAGMENT);
			expect(read.htmlError).toBeUndefined();
		});

		test("a page next to missing JSON files yields only the page", () => {
			using fx = new ViewDirFixture();
			fx.write("view.html", FRAGMENT);

			const read = fx.store.read();
			expect(read.view).toBeUndefined();
			expect(read.plan).toBeUndefined();
			expect(read.error).toBeUndefined();
			expect(read.planError).toBeUndefined();
		});

		test("the limits of view.json and view.html apply independently", () => {
			using fx = new ViewDirFixture();
			fx.writeView(VIEW);
			fx.write("view.html", htmlOfBytes(HTML_LIMIT));
			fx.store.read();

			fx.write("view.json", viewOfBytes(LIMIT + 1));
			const read = fx.store.read();
			expect(read.error).toBe(`view.json is larger than ${LIMIT} bytes`);
			expect(read.view).toEqual(VIEW);
			expect(read.html).toBe(htmlOfBytes(HTML_LIMIT));
			expect(read.htmlError).toBeUndefined();
		});
	});
});
