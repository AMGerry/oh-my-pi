/**
 * Data model of the swarm Overview: the narrator's `view.json` and the coordinator's `plan.json`.
 *
 * The schemas follow the `swarm_narrator` and `swarm_pane` skills. {@link parseNarratorView} and
 * {@link parseSwarmPlan} turn parsed JSON into typed values and throw {@link SwarmViewError} with a
 * readable reason when the structure breaks the contract. Validation is structural: whether a board
 * post, a member or a file exists, and which directories a `file` action may open, is decided by the
 * caller.
 *
 * Contract highlights:
 * - `version` is 1, `as_of_seq` and every `seq` are safe integers, `updated_at` is a UTC timestamp.
 * - `state`, `kind` and `severity` come from closed enums; ids match `^[a-z0-9-]{1,40}$` and are
 *   unique across attention items, workstreams, milestones, risks and threads.
 * - Attention items, workstreams, milestones and risks cite at least one `seq` or member.
 * - `phase.index` runs from 1 to `phase.total`; `progress.done` runs from 0 to `progress.total`.
 * - Threads (when present) number 1 to 6 and list every workstream and every non-`fyi` attention item
 *   exactly once.
 * - Actions keep only the navigation types `open_conv`, `board_post`, `url` (https) and `file`; any
 *   other or malformed action is dropped and the rest of the view stays.
 * - Reel frames keep only absolute `.png`, `.jpg`, `.jpeg` and `.webp` paths, newest 24; a reel whose
 *   frames all drop out is omitted.
 *
 * @example
 * ```ts ignore
 * const view = parseNarratorView(JSON.parse(text));
 * for (const item of view.attention) render(item.title, item.actions ?? []);
 * ```
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";

/** Work states a workstream can report. */
export const NARRATOR_STATES = ["queued", "active", "blocked", "review", "done", "failed"] as const;
/** Attention kinds, ranked from the most to the least urgent. */
export const NARRATOR_KINDS = ["decision", "failure", "review", "stuck", "quota", "error", "fyi"] as const;
/** Attention severities, from the highest to the lowest. */
export const NARRATOR_SEVERITIES = ["high", "med", "low"] as const;

export type NarratorState = (typeof NARRATOR_STATES)[number];
export type NarratorKind = (typeof NARRATOR_KINDS)[number];
export type NarratorSeverity = (typeof NARRATOR_SEVERITIES)[number];

/** A view or plan that breaks the data contract; the message names the offending field. */
export class SwarmViewError extends Error {
	override readonly name = "SwarmViewError";
}

const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const MEMBER_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const NON_BLANK_PATTERN = /\S/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_THREADS = 6;
const MAX_REEL_FRAMES = 24;
const MAX_PATH_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_SUMMARY_LENGTH = 600;

