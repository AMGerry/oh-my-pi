import { describe, expect, it, vi } from "bun:test";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { readSchema, type SwarmReadResult } from "../../src/swarm/api";
import { formatRoster } from "../../src/swarm/format";
import { SwarmReadTool } from "../../src/swarm/tools/swarm-read";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { createToolFixture, parseRoster, resultJson, resultText } from "./tool-fixture";

const seqs = (result: SwarmReadResult) => result.messages.map(message => message.seq);

describe("swarm_read schema", () => {
	it("accepts the documented arguments and rejects everything else", () => {
		for (const accepted of [
			{},
			{ since: 0 },
			{ since: 3, limit: 50, channel: "parser" },
			{ limit: 2000 },
			{ channel: "*" },
			{ channel: "main" },
			{ status: true },
			{ status: false, since: 1 },
		])
			expect(readSchema.allows(accepted)).toBe(true);
		for (const rejected of [
			{ since: -1 },
			{ since: 1.5 },
			{ since: "1" },
			{ limit: 0 },
			{ limit: 2001 },
			{ limit: 1.5 },
			{ channel: "Parser" },
			{ channel: "" },
			{ status: "yes" },
			{ extra: 1 },
		])
			expect(readSchema.allows(rejected)).toBe(false);
	});

	it("is an essential, strict, read-approved tool", async () => {
		await using f = await createToolFixture();
		const tool = new SwarmReadTool(f.session("coordinator"));
		expect(tool).toMatchObject({ name: "swarm_read", loadMode: "essential", strict: true, approval: "read" });
		expect(tool.description).toContain("status:true");
	});
});

describe("swarm_read messages", () => {
	it("returns complete messages from the caller's cursor and moves only that cursor", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const first = "@alice first\n  two lines, keep the indent";
		await f.post("coordinator", first);
		await f.post("coordinator", "Plain note");
		await f.post("coordinator", "@bob only bob");
		const tool = new SwarmReadTool(f.session("alice"));

		const result = await tool.execute("read", {});
		expect(result.isError).not.toBe(true);
		const body = resultJson<SwarmReadResult>(result);
		expect(seqs(body)).toEqual([2, 3, 4, 5]);
		expect(body.messages[1]).toMatchObject({ agent: "coordinator", text: first, mentions: ["alice"], all: false });
		expect(body).toMatchObject({ lastReadSeq: 5, head: 5, boardUri: f.boardUri });
		expect(result.details).toEqual({ boardUri: f.boardUri, status: false, result: body });
		expect(f.member("alice")?.lastReadSeq).toBe(5);
		expect(f.member("bob")?.lastReadSeq).toBe(2);
		expect(f.member("coordinator")?.lastReadSeq).toBe(0);

		const again = resultJson<SwarmReadResult>(await tool.execute("again", {}));
		expect(again).toMatchObject({ messages: [], lastReadSeq: 5, head: 5 });
	});

	it("reads from an explicit cursor without moving the cursor backwards", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.post("coordinator", "One");
		await f.post("coordinator", "Two");
		const tool = new SwarmReadTool(f.session("alice"));
		expect(seqs(resultJson<SwarmReadResult>(await tool.execute("read", {})))).toEqual([2, 3]);
		const replay = resultJson<SwarmReadResult>(await tool.execute("replay", { since: 0, limit: 2 }));
		expect(seqs(replay)).toEqual([1, 2]);
		expect(replay.lastReadSeq).toBe(3);
		expect(f.member("alice")?.lastReadSeq).toBe(3);
	});

	it("pages by limit, one page per call, ending with an empty page", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		for (const label of ["a", "b", "c", "d", "e"]) await f.post("coordinator", `Note ${label}`);
		const tool = new SwarmReadTool(f.session("alice"));
		const pages: number[][] = [];
		const cursors: number[] = [];
		for (let page = 0; page < 4; page++) {
			const body = resultJson<SwarmReadResult>(await tool.execute(`page-${page}`, { limit: 2 }));
			pages.push(seqs(body));
			cursors.push(body.lastReadSeq);
		}
		expect(pages).toEqual([[2, 3], [4, 5], [6], []]);
		expect(cursors).toEqual([3, 5, 6, 6]);
	});

	it("shows each member its own channels and lets coordinator-class members read everything", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const coordinator = await f.actorOf("coordinator");
		await f.runtime.channel(coordinator, { action: "channel", op: "create", channel: "parser" });
		await f.runtime.channel(await f.actorOf("alice"), { action: "channel", op: "subscribe", channel: "parser" });
		await f.post("coordinator", "Parser-only note", "parser");
		await f.post("coordinator", "Main note");

		const read = async (member: string, params: Parameters<SwarmReadTool["execute"]>[1]) =>
			resultJson<SwarmReadResult>(await new SwarmReadTool(f.session(member)).execute("read", params));
		expect(seqs(await read("alice", {}))).toEqual([2, 3, 4]);
		expect(seqs(await read("bob", { since: 0 }))).toEqual([1, 2, 4]);
		expect(seqs(await read("bob", { since: 0, channel: "parser" }))).toEqual([]);
		expect(seqs(await read("coordinator", { since: 0, channel: "*" }))).toEqual([1, 2, 3, 4]);
		expect(seqs(await read("coordinator", { since: 0, channel: "main" }))).toEqual([1, 2, 4]);
		expect(seqs(await read("coordinator", { since: 0, channel: "parser" }))).toEqual([3]);
	});
});

