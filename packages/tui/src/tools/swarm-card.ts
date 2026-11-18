import { type } from "@oh-my-pi/omptype";
import { formatCount } from "@oh-my-pi/pi-utils";
import { text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { renderStatusLine } from "../render";
import { createCachedComponent } from "../render/render-utils";
import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import { truncateToWidth, wrapTextWithAnsi } from "../utils";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

export type SwarmToolName = "swarm" | "swarm_post" | "swarm_read" | "swarm_wait" | "swarm_schedule";
const LABELS: Record<SwarmToolName, string> = {
	swarm: "Swarm",
	swarm_post: "Swarm post",
	swarm_read: "Swarm read",
	swarm_wait: "Swarm wait",
	swarm_schedule: "Swarm schedule",
};
const sequence = type("0 <= number.integer <= 9007199254740991");
const argsSchema = type({
	"action?": "string",
	"name?": "string",
	"title?": "string",
	"model?": "string",
	"text?": "string",
	"channel?": "string",
	"since?": sequence,
	"mentionsOnly?": "boolean",
	"status?": "boolean",
	"cron?": "string",
	"daemon?": "boolean",
	"id?": "string",
	"n?": sequence,
	"tasks?": "string[]",
	"op?": "string",
});
type SwarmRenderArgs = typeof argsSchema.infer;
const envelopeSchema = type({ "action?": "string", "error?": "string", "result?": "unknown", "snapshot?": "unknown" });
const memberSchema = type({
	name: "string",
	state: "'working' | 'waiting' | 'stopped' | 'killed'",
	model: "string",
	role: "string",
	"unread?": sequence,
	"error?": "string",
});
const snapshotSchema = type({
	title: "string",
	head: sequence,
	members: memberSchema.array(),
	"added?": "string[]",
	"killed?": "string[]",
	"retainedBranches?": "string[]",
	"retainedWorkspaces?": "string[]",
	"models?": type({ model: "string", name: "string" }).array(),
	"channels?": { "[string]": "unknown" },
});
const postSchema = type({ seq: sequence, agent: "string", text: "string", "channel?": "string" });
const readSchema = type({
	messages: postSchema.array(),
	head: sequence,
	lastReadSeq: sequence,
	"interrupted?": "boolean",
});
const postResultSchema = type({
	post: postSchema,
	head: sequence,
	lastReadSeq: sequence,
	receipts: type({
		name: "string",
		outcome: "'injected' | 'woken' | 'revived' | 'failed'",
		"error?": "string",
	}).array(),
});
const taskSchema = type({
	id: "string",
	owner: "string",
	cron: "string",
	nextFire: "string",
	daemon: "boolean",
	running: "boolean",
	"error?": "string",
});
const scheduleSchema = type({ "id?": "string", "task?": taskSchema, "tasks?": taskSchema.array() }).narrow(
	value => Boolean(value.id) || value.task !== undefined || value.tasks !== undefined,
);
const BOARD_LINK = /swarm:\/\/[^\s<>\])"']*/gi;

interface SwarmCard {
	title: string;
	target?: string;
	meta: string[];
	rows: string[];
	note?: string;
	error?: boolean;
	passive?: boolean;
}

function cleanCard(card: SwarmCard): SwarmCard {
	card.title = plainText(card.title).replace(BOARD_LINK, "[board]");
	card.target = card.target === undefined ? undefined : plainText(card.target).replace(BOARD_LINK, "[board]");
	card.meta = card.meta.map(value => plainText(value).replace(BOARD_LINK, "[board]"));
	card.rows = card.rows.map(value => plainText(value).replace(BOARD_LINK, "[board]"));
	card.note = card.note === undefined ? undefined : plainText(card.note).replace(BOARD_LINK, "[board]");
	return card;
}

