import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { SWARM_WAIT_DISCONNECTED, type SwarmActor } from "../../src/swarm/api";
import { BoardStore } from "../../src/swarm/board-store";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { makeChannel, makeMember, SWARM_CAPABILITIES } from "./fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-waiters-"));
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const bus = new IrcBus(registry, lifecycle);
	const runtime = new SwarmRuntime(registry, lifecycle, bus);
	const board = runtime.create(dir, {
		id: "swarm-waiters",
		title: "Waiter invariants",
		coordinator: makeMember("Main", { role: "coordinator", wakeMode: null }),
		capabilities: SWARM_CAPABILITIES,
	});
	for (const name of ["alice", "bob", "monitor"]) {
		const agentId = `Member-${name}`;
		board.addMember(name, makeMember(agentId, { wakeMode: null, role: name === "monitor" ? "monitor" : "worker" }));
		registry.register({
			id: agentId,
			displayName: name,
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
	}
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
	cleanups.push(async () => {
		runtime.dispose();
		await lifecycle.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const actor = (name: string): SwarmActor => ({ id: board.metadata.id, name, agentId: board.member(name).agentId });
	return { dir, board, registry, lifecycle, bus, runtime, actor, coordinator: actor("coordinator") };
}

describe("swarm runtime waiting and delivery", () => {
	it("M3 gate: keeps real waiters timer-free and wakes only the named worker within one second", async () => {
		const f = fixture();
		vi.useFakeTimers();
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const interval = vi.spyOn(globalThis, "setInterval");
		const alice = f.runtime.wait(f.actor("alice"), { since: 0 });
		const bob = f.runtime.wait(f.actor("bob"), { since: 0 });
		expect(f.runtime.waiters()).toEqual([
			{ swarmId: "swarm-waiters", name: "alice", agentId: "Member-alice", since: 0, mentionsOnly: true },
			{ swarmId: "swarm-waiters", name: "bob", agentId: "Member-bob", since: 0, mentionsOnly: true },
		]);
		expect(f.runtime.snapshot(f.board.metadata.id).members[1]).toMatchObject({
			state: "waiting",
			wakeMode: "mentions",
			waitSince: 0,
		});
		const quiet = await f.runtime.post(f.coordinator, "A public observation about @unknown");
		expect(quiet.receipts).toEqual([]);
		expect(f.runtime.waiters()).toHaveLength(2);
		const started = Bun.nanoseconds();
		const wake = await f.runtime.post(f.coordinator, "@bob continue your work");
		expect(wake.receipts).toEqual([{ name: "bob", to: "Member-bob", outcome: "woken" }]);
		expect((await bob).messages.map(post => post.seq)).toEqual([1, 2]);
		expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(1000);
		expect(f.runtime.waiters().map(waiter => waiter.name)).toEqual(["alice"]);
		expect(f.board.member("alice").lastReadSeq).toBe(0);
		await f.runtime.post(f.coordinator, "@ALICE review the result");
		expect((await alice).messages.map(post => post.seq)).toEqual([1, 2, 3]);
		expect(f.board.member("bob").lastReadSeq).toBe(2);
		expect(f.runtime.waiters()).toEqual([]);
		expect(timeout).not.toHaveBeenCalled();
		expect(interval).not.toHaveBeenCalled();
	});

	it("keeps a member parked on the board out of its parent's wake sources until the wait settles", async () => {
		const f = fixture();
		expect(f.registry.awaits.blocksOn("Member-alice", "Main", 0)).toBe(false);
		const cancel = new AbortController();
		const alice = f.runtime.wait(f.actor("alice"), { since: 0 }, cancel.signal);
		// The parent's open run asks exactly this (`AgentSession` wake sources): a parked member is not a reason to stay open.
		expect(f.registry.awaits.blocksOn("Member-alice", "Main", 0)).toBe(true);
		// A direct message sent during the wait still interrupts it, so the hold does not block that message.
		expect(f.registry.awaits.blocksOn("Member-alice", "Main", Date.now() + 1)).toBe(false);
		cancel.abort("tool interrupted");
		await alice;
		expect(f.registry.awaits.blocksOn("Member-alice", "Main", 0)).toBe(false);
	});

	it("filters channels while any-post helpers and cross-channel addresses see their own eligible posts", async () => {
		const f = fixture();
		f.board.setChannel("ui", makeChannel({ subscribers: ["alice"] }));
		f.board.setChannel("code", makeChannel({ subscribers: ["bob"] }));
		f.board.updateMember("alice", { channels: ["ui"] });
		f.board.updateMember("bob", { channels: ["code"] });
		const cancel = new AbortController();
		const alice = f.runtime.wait(f.actor("alice"), { since: 0 });
		const bob = f.runtime.wait(f.actor("bob"), { since: 0 }, cancel.signal);
		const monitor = f.runtime.wait(f.actor("monitor"), { since: 0, mentionsOnly: false });
		const first = await f.runtime.post(f.coordinator, "Private code-channel progress", "code");
		expect(first.receipts).toEqual([{ name: "monitor", to: "Member-monitor", outcome: "woken" }]);
		expect((await monitor).messages.map(post => post.seq)).toEqual([1]);
		expect(f.runtime.waiters().map(waiter => waiter.name)).toEqual(["alice", "bob"]);
		await f.runtime.post(f.coordinator, "@#ui inspect this cross-channel decision", "code");
		expect((await alice).messages.map(post => post.seq)).toEqual([2]);
		expect(f.runtime.waiters().map(waiter => waiter.name)).toEqual(["bob"]);
		cancel.abort("tool interrupted");
		expect((await bob).messages.map(post => post.seq)).toEqual([1, 2]);
		expect(f.board.member("monitor").lastReadSeq).toBe(1);
	});

	it("finds an addressed post beyond the first page and advances only through returned messages", async () => {
		const f = fixture();
		for (let index = 0; index < 201; index++)
			f.runtime.append(f.board.metadata.id, "coordinator", `Progress ${index}`);
		f.runtime.append(f.board.metadata.id, "coordinator", "@alice act on this assignment");
		const first = await f.runtime.wait(f.actor("alice"), { since: 0 });
		expect(first.messages).toHaveLength(200);
		expect(first.lastReadSeq).toBe(200);
		expect(first.head).toBe(202);
		const next = await f.runtime.wait(f.actor("alice"), { since: first.lastReadSeq });
		expect(next.messages.map(post => post.seq)).toEqual([201, 202]);
		expect(next.lastReadSeq).toBe(202);
		expect(f.board.member("bob").lastReadSeq).toBe(0);
		expect(f.runtime.waiters()).toEqual([]);
	});

	it("rejects overlapping waits and returns pending data on ordinary tool interruption", async () => {
		const f = fixture();
		const abort = new AbortController();
		const waiting = f.runtime.wait(f.actor("alice"), { since: 0 }, abort.signal);
		await f.runtime.post(f.coordinator, "An unaddressed update");
		await expect(f.runtime.wait(f.actor("alice"), { since: 0 })).rejects.toThrow("already has a pending");
		expect(f.runtime.waiters()).toHaveLength(1);
		abort.abort("tool interrupted");
		const result = await waiting;
		expect(result).toMatchObject({ interrupted: true, lastReadSeq: 1, boardUri: "swarm://swarm-waiters" });
		expect(result.messages[0]?.text).toBe("An unaddressed update");
		expect(f.board.member("alice")).toMatchObject({ lastReadSeq: 1, wakeMode: null, waitSince: null });
		expect(f.runtime.waiters()).toEqual([]);
	});

	it("retains unseen posts and the cursor when the caller disconnects, then reopens the same backlog", async () => {
		const f = fixture();
		const abort = new AbortController();
		const waiting = f.runtime.wait(f.actor("bob"), { since: 0 }, abort.signal);
		await f.runtime.post(f.coordinator, "An update queued before disconnect");
		abort.abort(SWARM_WAIT_DISCONNECTED);
		expect(await waiting).toMatchObject({ interrupted: true, messages: [], lastReadSeq: 0 });
		const disk = BoardStore.open(f.dir, { readOnly: true });
		expect(disk.member("bob")).toMatchObject({ lastReadSeq: 0, wakeMode: null, waitSince: null });
		const restored = new SwarmRuntime(f.registry, f.lifecycle, f.bus);
		try {
			restored.open(f.dir);
			const result = await restored.wait(f.actor("bob"), { since: 0, mentionsOnly: false });
			expect(result.messages.map(post => post.seq)).toEqual([1]);
			expect(result.lastReadSeq).toBe(1);
		} finally {
			restored.dispose();
		}
	});

	it("settles waits on kill and permanently blocks doorbells to a tombstoned member", async () => {
		const f = fixture();
		const delivery = vi.spyOn(f.bus, "send");
		const waiting = f.runtime.wait(f.actor("alice"), { since: 0 });
		await f.runtime.kill(f.coordinator, "alice");
		expect(await waiting).toMatchObject({ interrupted: true, messages: [], lastReadSeq: 0 });
		const post = await f.runtime.post(f.coordinator, "@alice return");
		expect(post.receipts[0]).toMatchObject({
			name: "alice",
			outcome: "failed",
			error: expect.stringContaining("killed"),
		});
		expect(delivery).not.toHaveBeenCalled();
		expect(f.runtime.waiters()).toEqual([]);
		expect(BoardStore.open(f.dir, { readOnly: true }).member("alice").killed).toBe(true);
		await expect(f.runtime.wait(f.actor("alice"), { since: 0 })).rejects.toThrow("killed");
	});

	it("commits the full report before the native bus receives its sequence-only doorbell", async () => {
		const f = fixture();
		const nativeSend = f.bus.send.bind(f.bus);
		const send = vi.spyOn(f.bus, "send").mockImplementation(async message => {
			const disk = BoardStore.open(f.dir, { readOnly: true });
			expect(disk.posts()[0]?.text).toBe("@alice [done] Unique full report body");
			expect(message.body).toBe("[swarm] board moved: #1; swarm_read{since:0}");
			expect(message.boardNotice).toEqual({ id: "swarm-waiters", seq: 1 });
			return nativeSend(message);
		});
		const result = await f.runtime.post(f.coordinator, "@alice [done] Unique full report body");
		expect(send).toHaveBeenCalledTimes(1);
		expect(result.post.seq).toBe(1);
		expect(result.receipts[0]?.outcome).toBe("failed");
		expect(f.board.member("alice").lastReadSeq).toBe(0);
	});

	it("keeps the real waiter parked when fsync fails before the post commits", async () => {
		const f = fixture();
		const abort = new AbortController();
		const waiting = f.runtime.wait(f.actor("alice"), { since: 0 }, abort.signal);
		const send = vi.spyOn(f.bus, "send");
		vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
			throw new Error("simulated fsync failure");
		});
		await expect(f.runtime.post(f.coordinator, "@alice uncommitted work")).rejects.toThrow("fsync failure");
		expect(f.runtime.waiters().map(waiter => waiter.name)).toEqual(["alice"]);
		expect(f.board.head).toBe(0);
		expect(send).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		abort.abort("cleanup");
		expect((await waiting).messages).toEqual([]);
	});

	it("preserves the cursor when durable waiter completion fails, then delivers the retained post", async () => {
		const f = fixture();
		const waiting = f.runtime.wait(f.actor("alice"), { since: 0 });
		const failed = waiting.catch((error: unknown) => error);
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (path.basename(String(to)) === "members.json") throw new Error("simulated members failure");
			rename(from, to);
		});
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const result = await f.runtime.post(f.coordinator, "@alice retained assignment");
		expect(await failed).toMatchObject({ message: "simulated members failure" });
		expect(result.receipts[0]?.outcome).toBe("failed");
		expect(f.board.member("alice").lastReadSeq).toBe(0);
		expect(f.runtime.waiters()).toEqual([]);
		vi.restoreAllMocks();
		const retried = await f.runtime.wait(f.actor("alice"), { since: 0 });
		expect(retried.messages[0]?.text).toBe("@alice retained assignment");
		expect(retried.lastReadSeq).toBe(1);
	});
});

