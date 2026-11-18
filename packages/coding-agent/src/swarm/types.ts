import { type } from "@oh-my-pi/omptype";

export const memberNameSchema = type("string").matching(/^[a-z][a-z0-9-]{0,39}$/);
export const sequenceSchema = type("number.integer >= 0");
export const capabilitiesSchema = type({
	channels: "boolean",
	workspaces: "boolean",
	narrator: "boolean",
	monitor: "boolean",
	graph: "boolean",
	customPage: "boolean",
});
export type SwarmCapabilities = typeof capabilitiesSchema.infer;

export const postSchema = type({
	seq: "number.integer >= 1",
	agent: memberNameSchema,
	text: "string",
	time: "string",
	"channel?": memberNameSchema,
	mentions: "string[]",
	all: "boolean",
});
export type BoardPost = typeof postSchema.infer;

export const memberSchema = type({
	agentId: "string",
	sessionFile: "string | null",
	model: "string",
	role: "'worker' | 'coordinator' | 'narrator' | 'monitor'",
	wakeMode: "'mentions' | 'any' | null",
	waitSince: "number.integer >= 0 | null",
	lastReadSeq: sequenceSchema,
	lastPostSeq: sequenceSchema,
	lastPostTime: "string | null",
	channels: "string[]",
	workspace: "'inherit' | 'share' | 'branch'",
	"workspacePath?": "string",
	"workspaceBranch?": "string",
	"workspaceBase?": "string",
	"workspaceSource?": "string",
	killed: "boolean",
	"forkOf?": "string",
	"error?": "string",
	"owner?": "string",
	"group?": "string",
	"subscribedSince?": { "[string]": sequenceSchema },
});
export type SwarmMember = typeof memberSchema.infer;
export type MemberRole = SwarmMember["role"];
export type MemberState = "working" | "waiting" | "stopped" | "killed";

export const channelSchema = type({
	topic: "string",
	createdBy: "string",
	subscribers: "string[]",
	archived: "boolean",
});
export type SwarmChannel = typeof channelSchema.infer;
export const channelsSchema = type({ "[string]": channelSchema });
export const membersSchema = type({
	title: "string",
	members: { "[string]": memberSchema },
	capabilities: capabilitiesSchema,
});
export const metadataSchema = type({
	version: "1",
	id: memberNameSchema,
	title: "string",
	created: "string",
	coordinator: "string",
});
export type SwarmMetadata = typeof metadataSchema.infer;

export interface MemberSnapshot extends SwarmMember {
	name: string;
	state: MemberState;
	unread: number;
}

export interface SwarmSnapshot {
	id: string;
	title: string;
	head: number;
	dir: string;
	capabilities: SwarmCapabilities;
	boardUri: string;
	members: MemberSnapshot[];
}

export interface BoardReadOptions {
	since?: number;
	limit?: number;
	channel?: string;
}

export interface BoardReadResult {
	messages: BoardPost[];
	lastReadSeq: number;
	head: number;
}

/** An expected policy or input refusal, presented as an isError tool result. */
export class SwarmRefusal extends Error {
	override readonly name = "SwarmRefusal";
}
