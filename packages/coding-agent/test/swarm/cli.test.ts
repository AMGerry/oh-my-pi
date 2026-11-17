/**
 * `omp swarm`: `list` and `board` read the persisted boards of saved sessions, `selftest` runs the headless self-check.
 * Sessions are real files under an isolated agent directory; the command's standard output is captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { runSwarmCommand, runSwarmSelftest, type SwarmCommandArgs } from "../../src/cli/swarm-cli";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SessionManager } from "../../src/session/session-manager";
import { BoardStore } from "../../src/swarm/board-store";
import { SwarmRuntime } from "../../src/swarm/runtime";
import * as bundledSkills from "../../src/swarm/skills";
import type { BoardPost, SwarmSnapshot } from "../../src/swarm/types";
import { addWorker, makeMember, SWARM_CAPABILITIES } from "./fixtures";

const SELFTEST_STEPS = [
	"board store",
	"mentions",
	"wait and selective wake",
	"channels",
	"scheduler",
	"swarm:// surface",
	"bundled skills",
	"tools",
	"custom page",
];

type BoardJson = SwarmSnapshot & { posts: BoardPost[] };

let home: string;
let project: string;
let elsewhere: string;
let originalAgentDir: string;
let output: string[];
const journals: SessionManager[] = [];

beforeEach(() => {
	originalAgentDir = getAgentDir();
	home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-cli-"));
	setAgentDir(path.join(home, "agent"));
	project = path.join(home, "project");
	elsewhere = path.join(home, "elsewhere");
	fs.mkdirSync(project);
	fs.mkdirSync(elsewhere);
	AgentRegistry.resetGlobalForTests();
	output = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const journal of journals.splice(0)) await journal.close();
	resetRegisteredArtifactDirsForTests();
	SwarmRuntime.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	setAgentDir(originalAgentDir);
	await removeWithRetries(home);
});

/** A saved session of `cwd` whose artifacts directory holds a board with three posts and one worker. */
async function saveBoard(cwd: string, id: string, title: string): Promise<BoardStore> {
	const journal = SessionManager.create(cwd);
	journals.push(journal);
	journal.appendMessage({ role: "user", content: `Session of ${id}`, timestamp: Date.now() });
	await journal.ensureOnDisk();
	await journal.flush();
	const artifacts = journal.getArtifactsDir();
	if (!journal.getSessionFile() || !artifacts)
		throw new Error("The saved session needs a file and an artifacts directory");
	const store = BoardStore.create(path.join(artifacts, "swarm"), {
		id,
		title,
		coordinator: makeMember("coordinator-agent", { role: "coordinator", wakeMode: null }),
		capabilities: SWARM_CAPABILITIES,
	});
	addWorker(store, "alice");
	store.append("coordinator", "@alice build the lexer");
	store.append("alice", "[done] lexer ready");
	store.append("coordinator", "Wrap up");
	return store;
}

describe("omp swarm list", () => {
	it("prints the boards of this project's saved sessions with link, title and head", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		expect(await runSwarmCommand({ action: "list", flags: { json: false, all: false } }, project)).toBe(0);
		const text = output.join("");
		expect(text).toContain("# Swarm boards");
		expect(text).toContain("| swarm://cli-board | Lexer team | #3 | 2 stopped | read-only |");
	});

	it("prints the snapshots as JSON with id, title, head and members", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		expect(await runSwarmCommand({ action: "list", flags: { json: true, all: false } }, project)).toBe(0);
		expect(output).toHaveLength(1);
		const snapshots: SwarmSnapshot[] = JSON.parse(output.join(""));
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({
			id: "cli-board",
			title: "Lexer team",
			head: 3,
			boardUri: "swarm://cli-board",
		});
		expect(snapshots[0]?.members.map(member => [member.name, member.state])).toEqual([
			["coordinator", "stopped"],
			["alice", "stopped"],
		]);
	});

	it("lists another project's boards only with all", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		expect(await runSwarmCommand({ action: "list", flags: { json: true, all: false } }, elsewhere)).toBe(0);
		expect(JSON.parse(output.join(""))).toEqual([]);

		output.length = 0;
		expect(await runSwarmCommand({ action: "list", flags: { json: false, all: false } }, elsewhere)).toBe(0);
		expect(output.join("")).not.toContain("swarm://cli-board");

		output.length = 0;
		expect(await runSwarmCommand({ action: "list", flags: { json: true, all: true } }, elsewhere)).toBe(0);
		const snapshots: SwarmSnapshot[] = JSON.parse(output.join(""));
		expect(snapshots.map(snapshot => snapshot.id)).toEqual(["cli-board"]);
	});

	it("refuses an id", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		const failure = runSwarmCommand({ action: "list", id: "cli-board", flags: { json: false, all: false } }, project);
		await expect(failure).rejects.toBeInstanceOf(CliUsageError);
		await expect(failure).rejects.toThrow(/usage: omp swarm list/);
		expect(output).toEqual([]);
	});
});

