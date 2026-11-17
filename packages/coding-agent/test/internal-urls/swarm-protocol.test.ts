/**
 * swarm:// is the read-only window onto shared-board swarms. Boards come from real directories: persisted ones render
 * read-only from disk, boards a runtime holds open render live, and a board that cannot be read never hides the others.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter, type ResolveContext, SwarmProtocolHandler } from "../../src/internal-urls";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import type { SchemeHost } from "../../src/internal-urls/types";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { sessionDirForCwd } from "../../src/session/session-paths";
import { BoardStore } from "../../src/swarm/board-store";
import { SwarmRuntime } from "../../src/swarm/runtime";
import {
	findSwarmSurface,
	formatSwarmUrl,
	getSwarmSurface,
	listSwarmSurfaces,
	parseSwarmUrl,
	renderSwarmSnapshot,
	savedBoardDirectories,
	type SwarmUrlTarget,
	writeSwarmSnapshotFile,
} from "../../src/swarm/surface";
import { SwarmRefusal } from "../../src/swarm/types";
import type { ToolSession } from "../../src/tools";
import {
	addWorker,
	BOARD_FILES,
	type BoardFixture,
	createBoardFixture,
	makeMember,
	rawPost,
	SWARM_CAPABILITIES,
	seedSwarm,
	writeBoardPosts,
} from "../swarm/fixtures";
import { parseRoster } from "../swarm/tool-fixture";

const temporaryDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
let originalAgentDir: string;

// Saved sessions are discovered under the agent directory's sessions root; every test sees an empty, private one.
beforeEach(() => {
	originalAgentDir = getAgentDir();
	const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-agent-"));
	temporaryDirs.push(agentRoot);
	setAgentDir(path.join(agentRoot, "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	InternalUrlRouter.resetForTests();
	SwarmRuntime.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	for (const dir of temporaryDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
});

const router = (): InternalUrlRouter => InternalUrlRouter.instance();

function temporaryDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-surface-"));
	temporaryDirs.push(dir);
	return dir;
}

function toolSession(artifactsDir: string): ToolSession {
	return {
		cwd: artifactsDir,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
	};
}

/** A caller whose artifacts directory is `artifactsDir`; its `swarm` child is the preferred board. */
function context(artifactsDir: string): ResolveContext {
	return { cwd: artifactsDir, session: toolSession(artifactsDir) };
}

async function read(url: string, artifactsDir: string): Promise<string> {
	return (await router().resolve(url, context(artifactsDir))).content;
}

/** A persisted board in `<root>/swarm` with the standard cast, a coordinator post to alice and alice's report. */
function seededFixture(): BoardFixture {
	const fixture = createBoardFixture();
	seedSwarm(fixture.store);
	fixture.store.append("coordinator", "@alice take the lexer\n# not a heading\n\n  keep this indent");
	fixture.store.append("alice", "@coordinator [done] lexer ready");
	fixture.store.read("alice");
	return fixture;
}

/** A board with another id in its own directory. */
function createOtherBoard(id: string, title: string): { root: string; dir: string; store: BoardStore } {
	const root = temporaryDir();
	const dir = path.join(root, "swarm");
	const store = BoardStore.create(dir, {
		id,
		title,
		coordinator: makeMember(`${id}-coordinator`, { role: "coordinator", wakeMode: null }),
		capabilities: SWARM_CAPABILITIES,
	});
	return { root, dir, store };
}

function fileBytes(fixture: BoardFixture): Record<string, string> {
	return Object.fromEntries(BOARD_FILES.map(name => [name, fixture.bytes(name).toString("base64")]));
}

