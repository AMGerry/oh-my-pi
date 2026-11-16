import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type { SwarmCaller } from "../../src/swarm/api";
import { SwarmRuntime } from "../../src/swarm/runtime";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { swarmThreadService } from "../../src/thread/services/swarm";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { SwarmProbe, SwarmProbeGlobals } from "../fixtures/swarm-bridge-worker";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	SwarmRuntime.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function worker(): Promise<SwarmProbe> {
	const probe = Promise.withResolvers<SwarmProbe>();
	const service: ThreadService = {
		name: "swarm-probe",
		globals: (): SwarmProbeGlobals => ({ ready: value => probe.resolve(value) }),
	};
	const spawned = new SubagentWorker({
		entry: new URL("../fixtures/swarm-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, swarmThreadService, service],
		initTimeoutMs: 20000,
	});
	cleanups.push(() => spawned.terminate("swarm test complete"));
	await spawned.ready;
	return probe.promise;
}

it("serializes control calls from two real worker threads and retains completion callbacks", async () => {
	SwarmRuntime.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-bridge-"));
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const runtime = SwarmRuntime.local();
	const caller: SwarmCaller = {
		agentId: "Main",
		cwd,
		artifactsDir: path.join(cwd, "artifacts"),
		sessionFile: path.join(cwd, "parent.jsonl"),
		model: "mock/parent",
		maxMembers: 32,
	};
	registry.register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		session: null,
		sessionFile: caller.sessionFile,
		status: "idle",
	});
	cleanups.push(async () => {
		runtime.dispose();
		await lifecycle.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	const [left, right] = await Promise.all([worker(), worker()]);
	expect(await left.writerGuard()).toBe(true);
	const results = await Promise.all([
		left.add(caller, { action: "add", name: "left", brief: "Complete left work", n: 3 }),
		right.add(caller, { action: "add", name: "right", brief: "Complete right work", n: 3 }),
	]);
	expect(results[0]!.id).toBe(results[1]!.id);
	const board = runtime.board(results[0]!.id);
	expect(board.posts().map(post => post.seq)).toEqual([1, 2, 3, 4, 5, 6]);
	expect(board.listMembers()).toHaveLength(7);
	expect(registry.list().filter(ref => ref.kind === "sub")).toHaveLength(6);
	await right.finish("right-2", { error: "429 quota" });
	expect(runtime.snapshot(board.metadata.id).members.find(member => member.name === "right-2")).toMatchObject({
		state: "waiting",
		error: "quota",
	});
	const own = await runtime.ensure(caller);
	await runtime.kill(own, "left");
	await expect(left.add(caller, { action: "add", name: "left", brief: "Again" })).rejects.toThrow("already been used");
});

it("routes a waiting peer's explicit model change through the native session bridge", async () => {
	SwarmRuntime.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const from = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const to = getBundledModel("anthropic", "claude-sonnet-4-6")!;
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: from, systemPrompt: ["Model bridge test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth),
		agentId: "Main",
	});
	AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session, status: "idle" });
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
	});
	const probe = await worker();
	expect(await probe.switchPeerModel("Main", to)).toBe(to.id);
	expect(session.model?.id).toBe(to.id);
});
