import { afterEach, describe, expect, it, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { Settings } from "../../src/config/settings";
import { waitSchema, type SwarmWaitResult } from "../../src/swarm/api";
import { cfgSwarmWaitMaxMs } from "../../src/swarm/settings";
import { SwarmReadTool } from "../../src/swarm/tools/swarm-read";
import { SwarmWaitTool } from "../../src/swarm/tools/swarm-wait";
import { createToolFixture, parseRoster, resultJson, resultText } from "./tool-fixture";

const seqs = (result: SwarmWaitResult) => result.messages.map(message => message.seq);

describe("swarm_wait schema", () => {
	it("accepts the documented arguments and rejects everything else", () => {
		expect(waitSchema.allows({ since: 0 })).toBe(true);
		expect(waitSchema.allows({ since: 5, mentionsOnly: false })).toBe(true);
		for (const rejected of [
			{},
			{ since: -1 },
			{ since: 1.5 },
			{ since: "1" },
			{ since: 0, mentionsOnly: "yes" },
			{ since: 0, mentions_only: true },
			{ since: 0, extra: 1 },
		])
			expect(waitSchema.allows(rejected)).toBe(false);
	});

	it("is an essential, strict, read-approved tool that an interrupt can end", async () => {
		await using f = await createToolFixture();
		const tool = new SwarmWaitTool(f.session("coordinator"));
		expect(tool).toMatchObject({
			name: "swarm_wait",
			loadMode: "essential",
			strict: true,
			approval: "read",
			interruptible: true,
			handlesToolInterrupt: true,
		});
		expect(tool.description).toContain("mentionsOnly");
	});
});

describe("swarm_wait parking", () => {
	it("parks until a post names the caller, then returns the visible posts and advances the cursor", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 });
		await f.parked("alice", call);
		expect(f.member("alice")).toMatchObject({ state: "waiting", wakeMode: "mentions", waitSince: 1 });
		expect(f.runtime.waiters(f.id)).toEqual([
			{ swarmId: f.id, agentId: "Member-alice", name: "alice", since: 1, mentionsOnly: true },
		]);

		const unrelated = await f.post("coordinator", "Unrelated note");
		expect(unrelated.receipts).toEqual([]);
		expect(f.runtime.waiters(f.id)).toHaveLength(1);

		const wake = await f.post("coordinator", "@alice go");
		expect(wake.receipts).toEqual([{ name: "alice", to: "Member-alice", outcome: "woken" }]);
		const result = await call;
		expect(result.isError).not.toBe(true);
		const body = resultJson<SwarmWaitResult>(result);
		expect(seqs(body)).toEqual([2, 3, 4]);
		expect(body).toMatchObject({ lastReadSeq: 4, head: 4, boardUri: f.boardUri });
		expect(body.interrupted).toBeUndefined();
		expect(result.details).toEqual({ boardUri: f.boardUri, since: 1, mentionsOnly: true, result: body });
		expect(f.runtime.waiters(f.id)).toEqual([]);
		expect(f.member("alice")).toMatchObject({ state: "working", wakeMode: null, waitSince: null, lastReadSeq: 4 });
	});

	it("wakes on @all and on a numbered group's base name", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("parse", { n: 2 });
		const everyone = new SwarmWaitTool(f.session("alice")).execute("wait-all", { since: 3 });
		await f.parked("alice", everyone);
		await f.post("parse-1", "@all heads up");
		expect(seqs(resultJson<SwarmWaitResult>(await everyone))).toEqual([4]);

		const group = new SwarmWaitTool(f.session("parse-2")).execute("wait-group", { since: 4 });
		await f.parked("parse-2", group);
		const rung = await f.post("coordinator", "@parse next slice");
		expect(rung.receipts.find(receipt => receipt.name === "parse-2")).toMatchObject({ outcome: "woken" });
		expect(seqs(resultJson<SwarmWaitResult>(await group))).toEqual([5]);
	});

	it("wakes for any visible post with mentionsOnly false", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1, mentionsOnly: false });
		await f.parked("alice", call);
		expect(f.member("alice")?.wakeMode).toBe("any");
		await f.post("coordinator", "No mention here");
		const result = await call;
		expect(seqs(resultJson<SwarmWaitResult>(result))).toEqual([2]);
		expect(result.details).toMatchObject({ since: 1, mentionsOnly: false });
	});

	it("returns at once when a matching post is already on the board", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.post("coordinator", "@alice early");
		const result = await new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 });
		expect(seqs(resultJson<SwarmWaitResult>(result))).toEqual([2]);
		expect(f.runtime.waiters(f.id)).toEqual([]);
	});

	it("shows a parked member as waiting in the roster", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 });
		await f.parked("alice", call);
		const status = await new SwarmReadTool(f.session("coordinator")).execute("status", { status: true });
		const row = parseRoster(resultText(status)).find(candidate => candidate.Member === "alice");
		expect(row).toMatchObject({ State: "waiting", Wake: "mentions after #1" });
		expect(status.details?.snapshot?.members.find(member => member.name === "alice")).toMatchObject({
			state: "waiting",
			wakeMode: "mentions",
			waitSince: 1,
		});
		await f.post("coordinator", "@alice wake up");
		await call;
	});
});

