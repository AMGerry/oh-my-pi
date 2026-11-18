/**
 * The swarm board sheet: Board, Members and Overview tabs over a read-only state projection.
 * Covers bounded rendering, keyboard and native navigation, #seq citations, live updates, the
 * evidence markers of the narrator Overview, text hygiene, finite motion and disposal.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { SwarmBoardOverlay } from "@oh-my-pi/pi-tui/overlays/swarm-board";
import { buildSwarmBoardRows, type SwarmBoardRow } from "@oh-my-pi/pi-tui/overlays/swarm-board-projection";
import type {
	SwarmBoardDeps,
	SwarmBoardMember,
	SwarmBoardPost,
	SwarmBoardState,
	SwarmBoardTab,
} from "@oh-my-pi/pi-tui/overlays/swarm-board-types";
import type { NarratorAction, NarratorView, SwarmPlan } from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { theme } from "@oh-my-pi/pi-tui/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const ENTER = "\r";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const TABS: readonly SwarmBoardTab[] = ["board", "members", "overview"];

const cx: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

const REEL_PATH = "/brain/conversation-1/shots/board.png";

/** Every part of the narrator contract the Overview shows. */
const VIEW: NarratorView = {
	version: 1,
	as_of_seq: 3,
	updated_at: "2026-10-06T04:20:00Z",
	headline: "Building the board; review pending.",
	phase: { label: "Review", index: 2, total: 3 },
	goal: { title: "Ship the board", line: "Board lands after review." },
	running_summary: "The reviewer checks the overlay.",
	attention: [
		{
			id: "att-scope",
			kind: "decision",
			severity: "high",
			title: "Decide the scope",
			why: "Blocks the release",
			refs: [{ seq: 2 }, { member: "alice" }],
			actions: [{ type: "open_conv", target: "coordinator", label: "Open coordinator" }],
			short: { title: "Decide scope", line: "Blocks release" },
		},
		{ id: "att-fyi", kind: "fyi", severity: "low", title: "Docs reorganised", refs: [{ member: "bob" }] },
	],
	workstreams: [
		{
			id: "ws-board",
			title: "Board overlay",
			owners: ["alice"],
			state: "active",
			note: "Rows land",
			refs: [{ seq: 3 }],
			progress: { done: 1, total: 2 },
		},
	],
	milestones: [{ id: "m-1", text: "Contract settled", refs: [{ seq: 1 }] }],
	risks: [],
	threads: [
		{
			id: "t-board",
			title: "Board",
			goal: "Show the swarm",
			now: "Reviewing",
			workstreams: ["ws-board"],
			attention: ["att-scope"],
		},
	],
	now: { alice: "Drafting the parser", coordinator: "Waiting on review" },
	reel: { frames: [{ path: REEL_PATH, seq: 2, caption: "Board layout draft" }] },
	feedback_ack: { through_seq: 3, text: "Switched to a board view." },
};

const PLAN: SwarmPlan = {
	goal: { title: "Ship the board", line: "Audit, build, review." },
	tasks: { alice: "Draft the parser", bob: "Review the overlay" },
	threads: [{ id: "t-main", title: "Board work", goal: "Deliver the board.", tasks: ["alice", "bob"] }],
};

function post(seq: number, agent: string, text: string, channel?: string): SwarmBoardPost {
	const time = `2026-10-06T04:${String(10 + (seq % 50)).padStart(2, "0")}:00Z`;
	return channel === undefined ? { seq, agent, text, time } : { seq, agent, text, time, channel };
}

function member(name: string, overrides: Partial<SwarmBoardMember> = {}): SwarmBoardMember {
	return {
		name,
		agentId: `${name}-agent`,
		role: "worker",
		state: "waiting",
		model: "test/model",
		unread: 0,
		lastReadSeq: 0,
		lastPostSeq: 0,
		lastPostTime: null,
		wakeMode: "mentions",
		waitSince: null,
		channels: [],
		...overrides,
	};
}

const COORDINATOR = member("coordinator", { role: "coordinator", state: "working", wakeMode: null, lastReadSeq: 3 });
const ALICE = member("alice", { state: "working", lastPostSeq: 2, lastPostTime: "2026-10-06T04:12:00Z" });
const BOB = member("bob", { unread: 2, waitSince: 2, lastPostSeq: 3, lastPostTime: "2026-10-06T04:13:00Z" });

/** Three posts, all read by the coordinator, so the board opens on its newest post. */
function boardState(overrides: Partial<SwarmBoardState> = {}): SwarmBoardState {
	return {
		id: "swarm-1",
		title: "Native swarm",
		head: 3,
		members: [COORDINATOR, ALICE, BOB],
		posts: [
			post(1, "coordinator", "Kickoff: build the board."),
			post(2, "alice", "Parser draft is ready."),
			post(3, "bob", "Review pending on the overlay."),
		],
		...overrides,
	};
}

function overviewState(overrides: Partial<SwarmBoardState> = {}): SwarmBoardState {
	return boardState({ view: VIEW, ...overrides });
}

function withPost(state: SwarmBoardState, added: SwarmBoardPost): SwarmBoardState {
	return { ...state, head: added.seq, posts: [...state.posts, added] };
}

function manyPosts(count: number): SwarmBoardPost[] {
	const agents = ["coordinator", "alice", "bob"];
	return Array.from({ length: count }, (_, index) =>
		post(index + 1, agents[index % agents.length], `Progress note ${index + 1}: ${"word ".repeat(40)}`),
	);
}

/** Stand-in for the controller: owns the state, the listeners and every callback the sheet calls. */
class Harness {
	state: SwarmBoardState;
	readonly terminal = { rows: 24 };
	readonly listeners = new Set<() => void>();
	readonly navigations: NarratorAction[] = [];
	unsubscribed = 0;
	renders = 0;
	closes = 0;
	refreshes = 0;
	reads = 0;

	constructor(state: SwarmBoardState = boardState()) {
		this.state = state;
	}

	deps(overrides: Partial<SwarmBoardDeps> = {}): SwarmBoardDeps {
		return {
			terminal: this.terminal,
			getState: () => {
				this.reads++;
				return this.state;
			},
			subscribe: listener => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
					this.unsubscribed++;
				};
			},
			requestRender: () => {
				this.renders++;
			},
			onClose: () => {
				this.closes++;
			},
			onNavigate: action => {
				this.navigations.push(action);
			},
			refresh: () => {
				this.refreshes++;
			},
			...overrides,
		};
	}

	open(overrides: Partial<SwarmBoardDeps> = {}): SwarmBoardOverlay {
		const overlay = new SwarmBoardOverlay(this.deps(overrides));
		opened.push(overlay);
		return overlay;
	}

	/** The source changed: store the new state and notify every subscriber. */
	publish(next: SwarmBoardState): void {
		this.state = next;
		const observers = [...this.listeners];
		for (const listener of observers) listener();
	}
}

