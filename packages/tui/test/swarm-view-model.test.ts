/**
 * The swarm Overview data contract: view.json (narrator) and plan.json (coordinator) parse into typed
 * values, and every structural break is refused with a readable reason. Actions and reel frames that
 * cannot be used are filtered out while the rest of the view survives.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	NARRATOR_KINDS,
	NARRATOR_SEVERITIES,
	NARRATOR_STATES,
	type NarratorThread,
	type NarratorView,
	parseNarratorView,
	parseSwarmPlan,
	type SwarmPlan,
	SwarmViewError,
} from "@oh-my-pi/pi-tui/overlays/swarm-view-model";

const BRAIN = path.resolve("/brain/conversation-1");
const BASELINE_SHOT = path.join(BRAIN, "shots", "baseline.png");
const FINAL_SHOT = path.join(BRAIN, "shots", "final.webp");
const REPORT_FILE = path.join(BRAIN, "report.md");

/** The start example of the narrator skill. */
const MINIMAL: NarratorView = {
	version: 1,
	as_of_seq: 31,
	updated_at: "2026-10-06T04:20:00Z",
	headline: "Drafting a design doc; research done, draft under review.",
	phase: { label: "Review", index: 3, total: 4 },
	attention: [
		{
			id: "att-html-vs-json",
			kind: "decision",
			severity: "high",
			title: "Decide: freeform HTML or JSON view model?",
			why: "critic and designer disagree; blocks the final doc",
			refs: [{ seq: 12 }, { seq: 13 }, { member: "critic" }],
			actions: [
				{ type: "open_conv", target: "coordinator", label: "Open coordinator" },
				{ type: "board_post", target: 13, label: "Jump to #13" },
			],
		},
	],
	workstreams: [
		{
			id: "ws-backend",
			title: "Backend research",
			owners: ["backend"],
			state: "done",
			note: "Hook point found",
			refs: [{ seq: 6 }],
		},
	],
	milestones: [{ id: "m-6", text: "Backend report posted", refs: [{ seq: 6 }] }],
	risks: [{ id: "r-cost", text: "Always-on member adds token cost", refs: [{ seq: 6 }] }],
};

/** Every optional part of the contract: goal, summary, progress, short copy, threads, now, reel, feedback. */
const FULL: NarratorView = {
	...MINIMAL,
	goal: { title: "Draft the view model design", line: "Research done; draft in review." },
	running_summary: "Two members review the draft; one task is left.",
	attention: [
		{
			...MINIMAL.attention[0],
			short: { title: "HTML or JSON?", line: "Critic and designer disagree." },
			actions: [
				{ type: "open_conv", target: "coordinator", label: "Open coordinator" },
				{ type: "board_post", target: 13, label: "Jump to #13" },
				{ type: "url", target: "https://example.com/design?rev=2#top", label: "Design doc" },
				{ type: "file", target: REPORT_FILE, label: "Report" },
			],
		},
		{
			id: "att-docs-moved",
			kind: "fyi",
			severity: "low",
			title: "Docs folder reorganised",
			refs: [{ member: "docs" }],
		},
	],
	workstreams: [
		{
			...MINIMAL.workstreams[0],
			progress: { done: 2, total: 5 },
			short: { title: "Backend done", line: "Hook point found." },
		},
		{ id: "ws-draft", title: "Draft the doc", owners: ["writer", "critic"], state: "review", refs: [{ seq: 20 }] },
	],
	threads: [
		{
			id: "t-design",
			title: "Design doc",
			goal: "Settle the view model.",
			now: "Reviewing the draft",
			workstreams: ["ws-backend", "ws-draft"],
			attention: ["att-html-vs-json"],
		},
	],
	now: { coordinator: "Waiting on the critic", backend: "Retired" },
	reel: {
		frames: [
			{ path: BASELINE_SHOT, seq: 8, caption: "Baseline layout" },
			{ path: FINAL_SHOT, seq: 20, caption: "Final layout" },
		],
	},
	feedback_ack: { through_seq: 31, text: "Switched to a kanban, as you asked." },
};