describe("swarm_wait cursor", () => {
	it("returns 200-message pages and leaves the cursor at the last message shown", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		for (let item = 1; item <= 201; item++) f.board.append("coordinator", `@alice item ${item}`);
		const tool = new SwarmWaitTool(f.session("alice"));

		const first = resultJson<SwarmWaitResult>(await tool.execute("page-1", { since: 1 }));
		expect(first.messages).toHaveLength(200);
		expect(seqs(first)[0]).toBe(2);
		expect(first).toMatchObject({ lastReadSeq: 201, head: 202 });
		expect(f.member("alice")?.lastReadSeq).toBe(201);

		const second = resultJson<SwarmWaitResult>(await tool.execute("page-2", { since: first.lastReadSeq }));
		expect(seqs(second)).toEqual([202]);
		expect(second.lastReadSeq).toBe(202);
		expect(second.messages[0].text).toBe("@alice item 201");
	}, 30_000);
});

describe("swarm_wait interruption", () => {
	const reasons: Array<[string, unknown]> = [
		["a tool interrupt", TOOL_INTERRUPT_ABORT_REASON],
		["a user abort", undefined],
	];

	it.each(reasons)("returns the visible posts with interrupted after %s", async (_label, reason) => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const controller = new AbortController();
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 }, controller.signal);
		await f.parked("alice", call);
		await f.post("coordinator", "Visible but not addressed");
		expect(f.runtime.waiters(f.id)).toHaveLength(1);

		controller.abort(reason);
		const result = await call;
		expect(result.isError).not.toBe(true);
		const body = resultJson<SwarmWaitResult>(result);
		expect(body.interrupted).toBe(true);
		expect(seqs(body)).toEqual([2, 3]);
		expect(body).toMatchObject({ lastReadSeq: 3, head: 3, boardUri: f.boardUri });
		expect(result.details).toEqual({ boardUri: f.boardUri, since: 1, mentionsOnly: true, result: body });
		expect(f.runtime.waiters(f.id)).toEqual([]);
		expect(f.member("alice")).toMatchObject({ state: "working", lastReadSeq: 3 });
	});

	it("keeps the cursor in place when nothing was visible at the interrupt", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const controller = new AbortController();
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 }, controller.signal);
		await f.parked("alice", call);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const body = resultJson<SwarmWaitResult>(await call);
		expect(body).toMatchObject({ messages: [], lastReadSeq: 1, head: 1, interrupted: true });
		expect(f.member("alice")?.lastReadSeq).toBe(1);
	});

	it("drains without parking when the interrupt arrived before the call started", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.post("coordinator", "Waiting in the board");
		const controller = new AbortController();
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 }, controller.signal);
		const body = resultJson<SwarmWaitResult>(result);
		expect(body).toMatchObject({ lastReadSeq: 2, interrupted: true });
		expect(seqs(body)).toEqual([2]);
		expect(f.runtime.waiters(f.id)).toEqual([]);
	});
});

