import { describe, expect, it } from "bun:test";
import type { SwarmActor } from "../../src/swarm/api";
import { SwarmScheduler, type ScheduledTaskSnapshot } from "../../src/swarm/scheduler";
import { TestSchedulerClock } from "./scheduler-clock";

const coordinator: SwarmActor = { id: "board", name: "coordinator", agentId: "Main" };
const monitor: SwarmActor = { id: "board", name: "monitor", agentId: "Monitor" };
const worker: SwarmActor = { id: "board", name: "worker", agentId: "Worker" };
const minute = 60_000;

describe("swarm scheduler", () => {
	it("fires twice, skips overlapping ticks and cancels the final deadline on kill", async () => {
		const clock = new TestSchedulerClock();
		const calls: ScheduledTaskSnapshot[] = [];
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const scheduler = new SwarmScheduler({
			clock,
			canRun: () => true,
			changed: () => {},
			run: async task => {
				calls.push(task);
				await gates[calls.length - 1]!.promise;
			},
		});
		try {
			expect(clock.pending.size).toBe(0);
			const task = scheduler.create(monitor, { cron: "* * * * *", prompt: "Inspect stalls", daemon: true });
			expect(Date.parse(task.nextFire) - clock.now()).toBe(minute);
			expect(clock.pending.size).toBe(1);
			await clock.advanceBy(minute);
			expect(calls).toHaveLength(1);
			expect(scheduler.list(coordinator)[0]?.running).toBe(true);
			expect(scheduler.isDaemon(monitor.agentId)).toBe(true);
			await clock.advanceBy(minute * 2);
			expect(calls).toHaveLength(1);
			gates[0]!.resolve();
			await clock.advanceBy(0);
			expect(scheduler.list(coordinator)[0]?.running).toBe(false);
			await clock.advanceBy(minute);
			expect(calls).toHaveLength(2);
			gates[1]!.resolve();
			await clock.advanceBy(0);
			scheduler.kill(coordinator, task.id);
			expect(clock.pending.size).toBe(0);
			await clock.advanceBy(minute * 20);
			expect(calls).toHaveLength(2);
			expect(scheduler.list(coordinator)).toEqual([]);
		} finally {
			scheduler.dispose();
		}
	});

	it("runs on consecutive minutes when the previous turn has settled", async () => {
		const clock = new TestSchedulerClock();
		const times: number[] = [];
		const scheduler = new SwarmScheduler({
			clock,
			canRun: () => true,
			changed: () => {},
			run: async () => {
				times.push(clock.now());
			},
		});
		try {
			const start = clock.now();
			scheduler.create(monitor, { cron: "* * * * *", prompt: "Tick" });
			await clock.advanceBy(minute * 2);
			expect(times).toEqual([start + minute, start + minute * 2]);
		} finally {
			scheduler.dispose();
		}
	});

	it("shares one deadline across owners and admits one turn per owner", async () => {
		const clock = new TestSchedulerClock();
		const run = Promise.withResolvers<void>();
		const calls: string[] = [];
		const scheduler = new SwarmScheduler({
			clock,
			canRun: () => true,
			changed: () => {},
			run: async task => {
				calls.push(task.agentId);
				await run.promise;
			},
		});
		try {
			scheduler.create(monitor, { cron: "* * * * *", prompt: "First" });
			scheduler.create(monitor, { cron: "* * * * *", prompt: "Second" });
			scheduler.create(worker, { cron: "* * * * *", prompt: "Independent" });
			expect(clock.pending.size).toBe(1);
			await clock.advanceBy(minute);
			expect(calls).toEqual(["Monitor", "Worker"]);
			expect(scheduler.list(monitor)).toHaveLength(2);
			expect(scheduler.list(worker)).toHaveLength(1);
			expect(scheduler.list(coordinator)).toHaveLength(3);
			expect(() => scheduler.kill(worker, scheduler.list(monitor)[0]!.id)).toThrow("owner or coordinator");
			expect(() => scheduler.kill({ ...coordinator, id: "different" }, scheduler.list(monitor)[0]!.id)).toThrow(
				"Unknown",
			);
			scheduler.killOwner(monitor);
			expect(scheduler.list(coordinator)).toHaveLength(1);
			run.resolve();
		} finally {
			run.resolve();
			scheduler.dispose();
		}
	});

	it("skips a busy owner, reports turn errors and preserves future firings", async () => {
		const clock = new TestSchedulerClock();
		let ready = false;
		let calls = 0;
		const scheduler = new SwarmScheduler({
			clock,
			canRun: () => ready,
			changed: () => {},
			run: async () => {
				calls++;
				throw new Error("provider quota");
			},
		});
		try {
			scheduler.create(worker, { cron: "* * * * *", prompt: "Continue" });
			await clock.advanceBy(minute * 2);
			expect(calls).toBe(0);
			ready = true;
			await clock.advanceBy(minute);
			expect(calls).toBe(1);
			expect(scheduler.list(worker)[0]).toMatchObject({ running: false, error: "provider quota" });
			expect(clock.pending.size).toBe(1);
		} finally {
			scheduler.dispose();
		}
	});

	it("cancels an active task on the coordinator's kill and promotes daemon visibility for deliberate user input", async () => {
		const clock = new TestSchedulerClock();
		const finished = Promise.withResolvers<void>();
		let runSignal: AbortSignal | undefined;
		const scheduler = new SwarmScheduler({
			clock,
			canRun: () => true,
			changed: () => {},
			run: async (_task, signal) => {
				runSignal = signal;
				signal.addEventListener("abort", () => finished.resolve(), { once: true });
				await finished.promise;
			},
		});
		try {
			const task = scheduler.create(monitor, { cron: "* * * * *", prompt: "Inspect", daemon: true });
			await clock.advanceBy(minute);
			expect(scheduler.isDaemon(monitor.agentId)).toBe(true);
			scheduler.promote(monitor.agentId);
			expect(scheduler.isDaemon(monitor.agentId)).toBe(false);
			scheduler.kill(coordinator, task.id);
			expect(runSignal?.aborted).toBe(true);
			await clock.advanceBy(0);
			expect(clock.pending.size).toBe(0);
			expect(() => scheduler.kill(monitor, task.id)).toThrow("Unknown scheduled task");
		} finally {
			finished.resolve();
			scheduler.dispose();
		}
	});

	it("lets the owner stop its schedule from inside the tick it started without cancelling that tick", async () => {
		const clock = new TestSchedulerClock();
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const signals: AbortSignal[] = [];
		const scheduler = new SwarmScheduler({
			clock,
			canRun: () => true,
			changed: () => {},
			run: async (_task, signal) => {
				signals.push(signal);
				await gates[signals.length - 1]!.promise;
			},
		});
		try {
			const cron = scheduler.create(monitor, { cron: "* * * * *", prompt: "Inspect", daemon: true });
			await clock.advanceBy(minute);
			expect(signals).toHaveLength(1);

			// Going dormant: the monitor kills its cron mid-tick and goes on to park on the board.
			scheduler.kill(monitor, cron.id);
			expect(signals[0]!.aborted).toBe(false);
			expect(scheduler.list(coordinator)).toEqual([]);
			expect(clock.pending.size).toBe(0);
			expect(scheduler.isDaemon(monitor.agentId)).toBe(true);

			// A cron recreated while that tick still runs waits for it: one scheduled turn per owner.
			scheduler.create(monitor, { cron: "* * * * *", prompt: "Inspect again" });
			await clock.advanceBy(minute);
			expect(signals).toHaveLength(1);

			gates[0]!.resolve();
			for (let step = 0; step < 10; step++) await Promise.resolve();
			expect(scheduler.isDaemon(monitor.agentId)).toBe(false);
			await clock.advanceBy(minute);
			expect(signals).toHaveLength(2);
		} finally {
			for (const gate of gates) gate.resolve();
			scheduler.dispose();
		}
	});

	it.each(["member", "runtime"] as const)("cancels a self-stopped tick when its %s is closed", async scope => {
		const clock = new TestSchedulerClock();
		const finished = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const scheduler = new SwarmScheduler({
			clock,
			canRun: () => true,
			changed: () => {},
			run: async (_task, active) => {
				signal = active;
				active.addEventListener("abort", () => finished.resolve(), { once: true });
				await finished.promise;
			},
		});
		try {
			const task = scheduler.create(monitor, { cron: "* * * * *", prompt: "Inspect", daemon: true });
			await clock.advanceBy(minute);
			scheduler.kill(monitor, task.id);
			expect(signal?.aborted).toBe(false);
			if (scope === "member") scheduler.killOwner(monitor);
			else scheduler.dispose();
			expect(signal?.aborted).toBe(true);
			await clock.advanceBy(0);
			expect(scheduler.isDaemon(monitor.agentId)).toBe(false);
			expect(clock.pending.size).toBe(0);
		} finally {
			finished.resolve();
			scheduler.dispose();
		}
	});

	it("starts with an empty schedule after runtime recreation and rejects invalid creates", () => {
		const clock = new TestSchedulerClock();
		const options = { clock, canRun: () => true, changed: () => {}, run: async () => {} };
		const previous = new SwarmScheduler(options);
		previous.create(monitor, { cron: "*/3 * * * *", prompt: "Inspect" });
		previous.dispose();
		const restarted = new SwarmScheduler(options);
		try {
			expect(restarted.list(coordinator)).toEqual([]);
			expect(clock.pending.size).toBe(0);
			expect(() => restarted.create(monitor, { cron: "bad", prompt: "Inspect" })).toThrow();
			expect(() => restarted.create(monitor, { cron: "* * * * *", prompt: " \n " })).toThrow("contain text");
			expect(clock.pending.size).toBe(0);
		} finally {
			restarted.dispose();
		}
	});
});
