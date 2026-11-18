import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMainThread } from "node:worker_threads";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Model } from "@oh-my-pi/pi-ai";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import { formatModelStringWithRouting } from "../config/model-resolver";
import { IrcBus, type IrcBusApi } from "../irc/bus";
import memberBriefTemplate from "../prompts/system/swarm-member.md" with { type: "text" };
import { AgentRegistry, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import { AgentLifecycleManager, type AgentLifecycleApi } from "../registry/agent-lifecycle";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import { SessionManager } from "../session/session-manager";
import { isUserTurnInitiator } from "../session/messages";
import type {
	AddMemberRequest,
	ChannelRequest,
	PrepareSwarmMember,
	ScheduleParams,
	SwarmScheduleResult,
	SwarmActor,
	SwarmApi,
	SwarmCaller,
	SwarmControlResult,
	SwarmDeliveryReceipt,
	SwarmPostResult,
	SwarmReadResult,
	SwarmWaitResult,
	SwarmWaitSnapshot,
	WaitParams,
} from "./api";
import { SWARM_WAIT_DISCONNECTED } from "./api";
import {
	getSwarmMemberContext,
	type PreparedSwarmMember,
	SWARM_MEMBER_AGENT,
	type SwarmMemberOutcome,
} from "./context";
import { createMemberWorkspace, removeMemberWorkspace, verifyMemberWorkspace } from "./workspaces";
import { BoardStore, type CreateBoardOptions } from "./board-store";
import { SwarmScheduler, type ScheduledTaskSnapshot, type SchedulerClock } from "./scheduler";
import {
	memberNameSchema,
	SwarmRefusal,
	type BoardPost,
	type BoardReadOptions,
	type MemberState,
	type SwarmMember,
} from "./types";

export type SwarmEvent =
	| { type: "post"; swarmId: string; post: BoardPost }
	| { type: "members" | "channels" | "view"; swarmId: string };
export type SwarmListener = (event: SwarmEvent) => void;

interface WaitSettlement {
	interrupted?: true;
	preserveCursor?: true;
}
interface PendingSwarmWait extends SwarmWaitSnapshot {
	settle(options?: WaitSettlement): SwarmDeliveryReceipt;
}

/** Main-thread owner of each session's board writer and live event subscriptions. */
/**
 * The transcript a registry ref speaks for. A live session reports its current file, which follows `/new`,
 * `/resume` and a fork inside one process; the registered file stands in while no session is attached.
 */
function conversationFile(ref: AgentRef | undefined): string | null | undefined {
	return ref?.session?.sessionFile ?? ref?.sessionFile;
}

export class SwarmRuntime implements SwarmApi {
	static #global: SwarmRuntime | undefined;
	static #installed: SwarmApi | undefined;

	static global(): SwarmApi {
		return SwarmRuntime.#installed ?? SwarmRuntime.local();
	}

	/** Main-thread consumers that inspect the live store, including the board overlay. */
	static local(): SwarmRuntime {
		if (SwarmRuntime.#installed instanceof SwarmRuntime) return SwarmRuntime.#installed;
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
	readonly #waiters = new Map<string, PendingSwarmWait>();
	readonly #activeLaunches = new Set<string>();
	readonly #sessionObservers = new Map<string, { session: AgentSessionHandle; unsubscribe: () => void }>();
	readonly scheduler: SwarmScheduler;
	#disposed = false;
	#unsubscribeRegistry: (() => void) | undefined;

	constructor(
		private readonly registry: AgentRegistryApi = AgentRegistry.global(),
		private readonly lifecycle: AgentLifecycleApi = AgentLifecycleManager.global(),
		private readonly bus?: IrcBusApi,
		clock?: SchedulerClock,
	) {
		if (!isMainThread) throw new Error("The writable swarm runtime belongs to the main thread");
		this.scheduler = new SwarmScheduler({
			canRun: owner => this.#canSchedule(owner),
			run: (task, signal) => this.#runScheduledTurn(task, signal),
			changed: swarmId => this.notify({ type: "members", swarmId }),
			clock,
		});
	}

	/** Release runtime subscriptions; session lifetime remains owned by AgentLifecycleManager. */
	dispose(): void {
		this.#disposed = true;
		this.scheduler.dispose();
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		this.#listeners.clear();
		for (const waiter of this.#waiters.values()) waiter.settle({ interrupted: true, preserveCursor: true });
		for (const observer of this.#sessionObservers.values()) observer.unsubscribe();
		this.#sessionObservers.clear();
		this.#activeLaunches.clear();
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
				if (member.agentId !== ref.id) continue;
				this.#observeSession(board, member.name, member, ref);
				if (member.killed) continue;
				const current = conversationFile(ref);
				if (member.sessionFile && current && member.sessionFile !== current) continue;
				const sessionFile = current ?? member.sessionFile;
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

	#observeSession(board: BoardStore, name: string, member: SwarmMember, ref: AgentRef): void {
		if (member.role === "coordinator") return;
		const key = `${board.metadata.id}:${member.agentId}`;
		const current = conversationFile(ref);
		const sameFile = !member.sessionFile || !current || member.sessionFile === current;
		const session = member.killed || !sameFile ? null : ref.session;
		const previous = this.#sessionObservers.get(key);
		if (previous?.session === session) return;
		previous?.unsubscribe();
		this.#sessionObservers.delete(key);
		if (!session) return;
		let wasRunning = ref.status === "running";
		const unsubscribe = session.subscribeRunState(state => {
			const completed = wasRunning && state === "idle";
			wasRunning = state === "running";
			if (!completed || this.#activeLaunches.has(key) || this.#disposed) return;
			const last = session.messages.findLast(message => message.role === "assistant");
			const error =
				last?.role === "assistant" && last.stopReason === "error"
					? (last.errorMessage ?? "Model request failed")
					: undefined;
			queueMicrotask(() => {
				void this.#settled(board.metadata.id, name, { error }).catch(error => {
					logger.error("Swarm wake outcome failed", { agentId: member.agentId, error: String(error) });
				});
			});
		});
		this.#sessionObservers.set(key, { session, unsubscribe });
	}

	#restore(board: BoardStore): void {
		for (const member of board.listMembers()) {
			if (
				(member.wakeMode !== null || member.waitSince !== null) &&
				!this.#waiters.has(`${board.metadata.id}:${member.agentId}`)
			)
				board.updateMember(member.name, { wakeMode: null, waitSince: null });
			if (member.role === "coordinator") continue;
			const existing = this.registry.get(member.agentId);
			if (existing) {
				const current = conversationFile(existing);
				if (current && member.sessionFile && current !== member.sessionFile)
					throw new SwarmRefusal(`Agent ${member.agentId} belongs to a different conversation`);
				continue;
			}
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
						history: { agent: SWARM_MEMBER_AGENT, resolvedModel: member.model },
					},
					null,
				);
		}
	}

	#authorize(actor: SwarmActor): BoardStore {
		if (this.#disposed) throw new SwarmRefusal("The swarm runtime is closed");
		const board = this.board(actor.id);
		const member = board.member(actor.name);
		if (member.agentId !== actor.agentId) throw new SwarmRefusal("The session's swarm identity has changed");
		if (member.killed || this.#closing.has(member.agentId))
			throw new SwarmRefusal(`Member ${actor.name} is killed or closing`);
		const current = conversationFile(this.registry.get(member.agentId));
		if (current && member.sessionFile && current !== member.sessionFile)
			throw new SwarmRefusal("This member's conversation is not active in the native registry");
		return board;
	}

	async ensure(caller: SwarmCaller): Promise<SwarmActor> {
		if (this.#disposed) throw new SwarmRefusal("The swarm runtime is closed");
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

	#memberState(member: SwarmMember, id: string): MemberState {
		if (member.killed) return "killed";
		if (this.#waiters.has(`${id}:${member.agentId}`) || this.#quota.has(member.agentId)) return "waiting";
		const ref = this.registry.get(member.agentId);
		const current = conversationFile(ref);
		if (current && member.sessionFile && current !== member.sessionFile) return "stopped";
		// A root session is registered as running for its whole life; its live run tells work from idle.
		if (ref?.kind === "main") return ref.session?.isStreaming ? "working" : "stopped";
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
			members: board.listMembers().map(member => {
				const waiting = this.#waiters.get(`${id}:${member.agentId}`);
				return {
					...member,
					state: this.#memberState(member, id),
					wakeMode: waiting ? (waiting.mentionsOnly ? ("mentions" as const) : ("any" as const)) : null,
					waitSince: waiting?.since ?? null,
					unread: posts.filter(post => post.seq > member.lastReadSeq && board.visible(post, member.name)).length,
				};
			}),
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
			const postingMember = board.member(actor.name);
			// A worker's helper joins its adder's active channels unless the request names its own.
			const inherited =
				postingMember.role === "coordinator"
					? []
					: postingMember.channels.filter(
							channel => channel === "main" || board.channels().get(channel)?.archived === false,
						);
			const channels = [...new Set(request.channels ?? inherited)];
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
			for (const launch of launches) {
				const post = this.append(actor.id, actor.name, `@${launch.name} ${launch.brief}`, channels[0] ?? "main");
				this.#wakeWaiters(board, post);
			}
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
						agentDir: caller.agentDir ?? getAgentDir(),
						cwd: launch.member.workspacePath,
						model: launch.prepared.model,
						channels: channels.join(", ") || "main",
						cursor,
						narrator: role === "narrator",
						monitor: role === "monitor",
						worker: role === "worker",
					});
					try {
						this.#activeLaunches.add(`${actor.id}:${launch.member.agentId}`);
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
		if (this.#disposed) return;
		const board = this.board(id);
		const member = board.member(name);
		this.#activeLaunches.delete(`${id}:${member.agentId}`);
		if (member.killed || this.#closing.has(member.agentId)) return;
		const ref = this.registry.get(member.agentId);
		const file = conversationFile(ref);
		if (file && member.sessionFile && file !== member.sessionFile) return;
		const error = outcome.error && /RESOURCE_EXHAUSTED|\b429\b|quota/i.test(outcome.error) ? "quota" : outcome.error;
		if (error === "quota") this.#quota.add(member.agentId);
		else this.#quota.delete(member.agentId);
		board.updateMember(name, {
			sessionFile: file ?? member.sessionFile,
			...(outcome.model ? { model: outcome.model } : {}),
			error,
		});
		if (ref?.status === "idle") {
			const session = ref.session;
			await session?.waitForIrcReplies();
			const current = this.registry.get(member.agentId);
			if (current === ref && current.session === session && current.status === "idle")
				await this.lifecycle.park(member.agentId);
		}
		this.notify({ type: "members", swarmId: id });
	}

	async kill(actor: SwarmActor, name: string): Promise<SwarmControlResult> {
		return this.#exclusive(actor.id, async () => {
			const board = this.#authorize(actor);
			const targets = this.#managedTargets(board, actor, name, false);
			if (targets.some(member => member.role === "coordinator"))
				throw new SwarmRefusal("The coordinator owns the swarm lifetime");
			if (targets.every(member => member.killed))
				throw new SwarmRefusal(`Member or group ${name} is already killed`);
			const live = targets.filter(member => !member.killed);
			// Every workspace is checked while its member still runs, so a refusal leaves the whole group as it was.
			for (const target of live) await verifyMemberWorkspace(board.dir, actor.id, target.name, target);
			const killed: string[] = [];
			const retainedBranches: string[] = [];
			const retainedWorkspaces: string[] = [];
			for (const target of live) {
				this.#closing.add(target.agentId);
				this.scheduler.killOwner({ id: actor.id, name: target.name, agentId: target.agentId });
				try {
					const ref = this.registry.get(target.agentId);
					if (ref) await this.lifecycle.release(target.agentId, ref, { tombstone: true });
					board.updateMember(target.name, { killed: true, wakeMode: null, waitSince: null });
					killed.push(target.name);
					try {
						const cleanup = await removeMemberWorkspace(board.dir, actor.id, target.name, target);
						if (cleanup.retainedBranch) retainedBranches.push(cleanup.retainedBranch);
					} catch (error) {
						// The member wrote between the check and its stop: the working copy stays for landing by hand.
						if (!(error instanceof SwarmRefusal) || !target.workspacePath) throw error;
						retainedWorkspaces.push(target.workspacePath);
					}
				} finally {
					this.#waiters.get(`${actor.id}:${target.agentId}`)?.settle({ interrupted: true, preserveCursor: true });
					this.#closing.delete(target.agentId);
					this.notify({ type: "members", swarmId: actor.id });
				}
			}
			return {
				...this.snapshot(actor.id),
				killed,
				...(retainedBranches.length ? { retainedBranches } : {}),
				...(retainedWorkspaces.length ? { retainedWorkspaces } : {}),
			};
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
					const subscribe = request.op === "subscribe";
					const targets = this.#managedTargets(board, actor, request.name ?? actor.name, true).filter(
						member => !member.killed,
					);
					if (!targets.length) throw new SwarmRefusal(`Member or group ${request.name} is killed`);
					let subscribers = channel.subscribers;
					for (const target of targets) {
						const subscribedSince = { ...target.subscribedSince };
						if (subscribe && !target.channels.includes(name)) subscribedSince[name] = board.head;
						if (!subscribe) delete subscribedSince[name];
						board.updateMember(target.name, {
							channels: subscribe
								? [...new Set([...target.channels, name])]
								: target.channels.filter(value => value !== name),
							subscribedSince,
						});
						subscribers = subscribe
							? [...new Set([...subscribers, target.name])]
							: subscribers.filter(value => value !== target.name);
					}
					board.setChannel(name, { ...channel, subscribers });
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
			const own = target === actor.name;
			if (actor.name !== "coordinator" && !own && member.owner !== actor.name)
				throw new SwarmRefusal(
					`A member switches its own model and its helpers' models; ask the coordinator to switch ${target}`,
				);
			// The caller's own turn is the one running; its next request uses the new model.
			if (!own && this.#memberState(member, actor.id) === "working")
				throw new SwarmRefusal(`Member ${target} is working; wait until it parks before changing model`);
			const resume = !own && member.error === "quota" && !this.#waiters.has(`${actor.id}:${member.agentId}`);
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
			if (resume) void this.#resumeAfterQuota(actor.id, target, member.agentId);
			return this.snapshot(actor.id);
		});
	}

	/** A member whose turn failed on quota picks that turn up again on its newly selected model. */
	async #resumeAfterQuota(id: string, name: string, agentId: string): Promise<void> {
		try {
			if (this.#disposed || this.#closing.has(agentId)) return;
			const session = await this.lifecycle.ensureLive(agentId);
			if (this.#disposed || this.#closing.has(agentId) || this.board(id).member(name).killed) return;
			if (session.isStreaming) return;
			if (!(await session.retry()))
				logger.debug("Swarm member had no failed turn to resume after its model switch", { agentId });
		} catch (error) {
			logger.warn("Swarm member did not resume after its model switch", { agentId, error: String(error) });
		}
	}

	/**
	 * Members `actor` may manage by member or group name: the coordinator any of them, every other member the
	 * helpers it added and, when `self` allows, itself.
	 */
	#managedTargets(
		board: BoardStore,
		actor: SwarmActor,
		name: string,
		self: boolean,
	): Array<SwarmMember & { name: string }> {
		const targets = board.listMembers().filter(member => member.name === name || member.group === name);
		if (!targets.length) throw new SwarmRefusal(`Unknown swarm member or group: ${name}`);
		if (actor.name === "coordinator") return targets;
		const foreign = targets.find(member => member.owner !== actor.name && !(self && member.name === actor.name));
		if (foreign)
			throw new SwarmRefusal(
				`${foreign.name} belongs to ${foreign.owner ?? "the coordinator"}; a member manages ${self ? "itself and " : ""}the helpers it added`,
			);
		return targets;
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
	append(id: string, agent: string, text: string, channel?: string): BoardPost {
		const post = this.board(id).append(agent, text, channel);
		this.notify({ type: "post", swarmId: id, post });
		return post;
	}

	async post(actor: SwarmActor, text: string, channel?: string): Promise<SwarmPostResult> {
		const board = this.#authorize(actor);
		const post = this.append(actor.id, actor.name, text, channel);
		const receipts = this.#wakeWaiters(board, post);
		const settled = new Set(receipts.map(receipt => receipt.name));
		// The author never rings itself: a brief that quotes `@coordinator` or an `@all` reaches everyone else.
		const targets = board
			.listMembers()
			.filter(
				member => member.name !== actor.name && board.addresses(post, member.name) && !settled.has(member.name),
			);
		receipts.push(
			...(await Promise.all(
				targets.map(async (member): Promise<SwarmDeliveryReceipt> => {
					const ref = this.registry.get(member.agentId);
					let error: string | undefined;
					if (member.killed || this.#closing.has(member.agentId))
						error = `Member ${member.name} is killed or closing`;
					else if (member.sessionFile && (conversationFile(ref) ?? member.sessionFile) !== member.sessionFile)
						error = `Member ${member.name}'s conversation is not active in the native registry`;
					if (error) return { name: member.name, to: member.agentId, outcome: "failed", error };
					try {
						const receipt = await (this.bus ?? IrcBus.global()).send({
							from: actor.agentId,
							to: member.agentId,
							body: `[swarm] board moved: #${post.seq}; swarm_read{since:${member.lastReadSeq}}`,
							boardNotice: { id: actor.id, seq: post.seq },
						});
						return { ...receipt, name: member.name };
					} catch (error) {
						return { name: member.name, to: member.agentId, outcome: "failed", error: String(error) };
					}
				}),
			)),
		);
		return {
			post,
			receipts,
			head: board.head,
			lastReadSeq: board.member(actor.name).lastReadSeq,
			boardUri: board.boardUri,
		};
	}

	async read(actor: SwarmActor, options: BoardReadOptions = {}): Promise<SwarmReadResult> {
		const board = this.#authorize(actor);
		const prior = board.member(actor.name).lastReadSeq;
		const result = board.read(actor.name, options);
		if (result.lastReadSeq !== prior) this.notify({ type: "members", swarmId: actor.id });
		return { ...result, boardUri: board.boardUri };
	}

	async schedule(actor: SwarmActor, options: ScheduleParams): Promise<SwarmScheduleResult> {
		const board = this.#authorize(actor);
		if (options.action === "create") {
			const task = this.scheduler.create(actor, options);
			return { boardUri: board.boardUri, id: task.id, task };
		}
		if (options.action === "kill") {
			this.scheduler.kill(actor, options.id);
			return { boardUri: board.boardUri, id: options.id };
		}
		return { boardUri: board.boardUri, tasks: this.scheduler.list(actor) };
	}

	/** Native UI activity excludes board parking and background scheduled turns. */
	isPassive(agentId: string): boolean {
		return this.scheduler.isDaemon(agentId) || [...this.#waiters.values()].some(waiter => waiter.agentId === agentId);
	}

	#canSchedule(actor: SwarmActor): boolean {
		if (this.#disposed || this.#closing.has(actor.agentId)) return false;
		const board = this.#boards.get(actor.id);
		const member = board
			?.listMembers()
			.find(candidate => candidate.name === actor.name && candidate.agentId === actor.agentId);
		const ref = this.registry.get(actor.agentId);
		if (!member || member.killed || member.error === "quota" || !ref || ref.status === "aborted") return false;
		const current = conversationFile(ref);
		if (member.sessionFile && current && member.sessionFile !== current) return false;
		// A board whose console moved to another transcript keeps its schedules quiet until the console returns.
		const coordinator = board?.listMembers().find(candidate => candidate.role === "coordinator");
		const consoleFile = coordinator && conversationFile(this.registry.get(coordinator.agentId));
		if (coordinator?.sessionFile && consoleFile && coordinator.sessionFile !== consoleFile) return false;
		return this.#memberState(member, actor.id) !== "working";
	}

	async #runScheduledTurn(task: ScheduledTaskSnapshot, signal: AbortSignal): Promise<void> {
		const actor: SwarmActor = { id: task.swarmId, name: task.owner, agentId: task.agentId };
		if (signal.aborted || !this.#canSchedule(actor)) return;
		const key = `${actor.id}:${actor.agentId}`;
		const priorWait = this.#waiters.get(key);
		const session = await this.lifecycle.ensureLive(actor.agentId);
		if (signal.aborted || !this.#canSchedule(actor)) return;
		const finished = Promise.withResolvers<void>();
		const stopState = session.subscribeRunState(state => {
			if (state === "idle") finished.resolve();
		});
		const stopMessages = session.subscribe(event => {
			if (
				(event.type === "message_start" &&
					((event.message.role === "user" && event.message.attribution !== "agent") ||
						(event.message.role === "custom" && isUserTurnInitiator(event.message)))) ||
				(event.type === "queue_update" && (event.steering.length > 0 || event.followUp.length > 0))
			)
				this.scheduler.promote(actor.agentId);
		});
		const stopBoard = this.onChange(event => {
			const waiting = this.#waiters.get(key);
			if (event.swarmId === actor.id && waiting && waiting !== priorWait) finished.resolve();
		});
		const abort = () => {
			if (this.registry.get(actor.agentId)?.session === session)
				void session.abort({ goalReason: "internal", deliverQueuedMessages: false }).catch(error => {
					logger.error("Scheduled turn abort failed", { agentId: actor.agentId, error: String(error) });
				});
			finished.resolve();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			if (signal.aborted) {
				abort();
				return;
			}
			// Only this turn's reply decides the outcome; an older failed reply is history.
			const turnStart = session.messages.length;
			const delivery = session.prompt(task.prompt, {
				attribution: "agent",
				userInitiated: false,
				runCommands: false,
				expandPromptTemplates: false,
				throwOnDrop: true,
				streamingBehavior: "steer",
			});
			void delivery.then(
				() => {
					if (!session.isStreaming) finished.resolve();
				},
				error => finished.reject(error),
			);
			await finished.promise;
			const last = session.messages.slice(turnStart).findLast(message => message.role === "assistant");
			if (!signal.aborted && last?.role === "assistant" && last.stopReason === "error")
				throw new Error(last.errorMessage ?? "Scheduled model request failed");
		} finally {
			stopState();
			stopMessages();
			stopBoard();
			signal.removeEventListener("abort", abort);
		}
	}

	/** Actual pending waits, exposed to diagnostics and the headless acceptance gate. */
	waiters(id?: string): SwarmWaitSnapshot[] {
		return [...this.#waiters.values()]
			.filter(waiter => id === undefined || waiter.swarmId === id)
			.map(({ swarmId, agentId, name, since, mentionsOnly }) => ({ swarmId, agentId, name, since, mentionsOnly }));
	}

	#finishWait(board: BoardStore, name: string, since: number, options: WaitSettlement = {}): SwarmWaitResult {
		const member = board.member(name);
		const messages = options.preserveCursor ? [] : board.select(name, { since });
		const lastReadSeq = Math.max(member.lastReadSeq, messages.at(-1)?.seq ?? member.lastReadSeq);
		if (lastReadSeq !== member.lastReadSeq || member.wakeMode !== null || member.waitSince !== null) {
			board.updateMember(name, { lastReadSeq, wakeMode: null, waitSince: null });
			this.notify({ type: "members", swarmId: board.metadata.id });
		}
		return {
			messages,
			lastReadSeq,
			head: board.head,
			boardUri: board.boardUri,
			...(options.interrupted ? { interrupted: true as const } : {}),
		};
	}

	#wakeWaiters(board: BoardStore, post: BoardPost): SwarmDeliveryReceipt[] {
		const receipts: SwarmDeliveryReceipt[] = [];
		const pendingAtPost = [...this.#waiters.values()];
		for (const waiter of pendingAtPost) {
			if (
				waiter.swarmId !== board.metadata.id ||
				post.seq <= waiter.since ||
				post.agent === waiter.name ||
				this.#closing.has(waiter.agentId) ||
				board.member(waiter.name).killed ||
				!board.visible(post, waiter.name) ||
				(waiter.mentionsOnly && !board.addresses(post, waiter.name))
			)
				continue;
			receipts.push(waiter.settle());
		}
		return receipts;
	}

	async wait(actor: SwarmActor, options: WaitParams, signal?: AbortSignal): Promise<SwarmWaitResult> {
		const board = this.#authorize(actor);
		const key = `${actor.id}:${actor.agentId}`;
		if (this.#waiters.has(key)) throw new SwarmRefusal(`Member ${actor.name} already has a pending swarm_wait`);
		const mentionsOnly = options.mentionsOnly ?? true;
		const pending = board.hasPending(actor.name, options.since, mentionsOnly);
		if (signal?.aborted || pending) {
			return this.#finishWait(
				board,
				actor.name,
				options.since,
				signal?.aborted
					? {
							interrupted: true,
							...(signal.reason === SWARM_WAIT_DISCONNECTED ? { preserveCursor: true } : {}),
						}
					: {},
			);
		}
		const result = Promise.withResolvers<SwarmWaitResult>();
		let releaseParentHold: (() => void) | undefined;
		const onAbort = () =>
			waiter.settle({
				interrupted: true,
				...(signal?.reason === SWARM_WAIT_DISCONNECTED ? { preserveCursor: true } : {}),
			});
		const waiter: PendingSwarmWait = {
			swarmId: actor.id,
			name: actor.name,
			agentId: actor.agentId,
			since: options.since,
			mentionsOnly,
			settle: settlement => {
				if (this.#waiters.get(key) !== waiter)
					return { name: actor.name, to: actor.agentId, outcome: "failed", error: "Wait already settled" };
				this.#waiters.delete(key);
				releaseParentHold?.();
				signal?.removeEventListener("abort", onAbort);
				try {
					result.resolve(this.#finishWait(board, actor.name, options.since, settlement));
					return { name: actor.name, to: actor.agentId, outcome: "woken" };
				} catch (error) {
					result.reject(error);
					this.notify({ type: "members", swarmId: actor.id });
					return { name: actor.name, to: actor.agentId, outcome: "failed", error: String(error) };
				}
			},
		};
		board.updateMember(actor.name, { wakeMode: mentionsOnly ? "mentions" : "any", waitSince: options.since });
		this.#waiters.set(key, waiter);
		// A parked member messages its parent only after a post wakes it, so the parent's run must not stay open
		// for it: the interruptible hold excludes it from the parent's wake sources until the wait settles.
		const parentId = this.registry.get(actor.agentId)?.parentId;
		if (parentId) releaseParentHold = this.registry.awaits.hold(actor.agentId, [parentId], { interruptible: true });
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		else this.notify({ type: "members", swarmId: actor.id });
		return result.promise;
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