describe("swarm_wait refusals and failures", () => {
	it("refuses a second concurrent wait by the same member with isError and the board link", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const controller = new AbortController();
		const first = new SwarmWaitTool(f.session("alice")).execute("first", { since: 1 }, controller.signal);
		await f.parked("alice", first);
		const second = await new SwarmWaitTool(f.session("alice")).execute("second", { since: 1, mentionsOnly: false });
		expect(second.isError).toBe(true);
		const body = resultJson<{ error: string; boardUri: string }>(second);
		expect(body.error).toMatch(/pending swarm_wait/);
		expect(body.boardUri).toBe(f.boardUri);
		expect(second.details).toEqual({ boardUri: f.boardUri, since: 1, mentionsOnly: false, error: body.error });
		expect(f.runtime.waiters(f.id)).toHaveLength(1);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		await first;
	});

	it("reports an empty board link while the session cannot reach a board", async () => {
		await using f = await createToolFixture();
		const result = await new SwarmWaitTool(f.sessionWith("coordinator", { "swarm.enabled": false })).execute("wait", {
			since: 0,
		});
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			boardUri: "",
			since: 0,
			mentionsOnly: true,
			error: "Swarm is disabled in settings",
		});
		expect(resultJson<{ boardUri: string }>(result).boardUri).toBe("");
	});

	it("raises ToolError for unexpected failures", async () => {
		await using f = await createToolFixture();
		vi.spyOn(f.journal, "flush").mockRejectedValueOnce(new Error("journal offline"));
		const failure = new SwarmWaitTool(f.session("coordinator")).execute("wait", { since: 0 });
		await expect(failure).rejects.toBeInstanceOf(ToolError);
		await expect(failure).rejects.toThrow("journal offline");
		expect(f.runtime.waiters(f.id)).toEqual([]);
	});
});

describe("swarm.wait.maxMs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("arms no timer for a park under the default limit of zero", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		expect(cfgSwarmWaitMaxMs.get(f.settings)).toBe(0);
		vi.useFakeTimers();
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const interval = vi.spyOn(globalThis, "setInterval");
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 });
		await f.parked("alice", call);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(f.runtime.waiters(f.id)).toHaveLength(1);

		await f.post("coordinator", "@alice go");
		const body = resultJson<SwarmWaitResult>(await call);
		expect(seqs(body)).toEqual([2]);
		expect(body.timedOut).toBeUndefined();
		expect(body.interrupted).toBeUndefined();
		expect(timeout).not.toHaveBeenCalled();
		expect(interval).not.toHaveBeenCalled();
	});

	it("ends the park with timedOut once the limit passes, carrying the visible posts and moving the cursor", async () => {
		await using f = await createToolFixture({ "swarm.wait.maxMs": 60_000 });
		await f.add("alice");
		vi.useFakeTimers();
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 });
		await f.parked("alice", call);
		expect(vi.getTimerCount()).toBe(1);
		await f.post("coordinator", "Visible but not addressed");
		expect(f.runtime.waiters(f.id)).toHaveLength(1);

		vi.advanceTimersByTime(59_999);
		expect(f.runtime.waiters(f.id)).toHaveLength(1);
		vi.advanceTimersByTime(1);
		const result = await call;
		expect(result.isError).not.toBe(true);
		const body = resultJson<SwarmWaitResult>(result);
		expect(body.timedOut).toBe(true);
		expect(body.interrupted).toBeUndefined();
		expect(seqs(body)).toEqual([2]);
		expect(body).toMatchObject({ lastReadSeq: 2, head: 2, boardUri: f.boardUri });
		expect(result.details).toEqual({ boardUri: f.boardUri, since: 1, mentionsOnly: true, result: body });
		expect(f.runtime.waiters(f.id)).toEqual([]);
		expect(f.member("alice")).toMatchObject({ state: "working", wakeMode: null, waitSince: null, lastReadSeq: 2 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the cursor in place when the limit passes with nothing visible", async () => {
		await using f = await createToolFixture({ "swarm.wait.maxMs": 60_000 });
		await f.add("alice");
		vi.useFakeTimers();
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 });
		await f.parked("alice", call);
		vi.advanceTimersByTime(60_000);
		const body = resultJson<SwarmWaitResult>(await call);
		expect(body).toMatchObject({ messages: [], lastReadSeq: 1, head: 1, timedOut: true });
		expect(body.interrupted).toBeUndefined();
		expect(f.member("alice")?.lastReadSeq).toBe(1);
		expect(f.runtime.waiters(f.id)).toEqual([]);
	});

	it("ends normally and clears its timer when an addressed post arrives before the limit", async () => {
		await using f = await createToolFixture({ "swarm.wait.maxMs": 60_000 });
		await f.add("alice");
		vi.useFakeTimers();
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 });
		await f.parked("alice", call);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(30_000);

		await f.post("coordinator", "@alice go");
		const body = resultJson<SwarmWaitResult>(await call);
		expect(seqs(body)).toEqual([2]);
		expect(body.timedOut).toBeUndefined();
		expect(body.interrupted).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(f.runtime.waiters(f.id)).toEqual([]);
		expect(f.member("alice")).toMatchObject({ state: "working", lastReadSeq: 2 });

		// A post already on the board ends the next call at once, and no timer outlives it.
		await f.post("coordinator", "@alice and again");
		const early = resultJson<SwarmWaitResult>(
			await new SwarmWaitTool(f.session("alice")).execute("early", { since: 2 }),
		);
		expect(seqs(early)).toEqual([3]);
		expect(early.timedOut).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps reporting an interrupt as interrupted, never as timedOut, and clears its timer", async () => {
		await using f = await createToolFixture({ "swarm.wait.maxMs": 60_000 });
		await f.add("alice");
		vi.useFakeTimers();
		const controller = new AbortController();
		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1 }, controller.signal);
		await f.parked("alice", call);
		await f.post("coordinator", "Visible but not addressed");
		vi.advanceTimersByTime(10_000);

		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const body = resultJson<SwarmWaitResult>(await call);
		expect(body.interrupted).toBe(true);
		expect(body.timedOut).toBeUndefined();
		expect(seqs(body)).toEqual([2]);
		expect(body).toMatchObject({ lastReadSeq: 2, head: 2 });
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(f.runtime.waiters(f.id)).toEqual([]);
	});

	it("accepts whole milliseconds from zero to a day and rejects anything else", () => {
		const settings = Settings.isolated();
		for (const value of [undefined, 0, 60_000, 86_400_000])
			expect(() => cfgSwarmWaitMaxMs.checkConfigured(settings, value)).not.toThrow();
		for (const value of [-1, 1.5, 86_400_001, "60000", null, Number.NaN])
			expect(() => cfgSwarmWaitMaxMs.checkConfigured(settings, value)).toThrow("swarm.wait.maxMs");
		cfgSwarmWaitMaxMs.set(settings, 300_000);
		expect(cfgSwarmWaitMaxMs.get(settings)).toBe(300_000);
	});
});

