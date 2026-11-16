import { randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import type { SwarmActor } from "./api";
import { CronSchedule } from "./cron";
import { SwarmRefusal } from "./types";

export interface ScheduleDefinition {
	cron: string;
	prompt: string;
	daemon?: boolean;
}

export interface ScheduledTaskSnapshot {
	id: string;
	swarmId: string;
	agentId: string;
	owner: string;
	cron: string;
	prompt: string;
	daemon: boolean;
	nextFire: string;
	running: boolean;
	error?: string;
}

export interface SchedulerClock {
	now(): number;
	/** Arm one cancellable deadline. */
	arm(callback: () => void, delayMs: number): () => void;
}

export interface SchedulerOptions {
	canRun(owner: SwarmActor): boolean;
	run(task: ScheduledTaskSnapshot, signal: AbortSignal): Promise<void>;
	changed(swarmId: string): void;
	clock?: SchedulerClock;
}

interface ScheduledTask {
	id: string;
	owner: SwarmActor;
	cron: CronSchedule;
	prompt: string;
	daemon: boolean;
	nextFire: number;
	error?: string;
	run?: { controller: AbortController; foreground: boolean };
}

const SYSTEM_CLOCK: SchedulerClock = {
	now: () => Date.now(),
	arm(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

/** The process-global swarm runtime owns this minute-resolution scheduler and its single deadline. */
export class SwarmScheduler {
	readonly #tasks = new Map<string, ScheduledTask>();
	readonly #owners = new Map<string, ScheduledTask>();
	readonly #clock: SchedulerClock;
	#cancelDeadline: (() => void) | undefined;
	#disposed = false;

	constructor(private readonly options: SchedulerOptions) {
		if (!isMainThread) throw new Error("The swarm scheduler belongs to the main thread");
		this.#clock = options.clock ?? SYSTEM_CLOCK;
	}

	create(owner: SwarmActor, definition: ScheduleDefinition): ScheduledTaskSnapshot {
		if (this.#disposed) throw new SwarmRefusal("The swarm scheduler is closed");
		if (!definition.prompt.trim()) throw new SwarmRefusal("A scheduled prompt must contain text");
		const cron = new CronSchedule(definition.cron);
		const task: ScheduledTask = {
			id: randomUUID(),
			owner: { ...owner },
			cron,
			prompt: definition.prompt,
			daemon: definition.daemon ?? false,
			nextFire: cron.nextAfter(new Date(this.#clock.now())).getTime(),
		};
		this.#tasks.set(task.id, task);
		this.#arm();
		this.#changed(owner.id);
		return this.#snapshot(task);
	}

	list(actor: SwarmActor): ScheduledTaskSnapshot[] {
		return [...this.#tasks.values()]
			.filter(
				task =>
					task.owner.id === actor.id && (actor.name === "coordinator" || task.owner.agentId === actor.agentId),
			)
			.sort((left, right) => left.nextFire - right.nextFire || left.id.localeCompare(right.id))
			.map(task => this.#snapshot(task));
	}

	kill(actor: SwarmActor, id: string): void {
		const task = this.#tasks.get(id);
		if (!task || task.owner.id !== actor.id) throw new SwarmRefusal(`Unknown scheduled task: ${id}`);
		if (actor.name !== "coordinator" && task.owner.agentId !== actor.agentId)
			throw new SwarmRefusal("Only the task owner or coordinator can stop this schedule");
		// The owner stops its schedule from inside the turn that schedule started (the monitor going dormant
		// kills its cron, then parks on the board), so that turn runs on; the coordinator's kill cancels it.
		this.#remove(task, task.owner.agentId !== actor.agentId);
		this.#arm();
	}

	killOwner(owner: SwarmActor): void {
		for (const task of new Set([...this.#tasks.values(), ...this.#owners.values()]))
			if (task.owner.id === owner.id && task.owner.agentId === owner.agentId) this.#remove(task);
		this.#arm();
	}

	/** The active scheduled turn's visibility, also used by the native conversation HUD. */
	isDaemon(agentId: string): boolean {
		const task = this.#owners.get(agentId);
		return task?.daemon === true && task.run?.foreground === false;
	}

	/** Deliberate user input makes a running background turn foreground work. */
	promote(agentId: string): void {
		const task = this.#owners.get(agentId);
		if (!task?.run || task.run.foreground) return;
		task.run.foreground = true;
		this.#changed(task.owner.id);
	}

	dispose(): void {
		this.#disposed = true;
		this.#cancelDeadline?.();
		this.#cancelDeadline = undefined;
		for (const task of new Set([...this.#tasks.values(), ...this.#owners.values()])) this.#remove(task);
	}

	#snapshot(task: ScheduledTask): ScheduledTaskSnapshot {
		return {
			id: task.id,
			swarmId: task.owner.id,
			agentId: task.owner.agentId,
			owner: task.owner.name,
			cron: task.cron.expression,
			prompt: task.prompt,
			daemon: task.daemon,
			nextFire: new Date(task.nextFire).toISOString(),
			running: task.run !== undefined,
			...(task.error ? { error: task.error } : {}),
		};
	}

	#remove(task: ScheduledTask, cancelRun = true): void {
		this.#tasks.delete(task.id);
		if (cancelRun) task.run?.controller.abort(new Error("Scheduled task stopped"));
		this.#changed(task.owner.id);
	}

	#changed(swarmId: string): void {
		try {
			this.options.changed(swarmId);
		} catch (error) {
			logger.error("Swarm schedule observer failed", { error: String(error) });
		}
	}

	#arm(): void {
		this.#cancelDeadline?.();
		this.#cancelDeadline = undefined;
		if (this.#disposed || this.#tasks.size === 0) return;
		let next = Infinity;
		for (const task of this.#tasks.values()) next = Math.min(next, task.nextFire);
		this.#cancelDeadline = this.#clock.arm(
			() => this.#tick(),
			Math.max(0, Math.min(2_147_483_647, next - this.#clock.now())),
		);
	}

	#tick(): void {
		this.#cancelDeadline = undefined;
		if (this.#disposed) return;
		const now = this.#clock.now();
		const due = [...this.#tasks.values()].filter(task => task.nextFire <= now);
		for (const task of due) {
			if (this.#tasks.get(task.id) !== task) continue;
			task.nextFire = task.cron.nextAfter(new Date(now)).getTime();
			if (!task.run && !this.#owners.has(task.owner.agentId) && this.options.canRun(task.owner)) {
				void this.#execute(task);
			} else this.#changed(task.owner.id);
		}
		this.#arm();
	}

	async #execute(task: ScheduledTask): Promise<void> {
		const run = { controller: new AbortController(), foreground: false };
		task.run = run;
		task.error = undefined;
		this.#owners.set(task.owner.agentId, task);
		this.#changed(task.owner.id);
		try {
			await this.options.run(this.#snapshot(task), run.controller.signal);
		} catch (error) {
			if (!run.controller.signal.aborted) task.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.#owners.get(task.owner.agentId) === task) this.#owners.delete(task.owner.agentId);
			task.run = undefined;
			this.#changed(task.owner.id);
		}
	}
}
