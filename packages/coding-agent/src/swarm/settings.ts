import { register } from "../config/registry";

export const cfgSwarmEnabled = register({
	id: "swarm.enabled",
	type: "boolean",
	default: true,
	ui: { tab: "tasks", group: "Swarm", label: "Swarm", description: "Shared-board tools, skills and live board" },
});

export const cfgSwarmMaxMembers = register({
	id: "swarm.maxMembers",
	type: "number",
	default: 32,
	validate(value: unknown): void {
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 256)
			throw new Error("swarm.maxMembers must be an integer between 1 and 256");
	},
	ui: {
		tab: "tasks",
		group: "Swarm",
		label: "Maximum Members",
		description: "Active workers and helper members per swarm",
		options: [8, 16, 32, 64, 128, 256].map(value => ({ value: String(value), label: String(value) })),
	},
});

export const cfgSwarmBoardTab = register({
	id: "swarm.board.tab",
	type: "enum",
	values: ["board", "members", "overview"] as const,
	default: "board",
	ui: {
		tab: "tasks",
		group: "Swarm",
		label: "Board Tab",
		description: "Initial tab when opening the swarm board",
		options: [
			{ value: "board", label: "Board" },
			{ value: "members", label: "Members" },
			{ value: "overview", label: "Overview" },
		],
	},
});

export const cfgSwarmBoardMaxBytes = register({
	id: "swarm.board.maxBytes",
	type: "number",
	default: 65_536,
	validate(value: unknown): void {
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1_024 || value > 65_536)
			throw new Error("swarm.board.maxBytes must be an integer between 1024 and 65536");
	},
	ui: {
		tab: "tasks",
		group: "Swarm",
		label: "Overview Size Limit",
		description: "Maximum bytes read from each overview and plan document",
		options: [8_192, 16_384, 32_768, 65_536].map(value => ({
			value: String(value),
			label: `${value / 1_024} KiB`,
		})),
	},
});

const WAIT_LIMITS: ReadonlyArray<readonly [number, string]> = [
	[0, "Unlimited"],
	[60_000, "1 minute"],
	[300_000, "5 minutes"],
	[900_000, "15 minutes"],
	[3_600_000, "1 hour"],
];

export const cfgSwarmWaitMaxMs = register({
	id: "swarm.wait.maxMs",
	type: "number",
	default: 0,
	validate(value: unknown): void {
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 86_400_000)
			throw new Error("swarm.wait.maxMs must be an integer between 0 and 86400000");
	},
	ui: {
		tab: "tasks",
		group: "Swarm",
		label: "Wait Limit",
		description: "Longest park of one swarm_wait call; Unlimited parks on board events alone",
		options: WAIT_LIMITS.map(([value, label]) => ({ value: String(value), label })),
	},
});
