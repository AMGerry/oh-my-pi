import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { PreparedSwarmMember, SwarmLaunchPlan, SwarmMemberContext } from "./context";
import { memberNameSchema, type SwarmChannel, type SwarmSnapshot } from "./types";

export const addSchema = type({
	action: "'add'",
	name: memberNameSchema,
	brief: "string > 0",
	"model?": "string > 0",
	"channels?": memberNameSchema.array(),
	"tasks?": type("string > 0").array().atLeastLength(1),
	"n?": "number.integer >= 1",
	"fork?": memberNameSchema,
	"workspace?": "'inherit' | 'share' | 'branch'",
	"role?": "'worker' | 'narrator' | 'monitor'",
	"+": "reject",
});
export const channelActionSchema = type({
	action: "'channel'",
	op: "'create' | 'list' | 'subscribe' | 'unsubscribe' | 'archive'",
	"channel?": memberNameSchema,
	"topic?": "string",
	"+": "reject",
});
export const controlSchema = type({ action: "'status'", "+": "reject" })
	.or({ action: "'models'", "+": "reject" })
	.or(addSchema)
	.or({ action: "'model'", model: "string > 0", "name?": memberNameSchema, "+": "reject" })
	.or({ action: "'kill'", name: memberNameSchema, "+": "reject" })
	.or({ action: "'title'", title: "string > 0", "+": "reject" })
	.or(channelActionSchema);
export type AddMemberRequest = typeof addSchema.infer;
export type ChannelRequest = typeof channelActionSchema.infer;
export type ControlParams = typeof controlSchema.infer;

/** Session-owned identity, constructed by tools rather than supplied in tool arguments. */
export interface SwarmCaller {
	agentId: string;
	cwd: string;
	sessionFile: string;
	artifactsDir: string;
	model: string;
	context?: SwarmMemberContext;
	maxMembers: number;
}

export interface SwarmActor {
	id: string;
	name: string;
	agentId: string;
}

export interface SwarmControlResult extends SwarmSnapshot {
	added?: string[];
	killed?: string[];
	channels?: Record<string, SwarmChannel>;
	retainedBranches?: string[];
}

export type PrepareSwarmMember = (plan: SwarmLaunchPlan) => Promise<PreparedSwarmMember>;

/** Main-thread control surface, shared by local tools and native worker-thread proxies. */
export interface SwarmApi {
	ensure(caller: SwarmCaller): Promise<SwarmActor>;
	status(actor: SwarmActor): Promise<SwarmControlResult>;
	add(
		caller: SwarmCaller,
		request: AddMemberRequest,
		prepare: PrepareSwarmMember,
		signal?: AbortSignal,
	): Promise<SwarmControlResult>;
	kill(actor: SwarmActor, name: string): Promise<SwarmControlResult>;
	title(actor: SwarmActor, title: string): Promise<SwarmControlResult>;
	channel(actor: SwarmActor, request: ChannelRequest): Promise<SwarmControlResult>;
	switchModel(
		actor: SwarmActor,
		name: string | undefined,
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
	): Promise<SwarmControlResult>;
}