const PLAN: SwarmPlan = {
	goal: { title: "Fix Hub split pane layouts", line: "Audit, fix, then verify in both themes." },
	tasks: { auditor: "Audit split panes across states", fixer: "Put split panes in one card" },
	threads: [
		{
			id: "t-split",
			title: "Split pane cards",
			goal: "Panes share one card with clean headers.",
			tasks: ["auditor", "fixer"],
		},
	],
};

function expectViewRejected(input: unknown, message: RegExp): void {
	let thrown: unknown;
	try {
		parseNarratorView(input);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(SwarmViewError);
	if (thrown instanceof Error) expect(thrown.message).toMatch(message);
}

function expectPlanRejected(input: unknown, message: RegExp): void {
	let thrown: unknown;
	try {
		parseSwarmPlan(input);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(SwarmViewError);
	if (thrown instanceof Error) expect(thrown.message).toMatch(message);
}

function withView(overrides: Record<string, unknown>): unknown {
	return { ...FULL, ...overrides };
}

function withAttention(overrides: Record<string, unknown>): unknown {
	return { ...FULL, attention: [{ ...FULL.attention[0], ...overrides }, ...FULL.attention.slice(1)] };
}

function withWorkstream(overrides: Record<string, unknown>): unknown {
	return { ...FULL, workstreams: [{ ...FULL.workstreams[0], ...overrides }, ...FULL.workstreams.slice(1)] };
}

function withThreads(threads: readonly NarratorThread[]): unknown {
	return { ...FULL, threads };
}

function thread(id: string, workstreams: string[] = [], attention: string[] = []): NarratorThread {
	return { id, title: `Thread ${id}`, workstreams, attention };
}

function withPlan(overrides: Record<string, unknown>): unknown {
	return { ...PLAN, ...overrides };
}

describe("parseNarratorView", () => {
	describe("accepted views", () => {
		it("accepts the start example of the narrator skill", () => {
			expect(parseNarratorView(MINIMAL)).toEqual(MINIMAL);
		});

		it("accepts every optional part and returns it unchanged", () => {
			const parsed = parseNarratorView(FULL);
			expect(parsed).toEqual(FULL);
			expect(parsed.goal?.title).toBe("Draft the view model design");
			expect(parsed.threads?.[0].workstreams).toEqual(["ws-backend", "ws-draft"]);
			expect(parsed.reel?.frames.map(frame => frame.seq)).toEqual([8, 20]);
		});

		it("accepts empty lists", () => {
			const empty = { ...MINIMAL, attention: [], workstreams: [], milestones: [], risks: [] };
			expect(parseNarratorView(empty)).toEqual(empty);
		});

		it("accepts a thread with empty lists and up to six threads", () => {
			const bare = { ...MINIMAL, attention: [], workstreams: [], threads: [thread("t-empty")] };
			expect(parseNarratorView(bare)).toEqual(bare);
			const six = [
				thread("t-1", ["ws-backend", "ws-draft"], ["att-html-vs-json"]),
				...["t-2", "t-3", "t-4", "t-5", "t-6"].map(id => thread(id)),
			];
			expect(parseNarratorView(withThreads(six))).toEqual({ ...FULL, threads: six });
		});

		it("lets fyi attention sit in a thread or stay out of every thread", () => {
			const placed = withThreads([
				thread("t-design", ["ws-backend", "ws-draft"], ["att-html-vs-json", "att-docs-moved"]),
			]);
			expect(() => parseNarratorView(placed)).not.toThrow();
			expect(() => parseNarratorView(FULL)).not.toThrow();
		});

		it("accepts UTC timestamps with fractions and leap days", () => {
			for (const stamp of ["2026-10-06T04:20:00.123Z", "2024-02-29T23:59:59Z", "2026-12-31T00:00:00.123456789Z"]) {
				expect(parseNarratorView({ ...MINIMAL, updated_at: stamp }).updated_at).toBe(stamp);
			}
		});

		it("accepts every enum member", () => {
			for (const state of NARRATOR_STATES) expect(() => parseNarratorView(withWorkstream({ state }))).not.toThrow();
			for (const kind of NARRATOR_KINDS) {
				const view = { ...MINIMAL, attention: [{ ...MINIMAL.attention[0], kind }] };
				expect(() => parseNarratorView(view)).not.toThrow();
			}
			for (const severity of NARRATOR_SEVERITIES)
				expect(() => parseNarratorView(withAttention({ severity }))).not.toThrow();
		});

		it("accepts safe sequence boundaries", () => {
			const view = {
				...MINIMAL,
				as_of_seq: Number.MAX_SAFE_INTEGER,
				milestones: [{ id: "m-max", text: "Edge", refs: [{ seq: Number.MAX_SAFE_INTEGER }] }],
			};
			expect(parseNarratorView(view).as_of_seq).toBe(Number.MAX_SAFE_INTEGER);
			expect(parseNarratorView({ ...MINIMAL, as_of_seq: 0 }).as_of_seq).toBe(0);
		});

		it("keeps unknown fields from newer narrators", () => {
			expect(() => parseNarratorView({ ...MINIMAL, future_field: { anything: true } })).not.toThrow();
		});

		it("leaves its input untouched", () => {
			const input = structuredClone({
				...FULL,
				attention: [
					{
						...FULL.attention[0],
						actions: [...(FULL.attention[0].actions ?? []), { type: "exec", target: "x", label: "x" }],
					},
				],
			});
			const snapshot = structuredClone(input);
			parseNarratorView(input);
			expect(input).toEqual(snapshot);
		});
	});

	describe("refused views", () => {
		const { risks: _risks, ...viewLackingRisks } = MINIMAL;
		const { phase: _phase, ...viewLackingPhase } = MINIMAL;
		const { attention: _attention, ...viewLackingAttention } = MINIMAL;
		const cases: [string, unknown, RegExp][] = [
			["null", null, /./],
			["an array", [], /./],
			["a string", "view", /./],
			["a number", 42, /./],
			["version 2", withView({ version: 2 }), /version/],
			["a string version", withView({ version: "1" }), /version/],
			["a missing risks list", viewLackingRisks, /risks/],
			["a missing phase", viewLackingPhase, /phase/],
			["a missing attention list", viewLackingAttention, /attention/],
			["a blank headline", withView({ headline: "   " }), /headline/],
			["a non-string headline", withView({ headline: 7 }), /headline/],
			["a negative as_of_seq", withView({ as_of_seq: -1 }), /as_of_seq/],
			["a fractional as_of_seq", withView({ as_of_seq: 1.5 }), /as_of_seq/],
			["an unsafe as_of_seq", withView({ as_of_seq: Number.MAX_SAFE_INTEGER + 1 }), /as_of_seq/],
			["a string as_of_seq", withView({ as_of_seq: "31" }), /as_of_seq/],
			["a timestamp lacking a zone", withView({ updated_at: "2026-10-06T04:20:00" }), /updated_at/],
			["a timestamp with an offset", withView({ updated_at: "2026-10-06T04:20:00+02:00" }), /updated_at/],
			["a timestamp with a space", withView({ updated_at: "2026-10-06 04:20:00Z" }), /updated_at/],
			["a calendar date that never occurs", withView({ updated_at: "2026-02-30T04:20:00Z" }), /updated_at/],
			["a non-leap February 29", withView({ updated_at: "2026-02-29T04:20:00Z" }), /updated_at/],
			["month 13", withView({ updated_at: "2026-13-01T04:20:00Z" }), /updated_at/],
			["hour 24", withView({ updated_at: "2026-10-06T24:00:00Z" }), /updated_at/],
			["a number as timestamp", withView({ updated_at: 1760000000 }), /updated_at/],
			["an unknown attention kind", withAttention({ kind: "blocker" }), /kind/],
			["an uppercase attention kind", withAttention({ kind: "Decision" }), /kind/],
			["an unknown severity", withAttention({ severity: "urgent" }), /severity/],
			["an unknown workstream state", withWorkstream({ state: "finished" }), /state/],
			["an uppercase attention id", withAttention({ id: "Att-1" }), /\bid\b/],
			["an attention id with an underscore", withAttention({ id: "att_1" }), /\bid\b/],
			["an empty attention id", withAttention({ id: "" }), /\bid\b/],
			["a 41 character attention id", withAttention({ id: "a".repeat(41) }), /\bid\b/],
			["a workstream id with a space", withWorkstream({ id: "ws one" }), /\bid\b/],
			["attention with an empty refs list", withAttention({ refs: [] }), /refs/],
			["a workstream with an empty refs list", withWorkstream({ refs: [] }), /refs/],
			[
				"a milestone with an empty refs list",
				withView({ milestones: [{ id: "m-1", text: "Done", refs: [] }] }),
				/refs/,
			],
			["a risk with an empty refs list", withView({ risks: [{ id: "r-1", text: "Risk", refs: [] }] }), /refs/],
			["a missing refs list", withAttention({ refs: undefined }), /refs/],
			["a zero seq ref", withAttention({ refs: [{ seq: 0 }] }), /refs/],
			["a negative seq ref", withAttention({ refs: [{ seq: -3 }] }), /refs/],
			["a fractional seq ref", withAttention({ refs: [{ seq: 1.5 }] }), /refs/],
			["an unsafe seq ref", withAttention({ refs: [{ seq: Number.MAX_SAFE_INTEGER + 1 }] }), /refs/],
			["a string seq ref", withAttention({ refs: [{ seq: "12" }] }), /refs/],
			["an empty ref object", withAttention({ refs: [{}] }), /refs/],
			["a null ref", withAttention({ refs: [null] }), /refs/],
			["an uppercase member ref", withAttention({ refs: [{ member: "Critic" }] }), /refs/],
			["an empty member ref", withAttention({ refs: [{ member: "" }] }), /refs/],
			["an invalid owner name", withWorkstream({ owners: ["Backend"] }), /owners/],
			[
				"a phase index above the total",
				withView({ phase: { label: "Review", index: 5, total: 4 } }),
				/phase\.index/,
			],
			["a zero phase index", withView({ phase: { label: "Review", index: 0, total: 4 } }), /index/],
			["a zero phase total", withView({ phase: { label: "Review", index: 1, total: 0 } }), /total/],
			["a fractional phase index", withView({ phase: { label: "Review", index: 1.5, total: 4 } }), /index/],
			["a blank phase label", withView({ phase: { label: " ", index: 1, total: 4 } }), /label/],
			["progress done above total", withWorkstream({ progress: { done: 6, total: 5 } }), /progress\.done/],
			["negative progress done", withWorkstream({ progress: { done: -1, total: 5 } }), /done/],
			["a zero progress total", withWorkstream({ progress: { done: 0, total: 0 } }), /total/],
			["a fractional progress", withWorkstream({ progress: { done: 0.5, total: 5 } }), /done/],
			["a repeated attention id", withView({ attention: [FULL.attention[0], FULL.attention[0]] }), /repeats the id/],
			["an id shared by attention and a workstream", withAttention({ id: "ws-backend" }), /repeats the id/],
			[
				"an id shared by a milestone and a risk",
				withView({ risks: [{ id: "m-6", text: "Risk", refs: [{ seq: 1 }] }] }),
				/repeats the id/,
			],
			[
				"an id shared by a thread and a workstream",
				withThreads([thread("ws-backend", ["ws-backend", "ws-draft"], ["att-html-vs-json"])]),
				/repeats the id/,
			],
			["an empty threads list", withThreads([]), /threads/],
			[
				"seven threads",
				withThreads([
					thread("t-1", ["ws-backend", "ws-draft"], ["att-html-vs-json"]),
					...["t-2", "t-3", "t-4", "t-5", "t-6", "t-7"].map(id => thread(id)),
				]),
				/threads/,
			],
			[
				"an invalid thread id",
				withThreads([thread("T One", ["ws-backend", "ws-draft"], ["att-html-vs-json"])]),
				/\bid\b/,
			],
			[
				"a thread with a blank title",
				withThreads([
					{ id: "t-1", title: "", workstreams: ["ws-backend", "ws-draft"], attention: ["att-html-vs-json"] },
				]),
				/title/,
			],
			[
				"a workstream missing from the threads",
				withThreads([thread("t-design", ["ws-backend"], ["att-html-vs-json"])]),
				/workstream "ws-draft" is missing from threads/,
			],
			[
				"a workstream in two threads",
				withThreads([thread("t-1", ["ws-backend", "ws-draft"], ["att-html-vs-json"]), thread("t-2", ["ws-draft"])]),
				/more than one thread/,
			],
			[
				"a workstream twice in one thread",
				withThreads([thread("t-1", ["ws-backend", "ws-draft", "ws-draft"], ["att-html-vs-json"])]),
				/more than one thread/,
			],
			[
				"an unknown workstream in a thread",
				withThreads([thread("t-1", ["ws-backend", "ws-draft", "ws-ghost"], ["att-html-vs-json"])]),
				/unknown workstream "ws-ghost"/,
			],
			[
				"an attention id listed as a workstream",
				withThreads([thread("t-1", ["ws-backend", "ws-draft", "att-html-vs-json"], ["att-html-vs-json"])]),
				/unknown workstream/,
			],
			[
				"a non-fyi attention missing from the threads",
				withThreads([thread("t-1", ["ws-backend", "ws-draft"])]),
				/attention item "att-html-vs-json" \(decision\) is missing from threads/,
			],
			[
				"attention in two threads",
				withThreads([
					thread("t-1", ["ws-backend", "ws-draft"], ["att-html-vs-json"]),
					thread("t-2", [], ["att-html-vs-json"]),
				]),
				/more than one thread/,
			],
			[
				"an unknown attention id in a thread",
				withThreads([thread("t-1", ["ws-backend", "ws-draft"], ["att-html-vs-json", "att-ghost"])]),
				/unknown attention item "att-ghost"/,
			],
			["a now key outside the roster name format", withView({ now: { Coordinator: "Waiting" } }), /now key/],
			["a non-string now value", withView({ now: { coordinator: 3 } }), /now/],
			["a reel that lacks the frames list", withView({ reel: {} }), /frames/],
			["a negative feedback seq", withView({ feedback_ack: { through_seq: -1, text: "x" } }), /through_seq/],
			["a goal with a blank title", withView({ goal: { title: " ", line: "x" } }), /title/],
			["a short copy with a blank title", withAttention({ short: { title: "", line: "x" } }), /title/],
			["actions given as a string", withAttention({ actions: "open" }), /actions/],
		];
		for (const [name, input, message] of cases) {
			it(`refuses ${name}`, () => expectViewRejected(input, message));
		}

		it("names the broken field in the message", () => {
			expectViewRejected(withAttention({ kind: "blocker" }), /^invalid narrator view: /);
		});
	});

	describe("actions", () => {
		const unusable: unknown[] = [
			{ type: "url", target: "http://example.com/plain", label: "Plain http" },
			{ type: "url", target: "javascript:alert(1)", label: "Script" },
			{ type: "url", target: "https://user:secret@example.com/", label: "Credentials" },
			{ type: "url", target: "https://", label: "No host" },
			{ type: "url", target: "https://exa mple.com/", label: "Space" },
			{ type: "url", target: "https://example.com/\nnext", label: "Newline" },
			{ type: "url", target: 12, label: "Number target" },
			{ type: "file", target: "relative/report.md", label: "Relative path" },
			{ type: "file", target: `${BRAIN}${path.sep}..${path.sep}secret.txt`, label: "Parent segment" },
			{ type: "file", target: `${REPORT_FILE}\u0000.md`, label: "NUL byte" },
			{ type: "file", target: "", label: "Empty path" },
			{ type: "open_conv", target: "Not A Member", label: "Bad member" },
			{ type: "open_conv", target: 5, label: "Numeric member" },
			{ type: "board_post", target: "13", label: "String seq" },
			{ type: "board_post", target: 0, label: "Zero seq" },
			{ type: "board_post", target: 1.5, label: "Fractional seq" },
			{ type: "board_post", target: Number.MAX_SAFE_INTEGER + 1, label: "Unsafe seq" },
			{ type: "exec", target: "rm -rf /", label: "Unknown type" },
			{ type: "open_conv", target: "coordinator" },
			{ type: "open_conv", target: "coordinator", label: "   " },
			{ target: "coordinator", label: "No type" },
			"open_conv",
			null,
			7,
			[],
		];
		const usable = FULL.attention[0].actions ?? [];

		it("drops every unusable action and keeps the usable ones in order", () => {
			const mixed = [
				unusable[0],
				usable[0],
				unusable[1],
				usable[1],
				...unusable.slice(2, 12),
				usable[2],
				...unusable.slice(12),
				usable[3],
			];
			const parsed = parseNarratorView(withAttention({ actions: mixed }));
			expect(parsed.attention[0].actions).toEqual(usable);
		});

		it("keeps the rest of the view when every action is dropped", () => {
			const parsed = parseNarratorView(withAttention({ actions: unusable }));
			expect(parsed.attention[0].actions).toEqual([]);
			expect(parsed).toEqual({ ...FULL, attention: [{ ...FULL.attention[0], actions: [] }, FULL.attention[1]] });
		});

		it("accepts a plain https URL with a port, path and query", () => {
			const action = { type: "url", target: "https://example.com:8443/a/b?c=d", label: "Deep link" };
			expect(parseNarratorView(withAttention({ actions: [action] })).attention[0].actions).toEqual([action]);
		});

		it("accepts url schemes in any letter case", () => {
			const action = { type: "url", target: "HTTPS://Example.com/", label: "Shouting" };
			expect(parseNarratorView(withAttention({ actions: [action] })).attention[0].actions).toEqual([action]);
		});

		it("filters the actions of every attention item", () => {
			const second = {
				...FULL.attention[1],
				actions: [
					{ type: "exec", target: "x", label: "x" },
					{ type: "board_post", target: 4, label: "Post 4" },
				],
			};
			const parsed = parseNarratorView({ ...FULL, attention: [FULL.attention[0], second] });
			expect(parsed.attention[1].actions).toEqual([{ type: "board_post", target: 4, label: "Post 4" }]);
		});
	});

	describe("reel", () => {
		function frames(count: number) {
			return Array.from({ length: count }, (_, index) => ({
				path: path.join(BRAIN, "shots", `step-${index + 1}.png`),
				seq: index + 1,
				caption: `Step ${index + 1}`,
			}));
		}

		it("keeps the supported image types in any letter case", () => {
			const supported = ["a.png", "b.JPG", "c.jpeg", "d.WebP"].map((name, index) => ({
				path: path.join(BRAIN, "shots", name),
				seq: index + 1,
				caption: name,
			}));
			expect(parseNarratorView(withView({ reel: { frames: supported } })).reel?.frames).toEqual(supported);
		});

		it("keeps only frames that point at absolute image files", () => {
			const good = frames(2);
			const bad = [
				{ path: path.join(BRAIN, "shots", "clip.gif"), seq: 3, caption: "gif" },
				{ path: path.join(BRAIN, "shots", "noext"), seq: 4, caption: "extensionless" },
				{ path: "shots/relative.png", seq: 5, caption: "relative" },
				{ path: `${BRAIN}${path.sep}..${path.sep}outside.png`, seq: 6, caption: "parent segment" },
				{ path: good[0].path, seq: 0, caption: "zero seq" },
				{ path: good[0].path, seq: 7 },
				"frame",
				null,
			];
			const reel = { frames: [bad[0], good[0], ...bad.slice(1), good[1]] };
			expect(parseNarratorView(withView({ reel })).reel?.frames).toEqual(good);
		});

		it("accepts a single frame", () => {
			const one = frames(1);
			expect(parseNarratorView(withView({ reel: { frames: one } })).reel?.frames).toEqual(one);
		});

		it("omits a reel whose frames are all unusable", () => {
			const parsed = parseNarratorView(
				withView({ reel: { frames: [{ path: "shots/relative.png", seq: 1, caption: "x" }] } }),
			);
			expect("reel" in parsed).toBe(false);
			expect(parseNarratorView(withView({ reel: { frames: [] } })).reel).toBeUndefined();
		});

		it("keeps the newest 24 frames of a longer reel", () => {
			const all = frames(30);
			expect(parseNarratorView(withView({ reel: { frames: all } })).reel?.frames).toEqual(all.slice(-24));
			const exact = frames(24);
			expect(parseNarratorView(withView({ reel: { frames: exact } })).reel?.frames).toEqual(exact);
		});
	});
});

describe("parseSwarmPlan", () => {
	it("accepts the example of the pane skill", () => {
		expect(parseSwarmPlan(PLAN)).toEqual(PLAN);
	});

	it("accepts an empty task map and threads that omit the goal", () => {
		const bare = { goal: PLAN.goal, tasks: {}, threads: [{ id: "t-idle", title: "Idle", tasks: [] }] };
		expect(parseSwarmPlan(bare)).toEqual(bare);
	});

	it("accepts six threads", () => {
		const names = ["w1", "w2", "w3", "w4", "w5", "w6"];
		const plan = {
			goal: PLAN.goal,
			tasks: Object.fromEntries(names.map(name => [name, `Work of ${name}`])),
			threads: names.map(name => ({ id: `t-${name}`, title: `Thread ${name}`, tasks: [name] })),
		};
		expect(parseSwarmPlan(plan)).toEqual(plan);
	});

	const { goal: _goal, ...planLackingGoal } = PLAN;
	const { threads: _threads, ...planLackingThreads } = PLAN;
	const seven = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];
	const cases: [string, unknown, RegExp][] = [
		["null", null, /./],
		["an array", [], /./],
		["a missing goal", planLackingGoal, /goal/],
		["a missing threads list", planLackingThreads, /threads/],
		["a blank goal title", withPlan({ goal: { title: "  ", line: "x" } }), /title/],
		["a goal line given as a number", withPlan({ goal: { title: "Goal", line: 3 } }), /line/],
		["an empty threads list", withPlan({ threads: [] }), /threads/],
		[
			"seven threads",
			{
				goal: PLAN.goal,
				tasks: Object.fromEntries(seven.map(name => [name, `Work of ${name}`])),
				threads: seven.map(name => ({ id: `t-${name}`, title: `Thread ${name}`, tasks: [name] })),
			},
			/threads/,
		],
		["an invalid thread id", withPlan({ threads: [{ ...PLAN.threads[0], id: "T Split" }] }), /\bid\b/],
		["a blank thread title", withPlan({ threads: [{ ...PLAN.threads[0], title: "" }] }), /title/],
		[
			"a repeated thread id",
			withPlan({
				threads: [
					{ ...PLAN.threads[0], tasks: ["auditor"] },
					{ ...PLAN.threads[0], tasks: ["fixer"] },
				],
			}),
			/repeats thread id "t-split"/,
		],
		[
			"a worker in two threads",
			withPlan({ threads: [PLAN.threads[0], { id: "t-other", title: "Other", tasks: ["fixer"] }] }),
			/worker "fixer" is listed in more than one thread/,
		],
		[
			"a worker missing from the threads",
			withPlan({ threads: [{ ...PLAN.threads[0], tasks: ["auditor"] }] }),
			/worker "fixer" is missing from threads/,
		],
		[
			"a thread worker absent from tasks",
			withPlan({ threads: [{ ...PLAN.threads[0], tasks: ["auditor", "fixer", "ghost"] }] }),
			/"ghost", which is missing from tasks/,
		],
		[
			"a task key outside the roster name format",
			withPlan({ tasks: { ...PLAN.tasks, Fixer: "Fix" } }),
			/tasks key "Fixer"/,
		],
		["a blank task text", withPlan({ tasks: { auditor: "  ", fixer: "Fix" } }), /tasks/],
		["a non-string task text", withPlan({ tasks: { auditor: 4, fixer: "Fix" } }), /tasks/],
		[
			"an invalid worker name in a thread",
			withPlan({ threads: [{ ...PLAN.threads[0], tasks: ["auditor", "Fixer"] }] }),
			/tasks/,
		],
	];
	for (const [name, input, message] of cases) {
		it(`refuses ${name}`, () => expectPlanRejected(input, message));
	}

	it("starts every message with the plan label", () => {
		expectPlanRejected(withPlan({ threads: [] }), /^invalid swarm plan: /);
	});
});
