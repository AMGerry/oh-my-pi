import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SessionManager } from "../../src/session/session-manager";
import { controlSchema, type PrepareSwarmMember, type SwarmCaller } from "../../src/swarm/api";
import { getSwarmMemberContext, type SwarmLaunchPlan, type SwarmMemberOutcome } from "../../src/swarm/context";
import { SwarmRuntime } from "../../src/swarm/runtime";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-control-"));
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const runtime = new SwarmRuntime(registry, lifecycle);
	const caller: SwarmCaller = {
		cwd,
		agentId: "Coordinator",
		sessionFile: path.join(cwd, "parent.jsonl"),
		artifactsDir: path.join(cwd, "artifacts"),
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
	const plans: SwarmLaunchPlan[] = [];
	const briefs: string[] = [];
	const settled = new Map<string, (outcome: SwarmMemberOutcome) => void | Promise<void>>();
	const prepare: PrepareSwarmMember = async plan => {
		plans.push(plan);
		const agentId = `Member-${plan.name}`;
		return {
			agentId,
			model: plan.model,
			start: async (brief, onSettled) => {
				briefs.push(brief);
				settled.set(plan.name, onSettled);
				registry.register({
					id: agentId,
					displayName: plan.name,
					kind: "sub",
					parentId: caller.agentId,
					session: null,
					sessionFile: path.join(cwd, `${plan.name}.jsonl`),
					status: "running",
				});
			},
		};
	};
	cleanup.push(async () => {
		runtime.dispose();
		await lifecycle.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, registry, lifecycle, runtime, caller, actor, plans, briefs, prepare, settled };
}

describe("swarm control", () => {
	it("validates action-specific camelCase arguments", () => {
		expect(controlSchema.allows({ action: "add", name: "worker", brief: "Work", tasks: ["one", "two"] })).toBe(true);
		expect(controlSchema.allows({ action: "add", name: "Bad", brief: "Work" })).toBe(false);
		expect(controlSchema.allows({ action: "model" })).toBe(false);
		expect(controlSchema.allows({ action: "add", name: "worker", brief: "Work", workspace_path: "x" })).toBe(false);
	});

	it("adds a numbered group with complete briefs and separate cursors beyond every startup post", async () => {
		const f = await fixture();
		const result = await f.runtime.add(
			f.caller,
			{ action: "add", name: "parse", brief: "Common\n  indented", tasks: ["left", "right"] },
			f.prepare,
		);
		expect(result.added).toEqual(["parse-1", "parse-2"]);
		expect(result.boardUri).toBe(`swarm://${f.actor.id}`);
		expect(result.capabilities).toMatchObject({ channels: true, workspaces: true, narrator: true, monitor: true });
		expect(
			result.members
				.slice(1)
				.map(member => [member.name, member.state, member.model, member.lastReadSeq, member.unread]),
		).toEqual([
			["parse-1", "working", "mock/parent", 2, 0],
			["parse-2", "working", "mock/parent", 2, 0],
		]);
		expect(f.briefs[0]).toContain("Initial lastReadSeq: 2");
		expect(f.briefs[0]).toContain("Common\n  indented\n\nleft");
		expect(f.briefs[1]).toContain("Common\n  indented\n\nright");
		const board = f.runtime.board(f.actor.id);
		expect(board.posts().map(post => post.text)).toEqual([
			"@parse-1 Common\n  indented\n\nleft",
			"@parse-2 Common\n  indented\n\nright",
		]);
		expect(board.member("coordinator").lastReadSeq).toBe(0);
		const post = f.runtime.append(f.actor.id, "coordinator", "@parse continue");
		expect(board.addresses(post, "parse-1")).toBe(true);
		expect(board.addresses(post, "parse-2")).toBe(true);
		await f.runtime.read({ ...f.actor, name: "parse-1", agentId: board.member("parse-1").agentId });
		expect(board.member("parse-2").lastReadSeq).toBe(2);
	});

	it("tombstones groups and permanently reserves member and group names", async () => {
		const f = await fixture();
		await f.runtime.add(f.caller, { action: "add", name: "team", brief: "Work", n: 2 }, f.prepare);
		const result = await f.runtime.kill(f.actor, "team");
		expect(result.killed).toEqual(["team-1", "team-2"]);
		expect(result.members.slice(1).every(member => member.state === "killed")).toBe(true);
		await expect(f.runtime.add(f.caller, { action: "add", name: "team", brief: "Again" }, f.prepare)).rejects.toThrow(
			"already been used",
		);
		await expect(
			f.runtime.add(f.caller, { action: "add", name: "team-1", brief: "Again" }, f.prepare),
		).rejects.toThrow("already been used");
		await expect(f.runtime.kill(f.actor, "team")).rejects.toThrow("already killed");
	});

	it("serializes concurrent capacity and name admission", async () => {
		const f = await fixture();
		const caller = { ...f.caller, maxMembers: 1 };
		const results = await Promise.allSettled(
			["left", "right"].map(name => f.runtime.add(caller, { action: "add", name, brief: "Work" }, f.prepare)),
		);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		expect(f.runtime.snapshot(f.actor.id).members).toHaveLength(2);
	});

	it("keeps helper lifetimes independent and infers replacement roles", async () => {
		const f = await fixture();
		await f.runtime.add(f.caller, { action: "add", name: "narrator-2", brief: "Narrate" }, f.prepare);
		const first = f.runtime.board(f.actor.id).member("narrator-2");
		const helperCaller = {
			...f.caller,
			agentId: first.agentId,
			sessionFile: first.sessionFile!,
			context: {
				kind: "swarm" as const,
				id: f.actor.id,
				dir: f.runtime.board(f.actor.id).dir,
				name: "narrator-2",
				agentId: first.agentId,
			},
		};
		await f.runtime.add(helperCaller, { action: "add", name: "monitor-3", brief: "Monitor" }, f.prepare);
		const board = f.runtime.board(f.actor.id);
		expect(board.member("narrator-2").role).toBe("narrator");
		expect(board.member("monitor-3")).toMatchObject({ role: "monitor", owner: "narrator-2" });
		expect(f.plans.at(-1)?.model).toBe("mock/parent");
		await f.runtime.kill(f.actor, "narrator-2");
		expect(board.member("monitor-3").killed).toBe(false);
	});

	it("uses the first channel for briefs and scopes new subscriptions to future traffic", async () => {
		const f = await fixture();
		await f.runtime.channel(f.actor, { action: "channel", op: "create", channel: "code", topic: "parser" });
		await f.runtime.channel(f.actor, { action: "channel", op: "create", channel: "ui" });
		await f.runtime.add(
			f.caller,
			{ action: "add", name: "alice", brief: "Code", channels: ["code", "ui"] },
			f.prepare,
		);
		const board = f.runtime.board(f.actor.id);
		expect(board.posts()[0]?.channel).toBe("code");
		expect(board.channels().get("code")?.subscribers).toEqual(["alice"]);
		const alice = { ...f.actor, name: "alice", agentId: board.member("alice").agentId };
		await expect(f.runtime.title(alice, "Own title")).rejects.toThrow("Only the coordinator");
		await f.runtime.channel(alice, { action: "channel", op: "unsubscribe", channel: "ui" });
		f.runtime.append(f.actor.id, "coordinator", "old ui traffic", "ui");
		await f.runtime.channel(alice, { action: "channel", op: "subscribe", channel: "ui" });
		expect(board.select("alice")).toEqual([]);
		expect(board.select("alice", { channel: "ui" })).toHaveLength(1);
		await f.runtime.add(
			f.caller,
			{ action: "add", name: "main-first", brief: "Main brief", channels: ["main", "ui"] },
			f.prepare,
		);
		expect(board.posts().at(-1)?.channel).toBeUndefined();
		expect(board.member("main-first").channels).toEqual(["main", "ui"]);
		await f.runtime.channel(f.actor, { action: "channel", op: "archive", channel: "ui" });
		expect(() => f.runtime.append(f.actor.id, "alice", "new", "ui")).toThrow("unavailable");
	});

	it("rejects reserved names, ambiguous groups, unknown channels and mismatched identity", async () => {
		const f = await fixture();
		for (const name of ["all", "coordinator", "Bad", "a".repeat(41)])
			await expect(f.runtime.add(f.caller, { action: "add", name, brief: "Work" }, f.prepare)).rejects.toThrow();
		await expect(
			f.runtime.add(f.caller, { action: "add", name: "a", brief: "Work", n: 1, tasks: ["part"] }, f.prepare),
		).rejects.toThrow("Choose tasks or n");
		await expect(
			f.runtime.add(f.caller, { action: "add", name: "a", brief: "Work", channels: ["absent"] }, f.prepare),
		).rejects.toThrow("Create an active channel");
		await expect(f.runtime.status({ ...f.actor, agentId: "intruder" })).rejects.toThrow("identity");
		expect(f.plans).toHaveLength(0);
	});

	it("records quota as waiting and persists an explicit model switch in the existing conversation", async () => {
		const f = await fixture();
		await f.runtime.add(f.caller, { action: "add", name: "quota", brief: "Work" }, f.prepare);
		const model = createMockModel({ id: "replacement" });
		await expect(f.runtime.switchModel(f.actor, "quota", model)).rejects.toThrow("working");
		const board = f.runtime.board(f.actor.id);
		const member = board.member("quota");
		const journal = await SessionManager.open(member.sessionFile!, undefined, undefined, {
			initialCwd: f.cwd,
			suppressBreadcrumb: true,
		});
		journal.appendCustomEntry("swarm.member", {
			kind: "swarm",
			id: f.actor.id,
			name: "quota",
			agentId: member.agentId,
			dir: board.dir,
		});
		journal.appendMessage({ role: "user", content: "Keep this conversation", timestamp: Date.now() });
		await journal.flush();
		await journal.close();
		f.registry.setStatus(member.agentId, "parked");
		await f.settled.get("quota")?.({ error: "HTTP 429 rate limit" });
		expect(f.runtime.snapshot(f.actor.id).members[1]).toMatchObject({ error: "quota", state: "waiting" });
		await f.runtime.switchModel(f.actor, "quota", model);
		expect(board.member("quota").error).toBeUndefined();
		const reopened = await SessionManager.open(member.sessionFile!);
		expect(getSwarmMemberContext(reopened.getEntries())?.agentId).toBe(member.agentId);
		expect(reopened.getSessionLocalModelChange()?.model).toBe("mock/replacement");
		expect(JSON.stringify(reopened.getEntries())).toContain("Keep this conversation");
		await reopened.close();
	});

	it("reopens persisted workers as stopped with their cursors and tombstones intact", async () => {
		const f = await fixture();
		await f.runtime.add(f.caller, { action: "add", name: "workers", brief: "Work", n: 2 }, f.prepare);
		await f.runtime.add(
			{
				...f.caller,
				agentId: "Member-workers-2",
				context: {
					kind: "swarm",
					id: f.actor.id,
					name: "workers-2",
					agentId: "Member-workers-2",
					dir: f.runtime.board(f.actor.id).dir,
				},
			},
			{ action: "add", name: "helper", brief: "Help the worker", role: "monitor" },
			f.prepare,
		);
		await f.runtime.kill(f.actor, "workers-2");
		const board = f.runtime.board(f.actor.id);
		board.updateMember("workers-1", { wakeMode: "mentions", waitSince: 2 });
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const restored = new SwarmRuntime(registry, lifecycle);
		cleanup.push(async () => {
			restored.dispose();
			await lifecycle.dispose();
		});
		const actor = await restored.ensure({
			...f.caller,
			agentId: "Member-workers-1",
			context: { kind: "swarm", id: f.actor.id, name: "workers-1", agentId: "Member-workers-1", dir: board.dir },
		});
		const result = await restored.status(actor);
		expect(result.members[1]).toMatchObject({ state: "stopped", lastReadSeq: 2, wakeMode: null, waitSince: null });
		expect(result.members[2]).toMatchObject({ state: "killed", killed: true });
		expect(registry.get("Member-workers-1")?.status).toBe("parked");
		expect(registry.get("Member-workers-2")?.status).toBe("aborted");
		expect(registry.get("Member-helper")?.parentId).toBe("Member-workers-2");
		expect(result.members[3]).toMatchObject({ name: "helper", state: "stopped", killed: false });
	});
});