function callCard(name: SwarmToolName, input: unknown, options: RenderResultOptions): SwarmCard {
	const args: SwarmRenderArgs = argsSchema.allows(input) ? input : {};
	const card: SwarmCard = { title: LABELS[name], meta: [], rows: [] };
	switch (name) {
		case "swarm":
			card.target = [args.action, args.name ?? args.title ?? args.channel].filter(Boolean).join(" ");
			if (args.model) card.meta.push(args.model);
			if (args.n !== undefined || args.tasks)
				card.meta.push(formatCount("member", args.tasks?.length ?? args.n ?? 0));
			if (args.op) card.meta.push(args.op);
			break;
		case "swarm_post":
			card.target = args.channel ?? "main";
			if (args.text) card.rows.push(args.text);
			break;
		case "swarm_read":
			card.target = args.status ? "members" : (args.channel ?? "main");
			if (args.since !== undefined) card.meta.push(`after #${args.since}`);
			break;
		case "swarm_wait":
			card.target = args.since === undefined ? undefined : `after #${args.since}`;
			card.meta.push(args.mentionsOnly === false ? "any post" : "mentions");
			card.passive = options.executionStarted === true && options.cancelled !== true;
			if (card.passive) card.note = "parked";
			break;
		case "swarm_schedule":
			card.target = [args.action, args.cron ?? args.id].filter(Boolean).join(" ");
			if (args.daemon) card.meta.push("daemon");
			break;
	}
	return card;
}

function resultCard(
	name: SwarmToolName,
	result: ToolRenderResult,
	input: unknown,
	options: RenderResultOptions,
): SwarmCard {
	const card = callCard(name, input, options);
	const details = envelopeSchema.allows(result.details) ? result.details : undefined;
	let payload: unknown = details?.snapshot ?? details?.result;
	let failure = details?.error;
	const content = result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
	if (payload === undefined) {
		try {
			payload = JSON.parse(content);
		} catch {
			payload = undefined;
		}
	}
	if (envelopeSchema.allows(payload)) failure ??= payload.error;
	if (failure || result.isError) {
		card.error = true;
		card.passive = false;
		card.note = undefined;
		card.rows = [(failure || content || "Swarm call failed").slice(0, 4_096)];
		return card;
	}
	if (options.isPartial && payload === undefined) return card;
	card.passive = false;
	card.note = undefined;
	card.rows = [];
	if ((name === "swarm" || name === "swarm_read") && snapshotSchema.allows(payload)) {
		card.target = payload.title;
		card.meta = [`#${payload.head}`, formatCount("member", payload.members.length)];
		if (payload.models) {
			card.meta.push(formatCount("model", payload.models.length));
			card.rows = payload.models.map(model => `${model.model} · ${model.name}`);
		} else {
			card.rows = payload.members.map(
				member =>
					`${member.name} · ${member.state} · ${member.model}${member.unread ? ` · ${member.unread} unread` : ""}${member.error ? ` · ${member.error}` : ""}`,
			);
		}
		if (payload.added?.length) card.meta.push(`added ${payload.added.join(", ")}`);
		if (payload.killed?.length) card.meta.push(`killed ${payload.killed.join(", ")}`);
		if (payload.channels) card.rows.push(`Channels: ${Object.keys(payload.channels).join(", ")}`);
		if (payload.retainedBranches?.length) card.rows.push(`Retained branches: ${payload.retainedBranches.join(", ")}`);
		if (payload.retainedWorkspaces?.length)
			card.rows.push(`Retained workspaces: ${payload.retainedWorkspaces.join(", ")}`);
	} else if ((name === "swarm_read" || name === "swarm_wait") && readSchema.allows(payload)) {
		card.meta = [
			formatCount("post", payload.messages.length),
			`read #${payload.lastReadSeq}`,
			`head #${payload.head}`,
		];
		card.rows = payload.messages.map(
			post => `#${post.seq} ${post.agent}${post.channel ? ` · ${post.channel}` : ""}\n${post.text}`,
		);
		if (payload.interrupted) card.note = "interrupted";
	} else if (name === "swarm_post" && postResultSchema.allows(payload)) {
		card.target = `#${payload.post.seq} ${payload.post.agent}`;
		card.meta = [payload.post.channel ?? "main", formatCount("recipient", payload.receipts.length)];
		card.rows = [
			payload.post.text,
			...payload.receipts.map(
				receipt => `${receipt.name} · ${receipt.outcome}${receipt.error ? ` · ${receipt.error}` : ""}`,
			),
		];
		if (payload.receipts.some(receipt => receipt.outcome === "failed")) card.note = "delivery failed";
	} else if (name === "swarm_schedule" && scheduleSchema.allows(payload)) {
		const tasks = payload.tasks ?? (payload.task ? [payload.task] : []);
		card.meta = [formatCount("schedule", tasks.length)];
		if (payload.id && !tasks.length) card.target = `killed ${payload.id}`;
		card.rows = tasks.map(
			task =>
				`${task.owner} · ${task.cron} · next ${task.nextFire}${task.daemon ? " · daemon" : ""}${task.running ? " · running" : ""}${task.error ? ` · ${task.error}` : ""}\n${task.id}`,
		);
	} else {
		card.note = "unverified result";
		card.rows = ["The result format could not be validated."];
	}
	return card;
}

