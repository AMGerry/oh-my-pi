import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { postSchema, type SwarmPostResult } from "../../src/swarm/api";
import { SwarmPostTool } from "../../src/swarm/tools/swarm-post";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { createToolFixture, resultJson, resultText } from "./tool-fixture";

describe("swarm_post schema", () => {
	it("accepts the documented arguments and rejects everything else", () => {
		expect(postSchema.allows({ text: "hello" })).toBe(true);
		expect(postSchema.allows({ text: "@alice go\n  indented", channel: "parser" })).toBe(true);
		for (const rejected of [
			{},
			{ text: "" },
			{ text: 1 },
			{ text: "x", channel: "Parser" },
			{ text: "x", channel: "*" },
			{ text: "x", channel: "" },
			{ text: "x", extra: true },
		])
			expect(postSchema.allows(rejected)).toBe(false);
	});

	it("is an essential, strict, exec-approved tool that documents addressing and receipts", async () => {
		await using f = await createToolFixture();
		const tool = new SwarmPostTool(f.session("coordinator"));
		expect(tool).toMatchObject({
			name: "swarm_post",
			loadMode: "essential",
			strict: true,
			approval: "exec",
		});
		expect(tool.parameters.allows({ text: "ok" })).toBe(true);
		expect(tool.description).toContain("@#channel");
		expect(tool.description).toContain("receipts");
	});
});

describe("swarm_post behavior", () => {
	it("appends the complete post durably and reports it with the board link", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const text = "@alice take the lexer\n  keep this indentation\nsee #2 for the contract";
		const result = await new SwarmPostTool(f.session("coordinator")).execute("post", { text });
		expect(result.isError).not.toBe(true);
		const body = resultJson<SwarmPostResult>(result);
		expect(body).toMatchObject({
			post: { seq: 3, agent: "coordinator", text, mentions: ["alice"], all: false },
			head: 3,
			lastReadSeq: 0,
			boardUri: f.boardUri,
		});
		expect(body.post.channel).toBeUndefined();
		expect(body.receipts.map(receipt => receipt.name)).toEqual(["alice"]);
		expect(body.receipts[0]).toMatchObject({ to: "Member-alice" });
		expect(result.details).toEqual({ boardUri: f.boardUri, result: body });
		expect(f.board.posts().at(-1)).toEqual(body.post);
		const lines = fs.readFileSync(path.join(f.board.dir, "board.jsonl"), "utf8").trimEnd().split("\n");
		expect(JSON.parse(lines.at(-1)!)).toEqual(body.post);
	});

	it("stores a post that names nobody and rings nobody", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const result = await new SwarmPostTool(f.session("alice")).execute("post", {
			text: "Interim note, no action needed",
		});
		const body = resultJson<SwarmPostResult>(result);
		expect(body.post).toMatchObject({ seq: 2, agent: "alice", mentions: [], all: false });
		expect(body.receipts).toEqual([]);
		expect(f.board.posts()).toHaveLength(2);
		expect(f.member("coordinator")?.lastReadSeq).toBe(0);
	});

	it("rings a numbered group by its base name and every member, the author included, for @all", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("parse", { n: 2 });
		const tool = new SwarmPostTool(f.session("coordinator"));
		const group = resultJson<SwarmPostResult>(await tool.execute("group", { text: "@parse next slice" }));
		expect(group.receipts.map(receipt => receipt.name).sort()).toEqual(["parse-1", "parse-2"]);
		const single = resultJson<SwarmPostResult>(await tool.execute("single", { text: "@parse-2 only you" }));
		expect(single.receipts.map(receipt => receipt.name)).toEqual(["parse-2"]);
		const everyone = resultJson<SwarmPostResult>(await tool.execute("all", { text: "@all status please" }));
		expect(everyone.post.all).toBe(true);
		expect(everyone.receipts.map(receipt => receipt.name).sort()).toEqual([
			"alice",
			"coordinator",
			"parse-1",
			"parse-2",
		]);
		// The author is addressed like everyone else; its receipt reports its own session availability.
		expect(everyone.receipts.find(receipt => receipt.name === "coordinator")).toMatchObject({
			to: "Main",
			outcome: "failed",
			error: expect.stringContaining("no live session"),
		});
	});

	it("rings with a board notice that names the post and the recipient's own cursor", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const controller = new AbortController();
		const aliceBell = f.bus.wait("Member-alice", {}, 0, controller.signal);
		const authorBell = f.bus.wait("Main", {}, 0, controller.signal);
		const result = resultJson<SwarmPostResult>(
			await new SwarmPostTool(f.session("coordinator")).execute("post", { text: "@all heads up" }),
		);
		expect(result.post.seq).toBe(3);
		const outcomes = Object.fromEntries(result.receipts.map(receipt => [receipt.name, receipt.outcome]));
		expect(outcomes).toEqual({ alice: "injected", bob: "failed", coordinator: "injected" });
		expect(await aliceBell).toMatchObject({
			from: "Main",
			to: "Member-alice",
			body: "[swarm] board moved: #3; swarm_read{since:1}",
			boardNotice: { id: f.id, seq: 3 },
		});
		expect(await authorBell).toMatchObject({
			from: "Main",
			to: "Main",
			body: "[swarm] board moved: #3; swarm_read{since:0}",
			boardNotice: { id: f.id, seq: 3 },
		});
		// A doorbell is not a direct question the sender waits on.
		expect(f.bus.unansweredSends("Main", 0)).toEqual([]);

		// A post that names only bob leaves alice's parked bus waiter untouched.
		const bystander = f.bus.wait("Member-alice", {}, 0, controller.signal);
		const narrow = resultJson<SwarmPostResult>(
			await new SwarmPostTool(f.session("coordinator")).execute("narrow", { text: "@bob only you" }),
		);
		expect(narrow.receipts.map(receipt => receipt.name)).toEqual(["bob"]);
		controller.abort(new Error("stop"));
		await expect(bystander).rejects.toThrow("stop");
	});

	it("posts to a named channel for its subscribers", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const coordinator = await f.actorOf("coordinator");
		await f.runtime.channel(coordinator, {
			action: "channel",
			op: "create",
			channel: "parser",
			topic: "Parser work",
		});
		const result = await new SwarmPostTool(f.session("coordinator")).execute("post", {
			text: "Parser-only note",
			channel: "parser",
		});
		expect(resultJson<SwarmPostResult>(result).post).toMatchObject({ channel: "parser", text: "Parser-only note" });
		expect(f.board.posts().at(-1)?.channel).toBe("parser");
	});

	it("reports a killed member in its receipt and leaves it killed", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		await f.runtime.kill(f.actor, "bob");
		const result = await new SwarmPostTool(f.session("coordinator")).execute("post", { text: "@bob are you there" });
		expect(result.isError).not.toBe(true);
		const body = resultJson<SwarmPostResult>(result);
		expect(body.receipts).toHaveLength(1);
		expect(body.receipts[0]).toMatchObject({ name: "bob", outcome: "failed" });
		expect(body.receipts[0].error).toMatch(/killed/);
		expect(f.member("bob")?.state).toBe("killed");
	});
});

