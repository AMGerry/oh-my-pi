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
