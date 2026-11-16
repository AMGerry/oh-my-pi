import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import type { PreparedSwarmMember, SwarmLaunchPlan, SwarmMemberContext } from "./context";
import {
	memberNameSchema,
	sequenceSchema,
	type BoardPost,
	type BoardReadOptions,
	type BoardReadResult,
	type SwarmChannel,
	type SwarmSnapshot,
} from "./types";

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

export const postSchema = type({
	text: "string > 0",
	"channel?": memberNameSchema,
	"+": "reject",
});
export const readSchema = type({
	"since?": sequenceSchema,
	"limit?": "1 <= number.integer <= 2000",
	"channel?": memberNameSchema.or("'*'"),
	"status?": "boolean",
	"+": "reject",
});
export const waitSchema = type({
	since: sequenceSchema,
	"mentionsOnly?": "boolean",
	"+": "reject",
});
export type PostParams = typeof postSchema.infer;
export type ReadParams = typeof readSchema.infer;
export type WaitParams = typeof waitSchema.infer;

/** A disconnected caller leaves pending messages available to its next persisted turn. */
export const SWARM_WAIT_DISCONNECTED = Symbol("swarm wait disconnected");

export type SwarmDeliveryReceipt = IrcDeliveryReceipt & { name: string };
export interface SwarmPostResult {
	post: BoardPost;
	receipts: SwarmDeliveryReceipt[];
	head: number;
	lastReadSeq: number;
	boardUri: string;
}
export interface SwarmReadResult extends BoardReadResult {
	boardUri: string;
}
export interface SwarmWaitResult extends SwarmReadResult {
	interrupted?: true;
}
export interface SwarmWaitSnapshot {
	swarmId: string;
	agentId: string;
	name: string;
	since: number;
	mentionsOnly: boolean;
}

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
	post(actor: SwarmActor, text: string, channel?: string): Promise<SwarmPostResult>;
	read(actor: SwarmActor, options?: BoardReadOptions): Promise<SwarmReadResult>;
	wait(actor: SwarmActor, options: WaitParams, signal?: AbortSignal): Promise<SwarmWaitResult>;
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
