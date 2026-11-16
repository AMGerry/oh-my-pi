import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { createMemberWorkspace, removeMemberWorkspace } from "../../src/swarm/workspaces";
import { makeMember } from "./fixtures";

const roots: string[] = [];

afterEach(async () => {
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