describe("swarm_post refusals and failures", () => {
	it("refuses expected misuse with isError, the reason and the board link, and stores nothing", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const coordinator = await f.actorOf("coordinator");
		await f.runtime.channel(coordinator, { action: "channel", op: "create", channel: "parser" });
		const head = f.board.head;
		const cases: Array<[string, { text: string; channel?: string }, RegExp, string]> = [
			["coordinator", { text: " \n\t " }, /must contain text/, "whitespace-only text"],
			["coordinator", { text: "@#main hello" }, /@all/, "an @#main mention"],
			["coordinator", { text: "hello", channel: "ghost" }, /Channel ghost is unavailable/, "an unknown channel"],
			["bob", { text: "hello", channel: "parser" }, /not subscribed to parser/, "an unsubscribed worker channel"],
		];
		for (const [member, params, pattern, label] of cases) {
			const result = await new SwarmPostTool(f.session(member)).execute("post", params);
			expect(result.isError, label).toBe(true);
			const body = resultJson<{ error: string; boardUri: string }>(result);
			expect(body.error, label).toMatch(pattern);
			expect(body.boardUri, label).toBe(f.boardUri);
			expect(result.details, label).toEqual({ boardUri: f.boardUri, error: body.error });
		}
		expect(f.board.head).toBe(head);
	});

	it("reports an empty board link while the session cannot reach a board", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const disabled = await new SwarmPostTool(f.sessionWith("coordinator", { "swarm.enabled": false })).execute(
			"post",
			{
				text: "hello",
			},
		);
		expect(disabled.isError).toBe(true);
		expect(resultJson<{ error: string; boardUri: string }>(disabled)).toEqual({
			error: "Swarm is disabled in settings",
			boardUri: "",
		});
		expect(disabled.details).toEqual({ boardUri: "", error: "Swarm is disabled in settings" });
		await f.runtime.kill(f.actor, "alice");
		const killed = await new SwarmPostTool(f.session("alice")).execute("post", { text: "I am back" });
		expect(killed.isError).toBe(true);
		expect(resultJson<{ error: string; boardUri: string }>(killed)).toMatchObject({ boardUri: "" });
		expect(resultText(killed)).toMatch(/killed/);
		expect(f.board.head).toBe(1);
	});

	it("raises ToolError for unexpected failures", async () => {
		await using f = await createToolFixture();
		vi.spyOn(f.journal, "ensureOnDisk").mockRejectedValueOnce(new Error("disk full"));
		const failure = new SwarmPostTool(f.session("coordinator")).execute("post", { text: "hello" });
		await expect(failure).rejects.toBeInstanceOf(ToolError);
		await expect(failure).rejects.toThrow("disk full");
		expect(f.board.head).toBe(0);
	});

	it("stops before posting when the call is already aborted", async () => {
		await using f = await createToolFixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			new SwarmPostTool(f.session("coordinator")).execute("post", { text: "late" }, controller.signal),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(f.board.head).toBe(0);
	});
});
