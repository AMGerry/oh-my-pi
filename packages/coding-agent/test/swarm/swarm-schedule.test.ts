import { describe, expect, it } from "bun:test";
import { scheduleSchema, type SwarmScheduleResult } from "../../src/swarm/api";
import { SwarmScheduleTool } from "../../src/swarm/tools/swarm-schedule";
import { createToolFixture, resultJson, resultText } from "./tool-fixture";

describe("swarm_schedule", () => {
	it("accepts only the documented action shapes", () => {
		for (const value of [
			{ action: "create", cron: "* * * * *", prompt: "Inspect" },
			{ action: "create", cron: "*/3 * * * *", prompt: "Inspect", daemon: true },
			{ action: "list" },
			{ action: "kill", id: "schedule-id" },
		])
			expect(scheduleSchema.allows(value)).toBe(true);
		for (const value of [
			{},
			{ action: "create", cron: "", prompt: "Inspect" },
			{ action: "create", cron: "* * * * *", prompt: "" },
			{ action: "create", cron: "* * * * *", prompt: "Inspect", daemon: "yes" },
			{ action: "list", id: "x" },
			{ action: "kill" },
			{ action: "kill", id: "" },
			{ action: "create", cron: "* * * * *", prompt: "Inspect", owner: "another" },
		])
			expect(scheduleSchema.allows(value)).toBe(false);
	});

	it("creates, lists and kills owned schedules through the native tool API", async () => {
		await using f = await createToolFixture();
		await f.add("monitor", { role: "monitor" });
		const tool = new SwarmScheduleTool(f.session("monitor"));
		expect(tool).toMatchObject({ name: "swarm_schedule", strict: true, loadMode: "essential", approval: "exec" });
		const created = await tool.execute("create", { action: "create", cron: "*/3 * * * *", prompt: "Inspect stalls" });
		expect(created.isError).not.toBe(true);
		const body = resultJson<SwarmScheduleResult>(created);
		expect(body.boardUri).toBe(f.boardUri);
		expect(body.id).toBe(body.task?.id);
		expect(body.task).toMatchObject({
			owner: "monitor",
			agentId: "Member-monitor",
			daemon: false,
			running: false,
			cron: "*/3 * * * *",
		});
		expect(Number.isFinite(Date.parse(body.task!.nextFire))).toBe(true);
		expect(created.details).toEqual({ action: "create", boardUri: f.boardUri, result: body });
		const listed = resultJson<SwarmScheduleResult>(await tool.execute("list", { action: "list" }));
		expect(listed.tasks).toEqual([body.task!]);
		const killed = await tool.execute("kill", { action: "kill", id: body.id! });
		expect(resultJson<SwarmScheduleResult>(killed)).toEqual({ id: body.id, boardUri: f.boardUri });
		expect(resultJson<SwarmScheduleResult>(await tool.execute("list-empty", { action: "list" })).tasks).toEqual([]);
	});

	it("enforces ownership and lets the coordinator see and stop every board schedule", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		await f.add("bob");
		const alice = new SwarmScheduleTool(f.session("alice"));
		const bob = new SwarmScheduleTool(f.session("bob"));
		const coordinator = new SwarmScheduleTool(f.session("coordinator"));
		const task = resultJson<SwarmScheduleResult>(
			await alice.execute("create", { action: "create", cron: "* * * * *", prompt: "Inspect", daemon: true }),
		);
		expect(resultJson<SwarmScheduleResult>(await bob.execute("list", { action: "list" })).tasks).toEqual([]);
		const refused = await bob.execute("steal", { action: "kill", id: task.id! });
		expect(refused.isError).toBe(true);
		expect(resultText(refused)).toContain("owner or coordinator");
		expect(refused.details?.boardUri).toBe(f.boardUri);
		expect(resultJson<SwarmScheduleResult>(await coordinator.execute("list", { action: "list" })).tasks).toHaveLength(
			1,
		);
		expect((await coordinator.execute("kill", { action: "kill", id: task.id! })).isError).not.toBe(true);
	});

	it("removes a killed member's tasks and reports invalid expressions and the settings gate", async () => {
		await using f = await createToolFixture();
		await f.add("alice");
		const tool = new SwarmScheduleTool(f.session("alice"));
		for (const params of [
			{ action: "create" as const, cron: "0 0 31 FEB *", prompt: "Inspect" },
			{ action: "create" as const, cron: "* * * * *", prompt: " \n " },
			{ action: "kill" as const, id: "missing" },
		]) {
			const refused = await tool.execute("invalid", params);
			expect(refused.isError).toBe(true);
			expect(refused.details?.boardUri).toBe(f.boardUri);
		}
		await tool.execute("create", { action: "create", cron: "* * * * *", prompt: "Inspect" });
		await f.runtime.kill(f.actor, "alice");
		expect(f.runtime.scheduler.list(f.actor)).toEqual([]);
		const killed = await tool.execute("killed", { action: "list" });
		expect(killed.isError).toBe(true);
		const disabled = await new SwarmScheduleTool(f.sessionWith("coordinator", { "swarm.enabled": false })).execute(
			"disabled",
			{ action: "list" },
		);
		expect(disabled.isError).toBe(true);
		expect(resultText(disabled)).toContain("disabled");
	});
});
