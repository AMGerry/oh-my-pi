import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMainThread } from "node:worker_threads";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Model } from "@oh-my-pi/pi-ai";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { prompt } from "@oh-my-pi/pi-utils";
import { formatModelStringWithRouting } from "../config/model-resolver";
import memberBriefTemplate from "../prompts/system/swarm-member.md" with { type: "text" };
import { AgentRegistry, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import { AgentLifecycleManager, type AgentLifecycleApi } from "../registry/agent-lifecycle";
import { SessionManager } from "../session/session-manager";
import type {
	AddMemberRequest,
	ChannelRequest,
	PrepareSwarmMember,
	SwarmActor,
	SwarmApi,
	SwarmCaller,
	SwarmControlResult,
} from "./api";
import { getSwarmMemberContext, type PreparedSwarmMember, type SwarmMemberOutcome } from "./context";
import { createMemberWorkspace, removeMemberWorkspace } from "./workspaces";
import { BoardStore, type CreateBoardOptions } from "./board-store";
import {
	memberNameSchema,
	SwarmRefusal,
	type BoardPost,
	type BoardReadOptions,
	type BoardReadResult,
	type MemberState,
	type SwarmMember,
} from "./types";

export type SwarmEvent =
	| { type: "post"; swarmId: string; post: BoardPost }
	| { type: "members" | "channels" | "view"; swarmId: string };
export type SwarmListener = (event: SwarmEvent) => void;

/** Main-thread owner of each session's board writer and live event subscriptions. */
export class SwarmRuntime implements SwarmApi {
	static #global: SwarmRuntime | undefined;
	static #installed: SwarmApi | undefined;

	static global(): SwarmApi {
		return SwarmRuntime.#installed ?? SwarmRuntime.local();
	}

	/** Main-thread consumers that inspect the live store, including the board overlay. */
	static local(): SwarmRuntime {
		SwarmRuntime.#global ??= new SwarmRuntime();
		return SwarmRuntime.#global;
	}

	static installGlobal(api: SwarmApi): void {
		SwarmRuntime.#installed = api;
	}

	static resetGlobalForTests(): void {
		SwarmRuntime.#global?.dispose();
		SwarmRuntime.#global = undefined;
		SwarmRuntime.#installed = undefined;
	}

	readonly #boards = new Map<string, BoardStore>();
	readonly #directories = new Map<string, string>();
	readonly #listeners = new Set<SwarmListener>();
	readonly #locks = new Map<string, Promise<void>>();
	readonly #closing = new Set<string>();
	readonly #limits = new Map<string, number>();
	readonly #quota = new Set<string>();
	#unsubscribeRegistry: (() => void) | undefined;

	constructor(
		private readonly registry: AgentRegistryApi = AgentRegistry.global(),
		private readonly lifecycle: AgentLifecycleApi = AgentLifecycleManager.global(),
	) {
		if (!isMainThread) throw new Error("The writable swarm runtime belongs to the main thread");
	}

	/** Release runtime subscriptions; session lifetime remains owned by AgentLifecycleManager. */
	dispose(): void {
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		this.#listeners.clear();
	}

	async #exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(id);
		const gate = Promise.withResolvers<void>();
		this.#locks.set(id, gate.promise);
		await previous;
		try {
			return await operation();
		} finally {
			gate.resolve();
			if (this.#locks.get(id) === gate.promise) this.#locks.delete(id);
		}
	}

	#watchRegistry(): void {
		this.#unsubscribeRegistry ??= this.registry.onChange(event => this.#syncRef(event.ref));
	}

	#syncRef(ref: AgentRef): void {
		for (const board of this.#boards.values()) {
			for (const member of board.listMembers()) {
				if (member.agentId !== ref.id || member.killed) continue;
				if (member.sessionFile && ref.sessionFile && member.sessionFile !== ref.sessionFile) continue;
				const sessionFile = ref.sessionFile ?? member.sessionFile;
				const active = ref.session?.model;
				const model = active
					? `${formatModelStringWithRouting(active)}${ref.session?.thinkingLevel ? `:${ref.session.thinkingLevel}` : ""}`
					: member.model;
				if (sessionFile !== member.sessionFile || model !== member.model)
					board.updateMember(member.name, { sessionFile, model });
				this.notify({ type: "members", swarmId: board.metadata.id });
			}
		}
	}

	#restore(board: BoardStore): void {
		for (const member of board.listMembers()) {
			if (member.role === "coordinator") continue;
			const existing = this.registry.get(member.agentId);
			if (existing) {
				if (existing.sessionFile && member.sessionFile && existing.sessionFile !== member.sessionFile)
					throw new SwarmRefusal(`Agent ${member.agentId} belongs to a different conversation`);
				continue;
			}
			if (member.wakeMode !== null || member.waitSince !== null)
				board.updateMember(member.name, { wakeMode: null, waitSince: null });
			if (member.sessionFile)
				this.registry.registerIfAvailable(
					{
						id: member.agentId,
						displayName: member.name,
						kind: "sub",
						parentId: board.member(member.owner ?? "coordinator").agentId,
						session: null,
						sessionFile: member.sessionFile,
						status: member.killed ? "aborted" : "parked",
						history: { agent: "swarm", resolvedModel: member.model },
					},
					null,
				);
		}
	}

	#authorize(actor: SwarmActor): BoardStore {
		const board = this.board(actor.id);
		const member = board.member(actor.name);
		if (member.agentId !== actor.agentId) throw new SwarmRefusal("The session's swarm identity has changed");
		if (member.killed || this.#closing.has(member.agentId))
			throw new SwarmRefusal(`Member ${actor.name} is killed or closing`);
		return board;
	}

	async ensure(caller: SwarmCaller): Promise<SwarmActor> {
		this.#watchRegistry();
		let board: BoardStore;
		let name: string;
		if (caller.context) {
			const context = caller.context;
			if (context.agentId !== caller.agentId)
				throw new SwarmRefusal("Inherited swarm context needs its own member binding");
			board = this.open(context.dir);
			if (board.metadata.id !== context.id)
				throw new SwarmRefusal("Swarm directory identity does not match the session");
			name = context.name;
		} else {
			if (this.registry.get(caller.agentId)?.kind !== "main")
				throw new SwarmRefusal("Join the coordinator's swarm through swarm add before using its board");
			name = "coordinator";
			const dir = path.join(caller.artifactsDir, "swarm");
			if (fs.existsSync(path.join(dir, "swarm.json"))) board = this.open(dir);
			else
				board = this.create(dir, {
					id: `swarm-${randomUUID().replaceAll("-", "")}`,
					title: path.basename(caller.cwd) || "Swarm",
					coordinator: {
						agentId: caller.agentId,
						sessionFile: caller.sessionFile,
						model: caller.model,
						role: "coordinator",
						wakeMode: null,
						waitSince: null,
						lastReadSeq: 0,
						lastPostSeq: 0,
						lastPostTime: null,
						channels: [],
						workspace: "inherit",
						workspacePath: caller.cwd,
						killed: false,
					},
					capabilities: {
						channels: true,
						workspaces: true,
						narrator: true,
						monitor: true,
						graph: false,
						customPage: true,
					},
				});
			const coordinator = board.member(name);
			if (coordinator.agentId !== caller.agentId || coordinator.sessionFile !== caller.sessionFile)
				throw new SwarmRefusal("This board belongs to another coordinator session");
			if (coordinator.model !== caller.model) board.updateMember(name, { model: caller.model });
		}
		const actor = { id: board.metadata.id, name, agentId: caller.agentId };
		this.#authorize(actor);
		if (name === "coordinator" || !this.#limits.has(actor.id)) this.#limits.set(actor.id, caller.maxMembers);
		this.#restore(board);
		return actor;
	}

	memberState(member: SwarmMember): MemberState {
		if (member.killed) return "killed";
		if (member.wakeMode !== null || this.#quota.has(member.agentId)) return "waiting";
		const ref = this.registry.get(member.agentId);
		if (ref?.sessionFile && member.sessionFile && ref.sessionFile !== member.sessionFile) return "stopped";
		return ref?.status === "running" ? "working" : "stopped";
	}

	snapshot(id: string): SwarmControlResult {
		const board = this.board(id);
		const posts = board.posts();
		return {
			id,
			title: board.title,
			head: board.head,
			dir: board.dir,
			capabilities: structuredClone(board.capabilities),
			boardUri: board.boardUri,
			members: board.listMembers().map(member => ({
				...member,
				state: this.memberState(member),
				unread: posts.filter(post => post.seq > member.lastReadSeq && board.visible(post, member.name)).length,
			})),
		};
	}

	async status(actor: SwarmActor): Promise<SwarmControlResult> {
		this.#authorize(actor);
		return this.snapshot(actor.id);
	}

	async add(
		caller: SwarmCaller,
		request: AddMemberRequest,
		prepare: PrepareSwarmMember,
		signal?: AbortSignal,
	): Promise<SwarmControlResult> {
		const actor = await this.ensure(caller);
		return this.#exclusive(actor.id, async () => {
			const board = this.#authorize(actor);
			if (!request.brief.trim()) throw new SwarmRefusal("A member brief must contain text");
			if (request.tasks && request.n !== undefined) throw new SwarmRefusal("Choose tasks or n for a numbered group");
			const count = request.tasks?.length ?? request.n ?? 1;
			const grouped = request.tasks !== undefined || request.n !== undefined;
			if (!Number.isSafeInteger(count) || count < 1 || count > (this.#limits.get(actor.id) ?? caller.maxMembers))
				throw new SwarmRefusal("Group size exceeds swarm.maxMembers");
			const names = Array.from({ length: count }, (_, index) =>
				grouped ? `${request.name}-${index + 1}` : request.name,
			);
			const prior = board.listMembers();
			if (request.name === "all" || request.name === "coordinator" || !memberNameSchema.allows(request.name))
				throw new SwarmRefusal("Choose a lowercase member name; all and coordinator are reserved");
			for (const name of [request.name, ...names]) {
				if (!memberNameSchema.allows(name)) throw new SwarmRefusal(`Member name ${name} exceeds the name format`);
				if (prior.some(member => member.name === name || member.group === name))
					throw new SwarmRefusal(`Member or group name ${name} has already been used`);
			}
			if (
				prior.filter(member => !member.killed && member.role !== "coordinator").length + count >
				(this.#limits.get(actor.id) ?? caller.maxMembers)
			)
				throw new SwarmRefusal("Adding these members would exceed swarm.maxMembers");
			const channels = [...new Set(request.channels ?? [])];
			const postingMember = board.member(actor.name);
			if (
				postingMember.role === "worker" &&
				channels[0] &&
				channels[0] !== "main" &&
				!postingMember.channels.includes(channels[0])
			)
				throw new SwarmRefusal(`Subscribe to ${channels[0]} before posting a helper's brief there`);
			for (const channel of channels) {
				if (channel === "main") continue;
				const area = board.channels().get(channel);
				if (!area || area.archived)
					throw new SwarmRefusal(`Create an active channel ${channel} before assigning members`);
			}
			const coordinator = board.member("coordinator");
			const coordinatorRef = this.registry.get(coordinator.agentId);
			const coordinatorModel = coordinatorRef?.session?.model;
			const model =
				request.model ??
				(coordinatorModel
					? `${formatModelStringWithRouting(coordinatorModel)}${coordinatorRef.session?.thinkingLevel ? `:${coordinatorRef.session.thinkingLevel}` : ""}`
					: coordinator.model);
			const role =
				request.role ??
				(/^narrator(?:-\d+)?$/.test(request.name)
					? "narrator"
					: /^monitor(?:-\d+)?$/.test(request.name)
						? "monitor"
						: "worker");
			let forkFrom: string | undefined;
			if (request.fork) {
				const source = board.member(request.fork);
				if (source.killed || !source.sessionFile)
					throw new SwarmRefusal(`Member ${request.fork} has no available fork source`);
				forkFrom = source.sessionFile;
			}
			const launches: Array<{ name: string; brief: string; member: SwarmMember; prepared: PreparedSwarmMember }> =
				[];
			try {
				for (const [index, name] of names.entries()) {
					signal?.throwIfAborted();
					const workspace = request.workspace ?? "inherit";
					const location =
						workspace === "inherit"
							? { workspacePath: caller.cwd }
							: await createMemberWorkspace(
									caller.cwd,
									coordinator.workspacePath ?? caller.cwd,
									board.dir,
									actor.id,
									name,
									signal,
								);
					const brief = request.tasks ? `${request.brief}\n\n${request.tasks[index]}` : request.brief;
					const member: SwarmMember = {
						agentId: "",
						sessionFile: null,
						model,
						role,
						wakeMode: null,
						waitSince: null,
						lastReadSeq: board.head,
						lastPostSeq: 0,
						lastPostTime: null,
						channels,
						workspace,
						...location,
						killed: false,
						owner: actor.name,
						...(grouped ? { group: request.name } : {}),
						...(request.fork ? { forkOf: request.fork } : {}),
						subscribedSince: Object.fromEntries(channels.map(channel => [channel, board.head])),
					};
					let prepared: PreparedSwarmMember;
					try {
						prepared = await prepare({
							name,
							brief,
							model,
							coordinatorModel: coordinatorModel
								? formatModelStringWithRouting(coordinatorModel)
								: coordinator.model,
							cwd: location.workspacePath,
							forkFrom,
							context: { kind: "swarm", id: actor.id, name, dir: board.dir },
						});
					} catch (error) {
						if (workspace !== "inherit") {
							try {
								await removeMemberWorkspace(board.dir, actor.id, name, member);
							} catch (cleanupError) {
								throw new Error(
									`Member preparation failed; workspace retained at ${location.workspacePath}: ${String(cleanupError)}`,
									{ cause: error },
								);
							}
						}
						throw error;
					}
					member.agentId = prepared.agentId;
					member.model = prepared.model;
					launches.push({ name, brief, member, prepared });
				}
				signal?.throwIfAborted();
			} catch (error) {
				for (const launch of launches) {
					if (launch.member.workspace === "inherit") continue;
					try {
						await removeMemberWorkspace(board.dir, actor.id, launch.name, launch.member);
					} catch (cleanupError) {
						logger.warn("Prepared swarm workspace retained", {
							path: launch.member.workspacePath,
							error: String(cleanupError),
						});
					}
				}
				throw error;
			}
			for (const launch of launches) board.addMember(launch.name, launch.member);
			for (const channel of channels) {
				if (channel === "main") continue;
				const area = board.channels().get(channel)!;
				board.setChannel(channel, { ...area, subscribers: [...new Set([...area.subscribers, ...names])] });
			}
			for (const launch of launches)
				this.post(actor.id, actor.name, `@${launch.name} ${launch.brief}`, channels[0] ?? "main");
			const cursor = board.head;
			for (const launch of launches) board.updateMember(launch.name, { lastReadSeq: cursor });
			await Promise.all(
				launches.map(async launch => {
					const briefing = prompt.render(memberBriefTemplate, {
						name: launch.name,
						role,
						id: actor.id,
						boardUri: board.boardUri,
						dir: board.dir,
						cwd: launch.member.workspacePath,
						model: launch.prepared.model,
						channels: channels.join(", ") || "main",
						cursor,
						narrator: role === "narrator",
						monitor: role === "monitor",
						worker: role === "worker",
					});
					try {
						await launch.prepared.start(`${briefing}\n\n${launch.brief}`, outcome =>
							this.#settled(actor.id, launch.name, outcome),
						);
					} catch (error) {
						await this.#settled(actor.id, launch.name, {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}),
			);
			this.notify({ type: "members", swarmId: actor.id });
			return { ...this.snapshot(actor.id), added: names };
		});
	}

	async #settled(id: string, name: string, outcome: SwarmMemberOutcome): Promise<void> {
		const board = this.board(id);
		const member = board.member(name);
		if (member.killed || this.#closing.has(member.agentId)) return;
		const error = outcome.error && /RESOURCE_EXHAUSTED|\b429\b|quota/i.test(outcome.error) ? "quota" : outcome.error;
		if (error === "quota") this.#quota.add(member.agentId);
		else this.#quota.delete(member.agentId);
		const ref = this.registry.get(member.agentId);
		board.updateMember(name, {
			sessionFile: ref?.sessionFile ?? member.sessionFile,
			...(outcome.model ? { model: outcome.model } : {}),
			error,
			wakeMode: null,
			waitSince: null,
		});
		if (ref?.status === "idle") await this.lifecycle.park(member.agentId);
		this.notify({ type: "members", swarmId: id });
	}

	async kill(actor: SwarmActor, name: string): Promise<SwarmControlResult> {
		return this.#exclusive(actor.id, async () => {
			const board = this.#authorize(actor);
			const targets = board.listMembers().filter(member => member.name === name || member.group === name);
			if (!targets.length) throw new SwarmRefusal(`Unknown swarm member or group: ${name}`);
			if (targets.some(member => member.role === "coordinator"))
				throw new SwarmRefusal("The coordinator owns the swarm lifetime");
			if (targets.every(member => member.killed))
				throw new SwarmRefusal(`Member or group ${name} is already killed`);
			const killed: string[] = [];
			const retainedBranches: string[] = [];
			for (const target of targets.filter(member => !member.killed)) {
				this.#closing.add(target.agentId);
				try {
					const ref = this.registry.get(target.agentId);
					if (ref) await this.lifecycle.release(target.agentId, ref, { tombstone: true });
					const cleanup = await removeMemberWorkspace(board.dir, actor.id, target.name, target);
					if (cleanup.retainedBranch) retainedBranches.push(cleanup.retainedBranch);
					board.updateMember(target.name, { killed: true, wakeMode: null, waitSince: null });
					killed.push(target.name);
				} finally {
					this.#closing.delete(target.agentId);
					this.notify({ type: "members", swarmId: actor.id });
				}
			}
			return { ...this.snapshot(actor.id), killed, ...(retainedBranches.length ? { retainedBranches } : {}) };
		});
	}

	async title(actor: SwarmActor, title: string): Promise<SwarmControlResult> {
		const board = this.#authorize(actor);
		if (actor.name !== "coordinator") throw new SwarmRefusal("Only the coordinator can set the swarm title");
		board.setTitle(title);
		this.notify({ type: "members", swarmId: actor.id });
		return this.snapshot(actor.id);
	}

	async channel(actor: SwarmActor, request: ChannelRequest): Promise<SwarmControlResult> {
		return this.#exclusive(actor.id, async () => {
			const board = this.#authorize(actor);
			const name = request.channel;
			if (request.op === "list")
				return { ...this.snapshot(actor.id), channels: Object.fromEntries(board.channels()) };
			if (!name || name === "main") throw new SwarmRefusal("Choose a named channel; main is shared by every member");
			const channel = board.channels().get(name);
			if (request.op === "create") {
				if (channel) throw new SwarmRefusal(`Channel ${name} already exists`);
				board.setChannel(name, {
					topic: request.topic ?? "",
					createdBy: actor.name,
					subscribers: [],
					archived: false,
				});
			} else {
				if (!channel) throw new SwarmRefusal(`Unknown channel: ${name}`);
				if (request.op === "archive") {
					if (actor.name !== "coordinator" && channel.createdBy !== actor.name)
						throw new SwarmRefusal("Only the coordinator or channel creator can archive this channel");
					board.setChannel(name, { ...channel, archived: true });
				} else {
					if (channel.archived) throw new SwarmRefusal(`Channel ${name} is archived`);
					const member = board.member(actor.name);
					const subscribe = request.op === "subscribe";
					const subscribedSince = { ...member.subscribedSince };
					if (subscribe && !member.channels.includes(name)) subscribedSince[name] = board.head;
					if (!subscribe) delete subscribedSince[name];
					board.updateMember(actor.name, {
						channels: subscribe
							? [...new Set([...member.channels, name])]
							: member.channels.filter(value => value !== name),
						subscribedSince,
					});
					board.setChannel(name, {
						...channel,
						subscribers: subscribe
							? [...new Set([...channel.subscribers, actor.name])]
							: channel.subscribers.filter(value => value !== actor.name),
					});
				}
			}
			this.notify({ type: "channels", swarmId: actor.id });
			return { ...this.snapshot(actor.id), channels: Object.fromEntries(board.channels()) };
		});
	}

	async switchModel(
		actor: SwarmActor,
		name: string | undefined,
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
	): Promise<SwarmControlResult> {
		return this.#exclusive(actor.id, async () => {
			const board = this.#authorize(actor);
			const target = name ?? actor.name;
			const member = board.member(target);
			if (member.killed) throw new SwarmRefusal(`Member ${target} is killed`);
			if (this.memberState(member) === "working")
				throw new SwarmRefusal(`Member ${target} is working; wait until it parks before changing model`);
			const identity = formatModelStringWithRouting(model);
			if (this.lifecycle.isParking(member.agentId)) await this.lifecycle.park(member.agentId);
			const ref = this.registry.get(member.agentId);
			if (ref?.session) await ref.session.setModelTemporary(model, thinkingLevel);
			else {
				if (!member.sessionFile) throw new SwarmRefusal(`Member ${target} has no persisted conversation`);
				const journal = await SessionManager.open(member.sessionFile, undefined, undefined, {
					suppressBreadcrumb: true,
					throwIfMissing: true,
				});
				try {
					if (getSwarmMemberContext(journal.getEntries())?.agentId !== member.agentId)
						throw new SwarmRefusal("The persisted conversation belongs to a different member");
					journal.appendModelChange(identity, "temporary");
					if (thinkingLevel !== undefined)
						journal.appendThinkingLevelChange(
							thinkingLevel === AUTO_THINKING ? undefined : thinkingLevel,
							thinkingLevel,
						);
					await journal.flush();
				} finally {
					await journal.close();
				}
			}
			board.updateMember(target, {
				model: `${identity}${thinkingLevel ? `:${thinkingLevel}` : ""}`,
				error: undefined,
			});
			this.#quota.delete(member.agentId);
			this.notify({ type: "members", swarmId: actor.id });
			return this.snapshot(actor.id);
		});
	}

	create(dir: string, options: CreateBoardOptions): BoardStore {
		if (this.#boards.has(options.id)) throw new Error(`Swarm ${options.id} is already open`);
		const board = BoardStore.create(dir, options);
		this.#boards.set(board.metadata.id, board);
		this.#directories.set(fs.realpathSync(board.dir), board.metadata.id);
		this.notify({ type: "members", swarmId: board.metadata.id });
		return board;
	}

	open(dir: string): BoardStore {
		const canonical = fs.realpathSync(path.resolve(dir));
		const existingId = this.#directories.get(canonical);
		if (existingId) return this.board(existingId);
		const board = BoardStore.open(canonical);
		if (this.#boards.has(board.metadata.id))
			throw new Error(`Swarm id ${board.metadata.id} belongs to another directory`);
		this.#boards.set(board.metadata.id, board);
		this.#directories.set(canonical, board.metadata.id);
		return board;
	}

	board(id: string): BoardStore {
		const board = this.#boards.get(id);
		if (!board) throw new Error(`Unknown swarm: ${id}`);
		return board;
	}

	list(): BoardStore[] {
		return [...this.#boards.values()];
	}

	/** The append is durable when observers receive the event. */
	post(id: string, agent: string, text: string, channel?: string): BoardPost {
		const post = this.board(id).append(agent, text, channel);
		this.notify({ type: "post", swarmId: id, post });
		return post;
	}

	read(id: string, agent: string, options: BoardReadOptions = {}): BoardReadResult {
		const result = this.board(id).read(agent, options);
		this.notify({ type: "members", swarmId: id });
		return result;
	}

	onChange(listener: SwarmListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	notify(event: SwarmEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(structuredClone(event));
			} catch (error) {
				logger.error("Swarm observer failed", { error: String(error), swarmId: event.swarmId });
			}
		}
	}
}
