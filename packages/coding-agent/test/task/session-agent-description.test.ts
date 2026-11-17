import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type AgentDefinition, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { SWARM_MEMBER_AGENT } from "@oh-my-pi/pi-coding-agent/swarm/context";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const DISCOVERED: AgentDefinition[] = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	},
];

function tagged(name: string, selector: string): AgentDefinition {
	return {
		name,
		description: `Pinned to ${selector}.`,
		systemPrompt: "You are a task agent.",
		model: [selector],
		source: "bundled",
	};
}

function createSession(
	sessionAgents: () => AgentDefinition[],
	advertisedSessionAgents?: () => AgentDefinition[],
): ToolSession {
	return {
		cwd: "/tmp/omp-session-agent-description",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: sessionAgents,
		advertisedSessionAgents,
	} as unknown as ToolSession;
}

describe("task description session agents", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists the frozen surface and stays byte-identical when a later tag lands", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const committed = [tagged("m1", "b/y")];
		const live = [tagged("m1", "b/y")];
		const tool = await TaskTool.create(
			createSession(
				() => live,
				() => committed,
			),
		);
		expect(tool.description).toContain("`m1`");
		expect(tool.description).toContain("b/y");

		// A mid-session `^c/w` registration only reaches the live set. The
		// model-facing description must not change: it is part of the provider tool
		// prefix, and mutating it would drop the prompt cache for the whole turn.
		const frozen = tool.description;
		live.push(tagged("m2", "c/w"));
		expect(tool.description).toBe(frozen);
		expect(tool.description).not.toContain("m2");
	});

	it("falls back to the live set when the embedder has no prompt surface", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: DISCOVERED, projectAgentsDir: null });
		const live: AgentDefinition[] = [];
		const tool = await TaskTool.create(createSession(() => live));
		expect(tool.description).not.toContain("`m1`");

		live.push(tagged("m1", "b/y"));
		expect(tool.description).toContain("`m1`");
	});
});

describe("task description and the bundled swarm member agent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves the member agent out of the roster, from discovery and from the session's agents, and lists a user agent named swarm", async () => {
		const member = getBundledAgent(SWARM_MEMBER_AGENT);
		if (!member) throw new Error("The bundled swarm member agent must exist");
		const userAgent: AgentDefinition = {
			name: "swarm",
			description: "The user's own swarm persona",
			systemPrompt: "You are my swarm persona.",
			source: "user",
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [...DISCOVERED, member, userAgent],
			projectAgentsDir: null,
		});
		const tool = await TaskTool.create(createSession(() => [tagged(SWARM_MEMBER_AGENT, "b/y"), tagged("m1", "b/y")]));

		expect(tool.description).toContain("- `task`: General-purpose task agent");
		expect(tool.description).toContain("- `swarm`: The user's own swarm persona");
		expect(tool.description).toContain("- `m1`:");
		expect(tool.description).not.toContain(`\`${SWARM_MEMBER_AGENT}\``);
		expect(tool.description).not.toContain(member.description);
	});

	it("keeps the member agent bundled under its own name, so a user agent named swarm never shadows it", () => {
		expect(SWARM_MEMBER_AGENT).toBe("swarm-member");
		expect(getBundledAgent(SWARM_MEMBER_AGENT)).toMatchObject({ name: "swarm-member", source: "bundled" });
		expect(getBundledAgent("swarm")).toBeUndefined();
	});
});