describe("omp swarm board", () => {
	it("prints the board with a #seq heading per post", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		expect(
			await runSwarmCommand({ action: "board", id: "cli-board", flags: { json: false, all: false } }, project),
		).toBe(0);
		const text = output.join("");
		expect(text).toContain("Lexer team");
		expect(text).toContain("Posts #1–#3 of 3");
		expect(text).toMatch(/^### #1 coordinator .* → @alice$/m);
		expect(text).toMatch(/^### #2 alice /m);
		expect(text).toMatch(/^### #3 coordinator /m);
		expect(text).toContain("> @alice build the lexer");
		expect(text).toContain("> [done] lexer ready");
	});

	it("hides the posts up to --since", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		expect(
			await runSwarmCommand(
				{ action: "board", id: "cli-board", flags: { json: false, all: false, since: 2 } },
				project,
			),
		).toBe(0);
		const text = output.join("");
		expect(text).toMatch(/^### #3 coordinator /m);
		expect(text).not.toMatch(/^### #1 /m);
		expect(text).not.toMatch(/^### #2 /m);
		expect(text).not.toContain("build the lexer");

		output.length = 0;
		await runSwarmCommand(
			{ action: "board", id: "cli-board", flags: { json: false, all: false, since: 3 } },
			project,
		);
		expect(output.join("")).toContain("No posts after #3; the board head is #3.");
	});

	it("prints the snapshot with the posts after --since as JSON", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		await runSwarmCommand({ action: "board", id: "cli-board", flags: { json: true, all: false } }, project);
		const full: BoardJson = JSON.parse(output.join(""));
		expect(full).toMatchObject({ id: "cli-board", title: "Lexer team", head: 3 });
		expect(full.members.map(member => member.name)).toEqual(["coordinator", "alice"]);
		expect(full.posts.map(post => post.seq)).toEqual([1, 2, 3]);

		output.length = 0;
		await runSwarmCommand({ action: "board", id: "cli-board", flags: { json: true, all: false, since: 1 } }, project);
		const later: BoardJson = JSON.parse(output.join(""));
		expect(later).toMatchObject({ id: "cli-board", head: 3 });
		expect(later.posts.map(post => [post.seq, post.agent])).toEqual([
			[2, "alice"],
			[3, "coordinator"],
		]);
	});

	it("finds a board by id from any project", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		expect(
			await runSwarmCommand({ action: "board", id: "cli-board", flags: { json: true, all: false } }, elsewhere),
		).toBe(0);
		expect(JSON.parse(output.join(""))).toMatchObject({ id: "cli-board", head: 3 });
	});

	it("refuses a missing, unknown or invalid id and a negative --since", async () => {
		await saveBoard(project, "cli-board", "Lexer team");
		const flags = { json: false, all: false };
		const refusals: Array<[SwarmCommandArgs, RegExp]> = [
			[{ action: "board", flags }, /usage: omp swarm board <id>/],
			[{ action: "board", id: "missing-board", flags }, /Unknown swarm: missing-board.*Known swarms: cli-board/],
			[{ action: "board", id: "Not A Board!", flags }, /not a swarm id/],
			[{ action: "board", id: "cli-board", flags: { ...flags, since: -1 } }, /nonnegative/],
		];
		for (const [args, message] of refusals) {
			const failure = runSwarmCommand(args, project);
			await expect(failure, JSON.stringify(args)).rejects.toBeInstanceOf(CliUsageError);
			await expect(failure, JSON.stringify(args)).rejects.toThrow(message);
		}
		expect(output).toEqual([]);
	});
});

describe("omp swarm selftest", () => {
	it("passes its nine steps", async () => {
		const steps = await runSwarmSelftest();
		expect(steps.map(step => step.name)).toEqual(SELFTEST_STEPS);
		expect(steps.filter(step => !step.ok)).toEqual([]);
		for (const step of steps) expect(step.detail, step.name).not.toBe("");
	}, 30_000);

	it("prints one line per step and the total, and exits 0", async () => {
		expect(await runSwarmCommand({ action: "selftest", flags: { json: false, all: false } }, project)).toBe(0);
		const lines = output.join("").split("\n");
		for (const name of SELFTEST_STEPS)
			expect(
				lines.some(line => line.startsWith("ok  ") && line.includes(name)),
				name,
			).toBe(true);
		expect(lines).toContain("swarm selftest: 9/9 steps passed");
		expect(output.join("")).not.toContain("FAIL");
	}, 30_000);

	it("exits 1 and marks the step that failed, in text and in JSON", async () => {
		vi.spyOn(bundledSkills, "loadBundledSwarmSkills").mockRejectedValue(new Error("skills are unavailable"));
		expect(await runSwarmCommand({ action: "selftest", flags: { json: false, all: false } }, project)).toBe(1);
		const text = output.join("");
		expect(text).toMatch(/^FAIL {2}bundled skills\s+skills are unavailable$/m);
		expect(text).toContain("swarm selftest: 8/9 steps passed");
		expect(text.split("\n").filter(line => line.startsWith("ok  "))).toHaveLength(8);

		output.length = 0;
		expect(await runSwarmCommand({ action: "selftest", flags: { json: true, all: false } }, project)).toBe(1);
		const report: { ok: boolean; steps: Array<{ name: string; ok: boolean; detail: string }> } = JSON.parse(
			output.join(""),
		);
		expect(report.ok).toBe(false);
		expect(report.steps.filter(step => !step.ok)).toEqual([
			{ name: "bundled skills", ok: false, detail: "skills are unavailable" },
		]);
	}, 30_000);
});
