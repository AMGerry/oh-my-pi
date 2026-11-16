import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AgentSession } from "../../src/session/agent-session";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { getSwarmMemberContext } from "../../src/swarm/context";
import { SwarmTool } from "../../src/swarm/tools/swarm";
import { cfgSwarmEnabled, cfgSwarmMaxMembers } from "../../src/swarm/settings";
import { getBundledAgent } from "../../src/task/agents";
import * as discovery from "../../src/task/discovery";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { cfgTaskPerCallModel } from "../../src/task/settings";
import { invalidModelSelectorReason } from "../../src/task/structured-subagent";
import { createTools, type ToolSession } from "../../src/tools";

const cleanups: Array<() => Promise<void>> = [];
let nextFixture = 0;
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	SwarmRuntime.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

async function fixture() {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	SwarmRuntime.resetGlobalForTests();
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-swarm-native-"));
	const sourceId = `swarm-native-${++nextFixture}`;
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<MockResponse>();
	const model = createMockModel({
		id: "swarm-test",
		handler: async (_context, options) => {
			started.resolve();
			const aborted = () => response.resolve({ stopReason: "aborted", content: [] });
			options?.signal?.addEventListener("abort", aborted, { once: true });
			if (options?.signal?.aborted) aborted();
			try {
				return await response.promise;
			} finally {
				options?.signal?.removeEventListener("abort", aborted);
			}
		},
	});
	const replacement = createMockModel({
		id: "swarm-replacement",
		handler: () => ({ content: ["Continued after switch"] }),
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "test-key");
	registerMockApi(sourceId);
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model, replacement]);
	vi.spyOn(modelRegistry, "getAll").mockReturnValue([model, replacement]);
	const find = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation(
		(provider, id) =>
			[model, replacement].find(candidate => candidate.provider === provider && candidate.id === id) ??
			find(provider, id),
	);
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ ...getBundledAgent("swarm")!, tools: ["read", "swarm"] }],
		projectAgentsDir: null,
	});
	const settings = Settings.isolated({
		"task.maxRecursionDepth": 3,
		"task.workerThreads": 0,
		"task.isolation.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"task.prewalk": false,
		"task.agentIdleTtlMs": 0,
		modelRoles: { review: "mock/swarm-test", task: "mock/swarm-replacement" },
	});
	const journal = SessionManager.create(cwd, path.join(cwd, "sessions"));
	journal.appendMessage({ role: "user", content: "Fork source: keep this fact", timestamp: Date.now() });
	await journal.ensureOnDisk();
	await journal.flush();
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const root = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Swarm test coordinator"], tools: [], messages: [] } }),
		sessionManager: journal,
		settings,
		modelRegistry,
	});
	registry.register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		session: root,
		sessionFile: journal.getSessionFile(),
		status: "idle",
	});
	const runtime = new SwarmRuntime(registry, lifecycle);
	SwarmRuntime.installGlobal(runtime);
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		sessionManager: journal,
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: true,
		noContextFiles: true,
		contextFiles: [],
		skills: [],
		rules: [],
		skipPythonPreflight: true,
		getSessionFile: () => journal.getSessionFile() ?? null,
		getArtifactsDir: () => journal.getArtifactsDir(),
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		getActiveModel: () => model,
		getActiveModelString: () => "mock/swarm-test",
		agentRegistry: registry,
		agentLifecycle: () => lifecycle,
	};
	cleanups.push(async () => {
		response.resolve({ content: ["Fixture cleanup"] });
		await lifecycle.dispose();
		runtime.dispose();
		await root.dispose();
		await journal.close();
		authStorage.close();
		unregisterCustomApis(sourceId);
		await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
	});
	return {
		cwd,
		model,
		replacement,
		started,
		response,
		journal,
		session,
		root,
		settings,
		authStorage,
		modelRegistry,
		registry,
		lifecycle,
		runtime,
		tool: new SwarmTool(session),
	};
}

