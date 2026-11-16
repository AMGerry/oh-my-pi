import { type } from "@oh-my-pi/omptype";
import { memberNameSchema } from "./types";

export const swarmMemberContextSchema = type({
	kind: "'swarm'",
	id: memberNameSchema,
	name: memberNameSchema,
	agentId: "string",
	dir: "string",
});
export type SwarmMemberContext = typeof swarmMemberContextSchema.infer;

const entrySchema = type({
	type: "'custom'",
	customType: "'swarm.member'",
	data: swarmMemberContextSchema,
});

/** The latest binding belongs to this session; a fork appends its own binding after inherited history. */
export function getSwarmMemberContext(entries: readonly unknown[]): SwarmMemberContext | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entrySchema.allows(entry)) return structuredClone(entry.data);
	}
	return undefined;
}

export interface SwarmLaunchPlan {
	name: string;
	brief: string;
	model: string;
	coordinatorModel: string;
	cwd: string;
	forkFrom?: string;
	context: Omit<SwarmMemberContext, "agentId">;
}

export interface SwarmMemberOutcome {
	error?: string;
	model?: string;
}

export interface PreparedSwarmMember {
	agentId: string;
	model: string;
	start(brief: string, onSettled: (outcome: SwarmMemberOutcome) => void | Promise<void>): Promise<void>;
}
