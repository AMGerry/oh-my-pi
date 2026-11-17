import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { PrepareSwarmMember, SwarmCaller } from "../../src/swarm/api";
import { BoardStore } from "../../src/swarm/board-store";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { SwarmRefusal } from "../../src/swarm/types";
import * as workspaces from "../../src/swarm/workspaces";
import { createMemberWorkspace, removeMemberWorkspace } from "../../src/swarm/workspaces";
import { makeMember } from "./fixtures";
import { TestSchedulerClock } from "./scheduler-clock";

const roots: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dispose of disposers.splice(0).reverse()) await dispose();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 10 });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-swarm-workspace-"));
	roots.push(root);
	const cwd = path.join(root, "repo");
	const dir = path.join(root, "swarm");
	await fs.mkdir(cwd);
	const init = Bun.spawn(["git", "init", "-q", "-b", "main", cwd], {
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [code, output, error] = await Promise.all([
		init.exited,
		new Response(init.stdout).text(),
		new Response(init.stderr).text(),
	]);
	if (code !== 0) throw new Error(`Fixture Git init failed: ${error || output}`);
	const repo = vcs.requireGit(cwd);
	await repo.configSet("user.name", "Swarm fixture");
	await repo.configSet("user.email", "swarm@example.invalid");
	await repo.configSet("core.autocrlf", "false");
	await repo.configSet("core.hooksPath", path.join(root, "hooks"));
	await fs.writeFile(path.join(cwd, "base.txt"), "base\n");
	await repo.stageFiles(["base.txt"]);
	await repo.commitCreate("fixture base", {});
	return { cwd, dir, repo };
}

test("two linked member copies land independent commits and release their workspaces", async () => {
	const { cwd, dir, repo } = await fixture();
	const [a, b] = await Promise.all([
		createMemberWorkspace(cwd, cwd, dir, "test", "alice"),
		createMemberWorkspace(cwd, cwd, dir, "test", "bob"),
	]);
	const alice = makeMember("alice", { workspace: "share", ...a });
	const bob = makeMember("bob", { workspace: "share", ...b });
	const aliceRepo = vcs.requireGit(a.workspacePath);
	const bobRepo = vcs.requireGit(b.workspacePath);
	await fs.writeFile(path.join(a.workspacePath, "alice.txt"), "alice\n");
	await fs.writeFile(path.join(b.workspacePath, "bob.txt"), "bob\n");
	await aliceRepo.stageFiles(["alice.txt"]);
	await bobRepo.stageFiles(["bob.txt"]);
	const aHead = await aliceRepo.commitCreate("alice change", {});
	const bHead = await bobRepo.commitCreate("bob change", {});
	await expect(removeMemberWorkspace(dir, "test", "alice", alice)).rejects.toThrow("Land");
	expect(await fs.readFile(path.join(a.workspacePath, "alice.txt"), "utf8")).toBe("alice\n");
	await repo.cherryPick(aHead);
	await repo.cherryPick(bHead);
	await removeMemberWorkspace(dir, "test", "alice", alice);
	await removeMemberWorkspace(dir, "test", "bob", bob);
	await expect(fs.stat(a.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.stat(b.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fs.readFile(path.join(cwd, "alice.txt"), "utf8")).toBe("alice\n");
	expect(await fs.readFile(path.join(cwd, "bob.txt"), "utf8")).toBe("bob\n");
	expect(await repo.worktrees()).toHaveLength(1);
	expect(await repo.isDirty()).toBe(false);
});

test("dirty workspace bytes and an unrelated checkout survive a refused kill", async () => {
	const { cwd, dir } = await fixture();
	const workspace = await createMemberWorkspace(cwd, cwd, dir, "test", "alice");
	const member = makeMember("alice", { workspace: "branch", ...workspace });
	await fs.writeFile(path.join(workspace.workspacePath, "draft.txt"), "unique work\n");
	await expect(removeMemberWorkspace(dir, "test", "alice", member)).rejects.toThrow("working changes");
	await expect(removeMemberWorkspace(dir, "test", "alice", { ...member, workspacePath: cwd })).rejects.toThrow(
		"ownership",
	);
	expect(await fs.readFile(path.join(workspace.workspacePath, "draft.txt"), "utf8")).toBe("unique work\n");
	expect(await fs.readFile(path.join(cwd, "base.txt"), "utf8")).toBe("base\n");
});

test("a member starts with its source checkout's staged and unstaged changes", async () => {
	const { cwd, dir, repo } = await fixture();
	await fs.writeFile(path.join(cwd, "staged.txt"), "staged\n");
	await repo.stageFiles(["staged.txt"]);
	await fs.writeFile(path.join(cwd, "base.txt"), "edited\n");
	const before = await repo.statusPorcelain({ untracked: "all" });
	const workspace = await createMemberWorkspace(cwd, cwd, dir, "test", "alice");
	expect(await fs.readFile(path.join(workspace.workspacePath, "staged.txt"), "utf8")).toBe("staged\n");
	expect(await fs.readFile(path.join(workspace.workspacePath, "base.txt"), "utf8")).toBe("edited\n");
	expect(await repo.statusPorcelain({ untracked: "all" })).toBe(before);
});

/** A swarm runtime over a real Git repository: members added with `workspace: "share"` get linked working copies. */
async function swarmFixture() {
	const { cwd, repo } = await fixture();
	const root = path.dirname(cwd);
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const clock = new TestSchedulerClock();
	const runtime = new SwarmRuntime(registry, lifecycle, undefined, clock);
	disposers.push(async () => {
		runtime.dispose();
		await lifecycle.dispose();
	});
	const caller: SwarmCaller = {
		cwd,
		agentId: "Coordinator",
		sessionFile: path.join(root, "parent.jsonl"),
		artifactsDir: path.join(root, "artifacts"),
		model: "mock/parent",
		maxMembers: 32,
	};
	registry.register({
		id: caller.agentId,
		displayName: "Coordinator",
		kind: "main",
		session: null,
		sessionFile: caller.sessionFile,
		status: "idle",
	});
	const actor = await runtime.ensure(caller);
	const prepare: PrepareSwarmMember = async plan => {
		const agentId = `Member-${plan.name}`;
		return {
			agentId,
			model: plan.model,
			start: async () => {
				registry.register({
					id: agentId,
					displayName: plan.name,
					kind: "sub",
					parentId: caller.agentId,
					session: null,
					sessionFile: path.join(root, `${plan.name}.jsonl`),
					status: "running",
				});
			},
		};
	};
	/** Give each named member a cron task, so a kill has a schedule to keep or to end. */
	const schedule = async (names: string[]): Promise<void> => {
		for (const name of names) {
			await runtime.schedule(
				{ id: actor.id, name, agentId: `Member-${name}` },
				{ action: "create", cron: "* * * * *", prompt: "Inspect" },
			);
		}
	};
	/** Every named member is exactly as it was before a refused kill: running, scheduled, with its working copy and branch. */
	const standing = async (names: string[]): Promise<void> => {
		const board = runtime.board(actor.id);
		const persisted = BoardStore.open(board.dir, { readOnly: true });
		for (const name of names) {
			const member = board.member(name);
			expect(member.killed, name).toBe(false);
			expect(persisted.member(name).killed, name).toBe(false);
			expect(registry.get(member.agentId)?.status, name).toBe("running");
			await expect(fs.stat(path.join(root, `${name}.jsonl.tombstone`)), name).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(runtime.scheduler.list({ id: actor.id, name, agentId: member.agentId }), name).toHaveLength(1);
			await expect(fs.stat(member.workspacePath!), name).resolves.toBeDefined();
			expect(await repo.refExists(`swarm/${actor.id}/${name}`), name).toBe(true);
		}
		expect(await repo.worktrees()).toHaveLength(names.length + 1);
	};
	return { cwd, root, repo, registry, clock, runtime, caller, actor, prepare, schedule, standing };
}

test("a kill refused for open changes or an unlanded branch leaves the member untouched, and succeeds once the work has landed", async () => {
	const f = await swarmFixture();
	await f.runtime.add(f.caller, { action: "add", name: "alice", brief: "Work", workspace: "share" }, f.prepare);
	await f.schedule(["alice"]);
	const alice = f.runtime.board(f.actor.id).member("alice");
	const draft = path.join(alice.workspacePath!, "draft.txt");
	const branch = `swarm/${f.actor.id}/alice`;
	expect(f.clock.pending.size).toBe(1);

	// Open changes in the working copy.
	await fs.writeFile(draft, "unique work\n");
	const dirty = f.runtime.kill(f.actor, "alice");
	await expect(dirty).rejects.toBeInstanceOf(SwarmRefusal);
	await expect(dirty).rejects.toThrow("Land alice's working changes");
	await f.standing(["alice"]);
	expect(await fs.readFile(draft, "utf8")).toBe("unique work\n");
	expect(f.clock.pending.size).toBe(1);

	// Committed in the working copy, not yet in the coordinator's branch.
	const worker = vcs.requireGit(alice.workspacePath!);
	await worker.stageFiles(["draft.txt"]);
	const commit = await worker.commitCreate("alice work", {});
	const unlanded = f.runtime.kill(f.actor, "alice");
	await expect(unlanded).rejects.toBeInstanceOf(SwarmRefusal);
	await expect(unlanded).rejects.toThrow(`Land ${branch} in the coordinator's branch`);
	await f.standing(["alice"]);
	expect(f.clock.pending.size).toBe(1);

	// The coordinator's branch moves on first, so the cherry-pick lands as a commit of its own and the branch stays.
	await fs.writeFile(path.join(f.cwd, "other.txt"), "coordinator work\n");
	await f.repo.stageFiles(["other.txt"]);
	await f.repo.commitCreate("coordinator work", {});
	await f.repo.cherryPick(commit);
	const result = await f.runtime.kill(f.actor, "alice");
	expect(result.killed).toEqual(["alice"]);
	expect(result.retainedBranches).toEqual([branch]);
	expect(result.retainedWorkspaces).toBeUndefined();
	expect(result.members.find(member => member.name === "alice")).toMatchObject({ state: "killed", killed: true });
	expect(BoardStore.open(f.runtime.board(f.actor.id).dir, { readOnly: true }).member("alice").killed).toBe(true);
	expect(f.registry.get("Member-alice")?.status).toBe("aborted");
	await expect(fs.stat(path.join(f.root, "alice.jsonl.tombstone"))).resolves.toBeDefined();
	await expect(fs.stat(alice.workspacePath!)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await f.repo.worktrees()).toHaveLength(1);
	expect(await f.repo.refExists(branch)).toBe(true);
	expect(await fs.readFile(path.join(f.cwd, "draft.txt"), "utf8")).toBe("unique work\n");
	expect(f.clock.pending.size).toBe(0);
}, 60_000);

test("one unclean member refuses the kill of its whole group and leaves every member untouched", async () => {
	const f = await swarmFixture();
	await f.runtime.add(f.caller, { action: "add", name: "team", n: 2, brief: "Work", workspace: "share" }, f.prepare);
	await f.schedule(["team-1", "team-2"]);
	const board = f.runtime.board(f.actor.id);
	const draft = path.join(board.member("team-2").workspacePath!, "draft.txt");
	await fs.writeFile(draft, "unique work\n");

	const refused = f.runtime.kill(f.actor, "team");
	await expect(refused).rejects.toBeInstanceOf(SwarmRefusal);
	await expect(refused).rejects.toThrow("Land team-2's working changes");
	await f.standing(["team-1", "team-2"]);
	expect(await fs.readFile(draft, "utf8")).toBe("unique work\n");
	expect(f.runtime.scheduler.list(f.actor)).toHaveLength(2);

	// The clean member can still be killed on its own; the unclean one stays as it was.
	const clean = await f.runtime.kill(f.actor, "team-1");
	expect(clean.killed).toEqual(["team-1"]);
	expect(clean.retainedBranches).toBeUndefined();
	expect(clean.retainedWorkspaces).toBeUndefined();
	expect(board.member("team-1").killed).toBe(true);
	await f.standing(["team-2"]);
	expect(f.runtime.scheduler.list(f.actor)).toHaveLength(1);
	expect(f.clock.pending.size).toBe(1);
}, 60_000);

test("a working copy refused for removal after the stop is reported as retained, and its member is killed", async () => {
	const f = await swarmFixture();
	await f.runtime.add(f.caller, { action: "add", name: "alice", brief: "Work", workspace: "share" }, f.prepare);
	await f.schedule(["alice"]);
	const alice = f.runtime.board(f.actor.id).member("alice");
	// The member wrote after the check passed: the removal refuses.
	const removal = vi
		.spyOn(workspaces, "removeMemberWorkspace")
		.mockRejectedValue(new SwarmRefusal("Land alice's working changes before killing it"));

	const result = await f.runtime.kill(f.actor, "alice");
	expect(removal).toHaveBeenCalledTimes(1);
	expect(result.killed).toEqual(["alice"]);
	expect(result.retainedWorkspaces).toEqual([alice.workspacePath!]);
	expect(result.retainedBranches).toBeUndefined();
	expect(result.members.find(member => member.name === "alice")).toMatchObject({ state: "killed", killed: true });
	expect(BoardStore.open(f.runtime.board(f.actor.id).dir, { readOnly: true }).member("alice").killed).toBe(true);
	expect(f.registry.get("Member-alice")?.status).toBe("aborted");
	await expect(fs.stat(path.join(f.root, "alice.jsonl.tombstone"))).resolves.toBeDefined();
	expect(f.clock.pending.size).toBe(0);
	// The working copy and its branch stay for landing by hand.
	await expect(fs.stat(alice.workspacePath!)).resolves.toBeDefined();
	expect(await f.repo.refExists(`swarm/${f.actor.id}/alice`)).toBe(true);
	expect(await f.repo.worktrees()).toHaveLength(2);
}, 60_000);
