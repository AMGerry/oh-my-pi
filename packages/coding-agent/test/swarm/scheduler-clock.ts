import type { SchedulerClock } from "../../src/swarm/scheduler";

/** An explicit clock whose pending deadlines are inspectable by scheduler gates. */
export class TestSchedulerClock implements SchedulerClock {
	readonly pending = new Map<number, { at: number; callback: () => void }>();
	#time = Date.parse("2026-01-01T00:00:00Z");
	#id = 0;

	now(): number {
		return this.#time;
	}

	arm(callback: () => void, delayMs: number): () => void {
		const id = ++this.#id;
		this.pending.set(id, { at: this.#time + delayMs, callback });
		return () => {
			this.pending.delete(id);
		};
	}

	async advanceBy(milliseconds: number): Promise<void> {
		const target = this.#time + milliseconds;
		for (;;) {
			const next = [...this.pending.entries()].sort((left, right) => left[1].at - right[1].at)[0];
			if (!next || next[1].at > target) break;
			this.#time = next[1].at;
			this.pending.delete(next[0]);
			next[1].callback();
			await Promise.resolve();
		}
		this.#time = target;
		await Promise.resolve();
	}
}