describe("swarm member state", () => {
	it("reads a root coordinator from its live run, whatever its registry status says", async () => {
		const f = fixture();
		const id = f.board.metadata.id;
		// The registry keeps a root session `running` for its whole life.
		expect(f.registry.get("Main")).toMatchObject({ kind: "main", status: "running" });
		expect(f.runtime.snapshot(id).members[0]).toMatchObject({ name: "coordinator", state: "stopped" });

		const run = { isStreaming: false };
		f.registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: run as unknown as AgentSessionHandle,
			status: "running",
		});
		expect(f.runtime.snapshot(id).members[0]).toMatchObject({ name: "coordinator", state: "stopped" });
		run.isStreaming = true;
		expect(f.runtime.snapshot(id).members[0]).toMatchObject({ name: "coordinator", state: "working" });
		run.isStreaming = false;
		expect(f.runtime.snapshot(id).members[0]).toMatchObject({ name: "coordinator", state: "stopped" });

		// Parked on the board, the coordinator reads waiting even while its turn is open; the turn alone decides afterwards.
		run.isStreaming = true;
		const park = new AbortController();
		const parked = f.runtime.wait(f.coordinator, { since: 0 }, park.signal);
		expect(f.runtime.snapshot(id).members[0]).toMatchObject({ name: "coordinator", state: "waiting" });
		park.abort();
		await parked;
		expect(f.runtime.snapshot(id).members[0]).toMatchObject({ name: "coordinator", state: "working" });
		run.isStreaming = false;
		expect(f.runtime.snapshot(id).members[0]).toMatchObject({ name: "coordinator", state: "stopped" });
	});

	it("reads a coordinator that is parked on the board as waiting when it has no live session", async () => {
		const f = fixture();
		const park = new AbortController();
		const parked = f.runtime.wait(f.coordinator, { since: 0 }, park.signal);
		expect(f.runtime.snapshot(f.board.metadata.id).members[0]).toMatchObject({
			name: "coordinator",
			state: "waiting",
		});
		park.abort();
		await parked;
		expect(f.runtime.snapshot(f.board.metadata.id).members[0]).toMatchObject({
			name: "coordinator",
			state: "stopped",
		});
	});

	it("keeps reading a worker from its registry status", () => {
		const f = fixture();
		const id = f.board.metadata.id;
		const quiet = { isStreaming: false } as unknown as AgentSessionHandle;
		const refs = [
			["alice", "running", quiet],
			["bob", "idle", null],
			["monitor", "parked", null],
		] as const;
		for (const [name, status, session] of refs) {
			f.registry.register({
				id: `Member-${name}`,
				displayName: name,
				kind: "sub",
				parentId: "Main",
				session,
				status,
			});
		}
		// A worker is working while its ref is running, whether or not a stream is open, and stopped when idle or parked.
		expect(f.runtime.snapshot(id).members.map(member => [member.name, member.state])).toEqual([
			["coordinator", "stopped"],
			["alice", "working"],
			["bob", "stopped"],
			["monitor", "stopped"],
		]);
	});
});

