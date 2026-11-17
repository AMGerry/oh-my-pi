import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { withRepoLock } from "../utils/repo-lock";
import { memberNameSchema, SwarmRefusal, type SwarmMember } from "./types";

export interface MemberWorkspace {
	workspacePath: string;
	workspaceBranch: string;
	workspaceBase: string;
	workspaceSource: string;
}

/** A linked working copy stays attached to the ordinary, resumable task session. */
export async function createMemberWorkspace(
	cwd: string,
	coordinatorCwd: string,
	swarmDir: string,
	swarmId: string,
	name: string,
	signal?: AbortSignal,
): Promise<MemberWorkspace> {
	memberNameSchema.assert(swarmId);
	memberNameSchema.assert(name);
	const source = vcs.requireGit(cwd);
	const coordinator = vcs.requireGit(coordinatorCwd);
	if ((await fs.realpath(source.info().commonDir)) !== (await fs.realpath(coordinator.info().commonDir))) {
		throw new SwarmRefusal("Member workspaces require the coordinator's Git repository");
	}
	return withRepoLock(
		cwd,
		async () => {
			const head = await source.headSha(signal);
			if (!head) throw new SwarmRefusal("Commit the workspace's initial tree before creating member workspaces");
			const workspacePath = path.resolve(swarmDir, "workspaces", name);
			const workspaceBranch = `swarm/${swarmId}/${name}`;
			await fs.mkdir(path.dirname(workspacePath), { recursive: true });
			await source.createBranch(workspaceBranch, head, false, signal);
			try {
				await source.worktreeAdd(
					workspacePath,
					workspaceBranch,
					{ detach: false, clone: false, keepChanges: true },
					signal,
				);
			} catch (error) {
				// A failed creation can leave a useful working copy; Git's clean-tree guard owns its removal.
				try {
					await source.worktreeRemove(workspacePath, false);
					await source.deleteBranch(workspaceBranch, false);
				} catch {
					throw new Error(`Workspace creation failed; inspect ${workspacePath} and ${workspaceBranch}`, {
						cause: error,
					});
				}
				throw error;
			}
			return { workspacePath, workspaceBranch, workspaceBase: head, workspaceSource: coordinator.info().repoRoot };
		},
		signal,
	);
}

/** Verify the owned checkout and its landed changes; `remove` then deletes the working copy. */
async function settleMemberWorkspace(
	swarmDir: string,
	swarmId: string,
	name: string,
	member: SwarmMember,
	remove: boolean,
): Promise<{ retainedBranch?: string }> {
	if (member.workspace === "inherit") return {};
	const { workspacePath, workspaceBranch, workspaceBase, workspaceSource } = member;
	if (!workspacePath || !workspaceBranch || !workspaceBase || !workspaceSource) {
		throw new SwarmRefusal(`Workspace metadata for ${name} is incomplete`);
	}
	const expected = path.resolve(swarmDir, "workspaces", name);
	if (path.resolve(workspacePath) !== expected || workspaceBranch !== `swarm/${swarmId}/${name}`) {
		throw new SwarmRefusal(`Workspace ownership for ${name} does not match its swarm`);
	}
	const root = await fs.realpath(path.join(swarmDir, "workspaces"));
	const actual = await fs.realpath(workspacePath);
	if (path.dirname(actual) !== root) throw new SwarmRefusal(`Workspace ${name} resolves outside its swarm`);
	const source = vcs.requireGit(workspaceSource);
	const worker = vcs.requireGit(actual);
	if ((await fs.realpath(worker.info().commonDir)) !== (await fs.realpath(source.info().commonDir))) {
		throw new SwarmRefusal(`Workspace ${name} belongs to a different repository`);
	}
	return withRepoLock(workspaceSource, async () => {
		if (await worker.isDirty()) throw new SwarmRefusal(`Land ${name}'s working changes before killing it`);
		if ((await worker.currentBranch()) !== workspaceBranch) {
			throw new SwarmRefusal(`Restore ${name}'s workspace branch before killing it`);
		}
		const head = await worker.headSha();
		const landed = await source.headSha();
		if (!head || !landed) throw new SwarmRefusal(`Resolve ${name}'s workspace HEAD before killing it`);
		if ((await source.mergeBase(head, landed)) !== head) {
			const changed = new Set([
				...(await source.changedFiles({ base: workspaceBase, head })),
				...(await source.changedFiles({ base: head, head: workspaceBase })),
			]);
			if (
				changed.size > 0 &&
				(await source.hasDiff({ base: head, head: landed, files: [...changed].map(file => `:(literal)${file}`) }))
			) {
				throw new SwarmRefusal(`Land ${workspaceBranch} in the coordinator's branch before killing ${name}`);
			}
		}
		if (!remove) return {};
		if (!(await source.worktreeRemove(actual, false))) throw new SwarmRefusal(`Git retained ${name}'s working copy`);
		// A merge permits deletion; a cherry-pick keeps the original commit reference available.
		try {
			if (await source.deleteBranch(workspaceBranch, false)) return {};
		} catch (error) {
			if (!vcs.isVcsError(error)) throw error;
		}
		return { retainedBranch: workspaceBranch };
	});
}

/** Check that the member's owned checkout is clean and landed, leaving it in place. */
export async function verifyMemberWorkspace(
	swarmDir: string,
	swarmId: string,
	name: string,
	member: SwarmMember,
): Promise<void> {
	await settleMemberWorkspace(swarmDir, swarmId, name, member, false);
}

/** Verify the owned checkout and its landed changes before removing the working copy. */
export async function removeMemberWorkspace(
	swarmDir: string,
	swarmId: string,
	name: string,
	member: SwarmMember,
): Promise<{ retainedBranch?: string }> {
	return settleMemberWorkspace(swarmDir, swarmId, name, member, true);
}