const opened: SwarmBoardOverlay[] = [];

function visible(lines: readonly string[]): string {
	return lines.map(plainText).join("\n");
}

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

/** Every described node under `root` (child components stay unexpanded). */
function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if (isNode(child)) out.push(...nodes(child));
	return out;
}

function prop(described: NativeNode, name: string): unknown {
	return described.p === undefined ? undefined : Reflect.get(described.p, name);
}

function clickAct(described: NativeNode): string | undefined {
	const actions = prop(described, "actions");
	const click: unknown = typeof actions === "object" && actions !== null ? Reflect.get(actions, "click") : undefined;
	return typeof click === "string" ? click : undefined;
}

function byKey(root: NativeNode, key: string): NativeNode {
	const found = nodes(root).find(candidate => candidate.key === key);
	if (found === undefined) throw new Error(`missing node ${key}`);
	return found;
}

/** The navigation action strings of one described row, in button order. */
function actsOf(root: NativeNode, rowKey: string): string[] {
	const item = nodes(root).find(candidate => candidate.k === "item" && candidate.key === rowKey);
	if (item === undefined) return [];
	return nodes(item).flatMap(candidate => {
		const act = clickAct(candidate);
		return act?.startsWith("navigate:") ? [act] : [];
	});
}

function navigateAct(rowKey: string, action: Pick<NarratorAction, "type" | "target">): string {
	return `navigate:${encodeURIComponent(rowKey)}:${encodeURIComponent(`${action.type}:${action.target}`)}`;
}

function actionEvent(act: string): NativeUiEvent {
	return { type: "action", key: "", act, mods: [] };
}

function rowOf(rows: readonly SwarmBoardRow[], key: string): SwarmBoardRow {
	const found = rows.find(candidate => candidate.key === key);
	if (found === undefined) throw new Error(`missing row ${key} among ${rows.map(item => item.key).join(", ")}`);
	return found;
}

function overviewRows(state: SwarmBoardState): SwarmBoardRow[] {
	return buildSwarmBoardRows(state, "overview", 0);
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	vi.useFakeTimers();
	setMotionEffects(false);
	setNativeRendering(false);
});

afterEach(() => {
	for (const overlay of opened.splice(0)) overlay.dispose();
	vi.useRealTimers();
	setMotionEffects(true);
	setNativeRendering(false);
});