describe("swarm_wait and the caller's own posts", () => {
	it("stays parked behind a cursor that lies below the caller's own post, and a foreign post returns both", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.post("alice", "ready");

		const call = new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1, mentionsOnly: false });
		await f.parked("alice", call);
		expect(f.member("alice")).toMatchObject({ state: "waiting", wakeMode: "any", waitSince: 1, lastReadSeq: 1 });

		// The caller's own later post, as a parallel tool call would make it, does not end the park either.
		const own = await f.post("alice", "Still here");
		expect(own.receipts).toEqual([]);
		expect(f.runtime.waiters(f.id)).toHaveLength(1);

		const wake = await f.post("coordinator", "A note from the coordinator");
		expect(wake.receipts).toEqual([{ name: "alice", to: "Member-alice", outcome: "woken" }]);
		const result = await call;
		expect(result.isError).not.toBe(true);
		const body = resultJson<SwarmWaitResult>(result);
		expect(body.messages.map(message => [message.seq, message.agent])).toEqual([
			[2, "alice"],
			[3, "alice"],
			[4, "coordinator"],
		]);
		expect(body).toMatchObject({ lastReadSeq: 4, head: 4 });
		expect(body.interrupted).toBeUndefined();
		expect(f.runtime.waiters(f.id)).toEqual([]);
		expect(f.member("alice")).toMatchObject({ state: "working", lastReadSeq: 4 });
	});

	it("keeps returning at once when the first post after the cursor is someone else's", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.post("coordinator", "A note before the wait");
		await f.post("alice", "ready");
		const body = resultJson<SwarmWaitResult>(
			await new SwarmWaitTool(f.session("alice")).execute("wait", { since: 1, mentionsOnly: false }),
		);
		expect(seqs(body)).toEqual([2, 3]);
		expect(body.lastReadSeq).toBe(3);
		expect(f.runtime.waiters(f.id)).toEqual([]);
	});
});