/** The error an action throws; fails the test when it does not throw. */
function failureOf(action: () => unknown): Error {
	try {
		action();
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected the action to throw");
}

function headings(text: string): string[] {
	return text.match(/^### #\d+ .*$/gm) ?? [];
}

function createRuntime(registry = new AgentRegistry()): SwarmRuntime {
	const lifecycle = new AgentLifecycleManager(registry);
	const runtime = new SwarmRuntime(registry, lifecycle);
	cleanups.push(async () => {
		runtime.dispose();
		await lifecycle.dispose();
	});
	return runtime;
}

function createLiveBoard(runtime: SwarmRuntime, root: string, id: string, title: string): BoardStore {
	return runtime.create(path.join(root, "swarm"), {
		id,
		title,
		coordinator: makeMember("Main", { role: "coordinator", wakeMode: null }),
		capabilities: SWARM_CAPABILITIES,
	});
}

describe("swarm:// registration", () => {
	it("registers a linkable, read-only, virtual scheme with line selectors", () => {
		const spec = router().spec("swarm");
		expect(spec).toMatchObject({
			backing: "virtual",
			selectors: "lines",
			immutable: false,
			linkable: true,
			readTier: "read",
		});
		expect(spec?.write).toBeUndefined();
		expect(router().isBuiltin("swarm")).toBe(true);
		expect(router().canHandle("swarm://")).toBe(true);
		expect(router().canHandle("swarm://test-swarm?tab=members&since=2")).toBe(true);
		expect(router().readTier("read swarm://test-swarm")).toBe("read");
		expect(router().writeTier("swarm://test-swarm", "text", undefined)).toMatchObject({ policy: "deny" });
		expect(router().fileWritable("swarm://test-swarm")).toBe(false);
	});

	it("advertises itself in the system prompt with its URL forms and the #seq convention", () => {
		const host: SchemeHost = {
			skillUriAccess: false,
			ruleCount: 0,
			securityEnabled: false,
			settingsApproval: false,
			outReplies: false,
			subagent: false,
		};
		const lines = router()
			.describe(host)
			.filter(line => line.startsWith("swarm://"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("swarm://<id>");
		expect(lines[0]).toContain("#seq");
		expect(lines[0]).toContain("swarm_read");
		expect(new SwarmProtocolHandler().promptDoc()).toBe(lines[0]);
	});
});

describe("parseSwarmUrl and formatSwarmUrl", () => {
	const accepted: Array<[string, SwarmUrlTarget]> = [
		["swarm://", { tab: "board", since: 0 }],
		["swarm:///", { tab: "board", since: 0 }],
		["swarm://test-swarm", { id: "test-swarm", tab: "board", since: 0 }],
		["swarm://test-swarm/", { id: "test-swarm", tab: "board", since: 0 }],
		["SWARM://test-swarm", { id: "test-swarm", tab: "board", since: 0 }],
		["swarm://test-swarm?tab=members", { id: "test-swarm", tab: "members", since: 0 }],
		["swarm://test-swarm?tab=overview&since=12", { id: "test-swarm", tab: "overview", since: 12 }],
		["swarm://test-swarm?since=7&tab=board", { id: "test-swarm", tab: "board", since: 7 }],
		["swarm://test-swarm?tab=graph", { id: "test-swarm", tab: "board", since: 0 }],
		["swarm://test-swarm?since=0", { id: "test-swarm", tab: "board", since: 0 }],
		["swarm://test-swarm#top", { id: "test-swarm", tab: "board", since: 0 }],
		["swarm://?tab=members", { tab: "members", since: 0 }],
	];

	it.each(accepted)("parses %s", (href, expected) => {
		expect(parseSwarmUrl(href)).toEqual(expected);
	});

	const refused: Array<[string, RegExp]> = [
		["http://test-swarm", /Not a swarm:\/\/ URL/],
		["swarm:test-swarm", /Not a swarm:\/\/ URL/],
		["swarm://test-swarm/extra", /remove the path "\/extra"/],
		["swarm://test-swarm/../other", /remove the path/],
		["swarm://test-swarm/..%2F..", /remove the path/],
		["swarm:///test-swarm", /remove the path/],
		["swarm://..", /not a swarm id/],
		["swarm://../test-swarm", /remove the path|not a swarm id/],
		["swarm://a%2Fb", /not a swarm id/],
		["swarm://a%2e%2e", /not a swarm id/],
		["swarm://TEST-SWARM", /not a swarm id/],
		["swarm://-test", /not a swarm id/],
		["swarm://1test", /not a swarm id/],
		["swarm://test_swarm", /not a swarm id/],
		["swarm://test swarm", /not a swarm id/],
		["swarm://test-swarm:5", /not a swarm id/],
		[`swarm://${"a".repeat(41)}`, /not a swarm id/],
		["swarm://test-swarm?tab=nope", /Unknown swarm tab "nope"/],
		["swarm://test-swarm?tab=", /Unknown swarm tab ""/],
		["swarm://test-swarm?tab=Board", /Unknown swarm tab "Board"/],
		["swarm://test-swarm?tab=board&tab=members", /"tab" appears more than once/],
		["swarm://test-swarm?since=1&since=2", /"since" appears more than once/],
		["swarm://test-swarm?since=-1", /nonnegative integer/],
		["swarm://test-swarm?since=1.5", /nonnegative integer/],
		["swarm://test-swarm?since=abc", /nonnegative integer/],
		["swarm://test-swarm?since=", /nonnegative integer/],
		[`swarm://test-swarm?since=${"9".repeat(400)}`, /nonnegative integer/],
		[`swarm://test-swarm?since=${Number.MAX_SAFE_INTEGER + 1}`, /nonnegative integer/],
		["swarm://test-swarm?limit=5", /Unsupported swarm:\/\/ query parameter "limit"/],
		["swarm://test-swarm?tab=board&x=1", /Unsupported swarm:\/\/ query parameter "x"/],
	];

	it.each(refused)("refuses %s", (href, reason) => {
		expect(() => parseSwarmUrl(href)).toThrow(SwarmRefusal);
		expect(() => parseSwarmUrl(href)).toThrow(reason);
	});

	it("accepts the largest safe since and formats canonical links without defaults", () => {
		expect(parseSwarmUrl(`swarm://x?since=${Number.MAX_SAFE_INTEGER}`).since).toBe(Number.MAX_SAFE_INTEGER);
		expect(formatSwarmUrl({})).toBe("swarm://");
		expect(formatSwarmUrl({ id: "x" })).toBe("swarm://x");
		expect(formatSwarmUrl({ id: "x", tab: "board", since: 0 })).toBe("swarm://x");
		expect(formatSwarmUrl({ id: "x", tab: "members" })).toBe("swarm://x?tab=members");
		expect(formatSwarmUrl({ id: "x", tab: "overview", since: 4 })).toBe("swarm://x?tab=overview&since=4");
		expect(formatSwarmUrl({ id: "x", since: 4 })).toBe("swarm://x?since=4");
	});
});

describe("persisted boards", () => {
	it("renders title, head, roster, channels and a #seq feed from the board directory", async () => {
		using fx = seededFixture();
		const text = await read("swarm://test-swarm", fx.root);

		expect(text).toContain("# Swarm Test swarm (test-swarm)");
		expect(text).toContain("Board: swarm://test-swarm");
		expect(text).toContain("Head: #2");
		expect(text).toContain("Capabilities: channels, narrator, monitor");
		expect(text).toContain("Access: read-only copy of the persisted board");

		const roster = parseRoster(text);
		expect(roster.map(row => row.Member)).toEqual(["coordinator", "alice", "bob", "carol", "narrator", "monitor"]);
		expect(roster.map(row => row.Role)).toEqual(["coordinator", "worker", "worker", "worker", "narrator", "monitor"]);
		expect(roster.map(row => row.State)).toEqual(Array(6).fill("stopped"));
		expect(roster.map(row => row.Wake)).toEqual(Array(6).fill("—"));
		expect(roster.map(row => row.Read)).toEqual(["#0", "#2", "#0", "#0", "#0", "#0"]);
		expect(roster.map(row => row.Unread)).toEqual(["2", "0", "1", "1", "2", "2"]);
		expect(roster.map(row => row.Channels)).toEqual(["main", "parser", "ui", "main", "main", "main"]);
		expect(roster[0]["Last post"]).toMatch(/^#1 \d{4}-\d\d-\d\dT/);
		expect(roster[1]["Last post"]).toMatch(/^#2 \d{4}-\d\d-\d\dT/);
		expect(roster[3]["Last post"]).toBe("—");
		expect(roster[1].Model).toBe("test/model");

		expect(text).toContain("## Channels");
		expect(text).toContain("- #parser · lexer and parser · subscribers: alice");
		expect(text).toContain("- #ui · interface · subscribers: bob");

		expect(headings(text)).toHaveLength(2);
		expect(text).toMatch(/^### #1 coordinator · \S+ → @alice$/m);
		expect(text).toMatch(/^### #2 alice · \S+ · #parser → @coordinator$/m);
		expect(text).toContain("Posts #1–#2 of 2, in sequence order.");
	});

	it("quotes post text line by line so its own markup cannot restructure the document", async () => {
		using fx = seededFixture();
		const text = await read("swarm://test-swarm", fx.root);
		expect(text).toContain("> @alice take the lexer\n> # not a heading\n>\n>   keep this indent");
		expect(headings(text)).toHaveLength(2);
	});

	it("reports members as stopped, or killed, and leaves the stored members and wake fields unchanged", () => {
		using fx = seededFixture();
		addWorker(fx.store, "gone", { killed: true });
		const before = fileBytes(fx);

		const surface = getSwarmSurface("test-swarm", { artifactsDir: fx.root });

		expect(surface.board.readOnly).toBe(true);
		expect(surface.snapshot).toMatchObject({
			id: "test-swarm",
			title: "Test swarm",
			head: 2,
			boardUri: "swarm://test-swarm",
		});
		const states = Object.fromEntries(surface.snapshot.members.map(member => [member.name, member.state]));
		expect(states).toEqual({
			coordinator: "stopped",
			alice: "stopped",
			bob: "stopped",
			carol: "stopped",
			narrator: "stopped",
			monitor: "stopped",
			gone: "killed",
		});
		expect(surface.snapshot.members.every(member => member.wakeMode === null && member.waitSince === null)).toBe(
			true,
		);
		expect(surface.snapshot.members.find(member => member.name === "alice")).toMatchObject({
			lastReadSeq: 2,
			unread: 0,
		});
		// The directory still records what the last run left behind.
		expect(BoardStore.open(fx.dir, { readOnly: true }).member("bob").wakeMode).toBe("mentions");
		expect(BoardStore.open(fx.dir, { readOnly: true }).member("narrator").wakeMode).toBe("any");
		expect(fileBytes(fx)).toEqual(before);
	});

	it("shows a post appended after an earlier read on the next read", async () => {
		using fx = seededFixture();
		const first = await read("swarm://test-swarm", fx.root);
		expect(first).not.toContain("A second report");

		fx.store.append("alice", "@coordinator A second report");
		const second = await read("swarm://test-swarm", fx.root);

		expect(second).toContain("Head: #3");
		expect(second).toContain("> @coordinator A second report");
		expect(headings(second)).toHaveLength(3);
		expect(parseRoster(second)[1]["Last post"]).toMatch(/^#3 /);
	});

	it("reads a restored board whose last line was cut off, without repairing the file", async () => {
		using fx = seededFixture();
		fs.appendFileSync(fx.file("board.jsonl"), '{"seq":3,"agent":"coordinator","text":"cut o');
		const before = fileBytes(fx);

		const text = await read("swarm://test-swarm", fx.root);

		expect(text).toContain("Head: #2");
		expect(headings(text)).toHaveLength(2);
		expect(text).not.toContain("cut o");
		expect(fileBytes(fx)).toEqual(before);
	});

	it("starts the feed after `since` and says so when nothing follows", async () => {
		using fx = seededFixture();
		const afterFirst = await read("swarm://test-swarm?since=1", fx.root);
		expect(headings(afterFirst)).toHaveLength(1);
		expect(afterFirst).toMatch(/^### #2 alice/m);
		expect(afterFirst).not.toContain("take the lexer");
		expect(afterFirst).toContain("Posts #2–#2 of 2");

		const beyond = await read("swarm://test-swarm?since=2", fx.root);
		expect(headings(beyond)).toEqual([]);
		expect(beyond).toContain("No posts after #2; the board head is #2.");
		// The roster is part of every snapshot, whatever the feed shows.
		expect(parseRoster(beyond)).toHaveLength(6);

		const none = await read("swarm://test-swarm?since=99", fx.root);
		expect(none).toContain("No posts after #99; the board head is #2.");
	});

	it("pages the feed 200 posts at a time and links the next page and the latest posts", async () => {
		using fx = createBoardFixture();
		writeBoardPosts(
			fx.dir,
			Array.from({ length: 205 }, (_, index) => rawPost(index + 1, "coordinator", `Post ${index + 1}`)),
		);

		const first = await read("swarm://test-swarm", fx.root);
		expect(headings(first)).toHaveLength(200);
		expect(first).toContain("Posts #1–#200 of 205, in sequence order.");
		expect(first).toContain("Next page: swarm://test-swarm?since=200. Latest posts: swarm://test-swarm?since=5.");
		expect(first).toMatch(/^### #200 coordinator/m);
		expect(first).not.toMatch(/^### #201 /m);

		const last = await read("swarm://test-swarm?since=200", fx.root);
		expect(headings(last)).toHaveLength(5);
		expect(last).toContain("Posts #201–#205 of 205");
		expect(last).not.toContain("Next page:");

		const middle = await read("swarm://test-swarm?since=2", fx.root);
		expect(headings(middle)).toHaveLength(200);
		expect(middle).toContain("Posts #3–#202 of 205");
		expect(middle).toContain("Next page: swarm://test-swarm?since=202.");
	});

	it("renders the same document for tab=graph as for the board tab and reports the canonical URL", async () => {
		using fx = seededFixture();
		const board = await router().resolve("swarm://test-swarm", context(fx.root));
		const graph = await router().resolve("swarm://test-swarm?tab=graph", context(fx.root));
		expect(graph.content).toBe(board.content);
		expect(graph.url).toBe("swarm://test-swarm");
		expect(graph.contentType).toBe("text/markdown");
		expect(graph.size).toBe(Buffer.byteLength(graph.content, "utf8"));

		const members = await router().resolve("swarm://test-swarm?tab=members&since=1", context(fx.root));
		expect(members.url).toBe("swarm://test-swarm?tab=members&since=1");
		expect(members.content).toContain("# Swarm Test swarm (test-swarm)");
	});
});

describe("the board index", () => {
	it("lists every readable board with its live or read-only access and member states", async () => {
		using first = seededFixture();
		addWorker(first.store, "gone", { killed: true });
		const second = createOtherBoard("second-swarm", "Second");
		registerArtifactsDir(second.root);

		const text = await read("swarm://", first.root);

		expect(text).toContain("# Swarm boards");
		expect(text).toMatch(/\| swarm:\/\/test-swarm \| Test swarm \| #2 \| 6 stopped, 1 killed \| read-only \|/);
		expect(text).toMatch(/\| swarm:\/\/second-swarm \| Second \| #0 \| 1 stopped \| read-only \|/);
		const rows = text.split("\n").filter(line => line.startsWith("| swarm://"));
		expect(rows.map(row => row.split(" | ")[0])).toEqual(["| swarm://test-swarm", "| swarm://second-swarm"]);
	});

	it("says how a board appears when none exists, and creates nothing", async () => {
		const root = temporaryDir();
		const text = await read("swarm://", root);
		expect(text).toContain("# Swarm boards");
		expect(text).toContain("A board appears here once a coordinator session creates its team");
		expect(text).not.toContain("|");
		expect(fs.readdirSync(root)).toEqual([]);
	});
});

describe("discovery", () => {
	it("prefers the artifacts directory's board over explicit directories and the registry, deduplicating by directory", () => {
		using a = createBoardFixture();
		using b = createBoardFixture();
		a.store.setTitle("Board A");
		b.store.setTitle("Board B");
		registerArtifactsDir(b.root);

		expect(getSwarmSurface("test-swarm", { artifactsDir: a.root, directories: [b.dir] }).snapshot.title).toBe(
			"Board A",
		);
		expect(getSwarmSurface("test-swarm", { artifactsDir: b.root, directories: [a.dir] }).snapshot.title).toBe(
			"Board B",
		);
		expect(getSwarmSurface("test-swarm", { directories: [b.dir, a.dir] }).snapshot.title).toBe("Board B");

		const listed = listSwarmSurfaces({
			artifactsDir: a.root,
			directories: [a.dir, b.dir, path.join(a.dir, "."), path.join(b.root, "swarm", "..", "swarm")],
		});
		expect(listed.map(surface => surface.snapshot.title)).toEqual(["Board A", "Board B"]);
		// With nothing configured, the agent registry's artifacts directories still lead to boards.
		expect(listSwarmSurfaces().map(surface => surface.snapshot.title)).toEqual(["Board B"]);
	});

	it("finds boards through registered agent sessions' artifacts directories", () => {
		using fx = createBoardFixture();
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: `${fx.root}.jsonl`,
			status: "idle",
		});
		// A session file `<root>.jsonl` owns the artifacts directory `<root>`.
		expect(listSwarmSurfaces().map(surface => surface.snapshot.id)).toEqual(["test-swarm"]);
	});

	it("counts only directories that already hold a board and creates nothing", () => {
		const root = temporaryDir();
		fs.mkdirSync(path.join(root, "swarm"));
		const missing = path.join(root, "missing");
		const before = fs.readdirSync(root).sort();

		expect(listSwarmSurfaces({ artifactsDir: root, directories: [missing, path.join(root, "swarm")] })).toEqual([]);
		expect(findSwarmSurface("test-swarm", { artifactsDir: missing })).toBeUndefined();

		expect(fs.readdirSync(root).sort()).toEqual(before);
		expect(fs.existsSync(missing)).toBe(false);
		expect(fs.readdirSync(path.join(root, "swarm"))).toEqual([]);
	});

	it("keeps readable boards visible when another board cannot be read, and reports the broken one on get", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		using good = seededFixture();
		const broken = createOtherBoard("broken-swarm", "Broken");
		fs.writeFileSync(path.join(broken.dir, "members.json"), "{not json");
		const options = { directories: [broken.dir, good.dir] };

		expect(listSwarmSurfaces(options).map(surface => surface.snapshot.id)).toEqual(["test-swarm"]);
		expect(warn).toHaveBeenCalledWith("Swarm board skipped", expect.objectContaining({ dir: expect.any(String) }));

		const unreadable = failureOf(() => getSwarmSurface("broken-swarm", options));
		expect(unreadable).not.toBeInstanceOf(SwarmRefusal);
		expect(unreadable.message).toContain("is unreadable");
		expect(unreadable.message).toContain(path.basename(broken.root));
		expect(unreadable.cause).toBeInstanceOf(Error);
		expect(getSwarmSurface("test-swarm", options).snapshot.id).toBe("test-swarm");

		registerArtifactsDir(broken.root);
		registerArtifactsDir(good.root);
		const viaRouter = router().resolve("swarm://broken-swarm", context(temporaryDir()));
		await expect(viaRouter).rejects.toBeInstanceOf(ToolError);
		await expect(viaRouter).rejects.toThrow(/is unreadable/);
		expect(await read("swarm://test-swarm", temporaryDir())).toContain("# Swarm Test swarm");
	});

	it("names unidentifiable board directories when an unknown id is requested", () => {
		using good = seededFixture();
		const broken = createOtherBoard("broken-swarm", "Broken");
		fs.writeFileSync(path.join(broken.dir, "swarm.json"), "{not json");

		const unknown = failureOf(() => getSwarmSurface("nothing-here", { directories: [broken.dir, good.dir] }));
		expect(unknown).toBeInstanceOf(SwarmRefusal);
		expect(unknown.message).toContain("Unknown swarm: nothing-here. Known swarms: test-swarm");
		expect(unknown.message).toContain("unreadable board directories:");
		expect(() => getSwarmSurface("Bad Id")).toThrow(SwarmRefusal);
		expect(() => findSwarmSurface("Bad Id")).toThrow(SwarmRefusal);
		expect(findSwarmSurface("nothing-here", { directories: [good.dir] })).toBeUndefined();
	});
});

describe("live boards", () => {
	it("uses the runtime's store and snapshot for a board it holds open, and disk state for the same board elsewhere", () => {
		const root = temporaryDir();
		const registry = new AgentRegistry();
		const runtime = createRuntime(registry);
		const board = createLiveBoard(runtime, root, "live-swarm", "Live swarm");
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
			status: "running",
		});
		runtime.append("live-swarm", "coordinator", "First live post");

		const live = getSwarmSurface("live-swarm", { artifactsDir: root, runtime });
		expect(live.board).toBe(board);
		expect(live.board.readOnly).toBe(false);
		expect(live.snapshot.members[0]).toMatchObject({ name: "coordinator", state: "stopped" });
		const liveText = renderSwarmSnapshot(live);
		expect(liveText).toContain("Access: live board owned by this process.");
		expect(parseRoster(liveText)[0].State).toBe("stopped");

		const persisted = getSwarmSurface("live-swarm", { artifactsDir: root, runtime: createRuntime() });
		expect(persisted.board).not.toBe(board);
		expect(persisted.board.readOnly).toBe(true);
		expect(persisted.snapshot.members[0]).toMatchObject({ name: "coordinator", state: "stopped" });
		expect(renderSwarmSnapshot(persisted)).toContain("Access: read-only copy");
	});

	it("shows the second post as soon as the runtime appends it", async () => {
		const root = temporaryDir();
		const runtime = SwarmRuntime.local();
		createLiveBoard(runtime, root, "live-swarm", "Live swarm");
		runtime.append("live-swarm", "coordinator", "First live post");

		const first = await read("swarm://live-swarm", root);
		expect(first).toContain("Access: live board");
		expect(first).toContain("> First live post");
		expect(headings(first)).toHaveLength(1);

		runtime.append("live-swarm", "coordinator", "Second live post");
		const second = await read("swarm://live-swarm", root);
		expect(second).toContain("Head: #2");
		expect(second).toContain("> Second live post");
		expect(headings(second)).toHaveLength(2);
		expect(headings(await read("swarm://live-swarm?since=1", root))).toHaveLength(1);
	});

	it("lists runtime boards that are outside the caller's artifacts directory", async () => {
		const runtime = SwarmRuntime.local();
		createLiveBoard(runtime, temporaryDir(), "elsewhere-swarm", "Elsewhere");
		const text = await read("swarm://", temporaryDir());
		expect(text).toMatch(/\| swarm:\/\/elsewhere-swarm \| Elsewhere \| #0 \| 1 stopped \| live \|/);
	});
});

describe("locate", () => {
	it("regenerates board.snapshot.md atomically beside the board and leaves its records untouched", async () => {
		using fx = seededFixture();
		const before = fileBytes(fx);
		const expected = path.join(fs.realpathSync.native(fx.dir), "board.snapshot.md");

		const located = await router().locate("swarm://test-swarm", context(fx.root));

		expect(located).toBe(expected);
		expect(fs.readFileSync(expected, "utf8")).toBe(await read("swarm://test-swarm", fx.root));
		expect(fx.listFiles()).toEqual([...BOARD_FILES, "board.snapshot.md"].sort());
		expect(fileBytes(fx)).toEqual(before);

		fx.store.append("alice", "@coordinator Fresh news");
		const again = await router().locate("swarm://test-swarm", context(fx.root));
		expect(again).toBe(expected);
		expect(fs.readFileSync(expected, "utf8")).toContain("> @coordinator Fresh news");
		expect(fx.listFiles().some(name => name.endsWith(".tmp"))).toBe(false);
	});

	it("writes the snapshot for the URL's since and rewrites only when the content changed", async () => {
		using fx = seededFixture();
		const file = (await router().locate("swarm://test-swarm?since=1", context(fx.root)))!;
		expect(fs.readFileSync(file, "utf8")).toBe(await read("swarm://test-swarm?since=1", fx.root));
		expect(fs.readFileSync(file, "utf8")).not.toContain("take the lexer");

		const rename = vi.spyOn(fs, "renameSync");
		await router().locate("swarm://test-swarm?since=1&tab=members", context(fx.root));
		expect(rename).not.toHaveBeenCalled();
		await router().locate("swarm://test-swarm", context(fx.root));
		expect(rename).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(file, "utf8")).toContain("take the lexer");
	});

	it("keeps the previous snapshot and leaves no temporary file when the rename fails", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		using fx = seededFixture();
		const file = (await router().locate("swarm://test-swarm", context(fx.root)))!;
		const previous = fs.readFileSync(file, "utf8");
		fx.store.append("alice", "@coordinator Not yet linkable");
		vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
		});

		expect(await router().locate("swarm://test-swarm", context(fx.root))).toBeNull();

		expect(fs.readFileSync(file, "utf8")).toBe(previous);
		expect(fx.listFiles().some(name => name.endsWith(".tmp"))).toBe(false);
		expect(warn).toHaveBeenCalledWith("Swarm snapshot file was not written", expect.objectContaining({ file }));
	});

	it("exposes the same regeneration for a surface", () => {
		using fx = seededFixture();
		const surface = getSwarmSurface("test-swarm", { artifactsDir: fx.root });
		const file = writeSwarmSnapshotFile(surface);
		expect(file).toBe(path.join(surface.board.dir, "board.snapshot.md"));
		expect(fs.readFileSync(file!, "utf8")).toBe(renderSwarmSnapshot(surface));
	});

	it("has no file for the index or an unknown board, and rejects malformed URLs", async () => {
		using fx = seededFixture();
		expect(await router().locate("swarm://", context(fx.root))).toBeNull();
		expect(await router().locate("swarm://other-swarm", context(fx.root))).toBeNull();
		await expect(router().locate("swarm://test-swarm/extra", context(fx.root))).rejects.toBeInstanceOf(ToolError);
		await expect(router().locate("swarm://TEST-SWARM", context(fx.root))).rejects.toThrow(/not a swarm id/);
		expect(fx.listFiles()).toEqual([...BOARD_FILES].sort());
	});
});

describe("refused reads", () => {
	const refused: Array<[string, RegExp]> = [
		["swarm://test-swarm/extra", /remove the path/],
		["swarm://test-swarm/../../etc", /remove the path/],
		["swarm://..", /not a swarm id/],
		["swarm://..%2F..", /not a swarm id/],
		["swarm://TEST-SWARM", /not a swarm id/],
		["swarm://test-swarm?tab=nope", /Unknown swarm tab/],
		["swarm://test-swarm?since=-3", /nonnegative integer/],
		["swarm://test-swarm?since=1&since=2", /more than once/],
		["swarm://test-swarm?path=../x", /Unsupported swarm:\/\/ query parameter "path"/],
		["swarm://not-a-board", /Unknown swarm: not-a-board\. Known swarms: test-swarm/],
	];

	it.each(refused)("refuses %s with a tool error that names the problem", async (url, reason) => {
		using fx = seededFixture();
		const result = router().resolve(url, context(fx.root));
		await expect(result).rejects.toBeInstanceOf(ToolError);
		await expect(result).rejects.toThrow(reason);
		expect(fx.listFiles()).toEqual([...BOARD_FILES].sort());
	});
});

describe("boards of saved sessions", () => {
	function projectDir(): string {
		const project = path.join(temporaryDir(), "project");
		fs.mkdirSync(project);
		return project;
	}

	/** A saved session of the project at `project`: its transcript file and, beside it, its artifacts with a board. */
	function savedBoard(project: string, id: string, title: string): string {
		const bucket = sessionDirForCwd(project);
		const session = `2026-01-01T00-00-00-000Z_${id}`;
		fs.mkdirSync(path.join(bucket, session), { recursive: true });
		fs.writeFileSync(path.join(bucket, `${session}.jsonl`), "");
		const dir = path.join(bucket, session, "swarm");
		const store = BoardStore.create(dir, {
			id,
			title,
			coordinator: makeMember(`${id}-coordinator`, { role: "coordinator", wakeMode: null }),
			capabilities: SWARM_CAPABILITIES,
		});
		store.append("coordinator", "Saved evidence");
		return dir;
	}

	it("renders a saved session's board for a caller without a session or artifacts directory, and lists it in the index", async () => {
		const project = projectDir();
		const dir = savedBoard(project, "saved-swarm", "Saved team");
		const before = fs.readdirSync(dir).sort();

		const resource = await router().resolve("swarm://saved-swarm", { cwd: project });
		expect(resource.url).toBe("swarm://saved-swarm");
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Swarm Saved team (saved-swarm)");
		expect(resource.content).toContain("Access: read-only copy");
		expect(headings(resource.content)).toHaveLength(1);
		expect(resource.content).toContain("> Saved evidence");

		const index = (await router().resolve("swarm://", { cwd: project })).content;
		expect(index).toMatch(/\| swarm:\/\/saved-swarm \| Saved team \| #1 \| 1 stopped \| read-only \|/);
		expect(fs.readdirSync(dir).sort()).toEqual(before);
		expect(before).toEqual([...BOARD_FILES].sort());
	});

	it("finds the board from another project through every project's sessions, which that project's index does not list", async () => {
		const project = projectDir();
		const elsewhere = projectDir();
		savedBoard(project, "saved-swarm", "Saved team");

		const resource = await router().resolve("swarm://saved-swarm", { cwd: elsewhere });
		expect(resource.content).toContain("# Swarm Saved team (saved-swarm)");

		const index = (await router().resolve("swarm://", { cwd: elsewhere })).content;
		expect(index).not.toContain("swarm://saved-swarm");
		expect(index).toContain("A board appears here once a coordinator session creates its team");
	});

	it("prefers the caller's own project when two saved boards share an id", async () => {
		const alpha = projectDir();
		const bravo = projectDir();
		savedBoard(alpha, "shared-swarm", "Alpha team");
		savedBoard(bravo, "shared-swarm", "Bravo team");
		expect((await router().resolve("swarm://shared-swarm", { cwd: alpha })).content).toContain("Alpha team");
		expect((await router().resolve("swarm://shared-swarm", { cwd: bravo })).content).toContain("Bravo team");
	});

	it("locates a saved board's snapshot file beside its records, from its own project and from another", async () => {
		const project = projectDir();
		const elsewhere = projectDir();
		const dir = savedBoard(project, "saved-swarm", "Saved team");
		const expected = path.join(fs.realpathSync.native(dir), "board.snapshot.md");

		expect(await router().locate("swarm://saved-swarm", { cwd: project })).toBe(expected);
		expect(fs.readFileSync(expected, "utf8")).toBe(
			(await router().resolve("swarm://saved-swarm", { cwd: project })).content,
		);
		expect(await router().locate("swarm://saved-swarm", { cwd: elsewhere })).toBe(expected);
		expect(fs.readdirSync(dir).sort()).toEqual([...BOARD_FILES, "board.snapshot.md"].sort());
	});

	it("still refuses an id that no discovered or saved board holds, naming the boards it knows", async () => {
		using fx = seededFixture();
		const project = projectDir();
		savedBoard(project, "saved-swarm", "Saved team");
		const caller = { ...context(fx.root), cwd: project };

		expect((await router().resolve("swarm://saved-swarm", caller)).content).toContain("Saved team");
		const unknown = router().resolve("swarm://nothing-here", caller);
		await expect(unknown).rejects.toBeInstanceOf(ToolError);
		await expect(unknown).rejects.toThrow(/Unknown swarm: nothing-here\. Known swarms: test-swarm/);
		expect(await router().locate("swarm://nothing-here", caller)).toBeNull();
	});
});

describe("savedBoardDirectories", () => {
	function boardAt(dir: string, id: string): string {
		BoardStore.create(dir, {
			id,
			title: id,
			coordinator: makeMember(`${id}-coordinator`, { role: "coordinator", wakeMode: null }),
			capabilities: SWARM_CAPABILITIES,
		});
		return dir;
	}

	it("lists the boards of the project's saved sessions, or of every project's, and nothing else", () => {
		const root = temporaryDir();
		const alphaCwd = path.join(root, "alpha-project");
		const bravoCwd = path.join(root, "bravo-project");
		const alpha = sessionDirForCwd(alphaCwd, root);
		const bravo = sessionDirForCwd(bravoCwd, root);
		const first = boardAt(path.join(alpha, "session-one", "swarm"), "alpha-one");
		const second = boardAt(path.join(alpha, "session-two", "swarm"), "alpha-two");
		const third = boardAt(path.join(bravo, "session-three", "swarm"), "bravo-one");
		// None of these is a board: a swarm directory without swarm.json, a session without one, and files where
		// directories belong (a transcript, a file named like a session, a swarm file, a stray file in the root).
		fs.mkdirSync(path.join(alpha, "session-four", "swarm"), { recursive: true });
		fs.writeFileSync(path.join(alpha, "session-four", "swarm", "board.jsonl"), "");
		fs.mkdirSync(path.join(alpha, "session-five"), { recursive: true });
		fs.writeFileSync(path.join(alpha, "session-six.jsonl"), "");
		fs.writeFileSync(path.join(alpha, "session-seven"), "a file named like a session");
		fs.mkdirSync(path.join(alpha, "session-eight"), { recursive: true });
		fs.writeFileSync(path.join(alpha, "session-eight", "swarm"), "a file named swarm");
		fs.writeFileSync(path.join(root, "stray.txt"), "");

		expect(savedBoardDirectories(alphaCwd, root).sort()).toEqual([first, second].sort());
		expect(savedBoardDirectories(bravoCwd, root)).toEqual([third]);
		expect(savedBoardDirectories(undefined, root).sort()).toEqual([first, second, third].sort());
		expect(savedBoardDirectories(path.join(root, "unknown-project"), root)).toEqual([]);
	});

	it("returns an empty list for a missing sessions root and for a project without sessions", () => {
		const root = temporaryDir();
		const absent = path.join(root, "absent");
		expect(savedBoardDirectories(undefined, absent)).toEqual([]);
		expect(savedBoardDirectories(path.join(root, "project"), absent)).toEqual([]);
		expect(fs.existsSync(absent)).toBe(false);

		fs.mkdirSync(sessionDirForCwd(path.join(root, "project"), root), { recursive: true });
		expect(savedBoardDirectories(path.join(root, "project"), root)).toEqual([]);
		expect(savedBoardDirectories(undefined, root)).toEqual([]);
	});

	it("reads the sessions root of the active agent directory by default", () => {
		const project = path.join(temporaryDir(), "project");
		fs.mkdirSync(project);
		const bucket = sessionDirForCwd(project);
		const dir = boardAt(path.join(bucket, "session-one", "swarm"), "default-root");
		expect(savedBoardDirectories(project)).toEqual([dir]);
		expect(savedBoardDirectories()).toEqual([dir]);
	});
});