function plainCard(card: SwarmCard, options: RenderResultOptions, uiTheme: Theme, pending: boolean): Component {
	const header = renderStatusLine(
		{
			icon: card.error ? "error" : pending ? "pending" : "success",
			title: card.title,
			description: card.target,
			meta: [...card.meta, ...(card.note ? [card.note] : [])],
		},
		uiTheme,
	);
	return createCachedComponent(
		() => options.expanded,
		(width, expanded) => {
			const rows = card.rows.flatMap(value =>
				wrapTextWithAnsi(uiTheme.fg(card.error ? "error" : "dim", value), width),
			);
			const head = wrapTextWithAnsi(header, width);
			if (expanded) return [...head, ...rows];
			const visible = [...head, ...rows].slice(0, 4);
			const remaining = head.length + rows.length - visible.length;
			if (remaining > 0) visible.push(truncateToWidth(uiTheme.fg("dim", `${remaining} more lines`), width));
			return visible;
		},
	);
}

function nativeCard(card: SwarmCard): NativeToolView {
	return {
		tool: { title: card.title, target: card.target, meta: card.meta, note: card.note },
		body: card.rows.map(value => text(value, { wrap: "word" })),
		tone: card.error ? "error" : undefined,
		preview: { lines: 4 },
		inline: true,
		passive: card.passive,
	};
}

/** One compact card grammar for the five shared-board tools. */
export function createSwarmToolRenderer(name: SwarmToolName): ToolRenderer {
	const calls = new OwnerMemo<NativeToolView>();
	const results = new OwnerMemo<NativeToolView>();
	return {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: false,
		animatedPartialResult: false,
		tickElapsed: false,
		renderCall(args, options, uiTheme) {
			const card = cleanCard(callCard(name, args, options));
			return plainCard(card, options, uiTheme, true);
		},
		renderResult(result, options, uiTheme, args) {
			const card = cleanCard(resultCard(name, result, args, options));
			return plainCard(card, options, uiTheme, options.isPartial);
		},
		describeCall(args, options) {
			const owner = typeof args === "object" && args !== null ? args : undefined;
			return calls.get(owner, [JSON.stringify(args), options.executionStarted, options.cancelled], () =>
				nativeCard(cleanCard(callCard(name, args, options))),
			);
		},
		describeResult(result, options, args) {
			return results.get(
				result,
				[result.details, JSON.stringify(args), options.isPartial, options.executionStarted, options.cancelled],
				() => nativeCard(cleanCard(resultCard(name, result, args, options))),
			);
		},
	};
}

/** Shared semantic row for compact consecutive board reads. */
export function summarizeSwarmRead(
	args: unknown,
	result?: ToolRenderResult,
): { label: string; content: string; error: boolean } {
	const options: RenderResultOptions = { expanded: false, isPartial: false };
	const card = cleanCard(
		result ? resultCard("swarm_read", result, args, options) : callCard("swarm_read", args, options),
	);
	const label = [card.target, ...card.meta, card.note].filter(Boolean).join(" · ");
	return { label: label || "Board", content: card.rows.join("\n"), error: card.error === true };
}