describe("native swarm control tool", () => {
	it("M2 gate: TaskTool add creates a working native session, kill tombstones it, and the name stays reserved", async () => {
		const f = await fixture();
		expect(cfgTaskPerCallModel.get(f.settings)).toBe("off");
		expect(
			invalidModelSelectorReason("mock/swarm-test", "task", { settings: f.settings, invocationKind: "task" }),
		).toContain("disabled");
		const added = await f.tool.execute("add", {
			action: "add",
			name: "author",
			brief: "Implement the assigned piece",
		});
		expect(added.isError).not.toBe(true);
		const member = added.details?.result?.members.find(candidate => candidate.name === "author");
		expect(member).toMatchObject({ state: "working", model: "mock/swarm-test", lastReadSeq: 1 });
		expect(added.details?.result?.capabilities.channels).toBe(true);
		expect(added.details?.result?.boardUri).toMatch(/^swarm:\/\//);
		await f.started.promise;
		const ref = f.registry.get(member!.agentId)!;
		expect(ref.kind).toBe("sub");
		expect(ref.session?.model?.id).toBe("swarm-test");
		expect(ref.sessionFile).toBeTruthy();
		expect(f.model.calls).toHaveLength(1);
		expect(JSON.stringify(f.model.calls[0]?.context.messages)).toContain("Implement the assigned piece");
		const killed = await f.tool.execute("kill", { action: "kill", name: "author" });
		expect(killed.details?.result?.members.find(candidate => candidate.name === "author")).toMatchObject({
			state: "killed",
			killed: true,
		});
		expect(f.registry.get(member!.agentId)?.status).toBe("aborted");
		const repeat = await f.tool.execute("again", { action: "add", name: "author", brief: "Again" });
		expect(repeat.isError).toBe(true);
		expect(repeat.details?.error).toContain("already been used");
	});

	it("gives a helper the live coordinator model across a different parent model and cold revival", async () => {
		const f = await fixture();
		f.settings.setModelRole("review", "mock/swarm-replacement");
		const parked = async (id: string) => {
			const done = Promise.withResolvers<void>();
			const stop = f.registry.onChange(event => {
				if (event.ref.id === id && event.ref.status === "parked") done.resolve();
			});
			if (f.registry.get(id)?.status === "parked") done.resolve();
			try {
				await done.promise;
			} finally {
				stop();
			}
		};
		const added = await f.tool.execute("parent", {
			action: "add",
			name: "parent",
			brief: "Delegate specialist work",
			model: "mock/swarm-replacement",
		});
		expect(added.isError).not.toBe(true);
		const parent = added.details!.result!.members.find(member => member.name === "parent")!;
		await parked(parent.agentId);
		const parentHistory = await SessionManager.open(parent.sessionFile!);
		cleanups.push(() => parentHistory.close());
		const helperTool = new SwarmTool({
			...f.session,
			taskDepth: 1,
			sessionManager: parentHistory,
			getSessionFile: () => parentHistory.getSessionFile() ?? null,
			getArtifactsDir: () => parentHistory.getArtifactsDir(),
			getAgentId: () => parent.agentId,
			getActiveModel: () => f.replacement,
			getActiveModelString: () => "mock/swarm-replacement",
		});
		const helperResult = await helperTool.execute("helper", {
			action: "add",
			name: "helper",
			brief: "Preserve the helper's assignment",
			role: "monitor",
		});
		expect(helperResult.isError).not.toBe(true);
		await f.started.promise;
		const helper = helperResult.details!.result!.members.find(member => member.name === "helper")!;
		expect(helper.model).toBe("mock/swarm-test");
		expect(f.registry.get(helper.agentId)?.parentId).toBe(parent.agentId);
		f.response.resolve({ content: ["Helper paused"] });
		await parked(helper.agentId);
		const ref = f.registry.get(helper.agentId)!;
		const factory = createPersistedSubagentReviverFactory({
			session: f.root,
			settings: f.settings,
			authStorage: f.authStorage,
			modelRegistry: f.modelRegistry,
			enableLsp: false,
		});
		const revive = await factory(ref);
		expect(revive).toBeDefined();
		const revived = await revive!(ref);
		try {
			expect(revived.model?.id).toBe("swarm-test");
			await revived.prompt("Continue the helper's work");
			expect(f.model.calls).toHaveLength(2);
		} finally {
			await revived.dispose();
		}
	});

	it("forks persisted history into a separately bound member before its first native prompt", async () => {
		const f = await fixture();
		const added = await f.tool.execute("fork", {
			action: "add",
			name: "forked",
			brief: "Continue this part",
			fork: "coordinator",
		});
		expect(added.isError).not.toBe(true);
		await f.started.promise;
		const member = added.details!.result!.members.find(candidate => candidate.name === "forked")!;
		const ref = f.registry.get(member.agentId)!;
		expect(ref.sessionFile).not.toBe(f.journal.getSessionFile());
		const messages = JSON.stringify(f.model.calls[0]?.context.messages);
		expect(messages).toContain("Fork source: keep this fact");
		expect(messages).toContain("Continue this part");
		const child = await SessionManager.open(ref.sessionFile!);
		expect(getSwarmMemberContext(child.getEntries())).toMatchObject({ name: "forked", agentId: member.agentId });
		await child.close();
		await f.tool.execute("kill", { action: "kill", name: "forked" });
	});

	it("switches a stopped quota conversation before cold revival with the selected native model", async () => {
		const f = await fixture();
		const added = await f.tool.execute("quota", { action: "add", name: "quota", brief: "Preserve this assignment" });
		await f.started.promise;
		const member = added.details!.result!.members.find(candidate => candidate.name === "quota")!;
		const stopped = Promise.withResolvers<void>();
		const stop = f.runtime.onChange(() => {
			if (
				f.runtime.snapshot(added.details!.result!.id).members.find(candidate => candidate.name === "quota")
					?.error === "quota"
			)
				stopped.resolve();
		});
		f.response.resolve({ stopReason: "error", errorMessage: "RESOURCE_EXHAUSTED quota", content: [] });
		await stopped.promise;
		stop();
		const switched = await f.tool.execute("switch", {
			action: "model",
			name: "quota",
			model: "mock/swarm-replacement",
		});
		expect(switched.isError).not.toBe(true);
		expect(switched.details?.result?.members.find(candidate => candidate.name === "quota")?.model).toBe(
			"mock/swarm-replacement",
		);
		const ref = f.registry.get(member.agentId)!;
		const factory = createPersistedSubagentReviverFactory({
			session: f.root,
			settings: f.settings,
			authStorage: f.authStorage,
			modelRegistry: f.modelRegistry,
			enableLsp: false,
		});
		const revive = await factory(ref);
		expect(revive).toBeDefined();
		const revived = await revive!(ref);
		try {
			expect(revived.model?.id).toBe("swarm-replacement");
			expect(JSON.stringify(revived.messages)).toContain("Preserve this assignment");
			await revived.prompt("Continue the same work");
			expect(f.replacement.calls).toHaveLength(1);
		} finally {
			await revived.dispose();
		}
	});

	it("lists approved exact models and obeys the live swarm settings gate", async () => {
		const f = await fixture();
		const listed = await f.tool.execute("models", { action: "models" });
		expect(listed.details?.result?.models?.map(model => model.model)).toEqual([
			"mock/swarm-test",
			"mock/swarm-replacement",
		]);
		expect(JSON.stringify(listed)).not.toContain("quotaRemaining");
		cfgSwarmEnabled.set(f.settings, false);
		const disabled = await f.tool.execute("disabled", { action: "status" });
		expect(disabled.isError).toBe(true);
		const tools = await createTools(f.session, ["swarm"]);
		expect(tools.some(tool => tool.name === "swarm")).toBe(false);
	});
	it("uses the configured member limit or its default when the configuration omits it", () => {
		const settings = Settings.isolated();
		expect(() => cfgSwarmMaxMembers.checkConfigured(settings, undefined)).not.toThrow();
		expect(cfgSwarmMaxMembers.get(settings)).toBe(32);
		cfgSwarmMaxMembers.set(settings, 8);
		expect(cfgSwarmMaxMembers.get(settings)).toBe(8);
		for (const value of [0, -1, 1.5, 257, NaN, "32", null])
			expect(() => cfgSwarmMaxMembers.checkConfigured(settings, value)).toThrow("swarm.maxMembers");
	});
});