describe("a member's own posts", () => {
	it("leave a wait with an older cursor parked, and another member's post then returns both in order", async () => {
		const f = fixture();
		const id = f.board.metadata.id;
		const own = await f.runtime.post(f.actor("alice"), "ready");
		expect(own.receipts).toEqual([]);

		// The cursor sits below the member's own post; that post alone is no reason to wake.
		let settled = false;
		const waiting = f.runtime.wait(f.actor("alice"), { since: 0, mentionsOnly: false }).finally(() => {
			settled = true;
		});
		expect(f.runtime.waiters().map(waiter => waiter.name)).toEqual(["alice"]);
		expect(f.runtime.snapshot(id).members.find(member => member.name === "alice")).toMatchObject({
			state: "waiting",
			wakeMode: "any",
			waitSince: 0,
		});
		expect(settled).toBe(false);

		const wake = await f.runtime.post(f.coordinator, "A progress note from the coordinator");
		expect(wake.receipts).toEqual([{ name: "alice", to: "Member-alice", outcome: "woken" }]);
		const result = await waiting;
		expect(result.messages.map(post => [post.seq, post.agent])).toEqual([
			[1, "alice"],
			[2, "coordinator"],
		]);
		expect(result.interrupted).toBeUndefined();
		expect(result).toMatchObject({ lastReadSeq: 2, head: 2 });
		expect(f.board.member("alice")).toMatchObject({ lastReadSeq: 2, wakeMode: null, waitSince: null });
		expect(f.runtime.waiters()).toEqual([]);
	});

	it("do not wake the author's own open wait, and its receipt does not list the author as woken", async () => {
		const f = fixture();
		const id = f.board.metadata.id;
		let settled = false;
		const waiting = f.runtime.wait(f.actor("alice"), { since: 0, mentionsOnly: false }).finally(() => {
			settled = true;
		});
		const bystander = f.runtime.wait(f.actor("bob"), { since: 0, mentionsOnly: false });

		// A post of its own while the wait is open, as a parallel tool call of the same member would make.
		const own = await f.runtime.post(f.actor("alice"), "A note while I wait");
		expect(own.receipts).toEqual([{ name: "bob", to: "Member-bob", outcome: "woken" }]);
		expect(settled).toBe(false);
		expect(f.runtime.waiters().map(waiter => waiter.name)).toEqual(["alice"]);
		expect(f.runtime.snapshot(id).members.find(member => member.name === "alice")).toMatchObject({
			state: "waiting",
			waitSince: 0,
		});
		expect(f.board.member("alice").lastReadSeq).toBe(0);
		expect((await bystander).messages.map(post => post.seq)).toEqual([1]);

		const wake = await f.runtime.post(f.coordinator, "@alice now it is your turn");
		expect(wake.receipts).toEqual([{ name: "alice", to: "Member-alice", outcome: "woken" }]);
		const result = await waiting;
		expect(result.messages.map(post => [post.seq, post.agent])).toEqual([
			[1, "alice"],
			[2, "coordinator"],
		]);
		expect(result.lastReadSeq).toBe(2);
		expect(f.runtime.waiters()).toEqual([]);
	});
});
