import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SessionManager } from "../../src/session/session-manager";
import type {
	AddMemberRequest,
	PrepareSwarmMember,
	SwarmActor,
	SwarmCaller,
	SwarmPostResult,
} from "../../src/swarm/api";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { getSwarmCaller } from "../../src/swarm/tools/session";
import type { BoardStore } from "../../src/swarm/board-store";
import type { ToolSession } from "../../src/tools";

export type MemberRequest = Omit<AddMemberRequest, "action" | "name" | "brief"> & { brief?: string };

/**
 * A coordinator session with a real journal, the real swarm runtime on private registries, and workers whose
 * sessions carry genuine swarm bindings. Launching a member records the registry entry only; no model is called.
 */
export class ToolFixture implements AsyncDisposable {
	readonly #journals: SessionManager[] = [];
	readonly #sessions = new Map<string, ToolSession>();
	readonly #prepare: PrepareSwarmMember;

	private constructor(
		readonly cwd: string,
		readonly settings: Settings,
		readonly registry: AgentRegistry,
		readonly lifecycle: AgentLifecycleManager,
		readonly bus: IrcBus,
		readonly runtime: SwarmRuntime,
		readonly journal: SessionManager,
		readonly caller: SwarmCaller,
		readonly actor: SwarmActor,
	) {
		this.#prepare = async plan => {
			const agentId = `Member-${plan.name}`;
			const memberJournal = SessionManager.create(plan.cwd, path.join(cwd, "sessions"));
			memberJournal.appendCustomEntry("swarm.member", { ...plan.context, agentId });
			memberJournal.appendMessage({ role: "user", content: plan.brief, timestamp: Date.now() });
			await memberJournal.ensureOnDisk();
			await memberJournal.flush();
			this.#journals.push(memberJournal);
			this.#sessions.set(plan.name, this.#session(memberJournal, agentId, plan.model, plan.cwd, settings));
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
						sessionFile: memberJournal.getSessionFile() ?? null,
						status: "running",
					});
				},
			};
		};
	}

	static async create(overrides: Readonly<Record<string, unknown>> = {}): Promise<ToolFixture> {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-tools-"));
		const settings = Settings.isolated({ "compaction.enabled": false, ...overrides });
		const journal = SessionManager.create(cwd, path.join(cwd, "sessions"));
		journal.appendMessage({ role: "user", content: "Coordinate the swarm", timestamp: Date.now() });
		await journal.ensureOnDisk();
		await journal.flush();
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const bus = new IrcBus(registry, lifecycle);
		const runtime = new SwarmRuntime(registry, lifecycle, bus);
		SwarmRuntime.installGlobal(runtime);
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: journal.getSessionFile() ?? null,
			status: "running",
		});
		const session = ToolFixture.#sessionFor(journal, "Main", "mock/board-tools", cwd, settings, registry, lifecycle);
		const caller = await getSwarmCaller(session);
		const actor = await runtime.ensure(caller);
		const fixture = new ToolFixture(cwd, settings, registry, lifecycle, bus, runtime, journal, caller, actor);
		fixture.#sessions.set("coordinator", session);
		return fixture;
	}

	static #sessionFor(
		journal: SessionManager,
		agentId: string,
		model: string,
		cwd: string,
		settings: Settings,
		registry: AgentRegistry,
		lifecycle: AgentLifecycleManager,
	): ToolSession {
		return {
			cwd,
			hasUI: false,
			settings,
			sessionManager: journal,
			getSessionFile: () => journal.getSessionFile() ?? null,
			getArtifactsDir: () => journal.getArtifactsDir(),
			getSessionSpawns: () => "*",
			getAgentId: () => agentId,
			getActiveModelString: () => model,
			agentRegistry: registry,
			agentLifecycle: () => lifecycle,
		};
	}

	#session(journal: SessionManager, agentId: string, model: string, cwd: string, settings: Settings): ToolSession {
		return ToolFixture.#sessionFor(journal, agentId, model, cwd, settings, this.registry, this.lifecycle);
	}

	/** Swarm id; the board link is `swarm://<id>`. */
	get id(): string {
		return this.actor.id;
	}

	get boardUri(): string {
		return `swarm://${this.actor.id}`;
	}

	get board(): BoardStore {
		return this.runtime.board(this.actor.id);
	}

	/** Launch a worker (or numbered group) with a startup brief; its cursor starts after the startup posts. */
	async add(name: string, options: MemberRequest = {}): Promise<void> {
		const { brief = `Start ${name}`, ...request } = options;
		await this.runtime.add(this.caller, { action: "add", name, brief, ...request }, this.#prepare);
	}

	/** The tool session bound to `name` ("coordinator" for the coordinator). */
	session(name: string): ToolSession {
		const session = this.#sessions.get(name);
		if (!session) throw new Error(`Fixture has no session for ${name}`);
		return session;
	}

	/** The same session with its own settings, e.g. to switch `swarm.enabled` off. */
	sessionWith(name: string, overrides: Readonly<Record<string, unknown>>): ToolSession {
		return { ...this.session(name), settings: Settings.isolated({ "compaction.enabled": false, ...overrides }) };
	}

	async actorOf(name: string): Promise<SwarmActor> {
		return this.runtime.ensure(await getSwarmCaller(this.session(name)));
	}

	/** Post as `name` through the runtime. */
	async post(name: string, text: string, channel?: string): Promise<SwarmPostResult> {
		return this.runtime.post(await this.actorOf(name), text, channel);
	}

	/** Resolve once `name` is parked in swarm_wait; fail at once if `call` settles before that. */
	async parked(name: string, call: Promise<unknown>): Promise<void> {
		const isParked = () => this.runtime.waiters(this.id).some(waiter => waiter.name === name);
		if (isParked()) return;
		const ready = Promise.withResolvers<void>();
		const unsubscribe = this.runtime.onChange(() => {
			if (isParked()) ready.resolve();
		});
		try {
			await Promise.race([
				ready.promise,
				call.then(
					() => {
						throw new Error(`${name}'s call settled before it parked`);
					},
					error => {
						throw error;
					},
				),
			]);
		} finally {
			unsubscribe();
		}
	}

	member(name: string) {
		return this.runtime.snapshot(this.id).members.find(member => member.name === name);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.runtime.dispose();
		SwarmRuntime.resetGlobalForTests();
		await this.lifecycle.dispose();
		await this.journal.close();
		for (const journal of this.#journals) await journal.close();
		fs.rmSync(this.cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
	}
}

export function createToolFixture(overrides: Readonly<Record<string, unknown>> = {}): Promise<ToolFixture> {
	return ToolFixture.create(overrides);
}

/** The text block of a tool result. */
export function resultText(result: AgentToolResult<unknown>): string {
	const block = result.content.find(candidate => candidate.type === "text");
	if (!block || block.type !== "text") throw new Error("Tool result has no text block");
	return block.text;
}

/** Parse a JSON text block as the named result shape. */
export function resultJson<T>(result: AgentToolResult<unknown>): T {
	return JSON.parse(resultText(result)) as T;
}

/** The roster table of a `status:true` read as one record per member, keyed by column header. */
export function parseRoster(text: string): Array<Record<string, string>> {
	const lines = text.split("\n").filter(line => line.startsWith("|"));
	const cells = (line: string) => line.slice(2, -2).split(" | ");
	const [header, , ...rows] = lines;
	if (!header) throw new Error("Roster has no table");
	const columns = cells(header);
	return rows.map(row => Object.fromEntries(cells(row).map((value, index) => [columns[index], value])));
}