describe("swarm_read status", () => {
	it("returns the roster as a Markdown table and keeps the complete snapshot in details", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		await f.runtime.kill(f.actor, "bob");
		const before = f.member("alice")?.lastReadSeq;

		const result = await new SwarmReadTool(f.session("coordinator")).execute("status", { status: true });
		expect(result.isError).not.toBe(true);
		const text = resultText(result);
		expect(text).toContain(`Board: ${f.boardUri}`);
		expect(text).toContain("Head: #2");
		expect(text).toContain("Capabilities: channels, workspaces, narrator, monitor, customPage");
		expect(text).not.toContain('"messages"');
		const roster = parseRoster(text);
		expect(roster.map(row => row.Member)).toEqual(["coordinator (you)", "alice", "bob"]);
		expect(roster[0]).toMatchObject({ Role: "coordinator", State: "stopped", Read: "#0", Unread: "2" });
		expect(roster[1]).toMatchObject({
			Role: "worker",
			State: "working",
			Wake: "—",
			Read: "#1",
			Unread: "1",
			"Last post": "—",
			Model: "mock/board-tools",
			Channels: "main",
			Workspace: "inherit",
		});
		expect(roster[2]).toMatchObject({ Role: "worker", State: "killed" });

		expect(result.details).toMatchObject({ boardUri: f.boardUri, status: true });
		expect(result.details?.result).toBeUndefined();
		expect(result.details?.snapshot).toEqual(f.runtime.snapshot(f.id));
		expect(result.details?.snapshot?.members.map(member => member.agentId)).toEqual([
			"Main",
			"Member-alice",
			"Member-bob",
		]);
		expect(f.member("alice")?.lastReadSeq).toBe(before);
		expect(f.member("coordinator")?.lastReadSeq).toBe(0);
	});

	it("marks the caller's own row and shows a worker's last post", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const posted = await f.post("alice", "@coordinator [done] lexer ready");
		const result = await new SwarmReadTool(f.session("alice")).execute("status", { status: true });
		const roster = parseRoster(resultText(result));
		expect(roster.map(row => row.Member)).toEqual(["coordinator", "alice (you)"]);
		expect(roster[1]["Last post"]).toBe(`#${posted.post.seq} ${posted.post.time}`);
	});

	it("returns the roster when status is requested alongside message options", async () => {
		await using f = await createToolFixture();
		const result = await new SwarmReadTool(f.session("coordinator")).execute("status", { status: true, since: 0 });
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ boardUri: f.boardUri, status: true });
		expect(parseRoster(resultText(result))[0]?.Member).toBe("coordinator (you)");
	});
});

describe("roster formatting", () => {
	it("renders wake triggers, notes and escaped cells from a snapshot", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const snapshot = f.runtime.snapshot(f.id);
		const [coordinator, alice] = snapshot.members;
		const text = formatRoster({
			...snapshot,
			members: [
				coordinator,
				{
					...alice,
					state: "waiting",
					wakeMode: "any",
					waitSince: 7,
					model: "pool|fast",
					error: "quota",
					group: "team",
				},
			],
		});
		const rows = parseRoster(text);
		expect(rows[0].Member).toBe("coordinator");
		expect(rows[1]).toMatchObject({
			State: "waiting",
			Wake: "any post after #7",
			Model: "pool\\|fast",
			Note: "error: quota; group: team",
		});
		expect(text.split("\n")[0]).toBe(`# Swarm ${snapshot.title} (${snapshot.id})`);
	});
});

describe("swarm_read refusals and failures", () => {
	it("refuses an all-channel read by a worker with isError and the board link", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const result = await new SwarmReadTool(f.session("alice")).execute("read", { channel: "*" });
		expect(result.isError).toBe(true);
		const body = resultJson<{ error: string; boardUri: string }>(result);
		expect(body.error).toMatch(/All-channel reads require/);
		expect(body.boardUri).toBe(f.boardUri);
		expect(result.details).toEqual({ boardUri: f.boardUri, status: false, error: body.error });
		expect(f.member("alice")?.lastReadSeq).toBe(1);
	});

	it("reports an empty board link while the session cannot reach a board", async () => {
		await using f = await createToolFixture();
		const result = await new SwarmReadTool(f.sessionWith("coordinator", { "swarm.enabled": false })).execute("read", {
			status: true,
		});
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ boardUri: "", status: true, error: "Swarm is disabled in settings" });
		expect(resultJson<{ boardUri: string }>(result).boardUri).toBe("");
	});

	it("raises ToolError for unexpected failures", async () => {
		await using f = await createToolFixture();
		vi.spyOn(f.journal, "flush").mockRejectedValueOnce(new Error("journal offline"));
		const failure = new SwarmReadTool(f.session("coordinator")).execute("read", {});
		await expect(failure).rejects.toBeInstanceOf(ToolError);
		await expect(failure).rejects.toThrow("journal offline");
	});

	it("stops before reading when the call is already aborted", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const controller = new AbortController();
		controller.abort();
		await expect(new SwarmReadTool(f.session("alice")).execute("read", {}, controller.signal)).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(f.member("alice")?.lastReadSeq).toBe(1);
	});
});