/** An ISO-8601 timestamp in UTC (`Z` suffix) that names a real calendar date and clock time. */
function isUtcTimestamp(value: string): boolean {
	const match = UTC_TIMESTAMP_PATTERN.exec(value);
	if (match === null) return false;
	const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
	if (hour > 23 || minute > 59 || second > 59) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** An absolute path made of plain segments: control characters and `..` segments are refused. */
function isCleanAbsolutePath(value: string): boolean {
	if (value.length > MAX_PATH_LENGTH || /\p{Cc}/u.test(value) || !path.isAbsolute(value)) return false;
	return !value.split(/[\\/]/).includes("..");
}

/** An https URL that has a host and is free of embedded credentials, whitespace and control characters. */
function isHttpsUrl(value: string): boolean {
	if (value.length > MAX_URL_LENGTH || /[\s\p{Cc}]/u.test(value) || !/^https:\/\//i.test(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}

const idSchema = type("string").matching(ID_PATTERN);
const memberSchema = type("string").matching(MEMBER_PATTERN);
const textSchema = type("string").matching(NON_BLANK_PATTERN);
const nonNegativeIntSchema = type("0 <= number.integer <= 9007199254740991");
const positiveIntSchema = type("1 <= number.integer <= 9007199254740991");

const refSchema = type({ seq: positiveIntSchema }).or(type({ member: memberSchema }));
const refsSchema = refSchema.array().atLeastLength(1);
const shortSchema = type({ title: textSchema, line: "string" });

const openConvActionSchema = type({ type: "'open_conv'", target: memberSchema, label: textSchema });
const boardPostActionSchema = type({ type: "'board_post'", target: positiveIntSchema, label: textSchema });
const urlActionSchema = type({ type: "'url'", target: "string", label: textSchema });
const fileActionSchema = type({ type: "'file'", target: "string", label: textSchema });
const actionSchema = openConvActionSchema.or(boardPostActionSchema).or(urlActionSchema).or(fileActionSchema);

const attentionSchema = type({
	id: idSchema,
	kind: type.enumerated(...NARRATOR_KINDS),
	severity: type.enumerated(...NARRATOR_SEVERITIES),
	title: textSchema,
	"why?": "string",
	refs: refsSchema,
	"actions?": actionSchema.array(),
	"short?": shortSchema,
});

const progressSchema = type({ done: nonNegativeIntSchema, total: positiveIntSchema });
const workstreamSchema = type({
	id: idSchema,
	title: textSchema,
	owners: memberSchema.array(),
	state: type.enumerated(...NARRATOR_STATES),
	"note?": "string",
	refs: refsSchema,
	"progress?": progressSchema,
	"short?": shortSchema,
});

const textItemSchema = type({ id: idSchema, text: textSchema, refs: refsSchema });
const phaseSchema = type({ label: textSchema, index: positiveIntSchema, total: positiveIntSchema });
const goalSchema = type({ title: textSchema, line: "string" });

const threadSchema = type({
	id: idSchema,
	title: textSchema,
	"goal?": "string",
	"now?": "string",
	workstreams: idSchema.array(),
	attention: idSchema.array(),
});

const frameSchema = type({ path: "string", seq: positiveIntSchema, caption: "string" });
const reelSchema = type({ frames: frameSchema.array().atLeastLength(1).atMostLength(MAX_REEL_FRAMES) });

const narratorViewSchema = type({
	version: "1",
	as_of_seq: nonNegativeIntSchema,
	updated_at: "string",
	headline: textSchema,
	phase: phaseSchema,
	attention: attentionSchema.array(),
	workstreams: workstreamSchema.array(),
	milestones: textItemSchema.array(),
	risks: textItemSchema.array(),
	"goal?": goalSchema,
	"running_summary?": "string",
	"threads?": threadSchema.array().atLeastLength(1).atMostLength(MAX_THREADS),
	"now?": type({ "[string]": "string" }),
	"reel?": reelSchema,
	"feedback_ack?": type({ through_seq: nonNegativeIntSchema, text: "string" }),
});

const planThreadSchema = type({
	id: idSchema,
	title: textSchema,
	"goal?": "string",
	tasks: memberSchema.array(),
});

const swarmPlanSchema = type({
	goal: goalSchema,
	tasks: type({ "[string]": textSchema }),
	threads: planThreadSchema.array().atLeastLength(1).atMostLength(MAX_THREADS),
});

/** Loose outline of the lists that are filtered before strict validation. */
const filterableViewSchema = type({
	"attention?": type({ "actions?": "unknown[]" }).array(),
	"reel?": type({ "frames?": "unknown[]" }),
});

/** A board post (`{seq}`) or a roster member (`{member}`) that backs an item. */
export type NarratorRef = typeof refSchema.infer;
/** Navigation offered on an attention item; `board_post` targets a seq, the others a string. */
export type NarratorAction = typeof actionSchema.infer;
export type NarratorShort = typeof shortSchema.infer;
export type NarratorAttention = typeof attentionSchema.infer;
export type NarratorWorkstream = typeof workstreamSchema.infer;
export type NarratorTextItem = typeof textItemSchema.infer;
export type NarratorMilestone = NarratorTextItem;
export type NarratorRisk = NarratorTextItem;
export type NarratorThread = typeof threadSchema.infer;
export type NarratorFrame = typeof frameSchema.infer;
export type NarratorView = typeof narratorViewSchema.infer;
export type SwarmPlanThread = typeof planThreadSchema.infer;
export type SwarmPlan = typeof swarmPlanSchema.infer;

/** An action of a navigation type whose target is usable: https URLs and absolute paths are checked here. */
function isUsableAction(value: unknown): boolean {
	if (!actionSchema.allows(value)) return false;
	if (value.type === "url") return isHttpsUrl(value.target);
	if (value.type === "file") return isCleanAbsolutePath(value.target);
	return true;
}

/**
 * Drop actions that fail validation and reel frames that cannot be shown, so one bad entry leaves
 * the rest of the view intact. Frames beyond the newest {@link MAX_REEL_FRAMES} are dropped as well,
 * and a reel whose frames all drop out is removed. Values of any other shape pass through for the
 * strict schema to judge.
 */
function dropUnusableEntries(value: unknown): unknown {
	if (Array.isArray(value) || !filterableViewSchema.allows(value)) return value;
	const { attention, reel, ...rest } = value;
	const filtered: Record<string, unknown> = { ...rest };
	if (attention !== undefined) {
		filtered.attention = attention.map(item =>
			item.actions === undefined ? item : { ...item, actions: item.actions.filter(isUsableAction) },
		);
	}
	if (reel !== undefined) {
		const frames = reel.frames?.filter(
			frame =>
				frameSchema.allows(frame) &&
				isCleanAbsolutePath(frame.path) &&
				IMAGE_EXTENSIONS.includes(path.extname(frame.path).toLowerCase()),
		);
		if (frames === undefined) filtered.reel = reel;
		else if (frames.length > 0) filtered.reel = { ...reel, frames: frames.slice(-MAX_REEL_FRAMES) };
	}
	return filtered;
}

/** Cross-field rules the schema cannot express: unique ids, numeric consistency and thread coverage. */
function checkNarratorView(view: NarratorView): void {
	if (!isUtcTimestamp(view.updated_at)) {
		throw new SwarmViewError(
			`updated_at must be a UTC timestamp such as 2026-10-06T04:20:00Z (was ${JSON.stringify(view.updated_at.slice(0, 40))})`,
		);
	}
	if (view.phase.index > view.phase.total) {
		throw new SwarmViewError(`phase.index ${view.phase.index} exceeds phase.total ${view.phase.total}`);
	}

	const claimed = new Map<string, string>();
	const claim = (id: string, where: string): void => {
		const earlier = claimed.get(id);
		if (earlier !== undefined) throw new SwarmViewError(`id "${id}" at ${where} repeats the id at ${earlier}`);
		claimed.set(id, where);
	};
	view.attention.forEach((item, index) => claim(item.id, `attention[${index}]`));
	view.workstreams.forEach((workstream, index) => {
		claim(workstream.id, `workstreams[${index}]`);
		const progress = workstream.progress;
		if (progress !== undefined && progress.done > progress.total) {
			throw new SwarmViewError(
				`workstreams[${index}].progress.done ${progress.done} exceeds progress.total ${progress.total}`,
			);
		}
	});
	view.milestones.forEach((item, index) => claim(item.id, `milestones[${index}]`));
	view.risks.forEach((item, index) => claim(item.id, `risks[${index}]`));
	view.threads?.forEach((thread, index) => claim(thread.id, `threads[${index}]`));

	for (const name of Object.keys(view.now ?? {})) {
		const label = JSON.stringify(name.slice(0, 40));
		if (!memberSchema.allows(name)) {
			throw new SwarmViewError(`now key ${label} must be a roster name`);
		}
	}

	const threads = view.threads;
	if (threads === undefined) return;
	const workstreamIds = new Set(view.workstreams.map(workstream => workstream.id));
	const attentionIds = new Set(view.attention.map(item => item.id));
	const placed = new Set<string>();
	threads.forEach((thread, index) => {
		for (const id of thread.workstreams) {
			if (!workstreamIds.has(id)) throw new SwarmViewError(`threads[${index}] lists unknown workstream "${id}"`);
			if (placed.has(id)) throw new SwarmViewError(`workstream "${id}" is listed in more than one thread slot`);
			placed.add(id);
		}
		for (const id of thread.attention) {
			if (!attentionIds.has(id)) throw new SwarmViewError(`threads[${index}] lists unknown attention item "${id}"`);
			if (placed.has(id)) throw new SwarmViewError(`attention item "${id}" is listed in more than one thread slot`);
			placed.add(id);
		}
	});
	for (const workstream of view.workstreams) {
		if (!placed.has(workstream.id)) throw new SwarmViewError(`workstream "${workstream.id}" is missing from threads`);
	}
	for (const item of view.attention) {
		if (item.kind !== "fyi" && !placed.has(item.id)) {
			throw new SwarmViewError(`attention item "${item.id}" (${item.kind}) is missing from threads`);
		}
	}
}

/** Cross-field rules for the plan: unique thread ids and every worker placed in exactly one thread. */
function checkSwarmPlan(plan: SwarmPlan): void {
	for (const member of Object.keys(plan.tasks)) {
		const label = JSON.stringify(member.slice(0, 40));
		if (!memberSchema.allows(member)) {
			throw new SwarmViewError(`tasks key ${label} must be a roster name`);
		}
	}
	const threadIds = new Set<string>();
	const placed = new Set<string>();
	plan.threads.forEach((thread, index) => {
		if (threadIds.has(thread.id)) throw new SwarmViewError(`threads[${index}] repeats thread id "${thread.id}"`);
		threadIds.add(thread.id);
		for (const member of thread.tasks) {
			if (!Object.hasOwn(plan.tasks, member)) {
				throw new SwarmViewError(`threads[${index}] lists "${member}", which is missing from tasks`);
			}
			if (placed.has(member)) throw new SwarmViewError(`worker "${member}" is listed in more than one thread`);
			placed.add(member);
		}
	});
	for (const member of Object.keys(plan.tasks)) {
		if (!placed.has(member)) throw new SwarmViewError(`worker "${member}" is missing from threads`);
	}
}

/**
 * Validate a parsed `view.json`. Unusable actions and reel frames are dropped; any other contract
 * break throws {@link SwarmViewError}.
 */
export function parseNarratorView(value: unknown): NarratorView {
	const view = narratorViewSchema(dropUnusableEntries(value));
	if (view instanceof type.errors) {
		throw new SwarmViewError(`invalid narrator view: ${view.summary.slice(0, MAX_SUMMARY_LENGTH)}`);
	}
	checkNarratorView(view);
	return view;
}

/** Validate a parsed `plan.json`; a contract break throws {@link SwarmViewError}. */
export function parseSwarmPlan(value: unknown): SwarmPlan {
	const plan = swarmPlanSchema(value);
	if (plan instanceof type.errors) {
		throw new SwarmViewError(`invalid swarm plan: ${plan.summary.slice(0, MAX_SUMMARY_LENGTH)}`);
	}
	checkSwarmPlan(plan);
	return plan;
}
