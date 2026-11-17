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
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { extractSessionInit, SessionManager } from "../../src/session/session-manager";
import { EventController } from "../../src/modes/controllers/event-controller";
import { cfgTerminalShowProgress } from "../../src/modes/settings";
import * as runStatus from "../../src/utils/run-status";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { createToolFixture } from "./tool-fixture";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { getSwarmMemberContext } from "../../src/swarm/context";
import type { SchedulerClock } from "../../src/swarm/scheduler";
import { TestSchedulerClock } from "./scheduler-clock";
import { SwarmTool } from "../../src/swarm/tools/swarm";
import { SwarmPostTool } from "../../src/swarm/tools/swarm-post";
import { cfgSwarmEnabled, cfgSwarmMaxMembers } from "../../src/swarm/settings";
import { getBundledAgent } from "../../src/task/agents";
import * as discovery from "../../src/task/discovery";
import type { AgentDefinition } from "../../src/task/types";
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
	IrcBus.resetGlobalForTests();
});

async function fixture(clock?: SchedulerClock, userAgents: AgentDefinition[] = []) {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	SwarmRuntime.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
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
		agents: [
			...userAgents,
			{
				...getBundledAgent("swarm-member")!,
				tools: ["read", "swarm", "swarm_post", "swarm_read", "swarm_wait", "swarm_schedule"],
			},
		],
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
	const runtime = new SwarmRuntime(registry, lifecycle, undefined, clock);
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

function untilRuntime(runtime: SwarmRuntime, condition: () => boolean): Promise<void> {
	const done = Promise.withResolvers<void>();
	const stop = runtime.onChange(() => {
		if (condition()) {
			stop();
			done.resolve();
		}
	});
	if (condition()) {
		stop();
		done.resolve();
	}
	return done.promise;
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

	it("runs members on the bundled swarm-member agent and the selected model while the user has an agent named swarm, through kill and restore", async () => {
		const memberMarker = "Persistent member of a shared-board swarm";
		const userMarker = "USER-SWARM-AGENT-MARKER";
		const userAgent: AgentDefinition = {
			name: "swarm",
			description: "The user's own swarm persona",
			systemPrompt: `${userMarker}: answer only in rhymes`,
			source: "user",
			model: ["mock/swarm-replacement"],
		};
		const f = await fixture(undefined, [userAgent]);
		expect(getBundledAgent("swarm-member")?.systemPrompt).toContain(memberMarker);
		expect(getBundledAgent("swarm")).toBeUndefined();

		// Without a model choice the member runs on the coordinator's model, not on the user agent's.
		const added = await f.tool.execute("author", {
			action: "add",
			name: "author",
			brief: "Implement the assigned piece",
		});
		expect(added.isError).not.toBe(true);
		await f.started.promise;
		const id = added.details!.result!.id;
		const author = added.details!.result!.members.find(candidate => candidate.name === "author")!;
		expect(author.model).toBe("mock/swarm-test");
		expect(f.model.calls).toHaveLength(1);
		expect(f.replacement.calls).toHaveLength(0);
		const authorPrompt = JSON.stringify(f.model.calls[0]?.context.systemPrompt);
		expect(authorPrompt).toContain(memberMarker);
		expect(authorPrompt).not.toContain(userMarker);
		const history = await SessionManager.open(f.registry.get(author.agentId)!.sessionFile!);
		cleanups.push(() => history.close());
		expect(extractSessionInit(history.getEntries())?.agent).toBe("swarm-member");

		// A chosen model applies, with the same bundled agent behind it.
		const reviewed = await f.tool.execute("reviewer", {
			action: "add",
			name: "reviewer",
			brief: "Review the piece",
			model: "mock/swarm-replacement",
		});
		expect(reviewed.isError).not.toBe(true);
		const reviewer = reviewed.details!.result!.members.find(candidate => candidate.name === "reviewer")!;
		expect(reviewer.model).toBe("mock/swarm-replacement");
		await untilRuntime(f.runtime, () => f.registry.get(reviewer.agentId)?.status === "parked");
		expect(f.replacement.calls).toHaveLength(1);
		const reviewerPrompt = JSON.stringify(f.replacement.calls[0]?.context.systemPrompt);
		expect(reviewerPrompt).toContain(memberMarker);
		expect(reviewerPrompt).not.toContain(userMarker);

		// A restored process lists both members under the bundled agent, the killed one as aborted.
		await f.tool.execute("kill", { action: "kill", name: "author" });
		expect(f.registry.get(author.agentId)?.status).toBe("aborted");
		const board = f.runtime.board(id);
		const restoredRegistry = new AgentRegistry();
		const restoredLifecycle = new AgentLifecycleManager(restoredRegistry);
		const restored = new SwarmRuntime(restoredRegistry, restoredLifecycle);
		cleanups.push(async () => {
			restored.dispose();
			await restoredLifecycle.dispose();
		});
		await restored.ensure({
			agentId: reviewer.agentId,
			cwd: f.cwd,
			sessionFile: board.member("reviewer").sessionFile!,
			artifactsDir: f.journal.getArtifactsDir()!,
			model: "mock/swarm-replacement",
			maxMembers: 32,
			context: { kind: "swarm", id, name: "reviewer", agentId: reviewer.agentId, dir: board.dir },
		});
		expect(restoredRegistry.get(author.agentId)).toMatchObject({
			status: "aborted",
			history: { agent: "swarm-member" },
		});
		expect(restoredRegistry.get(reviewer.agentId)).toMatchObject({
			status: "parked",
			history: { agent: "swarm-member" },
		});
	});

	it("parks two native TaskTool conversations inside swarm_wait and resumes only the addressed member with its selected model", async () => {
		const f = await fixture();
		for (let index = 0; index < 2; index++)
			f.model.push({ content: [{ type: "toolCall", name: "swarm_wait", arguments: { since: 2 } }] });
		const bothWaiting = untilRuntime(f.runtime, () => f.runtime.waiters().length === 2);
		const added = await f.tool.execute("writers", {
			action: "add",
			name: "writers",
			n: 2,
			brief: "Complete your own assignment, then park",
		});
		expect(added.isError).not.toBe(true);
		await bothWaiting;
		expect(f.model.calls).toHaveLength(2);
		const result = added.details!.result!;
		const board = f.runtime.board(result.id);
		const post = new SwarmPostTool(f.session);
		const quiet = await post.execute("quiet", { text: "An unaddressed observation" });
		expect(quiet.details?.result?.receipts).toEqual([]);
		expect(
			f.runtime
				.waiters()
				.map(waiter => waiter.name)
				.sort(),
		).toEqual(["writers-1", "writers-2"]);
		expect(f.model.calls).toHaveLength(2);
		const switched = await f.tool.execute("switch-waiter", {
			action: "model",
			name: "writers-2",
			model: "mock/swarm-replacement",
		});
		expect(switched.isError).not.toBe(true);
		expect(f.runtime.waiters()).toHaveLength(2);
		const resumed = Promise.withResolvers<string>();
		f.replacement.push(context => {
			resumed.resolve(JSON.stringify(context.messages));
			return { content: ["The addressed member completed its next step"] };
		});
		const started = Bun.nanoseconds();
		const wake = await post.execute("wake", { text: "@writers-2 act on this new instruction" });
		expect(wake.details?.result?.receipts).toMatchObject([{ name: "writers-2", outcome: "woken" }]);
		const context = await resumed.promise;
		expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(1000);
		expect(context).toContain("act on this new instruction");
		expect(context).toContain("An unaddressed observation");
		expect(f.model.calls).toHaveLength(2);
		expect(f.replacement.calls).toHaveLength(1);
		expect(board.member("writers-1").lastReadSeq).toBe(2);
		expect(board.member("writers-2").lastReadSeq).toBe(4);
		expect(f.runtime.waiters().map(waiter => waiter.name)).toEqual(["writers-1"]);
		await untilRuntime(f.runtime, () => f.registry.get(board.member("writers-2").agentId)?.status === "parked");
		expect(board.member("writers-2").model).toBe("mock/swarm-replacement");
		await f.tool.execute("finish", { action: "kill", name: "writers" });
		expect(f.runtime.waiters()).toEqual([]);
	});

	it("revives through IrcBus with the saved cursor, keeps reports on the board, and preserves a quota conversation for an explicit switch", async () => {
		const f = await fixture();
		f.model.push({ content: ["Initial native turn completed"] });
		const added = await f.tool.execute("revivable", {
			action: "add",
			name: "revivable",
			brief: "Preserve this exact assignment across turns",
		});
		expect(added.isError).not.toBe(true);
		const snapshot = added.details!.result!;
		const member = snapshot.members.find(candidate => candidate.name === "revivable")!;
		const actor = { id: snapshot.id, name: member.name, agentId: member.agentId };
		const coordinator = await f.runtime.ensure({
			agentId: "Main",
			cwd: f.cwd,
			sessionFile: f.journal.getSessionFile()!,
			artifactsDir: f.journal.getArtifactsDir()!,
			model: "mock/swarm-test",
			maxMembers: 32,
		});
		await untilRuntime(f.runtime, () => f.registry.get(member.agentId)?.status === "parked");
		await f.runtime.post(coordinator, "Earlier visible progress");
		await f.runtime.read(actor, { since: 1, limit: 1 });
		await f.runtime.post(coordinator, "Retained unread progress");
		const firstWake = Promise.withResolvers<string>();
		f.model.push(context => {
			firstWake.resolve(JSON.stringify(context.messages));
			return { content: [{ type: "toolCall", name: "swarm_read", arguments: { since: 2 } }] };
		});
		f.model.push({ content: ["Unique native wake completion stays in its own conversation"] });
		const send = vi.spyOn(IrcBus.global(), "send");
		const delivery = await f.runtime.post(coordinator, "@revivable continue from the saved cursor");
		expect(delivery.receipts).toMatchObject([{ name: "revivable", outcome: "revived" }]);
		const wakeContext = await firstWake.promise;
		expect(wakeContext).toContain("board moved: #4; swarm_read{since:2}");
		expect(wakeContext).toContain("Preserve this exact assignment across turns");
		expect(wakeContext).not.toContain("continue from the saved cursor");
		await untilRuntime(f.runtime, () => f.registry.get(member.agentId)?.status === "parked");
		expect(f.registry.get(member.agentId)?.session).toBeNull();
		expect(f.runtime.board(snapshot.id).member(member.name).lastReadSeq).toBe(4);
		expect(send).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(f.root.messages)).not.toContain("Unique native wake completion");
		f.model.push({ stopReason: "error", errorMessage: "RESOURCE_EXHAUSTED quota", content: [] });
		await f.runtime.post(coordinator, "@revivable inspect the next part");
		await untilRuntime(
			f.runtime,
			() =>
				f.registry.get(member.agentId)?.status === "parked" &&
				f.runtime.board(snapshot.id).member(member.name).error === "quota",
		);
		expect(f.runtime.snapshot(snapshot.id).members.find(candidate => candidate.name === member.name)).toMatchObject({
			state: "waiting",
			error: "quota",
		});
		expect(f.model.calls).toHaveLength(4);
		// A post still reaches the member, whose turn runs again on the exhausted model.
		f.model.push({ stopReason: "error", errorMessage: "RESOURCE_EXHAUSTED quota", content: [] });
		const retried = await f.runtime.post(coordinator, "@revivable try again");
		expect(retried.receipts).toMatchObject([{ name: member.name, outcome: "revived" }]);
		await untilRuntime(
			f.runtime,
			() =>
				f.model.calls.length === 5 &&
				f.registry.get(member.agentId)?.status === "parked" &&
				f.runtime.board(snapshot.id).member(member.name).error === "quota",
		);
		// Switching the model retries the failed turn on the selected model; no post is needed.
		const resumed = Promise.withResolvers<string>();
		f.replacement.push(context => {
			resumed.resolve(JSON.stringify(context.messages));
			return { content: ["Resumed on the selected model"] };
		});
		const switched = await f.tool.execute("switch-after-quota", {
			action: "model",
			name: member.name,
			model: "mock/swarm-replacement",
		});
		expect(switched.isError).not.toBe(true);
		expect(await resumed.promise).toContain("Preserve this exact assignment across turns");
		await untilRuntime(f.runtime, () => f.registry.get(member.agentId)?.status === "parked");
		expect(f.replacement.calls).toHaveLength(1);
		expect(f.model.calls).toHaveLength(5);
		expect(f.runtime.board(snapshot.id).member(member.name)).toMatchObject({
			model: "mock/swarm-replacement",
			lastReadSeq: 4,
		});
		expect(f.runtime.board(snapshot.id).member(member.name).error).toBeUndefined();
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

	it("switches a stopped quota conversation and resumes its failed turn on the selected native model", async () => {
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
		const resumed = Promise.withResolvers<string>();
		f.replacement.push(context => {
			resumed.resolve(JSON.stringify(context.messages));
			return { content: ["Continued on the selected model"] };
		});
		const switched = await f.tool.execute("switch", {
			action: "model",
			name: "quota",
			model: "mock/swarm-replacement",
		});
		expect(switched.isError).not.toBe(true);
		expect(switched.details?.result?.members.find(candidate => candidate.name === "quota")?.model).toBe(
			"mock/swarm-replacement",
		);
		// The failed turn picks up by itself in the same conversation, on the selected model.
		expect(await resumed.promise).toContain("Preserve this assignment");
		await untilRuntime(f.runtime, () => f.registry.get(member.agentId)?.status === "parked");
		expect(f.replacement.calls).toHaveLength(1);
		expect(f.runtime.board(added.details!.result!.id).member("quota").error).toBeUndefined();
	});

	it("M4 native gate: cron steers a waiting monitor, skips overlap and parks at the next wait", async () => {
		const clock = new TestSchedulerClock();
		const f = await fixture(clock);
		f.model.push({
			content: [
				{
					type: "toolCall",
					id: "create-schedule",
					name: "swarm_schedule",
					arguments: {
						action: "create",
						cron: "* * * * *",
						prompt: "Scheduled stall inspection",
						daemon: true,
					},
				},
			],
		});
		f.model.push({
			content: [{ type: "toolCall", id: "initial-wait", name: "swarm_wait", arguments: { since: 1 } }],
		});
		const added = await f.tool.execute("monitor", {
			action: "add",
			name: "monitor",
			role: "monitor",
			brief: "Monitor board stalls",
		});
		expect(added.isError).not.toBe(true);
		const member = added.details!.result!.members.find(candidate => candidate.name === "monitor")!;
		const actor = { id: added.details!.result!.id, name: "monitor", agentId: member.agentId };
		await untilRuntime(f.runtime, () => f.runtime.waiters(actor.id).length === 1);
		const task = f.runtime.scheduler.list(actor)[0]!;
		expect(task).toMatchObject({ daemon: true, running: false, owner: "monitor" });
		expect(f.runtime.isPassive(member.agentId)).toBe(true);

		const firstStarted = Promise.withResolvers<void>();
		const firstResponse = Promise.withResolvers<MockResponse>();
		cleanups.push(async () => {
			firstResponse.resolve({ content: ["Scheduler cleanup"] });
		});
		f.model.push(() => {
			firstStarted.resolve();
			return firstResponse.promise;
		});
		await clock.advanceBy(60_000);
		await firstStarted.promise;
		expect(f.runtime.scheduler.isDaemon(member.agentId)).toBe(true);
		expect(f.runtime.scheduler.list(actor)[0]?.running).toBe(true);
		expect(JSON.stringify(f.model.calls.at(-1)?.context.messages)).toContain("Scheduled stall inspection");
		expect(JSON.stringify(f.model.calls.at(-1)?.context.messages)).toContain("Monitor board stalls");
		expect(f.model.calls).toHaveLength(3);
		await clock.advanceBy(60_000);
		expect(f.model.calls).toHaveLength(3);
		firstResponse.resolve({
			content: [{ type: "toolCall", id: "first-tick-wait", name: "swarm_wait", arguments: { since: 1 } }],
		});
		await untilRuntime(
			f.runtime,
			() => f.runtime.scheduler.list(actor)[0]?.running === false && f.runtime.waiters(actor.id).length === 1,
		);

		const secondStarted = Promise.withResolvers<void>();
		f.model.push(() => {
			secondStarted.resolve();
			return {
				content: [{ type: "toolCall", id: "second-tick-wait", name: "swarm_wait", arguments: { since: 1 } }],
			};
		});
		await clock.advanceBy(60_000);
		await secondStarted.promise;
		await untilRuntime(
			f.runtime,
			() => f.runtime.scheduler.list(actor)[0]?.running === false && f.runtime.waiters(actor.id).length === 1,
		);
		expect(f.model.calls).toHaveLength(4);
		const killed = await f.runtime.schedule(actor, { action: "kill", id: task.id });
		expect(killed.id).toBe(task.id);
		expect(clock.pending.size).toBe(0);
		await clock.advanceBy(60_000 * 10);
		expect(f.model.calls).toHaveLength(4);
		await f.tool.execute("kill-monitor", { action: "kill", name: "monitor" });
		expect(f.runtime.waiters(actor.id)).toEqual([]);
	});

	it("lets a monitor kill its cron inside the tick and still park on the board", async () => {
		const clock = new TestSchedulerClock();
		const f = await fixture(clock);
		f.model.push({
			content: [
				{
					type: "toolCall",
					id: "create-schedule",
					name: "swarm_schedule",
					arguments: {
						action: "create",
						cron: "* * * * *",
						prompt: "Scheduled stall inspection",
						daemon: true,
					},
				},
			],
		});
		f.model.push({
			content: [{ type: "toolCall", id: "initial-wait", name: "swarm_wait", arguments: { since: 1 } }],
		});
		const added = await f.tool.execute("monitor", {
			action: "add",
			name: "monitor",
			role: "monitor",
			brief: "Monitor board stalls",
		});
		expect(added.isError).not.toBe(true);
		const member = added.details!.result!.members.find(candidate => candidate.name === "monitor")!;
		const actor = { id: added.details!.result!.id, name: "monitor", agentId: member.agentId };
		await untilRuntime(f.runtime, () => f.runtime.waiters(actor.id).length === 1);
		const task = f.runtime.scheduler.list(actor)[0]!;

		// Going dormant per the monitor skill: kill the cron during the tick, then park for any post.
		f.model.push({
			content: [
				{
					type: "toolCall",
					id: "dormant-kill",
					name: "swarm_schedule",
					arguments: { action: "kill", id: task.id },
				},
			],
		});
		f.model.push({
			content: [
				{ type: "toolCall", id: "dormant-wait", name: "swarm_wait", arguments: { since: 1, mentionsOnly: false } },
			],
		});
		await clock.advanceBy(60_000);
		await untilRuntime(
			f.runtime,
			() => f.runtime.waiters(actor.id)[0]?.mentionsOnly === false && !f.runtime.scheduler.isDaemon(member.agentId),
		);
		expect(f.model.calls).toHaveLength(4);
		expect(f.runtime.scheduler.list(actor)).toEqual([]);
		expect(clock.pending.size).toBe(0);
		expect(f.runtime.isPassive(member.agentId)).toBe(true);
		await clock.advanceBy(60_000 * 5);
		expect(f.model.calls).toHaveLength(4);
		await f.tool.execute("kill-monitor", { action: "kill", name: "monitor" });
		expect(f.runtime.waiters(actor.id)).toEqual([]);
	});

	it("keeps a daemon out of native busy indicators until actual user input is queued", async () => {
		initTheme();
		const clock = new TestSchedulerClock();
		const f = await fixture(clock);
		const status = await f.tool.execute("status", { action: "status" });
		const actor = { id: status.details!.result!.id, name: "coordinator", agentId: "Main" };
		cfgTerminalShowProgress.set(f.settings, true);
		const ctx = createInteractiveModeContext({
			settings: f.settings,
			session: { getAgentId: () => "Main", isStreaming: true },
		});
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(ctx);
		controller.subscribeToAgent();
		cleanups.push(async () => {
			controller.dispose();
			ctx.unsubscribe?.();
		});
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<MockResponse>();
		cleanups.push(async () => {
			response.resolve({ content: ["Daemon finished"] });
		});
		f.model.push(() => {
			started.resolve();
			return response.promise;
		});
		const scheduled = await f.runtime.schedule(actor, {
			action: "create",
			cron: "* * * * *",
			prompt: "Inspect silently",
			daemon: true,
		});
		await clock.advanceBy(60_000);
		await started.promise;
		await controller.handleEvent({ type: "agent_start" });
		expect(f.runtime.scheduler.isDaemon("Main")).toBe(true);
		expect(ctx.ensureLoadingAnimation).not.toHaveBeenCalled();
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
		expect(ctx.ui.terminal.setProgress).not.toHaveBeenCalledWith(true);
		expect(report).toHaveBeenLastCalledWith({ state: "idle" });
		await f.root.prompt("Now answer my direct question", {
			streamingBehavior: "steer",
			userInitiated: true,
			runCommands: false,
			expandPromptTemplates: false,
		});
		expect(f.runtime.scheduler.isDaemon("Main")).toBe(false);
		expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalled();
		expect(ctx.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
		await f.runtime.schedule(actor, { action: "kill", id: scheduled.id! });
		response.resolve({ content: ["Daemon finished"] });
		await f.root.abort({ goalReason: "internal", deliverQueuedMessages: false });
	});

	it("clears native activity and the existing loader while a real board waiter is parked", async () => {
		initTheme();
		await using f = await createToolFixture({ "terminal.showProgress": true });
		const stopped = vi.fn();
		const ctx = createInteractiveModeContext({
			settings: f.settings,
			session: { getAgentId: () => "Main", isStreaming: true },
			loadingAnimation: { stop: stopped },
		});
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(ctx);
		controller.subscribeToAgent();
		const abort = new AbortController();
		try {
			await controller.handleEvent({ type: "agent_start" });
			expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
			const waiting = f.runtime.wait(f.actor, { since: f.board.head }, abort.signal);
			await f.parked("coordinator", waiting);
			expect(stopped).toHaveBeenCalledTimes(1);
			expect(ctx.loadingAnimation).toBeUndefined();
			expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(false);
			expect(ctx.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
			expect(report).toHaveBeenLastCalledWith({ state: "idle" });
			abort.abort();
			expect((await waiting).interrupted).toBe(true);
			expect(ctx.composer.setRunActive).toHaveBeenLastCalledWith(true);
		} finally {
			abort.abort();
			controller.dispose();
			ctx.unsubscribe?.();
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