describe("viewports", () => {
	const VIEWPORTS: readonly (readonly [columns: number, rows: number])[] = [
		[80, 24],
		[80, 6],
		[40, 12],
		[24, 7],
		[12, 6],
		[8, 6],
		[7, 24],
		[7, 5],
		[5, 3],
		[3, 1],
		[1, 1],
		[0, 0],
		[0, 10],
		[120, 50],
	];

	for (const tab of TABS) {
		for (const [columns, rows] of VIEWPORTS) {
			it(`${tab} stays inside ${columns}x${rows}`, () => {
				const harness = new Harness(overviewState({ posts: manyPosts(12), head: 12 }));
				harness.terminal.rows = rows;
				const lines = harness.open({ initialTab: tab }).render(columns);

				expect(lines.length).toBeLessThanOrEqual(rows);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
				if (columns >= 8 && rows >= 6) expect(lines.length).toBe(rows);
			});
		}
	}

	it("fills 80x24 with the title, the tabs, the selected post and the footer", () => {
		const harness = new Harness();
		const lines = harness.open().render(80);
		const text = visible(lines);

		expect(lines).toHaveLength(24);
		expect(plainText(lines[0])).toContain("Swarm · Native swarm · #3");
		expect(plainText(lines[1])).toContain("Board");
		expect(plainText(lines[1])).toContain("Members");
		expect(plainText(lines[1])).toContain("Overview");
		expect(text).toContain("Review pending on the overlay.");
		expect(plainText(lines[22])).toContain("Esc Close");
		expect(plainText(lines[23]).startsWith(theme.boxRound.bottomLeft)).toBe(true);
	});

	it("shows the compact summary in a tiny viewport", () => {
		const harness = new Harness();
		harness.terminal.rows = 5;
		const text = visible(harness.open().render(20));

		expect(text).toContain("Swarm · #3");
		expect(text).toContain("Board");
	});

	it("keeps 200 long posts inside 80x24 and scrolls the selection into view", () => {
		const harness = new Harness(boardState({ head: 200, posts: manyPosts(200) }));
		const overlay = harness.open();

		overlay.handleInput("G");
		const last = overlay.render(80);
		expect(last).toHaveLength(24);
		expect(visible(last)).toMatch(/#200\s+alice/);

		overlay.handleInput("g");
		const first = overlay.render(80);
		expect(first).toHaveLength(24);
		expect(visible(first)).toMatch(/#1\s+coordinator/);
		expect(visible(first)).not.toMatch(/#200\s+alice/);
	});

	it("bounds unbroken and double-width text", () => {
		const hostile = boardState({
			posts: [
				post(1, "coordinator", "x".repeat(400)),
				post(2, "alice", "界".repeat(100)),
				post(3, "bob", "ünï".repeat(60)),
			],
		});
		for (const columns of [80, 20, 8]) {
			const harness = new Harness(hostile);
			harness.terminal.rows = 24;
			const overlay = harness.open();
			for (const key of ["", "k", "k"]) {
				if (key) overlay.handleInput(key);
				const lines = overlay.render(columns);
				expect(lines.length).toBeLessThanOrEqual(24);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
			}
		}
	});

	it("follows the terminal's row count between renders", () => {
		const harness = new Harness();
		const overlay = harness.open();

		expect(overlay.render(80)).toHaveLength(24);
		harness.terminal.rows = 10;
		expect(overlay.render(80)).toHaveLength(10);
		harness.terminal.rows = 5;
		expect(overlay.render(80).length).toBeLessThanOrEqual(5);
		harness.terminal.rows = 40;
		expect(overlay.render(80)).toHaveLength(40);
	});

	it("renders an empty roster and an empty board", () => {
		const harness = new Harness(boardState({ members: [], posts: [], head: 0 }));
		const overlay = harness.open();

		expect(visible(overlay.render(80))).toContain("Board is empty");
		overlay.handleInput(TAB);
		expect(overlay.selectedKey).toBeUndefined();
		expect(overlay.render(80)).toHaveLength(24);
		overlay.handleInput("j");
		overlay.handleInput(ENTER);
		expect(harness.navigations).toEqual([]);
	});

	it("shows a source error above the board", () => {
		const harness = new Harness(boardState({ error: "Board directory unreadable" }));
		const text = visible(harness.open().render(80));

		expect(text).toContain("Board unavailable");
		expect(text).toContain("Board directory unreadable");
	});
});

describe("keyboard", () => {
	it("moves the selection with j and k and clamps at both ends", () => {
		const harness = new Harness();
		const overlay = harness.open();
		expect(overlay.selectedKey).toBe("post-3");

		overlay.handleInput("k");
		expect(overlay.selectedKey).toBe("post-2");
		overlay.handleInput("k");
		expect(overlay.selectedKey).toBe("post-1");
		overlay.handleInput("k");
		expect(overlay.selectedKey).toBe("post-1");
		overlay.handleInput("j");
		expect(overlay.selectedKey).toBe("post-2");
		overlay.handleInput("j");
		overlay.handleInput("j");
		expect(overlay.selectedKey).toBe("post-3");
	});

	it("mirrors j and k on the arrow keys and jumps with g and G", () => {
		const harness = new Harness();
		const overlay = harness.open();

		overlay.handleInput(UP);
		expect(overlay.selectedKey).toBe("post-2");
		overlay.handleInput(DOWN);
		expect(overlay.selectedKey).toBe("post-3");
		overlay.handleInput("g");
		expect(overlay.selectedKey).toBe("post-1");
		overlay.handleInput("G");
		expect(overlay.selectedKey).toBe("post-3");
	});

	it("asks for a render after every move", () => {
		const harness = new Harness();
		const overlay = harness.open();

		overlay.handleInput("k");
		overlay.handleInput("j");
		expect(harness.renders).toBe(2);
	});

	it("cycles the tabs with Tab and Shift+Tab", () => {
		const harness = new Harness();
		const overlay = harness.open();
		expect(overlay.tab).toBe("board");

		overlay.handleInput(TAB);
		expect(overlay.tab).toBe("members");
		expect(overlay.selectedKey).toBe("member-coordinator");
		overlay.handleInput(TAB);
		expect(overlay.tab).toBe("overview");
		overlay.handleInput(TAB);
		expect(overlay.tab).toBe("board");
		overlay.handleInput(SHIFT_TAB);
		expect(overlay.tab).toBe("overview");
		overlay.handleInput(SHIFT_TAB);
		expect(overlay.tab).toBe("members");
		overlay.handleInput(SHIFT_TAB);
		expect(overlay.tab).toBe("board");
	});

	it("closes on Esc and refreshes on r", () => {
		const harness = new Harness();
		const overlay = harness.open();

		overlay.handleInput(ESCAPE);
		expect(harness.closes).toBe(1);
		overlay.handleInput("r");
		expect(harness.refreshes).toBe(1);
		expect(harness.closes).toBe(1);
	});

	it("opens the author's conversation on Enter and skips rows that carry zero actions", () => {
		const harness = new Harness(
			boardState({ members: [member("coordinator", { role: "coordinator", lastReadSeq: 1 })] }),
		);
		const overlay = harness.open();
		expect(overlay.selectedKey).toBe("unread");

		overlay.handleInput(ENTER);
		expect(harness.navigations).toEqual([]);

		overlay.handleInput("j");
		overlay.handleInput("j");
		expect(overlay.selectedKey).toBe("post-3");
		overlay.handleInput(ENTER);
		expect(harness.navigations).toEqual([{ type: "open_conv", target: "bob", label: "bob" }]);
	});

	it("opens a member's conversation from the Members tab", () => {
		const harness = new Harness();
		const overlay = harness.open({ initialTab: "members" });
		overlay.handleInput("j");
		expect(overlay.selectedKey).toBe("member-alice");

		overlay.handleInput(ENTER);
		expect(harness.navigations).toEqual([{ type: "open_conv", target: "alice", label: "Conversation" }]);
	});

	it("cycles through a row's actions with the arrows and shows the chosen one", () => {
		const harness = new Harness(overviewState());
		const overlay = harness.open({ initialTab: "overview" });
		overlay.handleNativeEvent({ type: "select", key: "feed", item: "attention-att-scope" });
		expect(visible(overlay.render(80))).toContain("[Open coordinator]");

		overlay.handleInput(RIGHT);
		expect(visible(overlay.render(80))).toContain("[#2]");
		overlay.handleInput(RIGHT);
		expect(visible(overlay.render(80))).toContain("[alice]");
		overlay.handleInput(RIGHT);
		expect(visible(overlay.render(80))).toContain("[Open coordinator]");
		overlay.handleInput(LEFT);
		expect(visible(overlay.render(80))).toContain("[alice]");

		overlay.handleInput(ENTER);
		expect(harness.navigations).toEqual([{ type: "open_conv", target: "alice", label: "alice" }]);
	});

	it("starts on the Unread divider and honors an explicit since", () => {
		const unread = new Harness(
			boardState({ members: [member("coordinator", { role: "coordinator", lastReadSeq: 1 })] }),
		);
		const overlay = unread.open();
		expect(overlay.selectedKey).toBe("unread");
		expect(visible(overlay.render(80))).toContain("Unread");

		const explicit = new Harness();
		const since = explicit.open({ since: 2 });
		expect(since.selectedKey).toBe("unread");
		since.handleInput("j");
		expect(since.selectedKey).toBe("post-3");
	});

	it("showSince reopens the board at the first post after the cursor", () => {
		const harness = new Harness();
		const overlay = harness.open({ initialTab: "members" });

		overlay.showSince("board", 1);
		expect(overlay.tab).toBe("board");
		expect(overlay.selectedKey).toBe("post-2");
		expect(visible(overlay.render(80))).toContain("Unread");
	});
});

describe("overview citations", () => {
	it("jumps from a #seq citation to that post on the Board", () => {
		const harness = new Harness(overviewState());
		const overlay = harness.open({ initialTab: "overview" });
		overlay.handleNativeEvent({ type: "select", key: "feed", item: "attention-att-scope" });
		overlay.handleInput(RIGHT);

		overlay.handleInput(ENTER);
		expect(overlay.tab).toBe("board");
		expect(overlay.selectedKey).toBe("post-2");
		expect(harness.navigations).toEqual([]);
		const text = visible(overlay.render(80));
		expect(text).toContain("Parser draft is ready.");
	});

	it("jumps from the as-of citation to the newest post it covers", () => {
		const harness = new Harness(overviewState());
		const overlay = harness.open({ initialTab: "overview" });
		overlay.handleNativeEvent({ type: "select", key: "feed", item: "as-of" });

		overlay.handleInput(ENTER);
		expect(overlay.tab).toBe("board");
		expect(overlay.selectedKey).toBe("post-3");
		expect(harness.navigations).toEqual([]);
	});

	it("keeps both the file action and the #seq citation of a reel frame", () => {
		const harness = new Harness(overviewState());
		const overlay = harness.open({ initialTab: "overview" });
		overlay.handleNativeEvent({ type: "select", key: "feed", item: "reel-0" });

		overlay.handleInput(ENTER);
		expect(harness.navigations).toEqual([{ type: "file", target: REEL_PATH, label: "Open frame" }]);
		expect(overlay.tab).toBe("overview");

		overlay.handleInput(RIGHT);
		overlay.handleInput(ENTER);
		expect(overlay.tab).toBe("board");
		expect(overlay.selectedKey).toBe("post-2");
		expect(harness.navigations).toHaveLength(1);
	});

	it("hands a citation of a post the board lacks to the controller", () => {
		const view: NarratorView = {
			...VIEW,
			threads: undefined,
			attention: [{ id: "att-far", kind: "review", severity: "med", title: "Check #9", refs: [{ seq: 9 }] }],
		};
		const harness = new Harness(boardState({ view }));
		const overlay = harness.open({ initialTab: "overview" });
		overlay.handleNativeEvent({ type: "select", key: "feed", item: "attention-att-far" });

		overlay.handleInput(ENTER);
		expect(overlay.tab).toBe("overview");
		expect(harness.navigations).toEqual([{ type: "board_post", target: 9, label: "#9" }]);
	});

	it("jumps from a native action button the same way", () => {
		const harness = new Harness(overviewState());
		const overlay = harness.open({ initialTab: "overview" });
		const act = navigateAct("attention-att-scope", { type: "board_post", target: 2 });
		expect(actsOf(overlay.describe(cx), "attention-att-scope")).toContain(act);

		overlay.handleNativeEvent(actionEvent(act));
		expect(overlay.tab).toBe("board");
		expect(overlay.selectedKey).toBe("post-2");
		expect(harness.navigations).toEqual([]);
	});
});

describe("live updates", () => {
	it("shows a new post in the next render and keeps an older selection", () => {
		const harness = new Harness();
		harness.terminal.rows = 60;
		const overlay = harness.open();
		overlay.handleInput("k");
		expect(overlay.selectedKey).toBe("post-2");
		const requested = harness.renders;

		harness.publish(withPost(harness.state, post(4, "alice", "Fresh evidence from alice.")));
		expect(harness.renders).toBe(requested + 1);
		expect(overlay.selectedKey).toBe("post-2");
		const text = visible(overlay.render(80));
		expect(text).toContain("Fresh evidence from alice.");
		expect(text).toContain("Unread");
	});

	it("follows the newest post while the selection sits at the end", () => {
		const harness = new Harness();
		const overlay = harness.open();
		expect(overlay.selectedKey).toBe("post-3");

		harness.publish(withPost(harness.state, post(4, "bob", "Second look at the overlay.")));
		expect(overlay.selectedKey).toBe("post-4");
		harness.publish(withPost(harness.state, post(5, "alice", "Merged.")));
		expect(overlay.selectedKey).toBe("post-5");
	});

	it("keeps the Unread divider selected while posts arrive", () => {
		const harness = new Harness(
			boardState({ members: [member("coordinator", { role: "coordinator", lastReadSeq: 1 })] }),
		);
		const overlay = harness.open();
		expect(overlay.selectedKey).toBe("unread");

		harness.publish(withPost(harness.state, post(4, "alice", "More news.")));
		expect(overlay.selectedKey).toBe("unread");
	});

	it("rebuilds the Members and Overview rows from the new state", () => {
		const harness = new Harness(overviewState());
		harness.terminal.rows = 60;
		const members = harness.open({ initialTab: "members" });
		const overview = harness.open({ initialTab: "overview" });

		harness.publish({ ...harness.state, members: [COORDINATOR, ALICE, member("carol", { state: "working" })] });
		expect(visible(members.render(80))).toContain("carol · working");
		harness.publish({
			...harness.state,
			view: { ...VIEW, headline: "Rebuilt.", goal: { title: "Ship it", line: "Now." } },
		});
		expect(visible(overview.render(80))).toContain("Ship it");
	});

	it("notifies every open sheet once per source event", () => {
		const harness = new Harness();
		harness.open();
		harness.open();
		expect(harness.listeners.size).toBe(2);

		harness.publish(harness.state);
		expect(harness.renders).toBe(2);
	});
});

describe("overview evidence", () => {
	it.each([true, false])("keeps the headline and running summary visible with goal=%s", includeGoal => {
		const view = { ...VIEW, goal: includeGoal ? VIEW.goal : undefined };
		const overlay = new Harness(overviewState({ view })).open({ initialTab: "overview" });
		const text = visible(overlay.render(80));
		expect(text.split(VIEW.headline)).toHaveLength(2);
		if (VIEW.running_summary === undefined) throw new Error("The fixture view carries a running summary");
		expect(text).toContain(VIEW.running_summary);
		if (includeGoal) expect(text).toContain("Board lands after review.");
		expect(JSON.stringify(overlay.describe(cx))).toContain(VIEW.headline);
	});

	it("shows the rejected update next to the last good view", () => {
		const harness = new Harness(
			overviewState({
				viewError: "view.json: invalid narrator view: headline must be non-blank",
				planError: "plan.json is not valid JSON: Unexpected end",
			}),
		);
		const overlay = harness.open({ initialTab: "overview" });
		const rows = overviewRows(harness.state);

		expect(rows.slice(0, 3).map(item => item.key)).toEqual(["view-error", "plan-error", "goal"]);
		expect(rowOf(rows, "view-error")).toMatchObject({ title: "Overview update rejected", tone: "warning" });
		expect(rowOf(rows, "plan-error")).toMatchObject({ title: "Plan update rejected", tone: "warning" });
		const text = visible(overlay.render(80));
		expect(text).toContain("Overview update rejected");
		expect(text).toContain("headline must be non-blank");
		expect(text).toContain("Plan update rejected");
		expect(text).toContain("Ship the board");
		expect(text).toContain("As of #3");
	});

	it("lists the last good rows in the native description too", () => {
		const harness = new Harness(overviewState({ viewError: "view.json is not valid JSON: Unexpected end" }));
		const feed = byKey(harness.open({ initialTab: "overview" }).describe(cx), "feed");
		const keys = (feed.c ?? []).filter(isNode).map(item => item.key);

		expect(keys.slice(0, 3)).toEqual(["view-error", "goal", "as-of"]);
		expect(keys).toContain("attention-att-scope");
	});

	it("falls back to the plan and the roster when the first view is rejected", () => {
		const posts = [
			post(1, "coordinator", "Kickoff."),
			post(2, "alice", "Parser draft is ready."),
			post(3, "bob", "Overlay reviewed [done]"),
		];
		const state = boardState({ posts, plan: PLAN, viewError: "view.json: invalid narrator view: version must be 1" });
		const rows = overviewRows(state);

		expect(rows.map(item => item.key)).toEqual(["view-error", "goal", "group-t-main", "task-alice", "task-bob"]);
		expect(rowOf(rows, "goal")).toMatchObject({ title: "Ship the board", text: "Audit, build, review." });
		expect(rowOf(rows, "task-alice")).toMatchObject({
			title: "Draft the parser",
			meta: "alice · working",
			actions: [{ type: "board_post", target: 2, label: "#2" }],
		});
		expect(rowOf(rows, "task-bob").meta).toBe("bob · waiting · reported done");
	});

	it("builds the default work group from the roster when neither view nor plan exists", () => {
		const rows = overviewRows(boardState());

		expect(rows.map(item => item.key)).toEqual(["goal", "group-work", "task-alice", "task-bob"]);
		expect(rowOf(rows, "goal").title).toBe("Native swarm");
	});

	it("marks a current view and leaves its verified citations unflagged", () => {
		const rows = overviewRows(overviewState());

		expect(rowOf(rows, "as-of")).toMatchObject({ title: "As of #3 · Current", tone: "muted" });
		expect(rowOf(rows, "attention-att-scope").meta).toBe("Awaiting coordinator · high");
		expect(rowOf(rows, "stream-ws-board").meta).toBe("active · alice · 1/2");
		for (const item of rows) expect(`${item.title} ${item.meta ?? ""}`).not.toContain("Unverified");
	});

	it("marks a view that trails the board as stale", () => {
		const posts = [...boardState().posts, post(4, "alice", "More."), post(5, "bob", "Even more.")];
		const state = overviewState({ posts, head: 5 });
		const rows = overviewRows(state);

		expect(rowOf(rows, "as-of")).toMatchObject({ title: "As of #3 · Stale · board #5", tone: "warning" });
		expect(rowOf(rows, "attention-att-scope").meta).toBe("Awaiting coordinator · high");
		const text = visible(new Harness(state).open({ initialTab: "overview" }).render(80));
		expect(text).toContain("Stale · board #5");
	});

	it("marks a view from the future as unverified, with every citation", () => {
		const state = overviewState({ view: { ...VIEW, as_of_seq: 7 } });
		const rows = overviewRows(state);

		expect(rowOf(rows, "as-of")).toMatchObject({
			title: "As of #7 · Unverified",
			tone: "warning",
			actions: [{ type: "board_post", target: 7, label: "#7" }],
		});
		expect(rowOf(rows, "attention-att-scope").meta).toBe("Awaiting coordinator · high · Unverified");
		expect(rowOf(rows, "stream-ws-board").meta).toBe("active · alice · 1/2 · Unverified");
		expect(rowOf(rows, "milestone-m-1").meta).toBe("Milestone · Unverified");
		const text = visible(new Harness(state).open({ initialTab: "overview" }).render(80));
		expect(text).toContain("Unverified");
	});

	describe("citations that cannot be verified", () => {
		function citing(refs: NarratorView["attention"][number]["refs"], asOf: number, posts: SwarmBoardPost[]): string {
			const view: NarratorView = {
				...VIEW,
				as_of_seq: asOf,
				threads: undefined,
				attention: [{ id: "att-cite", kind: "stuck", severity: "med", title: "Cited", refs }],
				workstreams: [],
				milestones: [],
				risks: [],
				reel: undefined,
			};
			const head = Math.max(0, ...posts.map(item => item.seq));
			return rowOf(overviewRows(boardState({ view, posts, head })), "attention-att-cite").meta ?? "";
		}
		const all = [post(1, "coordinator", "One."), post(2, "alice", "Two."), post(3, "bob", "Three.")];

		it("accepts known posts and members at the board's head", () => {
			expect(citing([{ seq: 2 }, { member: "alice" }], 3, all)).toBe("stuck · med");
		});

		it("flags a post that the board lacks", () => {
			expect(citing([{ seq: 9 }], 3, all)).toBe("stuck · med · Unverified");
			expect(citing([{ seq: 2 }], 3, [all[0], all[2]])).toBe("stuck · med · Unverified");
		});

		it("flags a post newer than the view's own as-of", () => {
			expect(citing([{ seq: 3 }], 2, all)).toBe("stuck · med · Unverified");
		});

		it("flags a member the roster lacks", () => {
			expect(citing([{ member: "ghost" }], 3, all)).toBe("stuck · med · Unverified");
		});

		it("flags a citation list when any single citation fails", () => {
			expect(citing([{ seq: 1 }, { member: "alice" }, { seq: 8 }], 3, all)).toBe("stuck · med · Unverified");
		});
	});

	it("keeps an fyi item visible when threads leave it out", () => {
		const harness = new Harness(overviewState());
		const rows = overviewRows(harness.state);

		expect(rows.map(item => item.key)).toContain("attention-att-fyi");
		expect(rowOf(rows, "attention-att-fyi")).toMatchObject({ title: "Docs reorganised", meta: "fyi · low" });
		const overlay = harness.open({ initialTab: "overview" });
		overlay.handleNativeEvent({ type: "select", key: "feed", item: "attention-att-fyi" });
		expect(visible(overlay.render(80))).toContain("Docs reorganised");
		const feed = byKey(overlay.describe(cx), "feed");
		expect((feed.c ?? []).filter(isNode).map(item => item.key)).toContain("attention-att-fyi");
	});

	it("places attention and workstreams under their thread, in the order the thread lists them", () => {
		const keys = overviewRows(overviewState()).map(item => item.key);

		expect(keys).toEqual([
			"goal",
			"as-of",
			"phase",
			"thread-t-board",
			"attention-att-scope",
			"stream-ws-board",
			"attention-att-fyi",
			"milestone-m-1",
			"reel-0",
			"feedback",
		]);
		expect(keys.indexOf("thread-t-board")).toBeLessThan(keys.indexOf("attention-att-scope"));
	});

	it("labels worker-facing asks as waiting on the coordinator", () => {
		const rows = overviewRows(overviewState());

		expect(rowOf(rows, "attention-att-scope")).toMatchObject({
			title: "Decide scope",
			text: "Blocks release",
			meta: "Awaiting coordinator · high",
		});
	});

	it("shows the narrator's per-member status, the wake rule and the member error on the Members tab", () => {
		const bob = member("bob", {
			unread: 2,
			waitSince: 2,
			error: "quota exhausted",
			lastPostSeq: 3,
			lastPostTime: "t",
		});
		const state = overviewState({ members: [COORDINATOR, ALICE, bob] });
		const rows = buildSwarmBoardRows(state, "members", 0);

		expect(rowOf(rows, "member-alice").text).toContain("Drafting the parser");
		expect(rowOf(rows, "member-alice").meta).toBe("worker · 0 unread");
		expect(rowOf(rows, "member-bob")).toMatchObject({ tone: "error", meta: "worker · 2 unread" });
		expect(rowOf(rows, "member-bob").text).toContain("mentions after #2");
		expect(rowOf(rows, "member-bob").text).toContain("Error: quota exhausted");
		expect(rowOf(rows, "member-coordinator").text).toContain("Waiting on review");
	});
});

describe("native", () => {
	it("describes the sheet as one card with tabs, a keyed feed and the footer actions", () => {
		const harness = new Harness();
		const overlay = harness.open();
		const root = overlay.describe(cx);

		expect(overlay.nativeOverlay).toMatchObject({ role: "omp.overlay.swarm", size: "full" });
		expect(root.k).toBe("card");
		expect(prop(root, "role")).toBe("omp.overlay.swarm");
		expect(prop(root, "head")).toBe("Native swarm · #3");
		const tabs = byKey(root, "tabs");
		expect(prop(tabs, "active")).toBe("board");
		expect(prop(tabs, "items")).toEqual([
			{ id: "board", label: "Board" },
			{ id: "members", label: "Members" },
			{ id: "overview", label: "Overview" },
		]);
		const feed = byKey(root, "feed");
		expect(prop(feed, "selected")).toBe("post-3");
		expect((feed.c ?? []).filter(isNode).map(item => item.key)).toEqual(["post-1", "post-2", "post-3"]);
		expect(nodes(root).map(clickAct)).toEqual(expect.arrayContaining(["refresh", "close"]));
	});

	it("switches tabs from the native tab strip and ignores unknown ids", () => {
		const harness = new Harness();
		const overlay = harness.open();

		overlay.handleNativeEvent({ type: "select", key: "tabs", item: "members" });
		expect(overlay.tab).toBe("members");
		expect(prop(byKey(overlay.describe(cx), "tabs"), "active")).toBe("members");
		overlay.handleNativeEvent({ type: "select", key: "body/tabs", item: "overview" });
		expect(overlay.tab).toBe("overview");
		overlay.handleNativeEvent({ type: "select", key: "tabs", item: "elsewhere" });
		expect(overlay.tab).toBe("overview");
	});

	it("selects rows on select and opens them on activate", () => {
		const harness = new Harness();
		const overlay = harness.open();

		overlay.handleNativeEvent({ type: "select", key: "feed", item: "post-1" });
		expect(overlay.selectedKey).toBe("post-1");
		expect(prop(byKey(overlay.describe(cx), "feed"), "selected")).toBe("post-1");
		expect(harness.navigations).toEqual([]);

		overlay.handleNativeEvent({ type: "activate", key: "feed", item: "post-2" });
		expect(overlay.selectedKey).toBe("post-2");
		expect(harness.navigations).toEqual([{ type: "open_conv", target: "alice", label: "alice" }]);

		overlay.handleNativeEvent({ type: "select", key: "feed", item: "post-404" });
		expect(overlay.selectedKey).toBe("post-2");
	});

	it("routes the close and refresh buttons", () => {
		const harness = new Harness();
		const overlay = harness.open();

		overlay.handleNativeEvent(actionEvent("close"));
		overlay.handleNativeEvent(actionEvent("refresh"));
		expect(harness.closes).toBe(1);
		expect(harness.refreshes).toBe(1);
	});

	it("navigates from the action buttons of a board row", () => {
		const harness = new Harness();
		const overlay = harness.open();
		const acts = actsOf(overlay.describe(cx), "post-2");
		expect(acts).toEqual([navigateAct("post-2", { type: "open_conv", target: "alice" })]);

		overlay.handleNativeEvent(actionEvent(acts[0]));
		expect(overlay.selectedKey).toBe("post-2");
		expect(harness.navigations).toEqual([{ type: "open_conv", target: "alice", label: "alice" }]);
	});

	describe("action identity", () => {
		const INSERTED: NarratorView = {
			...VIEW,
			attention: [
				{
					id: "att-new",
					kind: "review",
					severity: "med",
					title: "Review the draft",
					refs: [{ member: "bob" }, { member: "alice" }],
					actions: [{ type: "open_conv", target: "bob", label: "Open bob" }],
				},
				...VIEW.attention,
			],
			threads: [{ ...VIEW.threads![0], attention: ["att-new", "att-scope"] }],
		};

		it("builds the action string from row key, type and target", () => {
			const harness = new Harness(overviewState());
			const root = harness.open({ initialTab: "overview" }).describe(cx);

			expect(actsOf(root, "attention-att-scope")).toEqual([
				navigateAct("attention-att-scope", { type: "open_conv", target: "coordinator" }),
				navigateAct("attention-att-scope", { type: "board_post", target: 2 }),
				navigateAct("attention-att-scope", { type: "open_conv", target: "alice" }),
			]);
			expect(actsOf(root, "attention-att-scope")[1]).toBe("navigate:attention-att-scope:board_post%3A2");
		});

		it("keeps the action strings of existing rows when rows are inserted above them", () => {
			const harness = new Harness(overviewState());
			const overlay = harness.open({ initialTab: "overview" });
			const before = actsOf(overlay.describe(cx), "attention-att-scope");
			const keysBefore = overviewRows(harness.state).map(item => item.key);

			harness.publish(overviewState({ view: INSERTED }));
			const keysAfter = overviewRows(harness.state).map(item => item.key);
			expect(keysAfter.indexOf("attention-att-scope")).toBeGreaterThan(keysBefore.indexOf("attention-att-scope"));
			expect(actsOf(overlay.describe(cx), "attention-att-scope")).toEqual(before);
		});

		it("routes an action string captured before the insertion to the same row and action", () => {
			const harness = new Harness(overviewState());
			const overlay = harness.open({ initialTab: "overview" });
			const [, , toAlice] = actsOf(overlay.describe(cx), "attention-att-scope");

			harness.publish(overviewState({ view: INSERTED }));
			overlay.handleNativeEvent(actionEvent(toAlice));
			expect(overlay.selectedKey).toBe("attention-att-scope");
			expect(harness.navigations).toEqual([{ type: "open_conv", target: "alice", label: "alice" }]);
		});

		it("gives rows that cite the same target different action strings", () => {
			const harness = new Harness(overviewState({ view: INSERTED }));
			const overlay = harness.open({ initialTab: "overview" });
			const root = overlay.describe(cx);
			const fromNew = actsOf(root, "attention-att-new");
			const fromScope = actsOf(root, "attention-att-scope");
			const alice = (rowKey: string) => navigateAct(rowKey, { type: "open_conv", target: "alice" });

			expect(fromNew).toContain(alice("attention-att-new"));
			expect(fromScope).toContain(alice("attention-att-scope"));
			const all = nodes(root)
				.flatMap(candidate => clickAct(candidate) ?? [])
				.filter(act => act.startsWith("navigate:"));
			expect(new Set(all).size).toBe(all.length);

			overlay.handleNativeEvent(actionEvent(alice("attention-att-new")));
			expect(overlay.selectedKey).toBe("attention-att-new");
			overlay.handleNativeEvent(actionEvent(alice("attention-att-scope")));
			expect(overlay.selectedKey).toBe("attention-att-scope");
			expect(harness.navigations).toEqual([
				{ type: "open_conv", target: "alice", label: "alice" },
				{ type: "open_conv", target: "alice", label: "alice" },
			]);
		});

		it("ignores the action string of a row that has since disappeared", () => {
			const harness = new Harness(overviewState());
			const overlay = harness.open({ initialTab: "overview" });
			const [stale] = actsOf(overlay.describe(cx), "attention-att-scope");
			const viewDroppingScope: NarratorView = {
				...VIEW,
				attention: VIEW.attention.slice(1),
				threads: [{ ...VIEW.threads![0], attention: [] }],
			};

			harness.publish(overviewState({ view: viewDroppingScope }));
			const selected = overlay.selectedKey;
			overlay.handleNativeEvent(actionEvent(stale));
			expect(harness.navigations).toEqual([]);
			expect(overlay.selectedKey).toBe(selected);
		});

		it("still routes an action string after the tab round trip", () => {
			const harness = new Harness(overviewState());
			const overlay = harness.open({ initialTab: "overview" });
			const [toCoordinator] = actsOf(overlay.describe(cx), "attention-att-scope");

			overlay.handleInput(TAB);
			expect(overlay.tab).toBe("board");
			overlay.handleInput(TAB);
			expect(overlay.tab).toBe("members");
			overlay.handleInput(TAB);
			expect(overlay.tab).toBe("overview");
			overlay.handleNativeEvent(actionEvent(toCoordinator));
			expect(harness.navigations).toEqual([{ type: "open_conv", target: "coordinator", label: "Open coordinator" }]);
		});
	});

	describe("idle identity", () => {
		it("returns the same description object until something changes", () => {
			const harness = new Harness();
			const overlay = harness.open();
			const first = overlay.describe(cx);

			expect(overlay.describe(cx)).toBe(first);
			expect(overlay.describe({ ...cx, reduceMotion: true })).toBe(first);
			overlay.render(80);
			expect(overlay.describe(cx)).toBe(first);
		});

		it("keeps the description across motion frames", () => {
			setMotionEffects(true);
			const harness = new Harness();
			const overlay = harness.open();
			const first = overlay.describe(cx);

			vi.advanceTimersByTime(10_000);
			expect(overlay.describe(cx)).toBe(first);
		});

		it("describes anew after a selection, a tab change, a source update or an invalidation", () => {
			const harness = new Harness();
			const overlay = harness.open();
			let last = overlay.describe(cx);
			const changed = () => {
				const next = overlay.describe(cx);
				expect(next).not.toBe(last);
				expect(overlay.describe(cx)).toBe(next);
				last = next;
			};

			overlay.handleInput("k");
			changed();
			overlay.handleInput(TAB);
			changed();
			harness.publish({ ...harness.state, title: "Renamed swarm" });
			changed();
			overlay.invalidate();
			changed();
			overlay.handleNativeEvent({ type: "select", key: "tabs", item: "board" });
			changed();
		});
	});
});

describe("text hygiene", () => {
	const OSC_LINK = "\x1b]8;;http://evil.example\x07link\x1b]8;;\x07";
	const HOSTILE_TEXT = `hello ${OSC_LINK} \x1b[2Jclear\x00\x08 end`;
	const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
	const INJECTED = /\x1b\]|\x1b\[2J|[\x00\x07\x08\x7f]/;

	function hostileState(): SwarmBoardState {
		const view: NarratorView = {
			...VIEW,
			goal: { title: "Goal\x1b[2J", line: "Line\x07 here" },
			now: { alice: "Typing\x1b[2J fast" },
			attention: [
				{
					id: "att-scope",
					kind: "decision",
					severity: "high",
					title: "Decide\x1b]0;owned\x07 scope",
					refs: [{ seq: 2 }],
					actions: [{ type: "open_conv", target: "coordinator", label: "Open\x1b[2J coordinator" }],
				},
			],
			threads: undefined,
		};
		return boardState({
			title: "Swarm\x1b[2J\x07 title",
			members: [
				COORDINATOR,
				member("alice", { state: "working", error: "quota\x1b[2J\x07 hit", model: "m\x00odel" }),
			],
			posts: [post(1, "coordinator", HOSTILE_TEXT, "ch\x1b[2Jan"), post(2, "alice", "Plain.")],
			head: 2,
			view,
			viewError: "bad\x1b[2J view\x07",
			planError: "bad\x00 plan",
		});
	}

	it("strips escapes and control characters from every projected row", () => {
		for (const tab of TABS) {
			for (const item of buildSwarmBoardRows(hostileState(), tab, 0)) {
				for (const value of [item.title, item.text, item.meta]) {
					if (value !== undefined) expect(CONTROL.test(value)).toBe(false);
				}
			}
		}
	});

	it("keeps the visible words of a hostile post", () => {
		const post1 = buildSwarmBoardRows(hostileState(), "board", 0).find(item => item.key === "post-1");

		expect(post1?.text).toBe("hello link clear end");
		expect(post1?.meta).toBe("chan · 2026-10-06T04:11:00Z");
	});

	it("renders only clean text in every tab and size", () => {
		for (const tab of TABS) {
			for (const [columns, rows] of [
				[80, 24],
				[80, 60],
				[20, 8],
				[7, 24],
			] as const) {
				const harness = new Harness(hostileState());
				harness.terminal.rows = rows;
				const lines = harness.open({ initialTab: tab }).render(columns);
				for (const line of lines) expect(INJECTED.test(line)).toBe(false);
			}
		}
	});

	it("renders the cleaned words", () => {
		const harness = new Harness(hostileState());
		harness.terminal.rows = 60;
		const board = harness.open();
		const text = visible(board.render(80));

		expect(text).toContain("hello link clear end");
		expect(text).toContain("Swarm title");
		const overview = visible(harness.open({ initialTab: "overview" }).render(80));
		expect(overview).toContain("Overview update rejected");
		expect(overview).toContain("bad view");
		expect(overview).toContain("Decide scope");
		expect(overview).toContain("Open coordinator");
	});

	it("describes only clean strings", () => {
		for (const tab of TABS) {
			const harness = new Harness(hostileState());
			const json = JSON.stringify(harness.open({ initialTab: tab }).describe(cx));

			expect(json).not.toMatch(/\\u001b|\\u0007|\\u0000|\\u0008|\\u007f/i);
		}
	});
});

describe("motion", () => {
	it("runs six finite frames after opening and then stops", () => {
		setMotionEffects(true);
		const harness = new Harness();
		const baseline = vi.getTimerCount();
		const overlay = harness.open();
		expect(vi.getTimerCount()).toBe(baseline + 1);
		const entering = visible(overlay.render(80));

		vi.advanceTimersByTime(29);
		expect(harness.renders).toBe(0);
		vi.advanceTimersByTime(1);
		expect(harness.renders).toBe(1);
		for (let frame = 0; frame < 5; frame++) vi.advanceTimersByTime(30);
		expect(harness.renders).toBe(6);
		expect(vi.getTimerCount()).toBe(baseline);

		vi.advanceTimersByTime(10_000);
		expect(harness.renders).toBe(6);
		const settled = visible(overlay.render(80));
		expect(settled).not.toBe(entering);
		expect(visible(overlay.render(80))).toBe(settled);
	});

	it("restarts the finite entrance on a source update", () => {
		setMotionEffects(true);
		const harness = new Harness();
		const baseline = vi.getTimerCount();
		harness.open();
		for (let frame = 0; frame < 6; frame++) vi.advanceTimersByTime(30);
		expect(vi.getTimerCount()).toBe(baseline);
		const rendered = harness.renders;

		harness.publish(withPost(harness.state, post(4, "alice", "More.")));
		expect(harness.renders).toBe(rendered + 1);
		expect(vi.getTimerCount()).toBe(baseline + 1);
		for (let frame = 0; frame < 6; frame++) vi.advanceTimersByTime(30);
		expect(harness.renders).toBe(rendered + 7);
		expect(vi.getTimerCount()).toBe(baseline);
	});

	it("keeps the timer count at zero with motion effects off", () => {
		setMotionEffects(false);
		const harness = new Harness();
		const baseline = vi.getTimerCount();
		const overlay = harness.open();
		expect(vi.getTimerCount()).toBe(baseline);

		overlay.handleInput(TAB);
		harness.publish(withPost(harness.state, post(4, "alice", "More.")));
		expect(vi.getTimerCount()).toBe(baseline);
		const requested = harness.renders;
		vi.advanceTimersByTime(10_000);
		expect(harness.renders).toBe(requested);
	});

	it("renders the same frame every time with motion effects off", () => {
		const harness = new Harness();
		const overlay = harness.open();
		const first = overlay.render(80);

		expect(overlay.render(80)).toEqual(first);
		vi.advanceTimersByTime(1000);
		expect(overlay.render(80)).toEqual(first);
	});

	it("ends the entrance at its next frame when motion effects turn off", () => {
		setMotionEffects(true);
		const harness = new Harness();
		const baseline = vi.getTimerCount();
		harness.open();

		setMotionEffects(false);
		vi.advanceTimersByTime(30);
		expect(harness.renders).toBe(1);
		expect(vi.getTimerCount()).toBe(baseline);
		vi.advanceTimersByTime(10_000);
		expect(harness.renders).toBe(1);
	});

	it("leaves the animation to the terminal while a native surface renders", () => {
		setMotionEffects(true);
		setNativeRendering(true);
		const harness = new Harness();
		const baseline = vi.getTimerCount();
		const overlay = harness.open();

		expect(vi.getTimerCount()).toBe(baseline);
		harness.publish(withPost(harness.state, post(4, "alice", "More.")));
		expect(vi.getTimerCount()).toBe(baseline);
		expect(overlay.describe(cx).k).toBe("card");
	});
});

describe("dispose", () => {
	it("unsubscribes once, clears the timer and ignores late source events", () => {
		setMotionEffects(true);
		const harness = new Harness();
		const baseline = vi.getTimerCount();
		const overlay = harness.open();
		const [listener] = [...harness.listeners];
		expect(vi.getTimerCount()).toBe(baseline + 1);
		const reads = harness.reads;
		const requested = harness.renders;

		overlay.dispose();
		expect(harness.unsubscribed).toBe(1);
		expect(harness.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(baseline);

		listener();
		vi.advanceTimersByTime(10_000);
		expect(harness.reads).toBe(reads);
		expect(harness.renders).toBe(requested);

		overlay.dispose();
		expect(harness.unsubscribed).toBe(1);
	});

	it("stops a source update from reaching a disposed sheet while others keep listening", () => {
		const harness = new Harness();
		const gone = harness.open();
		const kept = harness.open();

		gone.dispose();
		harness.publish(withPost(harness.state, post(4, "alice", "After dispose.")));
		expect(kept.selectedKey).toBe("post-4");
		expect(gone.selectedKey).toBe("post-3");
		expect(harness.renders).toBe(1);
	});
});

describe("custom narrator page entry", () => {
	it("opens the page only from Overview with an available revision", () => {
		const requested = vi.fn();
		const h = new Harness(overviewState({ customPageRevision: "page-v1" }));
		const overlay = h.open({ onCustomPage: requested });
		overlay.handleInput("o");
		expect(requested).toHaveBeenCalledTimes(0);
		overlay.showTab("overview");
		expect(visible(overlay.render(80))).toContain("o Page");
		overlay.handleInput("o");
		overlay.handleNativeEvent({ type: "action", key: "custom-page", act: "custom-page", mods: [] });
		expect(requested).toHaveBeenCalledTimes(2);
		expect(nodes(overlay.describe(cx)).some(item => clickAct(item) === "custom-page")).toBe(true);
		h.publish(overviewState({ customPageError: "view.html is empty" }));
		expect(visible(overlay.render(80))).toContain("Custom page update rejected");
		expect(visible(overlay.render(80))).not.toContain("o Page");
		overlay.handleInput("o");
		expect(requested).toHaveBeenCalledTimes(2);
		expect(nodes(overlay.describe(cx)).some(item => clickAct(item) === "custom-page")).toBe(false);
	});
});
