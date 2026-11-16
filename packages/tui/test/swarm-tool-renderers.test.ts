/**
 * The five shared-board tool renderers draw the details the swarm tools really return (coding-agent
 * `src/swarm/api.ts` and `src/swarm/tools/*`): compact ANSI cards and native views over one card projection.
 * Fixtures keep every field the runtime adds (`boardUri`, `to`, `time`, `mentions`, `agentId`, `prompt`, …) so the
 * renderers' tolerance for fields they do not draw is exercised too.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspText } from "@oh-my-pi/pi-wire";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { initTheme, theme } from "../src/theme";
import { toolRenderers } from "../src/tools";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "../src/tools/renderer";
import { swarmToolRenderer } from "../src/tools/swarm";
import { type SwarmToolName, summarizeSwarmRead } from "../src/tools/swarm-card";
import { swarmPostToolRenderer } from "../src/tools/swarm-post";
import { swarmReadToolRenderer } from "../src/tools/swarm-read";
import { swarmScheduleToolRenderer } from "../src/tools/swarm-schedule";
import { swarmWaitToolRenderer } from "../src/tools/swarm-wait";
import { visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme();
});

const collapsed: RenderResultOptions = { expanded: false, isPartial: false };
const expanded: RenderResultOptions = { expanded: true, isPartial: false };
const BOARD = "swarm://swarm-0123456789abcdef0123456789abcdef";
const BOARD_ID = "swarm-0123456789abcdef0123456789abcdef";

const RENDERERS: Record<SwarmToolName, ToolRenderer> = {
	swarm: swarmToolRenderer,
	swarm_post: swarmPostToolRenderer,
	swarm_read: swarmReadToolRenderer,
	swarm_wait: swarmWaitToolRenderer,
	swarm_schedule: swarmScheduleToolRenderer,
};
const LABELS: Record<SwarmToolName, string> = {
	swarm: "Swarm",
	swarm_post: "Swarm post",
	swarm_read: "Swarm read",
	swarm_wait: "Swarm wait",
	swarm_schedule: "Swarm schedule",
};
const TOOL_NAMES = Object.keys(RENDERERS) as SwarmToolName[];

function plain(value: TspText | undefined): string {
	return typeof value === "string" ? value : (value ?? []).map(part => part.t).join("");
}

function bodyTexts(view: NativeToolView): string[] {
	return (view.body ?? []).flatMap((child: NativeChild) =>
		"k" in child && child.k === "text" ? [plain(child.p?.text ?? child.p?.spans)] : [],
	);
}

function metaOf(view: NativeToolView): string[] {
	return (view.tool?.meta ?? []).map(plain);
}

function nativeCall(renderer: ToolRenderer, args: unknown, options: RenderResultOptions = collapsed): NativeToolView {
	const view = renderer.describeCall?.(args, options);
	if (!view) throw new Error("The renderer has no native call view");
	return view;
}

function nativeResult(
	renderer: ToolRenderer,
	result: ToolRenderResult,
	args: unknown,
	options: RenderResultOptions = collapsed,
): NativeToolView {
	const view = renderer.describeResult?.(result, options, args);
	if (!view) throw new Error("The renderer has no native result view");
	return view;
}

function ansiLines(component: { render(width: number): readonly string[] } | undefined, width: number): string[] {
	if (!component) throw new Error("The renderer drew no component");
	return [...component.render(width)];
}

function ansiResult(
	renderer: ToolRenderer,
	result: ToolRenderResult,
	args: unknown,
	options: RenderResultOptions = collapsed,
	width = 80,
): string[] {
	return ansiLines(renderer.renderResult(result, options, theme, args), width);
}

function ansiCall(
	renderer: ToolRenderer,
	args: unknown,
	options: RenderResultOptions = { expanded: false, isPartial: true },
	width = 80,
): string[] {
	return ansiLines(renderer.renderCall(args, options, theme), width);
}

/** The characters a user sees: every escape sequence dropped. */
const visible = (lines: readonly string[]): string => sanitizeText(lines.join("\n"));

/** Terminal styling is SGR only; any other escape in drawn output is data the renderer failed to clean. */
function withoutSgr(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function privateModeSequences(text: string): string[] {
	return text.match(/\x1b\[\?[\d;]*[hl]/g) ?? [];
}

function toolResult(details: unknown, content: unknown = details, isError = false): ToolRenderResult {
	return { content: [{ type: "text", text: JSON.stringify(content) }], details, isError };
}

type Decorate = (value: string) => string;
const same: Decorate = value => value;

function member(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name,
		agentId: `Member-${name}`,
		sessionFile: null,
		model: "mock/parent",
		role: "worker",
		wakeMode: null,
		waitSince: null,
		lastReadSeq: 0,
		lastPostSeq: 0,
		lastPostTime: null,
		channels: [],
		workspace: "inherit",
		killed: false,
		state: "working",
		unread: 0,
		...overrides,
	};
}

function post(seq: number, agent: string, text: string, overrides: Record<string, unknown> = {}) {
	return { seq, agent, text, time: "2026-03-01T10:00:00.000Z", mentions: [], all: false, ...overrides };
}

function task(id: string, owner: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		swarmId: BOARD_ID,
		agentId: `Member-${owner}`,
		owner,
		cron: "*/3 * * * *",
		prompt: "Check the board",
		daemon: true,
		nextFire: "2026-03-01T10:03:00.000Z",
		running: false,
		...overrides,
	};
}

interface RendererCase {
	name: string;
	tool: SwarmToolName;
	args: unknown;
	result: ToolRenderResult;
}

/** One case per result shape the tools produce; `decorate` rewrites every string field the cards can draw. */
function buildCases(d: Decorate): RendererCase[] {
	const snapshot = {
		id: BOARD_ID,
		title: d("Parser swarm"),
		head: 5,
		dir: "C:/artifacts/swarm",
		capabilities: { channels: true, workspaces: true, narrator: true, monitor: true, graph: false, customPage: true },
		boardUri: BOARD,
		members: [
			member(d("coordinator"), { role: "coordinator", model: d("anthropic/claude-sonnet-5-5") }),
			member(d("parse-1"), { state: "waiting", unread: 2, wakeMode: "mentions", waitSince: 3 }),
			member(d("parse-2"), { state: "stopped", error: d("quota") }),
			member(d("old"), { state: "killed", killed: true }),
		],
	};
	const control = (action: string, args: unknown, extra: Record<string, unknown> = {}): RendererCase => {
		const result = { ...snapshot, ...extra };
		return { name: `swarm ${action}`, tool: "swarm", args, result: toolResult({ action, result }, result) };
	};
	const postResult = {
		post: post(6, d("coordinator"), d("@parse-1 take the lexer\n  keep indent"), {
			channel: d("parser"),
			mentions: ["parse-1"],
		}),
		receipts: [
			{ name: d("parse-1"), to: "Member-parse-1", outcome: "woken" },
			{
				name: d("parse-2"),
				to: "Member-parse-2",
				outcome: "failed",
				error: d("Member parse-2 is killed or closing"),
			},
		],
		head: 6,
		lastReadSeq: 0,
		boardUri: BOARD,
	};
	const readResult = {
		messages: [
			post(11, d("coordinator"), d("@alice go"), { mentions: ["alice"] }),
			post(12, d("alice"), d("lexer merged"), { channel: d("parser") }),
		],
		lastReadSeq: 12,
		head: 14,
		boardUri: BOARD,
	};
	const wakeResult = { ...readResult, interrupted: true };
	const created = task("task-1", d("monitor"));
	const listed = [
		created,
		task("task-2", d("narrator"), { daemon: false, running: true, nextFire: "2026-03-01T10:05:00.000Z" }),
	];
	/** A refusal as the tools return it: `isError`, the reason in `details.error` and `{ error, boardUri }` as text. */
	const refusal = (
		tool: SwarmToolName,
		args: unknown,
		message: string,
		extra: Record<string, unknown> = {},
		boardInDetails = true,
	) => ({
		tool,
		args,
		result: toolResult(
			{ ...(boardInDetails ? { boardUri: BOARD } : {}), ...extra, error: message },
			{ error: message, boardUri: BOARD },
			true,
		),
	});
	return [
		control("status", { action: "status" }),
		control(
			"models",
			{ action: "models" },
			{
				models: [
					{ model: d("anthropic/claude-sonnet-5-5"), name: d("Claude Sonnet 5.5") },
					{ model: d("openai-codex/gpt-6.1-terra:high"), name: d("GPT 6.1 Terra") },
				],
			},
		),
		control(
			"add",
			{ action: "add", name: d("parse"), brief: d("Parse the grammar"), n: 2, model: d("mock/x") },
			{ added: [d("parse-1"), d("parse-2")] },
		),
		control(
			"kill",
			{ action: "kill", name: d("parse") },
			{
				killed: [d("parse-1")],
				retainedBranches: [d("swarm/abc/parse-1")],
			},
		),
		control(
			"channel",
			{ action: "channel", op: "list" },
			{
				channels: {
					[d("parser")]: {
						topic: d("Lexer"),
						createdBy: "coordinator",
						subscribers: ["parse-1"],
						archived: false,
					},
					ui: { topic: "", createdBy: "coordinator", subscribers: [], archived: false },
				},
			},
		),
		{
			name: "swarm refusal",
			// SwarmTool's refusal details are { action, error }: the board link rides in the text only.
			...refusal(
				"swarm",
				{ action: "kill", name: "ghost" },
				d("Unknown swarm member or group: ghost"),
				{ action: "kill" },
				false,
			),
		},
		{
			name: "swarm_post",
			tool: "swarm_post",
			args: { text: d("@parse-1 take the lexer\n  keep indent"), channel: d("parser") },
			result: toolResult({ boardUri: BOARD, result: postResult }, postResult),
		},
		{ name: "swarm_post refusal", ...refusal("swarm_post", { text: " " }, d("A board post must contain text")) },
		{
			name: "swarm_read messages",
			tool: "swarm_read",
			args: { since: 10 },
			result: toolResult({ boardUri: BOARD, status: false, result: readResult }, readResult),
		},
		{
			name: "swarm_read status",
			tool: "swarm_read",
			args: { status: true },
			// status:true returns the Markdown roster as text and the whole snapshot in details.
			result: {
				content: [
					{
						type: "text",
						text: `# Swarm ${d("Parser swarm")} (${BOARD_ID})\nBoard: ${BOARD}\nHead: #5\n\n| Member | Role |\n| --- | --- |`,
					},
				],
				details: { boardUri: BOARD, status: true, snapshot },
			},
		},
		{
			name: "swarm_read refusal",
			...refusal("swarm_read", { channel: "*" }, d("All-channel reads require a coordinator, narrator or monitor"), {
				status: false,
			}),
		},
		{
			name: "swarm_wait result",
			tool: "swarm_wait",
			args: { since: 3, mentionsOnly: true },
			result: toolResult({ boardUri: BOARD, since: 3, mentionsOnly: true, result: wakeResult }, wakeResult),
		},
		{
			name: "swarm_wait refusal",
			...refusal("swarm_wait", { since: 3 }, d("Member parse-1 already has a pending swarm_wait"), {
				since: 3,
				mentionsOnly: true,
			}),
		},
		{
			name: "swarm_schedule create",
			tool: "swarm_schedule",
			args: { action: "create", cron: d("*/3 * * * *"), prompt: d("Check the board"), daemon: true },
			result: toolResult(
				{ action: "create", boardUri: BOARD, result: { boardUri: BOARD, id: "task-1", task: created } },
				{ boardUri: BOARD, id: "task-1", task: created },
			),
		},
		{
			name: "swarm_schedule list",
			tool: "swarm_schedule",
			args: { action: "list" },
			result: toolResult(
				{ action: "list", boardUri: BOARD, result: { boardUri: BOARD, tasks: listed } },
				{ boardUri: BOARD, tasks: listed },
			),
		},
		{
			name: "swarm_schedule kill",
			tool: "swarm_schedule",
			args: { action: "kill", id: d("task-1") },
			result: toolResult(
				{ action: "kill", boardUri: BOARD, result: { boardUri: BOARD, id: "task-1" } },
				{ boardUri: BOARD, id: "task-1" },
			),
		},
		{
			name: "swarm_schedule refusal",
			...refusal("swarm_schedule", { action: "kill", id: "nope" }, d("Unknown scheduled task: nope"), {
				action: "kill",
			}),
		},
	];
}

function caseNamed(cases: readonly RendererCase[], name: string): RendererCase {
	const found = cases.find(candidate => candidate.name === name);
	if (!found) throw new Error(`No renderer case named ${name}`);
	return found;
}

const CASES = buildCases(same);
const status = caseNamed(CASES, "swarm status");
const readMessages = caseNamed(CASES, "swarm_read messages");
const waitResult = caseNamed(CASES, "swarm_wait result");

describe("swarm tool renderer registry", () => {
	it("registers each swarm tool's renderer under its wire name", () => {
		for (const name of TOOL_NAMES) expect(toolRenderers[name]).toBe(RENDERERS[name]);
		expect(new Set(TOOL_NAMES.map(name => toolRenderers[name])).size).toBe(TOOL_NAMES.length);
		expect(toolRenderers.swarm_read).not.toBe(toolRenderers.read);
	});

	it("declares the compact merged card grammar with native describe hooks", () => {
		for (const name of TOOL_NAMES) {
			const renderer = toolRenderers[name];
			expect(renderer).toMatchObject({
				inline: true,
				mergeCallAndResult: true,
				animatedPendingPreview: false,
				animatedPartialResult: false,
				tickElapsed: false,
			});
			expect(typeof renderer.describeCall).toBe("function");
			expect(typeof renderer.describeResult).toBe("function");
			expect(nativeCall(renderer, {}).tool?.title).toBe(LABELS[name]);
		}
	});
});

describe("swarm control results", () => {
	it("draws the roster, the cursor head and counts in a compact card that expands to every member", () => {
		const lines = ansiResult(swarmToolRenderer, status.result, status.args);
		const text = visible(lines);
		expect(text).toContain("Swarm: Parser swarm");
		expect(text).toContain("#5");
		expect(text).toContain("4 members");
		expect(text).toContain("coordinator · working · anthropic/claude-sonnet-5-5");
		expect(text).toContain("parse-1 · waiting · mock/parent · 2 unread");
		expect(text).toContain("parse-2 · stopped · mock/parent · quota");
		expect(text).not.toContain("old · killed");
		expect(text).toContain("1 more lines");
		expect(lines).toHaveLength(5);

		const full = visible(ansiResult(swarmToolRenderer, status.result, status.args, expanded));
		expect(full).toContain("old · killed · mock/parent");
		expect(full).not.toContain("more lines");
	});

	it("describes the roster natively with names, states, models, counts and the swarm title", () => {
		const view = nativeResult(swarmToolRenderer, status.result, status.args);
		expect(view.tool).toMatchObject({ title: "Swarm", target: "Parser swarm" });
		expect(metaOf(view)).toEqual(["#5", "4 members"]);
		expect(bodyTexts(view)).toEqual([
			"coordinator · working · anthropic/claude-sonnet-5-5",
			"parse-1 · waiting · mock/parent · 2 unread",
			"parse-2 · stopped · mock/parent · quota",
			"old · killed · mock/parent",
		]);
		expect(view).toMatchObject({ inline: true, preview: { lines: 4 }, passive: false });
		expect(view.tone).toBeUndefined();
	});

	it("lists the selectable models in place of the roster", () => {
		const models = caseNamed(CASES, "swarm models");
		const view = nativeResult(swarmToolRenderer, models.result, models.args);
		expect(metaOf(view)).toEqual(["#5", "4 members", "2 models"]);
		expect(bodyTexts(view)).toEqual([
			"anthropic/claude-sonnet-5-5 · Claude Sonnet 5.5",
			"openai-codex/gpt-6.1-terra:high · GPT 6.1 Terra",
		]);
		const text = visible(ansiResult(swarmToolRenderer, models.result, models.args, expanded));
		expect(text).toContain("openai-codex/gpt-6.1-terra:high · GPT 6.1 Terra");
	});

	it("names the requested members and model on the call, and the added members on the result", () => {
		const add = caseNamed(CASES, "swarm add");
		const call = nativeCall(swarmToolRenderer, add.args);
		expect(call.tool).toMatchObject({ title: "Swarm", target: "add parse" });
		expect(metaOf(call)).toEqual(["mock/x", "2 members"]);
		expect(visible(ansiCall(swarmToolRenderer, add.args))).toContain("add parse");

		const view = nativeResult(swarmToolRenderer, add.result, add.args);
		expect(metaOf(view)).toEqual(["#5", "4 members", "added parse-1, parse-2"]);
	});

	it("reports killed members, retained branches and channels", () => {
		const kill = caseNamed(CASES, "swarm kill");
		const killed = nativeResult(swarmToolRenderer, kill.result, kill.args);
		expect(metaOf(killed)).toContain("killed parse-1");
		expect(bodyTexts(killed).at(-1)).toBe("Retained branches: swarm/abc/parse-1");

		const channel = caseNamed(CASES, "swarm channel");
		expect(metaOf(nativeCall(swarmToolRenderer, channel.args))).toEqual(["list"]);
		expect(bodyTexts(nativeResult(swarmToolRenderer, channel.result, channel.args)).at(-1)).toBe(
			"Channels: parser, ui",
		);
	});

	it("shows a refusal as an error card with its reason", () => {
		const refusal = caseNamed(CASES, "swarm refusal");
		const view = nativeResult(swarmToolRenderer, refusal.result, refusal.args);
		expect(view.tone).toBe("error");
		expect(bodyTexts(view)).toEqual(["Unknown swarm member or group: ghost"]);
		expect(visible(ansiResult(swarmToolRenderer, refusal.result, refusal.args))).toContain(
			"Unknown swarm member or group: ghost",
		);
	});
});

describe("swarm_post results", () => {
	const posted = caseNamed(CASES, "swarm_post");

	it("describes the committed post, its channel, recipients and delivery outcomes", () => {
		const view = nativeResult(swarmPostToolRenderer, posted.result, posted.args);
		expect(view.tool).toMatchObject({ title: "Swarm post", target: "#6 coordinator", note: "delivery failed" });
		expect(metaOf(view)).toEqual(["parser", "2 recipients"]);
		expect(bodyTexts(view)).toEqual([
			"@parse-1 take the lexer\n  keep indent",
			"parse-1 · woken",
			"parse-2 · failed · Member parse-2 is killed or closing",
		]);
	});

	it("draws the body collapsed in a few lines and every receipt expanded", () => {
		const small = visible(ansiResult(swarmPostToolRenderer, posted.result, posted.args));
		expect(small).toContain("@parse-1 take the lexer");
		expect(small).toContain("delivery failed");
		expect(small).toMatch(/\d+ more lines/);
		expect(small).not.toContain("Member parse-2 is killed");
		const full = visible(ansiResult(swarmPostToolRenderer, posted.result, posted.args, expanded));
		expect(full).toContain("parse-1 · woken");
		expect(full).toContain("parse-2 · failed · Member parse-2 is killed or closing");
	});

	it("previews the call with its channel and text before any result", () => {
		const call = nativeCall(swarmPostToolRenderer, posted.args);
		expect(call.tool).toMatchObject({ title: "Swarm post", target: "parser" });
		expect(bodyTexts(call)).toEqual(["@parse-1 take the lexer\n  keep indent"]);
		expect(nativeCall(swarmPostToolRenderer, { text: "hello" }).tool?.target).toBe("main");
	});
});

describe("swarm_read results", () => {
	it("states the cursor and counts, then the posts with their #seq", () => {
		const view = nativeResult(swarmReadToolRenderer, readMessages.result, readMessages.args);
		expect(view.tool).toMatchObject({ title: "Swarm read", target: "main" });
		expect(metaOf(view)).toEqual(["2 posts", "read #12", "head #14"]);
		expect(bodyTexts(view)).toEqual(["#11 coordinator\n@alice go", "#12 alice · parser\nlexer merged"]);
	});

	it("keeps the first lines while collapsed and every post expanded", () => {
		const small = visible(ansiResult(swarmReadToolRenderer, readMessages.result, readMessages.args));
		expect(small).toContain("Swarm read: main");
		expect(small).toContain("read #12");
		expect(small).toContain("#11 coordinator");
		expect(small).toContain("@alice go");
		expect(small).not.toContain("lexer merged");
		expect(small).toMatch(/\d+ more lines/);
		const full = visible(ansiResult(swarmReadToolRenderer, readMessages.result, readMessages.args, expanded));
		expect(full).toContain("#12 alice · parser");
		expect(full).toContain("lexer merged");
		expect(full).not.toContain("more lines");
	});

	it("draws the roster for status reads and names the members read", () => {
		const roster = caseNamed(CASES, "swarm_read status");
		expect(nativeCall(swarmReadToolRenderer, roster.args).tool?.target).toBe("members");
		const view = nativeResult(swarmReadToolRenderer, roster.result, roster.args);
		expect(view.tool?.target).toBe("Parser swarm");
		expect(metaOf(view)).toEqual(["#5", "4 members"]);
		expect(bodyTexts(view)[0]).toBe("coordinator · working · anthropic/claude-sonnet-5-5");
	});

	it("names the channel and cursor a read asks for", () => {
		const call = nativeCall(swarmReadToolRenderer, { channel: "parser", since: 7 });
		expect(call.tool?.target).toBe("parser");
		expect(metaOf(call)).toEqual(["after #7"]);
		expect(nativeCall(swarmReadToolRenderer, { channel: "*" }).tool?.target).toBe("*");
	});
});

describe("swarm_wait results", () => {
	it("describes the wake: cursor, counts and the interrupt", () => {
		const view = nativeResult(swarmWaitToolRenderer, waitResult.result, waitResult.args);
		expect(view.tool).toMatchObject({ title: "Swarm wait", target: "after #3", note: "interrupted" });
		expect(metaOf(view)).toEqual(["2 posts", "read #12", "head #14"]);
		expect(bodyTexts(view)).toEqual(["#11 coordinator\n@alice go", "#12 alice · parser\nlexer merged"]);
		const full = visible(ansiResult(swarmWaitToolRenderer, waitResult.result, waitResult.args, expanded));
		expect(full).toContain("Swarm wait: after #3");
		expect(full).toContain("interrupted");
		expect(full).toContain("lexer merged");
	});

	it("names what a parked wait listens for", () => {
		expect(metaOf(nativeCall(swarmWaitToolRenderer, { since: 3 }))).toEqual(["mentions"]);
		expect(metaOf(nativeCall(swarmWaitToolRenderer, { since: 3, mentionsOnly: true }))).toEqual(["mentions"]);
		expect(metaOf(nativeCall(swarmWaitToolRenderer, { since: 3, mentionsOnly: false }))).toEqual(["any post"]);
	});

	it("is passive while its running call is parked and active once a result arrives", () => {
		const args = { since: 3, mentionsOnly: true };
		const queued = nativeCall(swarmWaitToolRenderer, args, { expanded: false, isPartial: true });
		expect(queued.passive).toBe(false);
		expect(queued.tool?.note).toBeUndefined();

		const parked = nativeCall(swarmWaitToolRenderer, args, {
			expanded: false,
			isPartial: true,
			executionStarted: true,
		});
		expect(parked.passive).toBe(true);
		expect(plain(parked.tool?.note)).toBe("parked");
		expect(
			visible(ansiCall(swarmWaitToolRenderer, args, { expanded: false, isPartial: true, executionStarted: true })),
		).toContain("parked");

		// A streaming update with no payload yet keeps the call's parked state.
		const partial = nativeResult(swarmWaitToolRenderer, { content: [{ type: "text", text: "" }] }, args, {
			expanded: false,
			isPartial: true,
			executionStarted: true,
		});
		expect(partial.passive).toBe(true);

		const done = nativeResult(swarmWaitToolRenderer, waitResult.result, waitResult.args, {
			expanded: false,
			isPartial: false,
			executionStarted: true,
		});
		expect(done.passive).toBe(false);
		expect(done.tool?.note).not.toBe("parked");

		const refused = caseNamed(CASES, "swarm_wait refusal");
		const failed = nativeResult(swarmWaitToolRenderer, refused.result, refused.args, {
			expanded: false,
			isPartial: false,
			executionStarted: true,
		});
		expect(failed.passive).toBe(false);
		expect(failed.tone).toBe("error");
	});

	it("never marks another swarm tool passive, whatever its execution state", () => {
		const started: RenderResultOptions = { expanded: false, isPartial: true, executionStarted: true };
		for (const name of TOOL_NAMES.filter(candidate => candidate !== "swarm_wait")) {
			expect(nativeCall(RENDERERS[name], { since: 1 }, started).passive).not.toBe(true);
			expect(visible(ansiCall(RENDERERS[name], { since: 1 }, started))).not.toContain("parked");
		}
	});
});

describe("swarm_schedule results", () => {
	it("names the cron on the call and the daemon flag", () => {
		const create = caseNamed(CASES, "swarm_schedule create");
		const call = nativeCall(swarmScheduleToolRenderer, create.args);
		expect(call.tool).toMatchObject({ title: "Swarm schedule", target: "create */3 * * * *" });
		expect(metaOf(call)).toEqual(["daemon"]);
		expect(nativeCall(swarmScheduleToolRenderer, { action: "list" }).tool?.target).toBe("list");
		expect(nativeCall(swarmScheduleToolRenderer, { action: "kill", id: "task-1" }).tool?.target).toBe("kill task-1");
	});

	it("lists each schedule with its owner, cron, next fire, flags and id", () => {
		const list = caseNamed(CASES, "swarm_schedule list");
		const view = nativeResult(swarmScheduleToolRenderer, list.result, list.args);
		expect(metaOf(view)).toEqual(["2 schedules"]);
		expect(bodyTexts(view)).toEqual([
			"monitor · */3 * * * * · next 2026-03-01T10:03:00.000Z · daemon\ntask-1",
			"narrator · */3 * * * * · next 2026-03-01T10:05:00.000Z · running\ntask-2",
		]);
		const text = visible(ansiResult(swarmScheduleToolRenderer, list.result, list.args, expanded));
		expect(text).toContain("monitor · */3 * * * * · next 2026-03-01T10:03:00.000Z · daemon");
		expect(text).toContain("task-2");
	});

	it("shows the created task and confirms a kill by id", () => {
		const create = caseNamed(CASES, "swarm_schedule create");
		const created = nativeResult(swarmScheduleToolRenderer, create.result, create.args);
		expect(metaOf(created)).toEqual(["1 schedule"]);
		expect(bodyTexts(created)).toEqual(["monitor · */3 * * * * · next 2026-03-01T10:03:00.000Z · daemon\ntask-1"]);

		const kill = caseNamed(CASES, "swarm_schedule kill");
		const killed = nativeResult(swarmScheduleToolRenderer, kill.result, kill.args);
		expect(killed.tool?.target).toBe("killed task-1");
		expect(bodyTexts(killed)).toEqual([]);
	});

	it("carries a task's own error", () => {
		const failing = { boardUri: BOARD, tasks: [task("task-9", "monitor", { error: "tick skipped: running" })] };
		const view = nativeResult(swarmScheduleToolRenderer, toolResult({ action: "list", result: failing }, failing), {
			action: "list",
		});
		expect(bodyTexts(view)[0]).toContain("tick skipped: running");
	});
});

describe("refusals", () => {
	it("draw every tool's reason as an error card without the board link", () => {
		for (const refusal of CASES.filter(candidate => candidate.name.endsWith("refusal"))) {
			const renderer = RENDERERS[refusal.tool];
			const view = nativeResult(renderer, refusal.result, refusal.args);
			expect(view.tone, refusal.name).toBe("error");
			expect(view.passive, refusal.name).not.toBe(true);
			expect(bodyTexts(view), refusal.name).toHaveLength(1);
			expect(visible(ansiResult(renderer, refusal.result, refusal.args)), refusal.name).toContain(
				bodyTexts(view)[0],
			);
		}
	});

	it("read the reason from the content when details are missing", () => {
		const result: ToolRenderResult = {
			content: [{ type: "text", text: JSON.stringify({ error: "Swarm is disabled in settings", boardUri: "" }) }],
		};
		const view = nativeResult(swarmReadToolRenderer, result, { status: true });
		expect(view.tone).toBe("error");
		expect(bodyTexts(view)).toEqual(["Swarm is disabled in settings"]);
	});

	it("draw an isError result's plain content when it carries no structure", () => {
		const view = nativeResult(
			swarmPostToolRenderer,
			{ content: [{ type: "text", text: "Tool failed hard" }], isError: true },
			{
				text: "x",
			},
		);
		expect(view.tone).toBe("error");
		expect(bodyTexts(view)).toEqual(["Tool failed hard"]);
	});

	it("cap a runaway error message", () => {
		const message = "boom ".repeat(5_000);
		const result = toolResult({ boardUri: BOARD, error: message }, { error: message }, true);
		const view = nativeResult(swarmPostToolRenderer, result, { text: "x" });
		expect(bodyTexts(view)[0]).toHaveLength(4_096);
		const lines = ansiResult(swarmPostToolRenderer, result, { text: "x" });
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(visible(lines)).toContain("more lines");
	});
});

describe("board links", () => {
	const hasBoardLink = (text: string): boolean => text.includes("swarm://") || text.includes(BOARD_ID);

	it("never reach the ANSI cards, collapsed or expanded, call or result", () => {
		for (const item of CASES) {
			const renderer = RENDERERS[item.tool];
			for (const options of [collapsed, expanded]) {
				expect(hasBoardLink(visible(ansiResult(renderer, item.result, item.args, options))), item.name).toBe(false);
			}
			expect(hasBoardLink(visible(ansiCall(renderer, item.args))), item.name).toBe(false);
		}
	});

	it("never reach the native views' tooltip text, body or head", () => {
		for (const item of CASES) {
			const renderer = RENDERERS[item.tool];
			expect(hasBoardLink(JSON.stringify(nativeResult(renderer, item.result, item.args))), item.name).toBe(false);
			expect(hasBoardLink(JSON.stringify(nativeCall(renderer, item.args))), item.name).toBe(false);
		}
	});

	it("are replaced wherever a swarm URL appears in drawn text", () => {
		const result = {
			messages: [
				post(1, "coordinator", "Open swarm://swarm-abc?tab=members now"),
				post(2, "alice", "Also <swarm://swarm-abc> and (swarm://swarm-abc/x) and 'swarm://swarm-abc'"),
			],
			lastReadSeq: 2,
			head: 2,
			boardUri: BOARD,
		};
		const args = { since: 0 };
		const view = nativeResult(swarmReadToolRenderer, toolResult({ boardUri: BOARD, result }, result), args);
		expect(bodyTexts(view)[0]).toBe("#1 coordinator\nOpen [board] now");
		expect(bodyTexts(view)[1]).toBe("#2 alice\nAlso <[board]> and ([board]) and '[board]'");
		const text = visible(
			ansiResult(swarmReadToolRenderer, toolResult({ boardUri: BOARD, result }, result), args, expanded),
		);
		expect(text).toContain("Open [board] now");
		expect(text).not.toContain("swarm://");
		// The call side draws caller text too.
		expect(bodyTexts(nativeCall(swarmPostToolRenderer, { text: "see swarm://swarm-abc" }))).toEqual(["see [board]"]);
	});

	it("are removed from a result that only carries them in its content", () => {
		const result: ToolRenderResult = {
			content: [{ type: "text", text: `Look at ${BOARD}?tab=board` }],
			isError: true,
		};
		const view = nativeResult(swarmToolRenderer, result, { action: "status" });
		expect(bodyTexts(view)).toEqual(["Look at [board]"]);
	});
});

describe("terminal escapes in tool data", () => {
	const ESC = "\x1b";
	const hostile: Decorate = value =>
		`\x00${ESC}[?1049h${ESC}[?1000h${ESC}[?1003h${value}${ESC}]8;;https://evil.example/\x07link${ESC}]8;;\x07${ESC}[2J${ESC}[H\x07`;
	const HOSTILE_CASES = buildCases(hostile);

	it("reach neither the ANSI cards nor the native views, and the visible words remain", () => {
		for (const item of HOSTILE_CASES) {
			const renderer = RENDERERS[item.tool];
			const drawn = [
				...ansiResult(renderer, item.result, item.args, collapsed),
				...ansiResult(renderer, item.result, item.args, expanded),
				...ansiCall(renderer, item.args),
			].join("\n");
			expect(privateModeSequences(drawn), item.name).toEqual([]);
			const stripped = withoutSgr(drawn);
			expect(stripped, item.name).not.toContain(ESC);
			expect(stripped, item.name).not.toContain("\x07");
			expect(stripped, item.name).not.toContain("\x00");
			expect(stripped, item.name).not.toContain("evil.example");
			expect(stripped, item.name).toContain("link");

			const native = JSON.stringify([
				nativeResult(renderer, item.result, item.args),
				nativeCall(renderer, item.args),
			]);
			expect(native, item.name).not.toContain("\\u001b");
			expect(native, item.name).not.toContain("\\u0007");
			expect(native, item.name).not.toContain("\\u0000");
			expect(native, item.name).not.toContain("evil.example");
			expect(native, item.name).toContain("link");
		}
	});

	it("leave the caller's tool data untouched", () => {
		const item = caseNamed(HOSTILE_CASES, "swarm_post");
		const before = JSON.stringify([item.args, item.result]);
		ansiResult(swarmPostToolRenderer, item.result, item.args, expanded);
		nativeResult(swarmPostToolRenderer, item.result, item.args);
		expect(JSON.stringify([item.args, item.result])).toBe(before);
		expect(before).toContain("\\u001b");
	});
});

describe("card width", () => {
	const wide = "w".repeat(200);

	it("keeps every ANSI line within the surface width, collapsed and expanded, at 80 and 40 columns", () => {
		const long = buildCases(value => `${value}-${wide}`);
		for (const item of [...CASES, ...long]) {
			const renderer = RENDERERS[item.tool];
			for (const width of [80, 40]) {
				for (const options of [collapsed, expanded]) {
					for (const line of ansiResult(renderer, item.result, item.args, options, width)) {
						expect(visibleWidth(line), `${item.name} @${width}`).toBeLessThanOrEqual(width);
					}
				}
				for (const line of ansiCall(renderer, item.args, undefined, width)) {
					expect(visibleWidth(line), `${item.name} call @${width}`).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("collapses a very long list to a handful of lines with a remainder count, and expands it whole", () => {
		const members = Array.from({ length: 500 }, (_, index) => member(`worker-${index}`));
		const big = { id: BOARD_ID, title: "Big", head: 9, members, boardUri: BOARD };
		const result = toolResult({ action: "status", result: big }, big);
		const small = ansiResult(swarmToolRenderer, result, { action: "status" });
		expect(small).toHaveLength(5);
		expect(visible(small)).toContain("497 more lines");
		expect(ansiResult(swarmToolRenderer, result, { action: "status" }, expanded)).toHaveLength(501);
		const view = nativeResult(swarmToolRenderer, result, { action: "status" });
		expect(bodyTexts(view)).toHaveLength(500);
		expect(view.preview).toEqual({ lines: 4 });
	});
});

describe("malformed and unknown data", () => {
	const unusableDetails: unknown[] = [
		undefined,
		null,
		42,
		"text",
		true,
		[],
		{},
		{ result: null },
		{ result: "x" },
		{ result: 7 },
		{ snapshot: "x" },
		{ result: { messages: "no" } },
		{ result: { messages: [{ seq: -1, agent: "a", text: "t" }], head: 1, lastReadSeq: 1 } },
		{ result: { messages: [], head: 1.5, lastReadSeq: 0 } },
		{ result: { messages: [{ seq: 1, agent: 2, text: "t" }], head: 1, lastReadSeq: 1 } },
		{ snapshot: { title: "t", head: 1, members: "no" } },
		{ snapshot: { title: "t", head: 1, members: [{ name: "a", state: "zombie", model: "m", role: "worker" }] } },
		{ snapshot: { title: "t", head: Number.MAX_SAFE_INTEGER + 1, members: [] } },
		{ result: { post: { seq: 1, agent: "a", text: "t" }, head: 1, lastReadSeq: 0, receipts: [{ name: "a" }] } },
		{ result: {} },
		{ snapshot: {} },
		{ result: { boardUri: BOARD } },
		{ result: { id: "" } },
		{ result: [] },
	];
	const unusableContent: Array<ToolRenderResult["content"]> = [
		[],
		[{ type: "image" }],
		[{ type: "text" }],
		[{ type: "text", text: "not json" }],
		[{ type: "text", text: "{" }],
		[{ type: "text", text: "null" }],
		[{ type: "text", text: "7" }],
		[{ type: "text", text: '"text"' }],
		[{ type: "text", text: "[1,2]" }],
		[{ type: "text", text: "{}" }],
		[{ type: "text", text: '{"boardUri":"swarm://x"}' }],
	];
	// Every card validates its payload; schedule payloads need an id, a task or a task list.

	it("draw an unverified card, never an exception, for details no tool returns", () => {
		for (const name of TOOL_NAMES) {
			for (const details of unusableDetails) {
				const result: ToolRenderResult = { content: [{ type: "text", text: "plain" }], details };
				const view = nativeResult(RENDERERS[name], result, {});
				expect(view.tool?.title, `${name} ${JSON.stringify(details)}`).toBe(LABELS[name]);
				expect(view.tool?.note, `${name} ${JSON.stringify(details)}`).toBe("unverified result");
				expect(bodyTexts(view)).toEqual(["The result format could not be validated."]);
				const text = visible(ansiResult(RENDERERS[name], result, {}));
				expect(text).toContain(LABELS[name]);
				expect(text).toContain("unverified result");
			}
		}
	});

	it("draw an unverified card for content no tool returns", () => {
		for (const name of TOOL_NAMES) {
			for (const content of unusableContent) {
				const view = nativeResult(RENDERERS[name], { content }, {});
				expect(view.tool?.note, `${name} ${JSON.stringify(content)}`).toBe("unverified result");
				expect(view.tone).toBeUndefined();
				expect(ansiResult(RENDERERS[name], { content }, {}).length).toBeGreaterThan(0);
			}
		}
	});

	it("accept the schedule payloads a swarm_schedule call returns, and only those", () => {
		const stamp = task("task-1", "monitor");
		const valid: Array<[string, unknown, string]> = [
			["a created task", { boardUri: BOARD, id: "task-1", task: stamp }, "1 schedule"],
			["a task list", { boardUri: BOARD, tasks: [stamp, task("task-2", "narrator")] }, "2 schedules"],
			["an empty task list", { boardUri: BOARD, tasks: [] }, "0 schedules"],
			["a killed id", { boardUri: BOARD, id: "task-1" }, "0 schedules"],
		];
		for (const [label, payload, meta] of valid) {
			const view = nativeResult(
				swarmScheduleToolRenderer,
				toolResult({ action: "list", boardUri: BOARD, result: payload }, payload),
				{ action: "list" },
			);
			expect(view.tool?.note, label).toBeUndefined();
			expect(metaOf(view), label).toEqual([meta]);
		}
		const invalid: Array<[string, unknown]> = [
			["an empty object", {}],
			["only the board link", { boardUri: BOARD }],
			["an empty id", { boardUri: BOARD, id: "" }],
			[
				"a task with a numeric nextFire",
				{ tasks: [{ id: "t", owner: "o", cron: "* * * * *", nextFire: 12, daemon: true, running: false }] },
			],
			[
				"a task missing its owner",
				{ task: { id: "t", cron: "* * * * *", nextFire: "x", daemon: true, running: false } },
			],
			["tasks that are not a list", { tasks: "no" }],
			["an array", []],
		];
		for (const [label, payload] of invalid) {
			const view = nativeResult(
				swarmScheduleToolRenderer,
				toolResult({ action: "list", boardUri: BOARD, result: payload }, payload),
				{ action: "list" },
			);
			expect(view.tool?.note, label).toBe("unverified result");
			expect(bodyTexts(view), label).toEqual(["The result format could not be validated."]);
		}
	});

	it("draw a partial result that has no payload yet as its call", () => {
		for (const name of TOOL_NAMES) {
			const view = nativeResult(
				RENDERERS[name],
				{ content: [{ type: "text", text: "" }] },
				{ since: 1 },
				{
					expanded: false,
					isPartial: true,
				},
			);
			expect(view.tool?.title).toBe(LABELS[name]);
			expect(view.tool?.note, name).not.toBe("unverified result");
			expect(bodyTexts(view)).not.toContain("The result format could not be validated.");
		}
	});

	const unusableArgs: unknown[] = [
		undefined,
		null,
		5,
		"text",
		[],
		{},
		{ since: -1 },
		{ since: 1.5 },
		{ since: "3" },
		{ text: 5 },
		{ tasks: [1] },
		{ action: 7 },
		{ mentionsOnly: "yes" },
		{ n: Number.MAX_SAFE_INTEGER + 1 },
	];

	it("draw calls whose arguments match no schema as a bare card", () => {
		for (const name of TOOL_NAMES) {
			for (const args of unusableArgs) {
				expect(nativeCall(RENDERERS[name], args).tool?.title, `${name} ${JSON.stringify(args)}`).toBe(LABELS[name]);
				expect(visible(ansiCall(RENDERERS[name], args)), `${name} ${JSON.stringify(args)}`).toContain(LABELS[name]);
				const view = nativeResult(RENDERERS[name], toolResult({ result: {} }), args);
				expect(view.tool?.title).toBe(LABELS[name]);
			}
		}
	});

	it("summarize reads from unusable arguments and results", () => {
		for (const args of unusableArgs) {
			for (const details of unusableDetails) {
				const summary = summarizeSwarmRead(args, { content: [{ type: "text", text: "x" }], details });
				expect(summary.label.length).toBeGreaterThan(0);
				expect(typeof summary.content).toBe("string");
			}
		}
	});
});

describe("native view memos", () => {
	it("hand back the same call view for the same arguments and execution state", () => {
		const args = { since: 3, mentionsOnly: true };
		const parked: RenderResultOptions = { expanded: false, isPartial: true, executionStarted: true };
		const first = nativeCall(swarmWaitToolRenderer, args, parked);
		expect(nativeCall(swarmWaitToolRenderer, args, parked)).toBe(first);
		// Expansion is the transcript's concern: it does not rebuild the view.
		expect(nativeCall(swarmWaitToolRenderer, args, { ...parked, expanded: true })).toBe(first);

		const queued = nativeCall(swarmWaitToolRenderer, args, { expanded: false, isPartial: true });
		expect(queued).not.toBe(first);
		expect(queued.passive).toBe(false);
		expect(nativeCall(swarmWaitToolRenderer, args, parked)).toEqual(first);
	});

	it("rebuilds the call view when the arguments change in place", () => {
		const args = { since: 3 };
		const first = nativeCall(swarmWaitToolRenderer, args);
		args.since = 4;
		const second = nativeCall(swarmWaitToolRenderer, args);
		expect(second).not.toBe(first);
		expect(second.tool?.target).toBe("after #4");
	});

	it("hand back the same result view for the same result, arguments and partial state", () => {
		const args = { since: 10 };
		const first = nativeResult(swarmReadToolRenderer, readMessages.result, args);
		expect(nativeResult(swarmReadToolRenderer, readMessages.result, args)).toBe(first);
		expect(nativeResult(swarmReadToolRenderer, readMessages.result, args, expanded)).toBe(first);

		const partial = nativeResult(swarmReadToolRenderer, readMessages.result, args, {
			expanded: false,
			isPartial: true,
		});
		expect(partial).not.toBe(first);
		expect(partial).toEqual(first);

		const otherArgs = nativeResult(swarmReadToolRenderer, readMessages.result, { since: 10 });
		expect(otherArgs).not.toBe(first);
		expect(otherArgs).toEqual(first);
		const otherResult = nativeResult(swarmReadToolRenderer, { ...readMessages.result }, args);
		expect(otherResult).not.toBe(first);
	});

	it("keeps call and result memos apart, per renderer", () => {
		const args = { since: 3 };
		const wait = nativeCall(swarmWaitToolRenderer, args);
		const read = nativeCall(swarmReadToolRenderer, args);
		expect(wait).not.toBe(read);
		expect(wait.tool?.title).toBe("Swarm wait");
		expect(read.tool?.title).toBe("Swarm read");
		expect(nativeCall(swarmWaitToolRenderer, args)).toBe(wait);
		expect(nativeCall(swarmReadToolRenderer, args)).toBe(read);
	});

	it("builds without a cache for arguments and results that cannot carry one", () => {
		const frozen = Object.freeze({ since: 3 });
		const call = nativeCall(swarmWaitToolRenderer, frozen);
		expect(call.tool?.target).toBe("after #3");
		const result = Object.freeze({ ...readMessages.result });
		expect(bodyTexts(nativeResult(swarmReadToolRenderer, result, frozen))).toHaveLength(2);
		expect(nativeCall(swarmWaitToolRenderer, undefined).tool?.title).toBe("Swarm wait");
	});
});

describe("summarizeSwarmRead", () => {
	it("labels a pending read from its arguments", () => {
		expect(summarizeSwarmRead({ since: 10 })).toEqual({ label: "main · after #10", content: "", error: false });
		expect(summarizeSwarmRead({ channel: "parser" }).label).toBe("parser");
		expect(summarizeSwarmRead({ status: true }).label).toBe("members");
		expect(summarizeSwarmRead({ channel: "" }).label).toBe("Board");
	});

	it("labels a finished read with its counts and carries its posts as content", () => {
		const summary = summarizeSwarmRead(readMessages.args, readMessages.result);
		expect(summary).toEqual({
			label: "main · 2 posts · read #12 · head #14",
			content: "#11 coordinator\n@alice go\n#12 alice · parser\nlexer merged",
			error: false,
		});
	});

	it("flags a refusal and an unverifiable result", () => {
		const refusal = caseNamed(CASES, "swarm_read refusal");
		expect(summarizeSwarmRead(refusal.args, refusal.result)).toEqual({
			label: "*",
			content: "All-channel reads require a coordinator, narrator or monitor",
			error: true,
		});
		expect(summarizeSwarmRead({}, { content: [{ type: "text", text: "plain" }] })).toEqual({
			label: "main · unverified result",
			content: "The result format could not be validated.",
			error: false,
		});
	});

	it("keeps board links and escapes out of the label and content", () => {
		const result = {
			messages: [post(1, "a", `see ${BOARD}\x1b[?1049h`), post(2, "b", "plain")],
			lastReadSeq: 2,
			head: 2,
			boardUri: BOARD,
		};
		const summary = summarizeSwarmRead({ channel: `x${"\x1b"}[2J` }, toolResult({ boardUri: BOARD, result }, result));
		expect(summary.label).toBe("x · 2 posts · read #2 · head #2");
		expect(summary.content).toBe("#1 a\nsee [board]\n#2 b\nplain");
	});
});

describe("counts at one", () => {
	const solo = (extra: Record<string, unknown> = {}) => ({
		id: BOARD_ID,
		title: "Solo",
		head: 1,
		members: [member("worker")],
		boardUri: BOARD,
		...extra,
	});
	const controlView = (payload: Record<string, unknown>) =>
		nativeResult(swarmToolRenderer, toolResult({ action: "status", result: payload }, payload), { action: "status" });

	it("name one member, model, post and recipient in the singular and none in the plural", () => {
		expect(metaOf(controlView(solo()))).toEqual(["#1", "1 member"]);
		expect(metaOf(controlView(solo({ models: [{ model: "mock/x", name: "Mock" }] })))).toEqual([
			"#1",
			"1 member",
			"1 model",
		]);
		expect(metaOf(controlView(solo({ members: [], models: [] })))).toEqual(["#1", "0 members", "0 models"]);

		const one = { messages: [post(3, "alice", "only post")], lastReadSeq: 3, head: 3, boardUri: BOARD };
		const none = { messages: [], lastReadSeq: 3, head: 3, boardUri: BOARD };
		for (const renderer of [swarmReadToolRenderer, swarmWaitToolRenderer]) {
			expect(metaOf(nativeResult(renderer, toolResult({ boardUri: BOARD, result: one }, one), {}))).toEqual([
				"1 post",
				"read #3",
				"head #3",
			]);
			expect(metaOf(nativeResult(renderer, toolResult({ boardUri: BOARD, result: none }, none), {}))).toEqual([
				"0 posts",
				"read #3",
				"head #3",
			]);
		}

		const posted = {
			post: post(4, "coordinator", "hello"),
			receipts: [{ name: "alice", to: "Member-alice", outcome: "injected" }],
			head: 4,
			lastReadSeq: 0,
			boardUri: BOARD,
		};
		expect(
			metaOf(nativeResult(swarmPostToolRenderer, toolResult({ boardUri: BOARD, result: posted }, posted), {})),
		).toEqual(["main", "1 recipient"]);
		const alone = { ...posted, receipts: [] };
		expect(
			metaOf(nativeResult(swarmPostToolRenderer, toolResult({ boardUri: BOARD, result: alone }, alone), {})),
		).toEqual(["main", "0 recipients"]);
	});

	it("name one requested member in the singular on the add call", () => {
		expect(metaOf(nativeCall(swarmToolRenderer, { action: "add", name: "w", brief: "b", n: 1 }))).toEqual([
			"1 member",
		]);
		expect(metaOf(nativeCall(swarmToolRenderer, { action: "add", name: "w", brief: "b", tasks: ["only"] }))).toEqual([
			"1 member",
		]);
		expect(metaOf(nativeCall(swarmToolRenderer, { action: "add", name: "w", brief: "b", n: 3 }))).toEqual([
			"3 members",
		]);
	});

	it("carry the singular into the ANSI header", () => {
		const one = { messages: [post(3, "alice", "only post")], lastReadSeq: 3, head: 3, boardUri: BOARD };
		const text = visible(ansiResult(swarmReadToolRenderer, toolResult({ boardUri: BOARD, result: one }, one), {}));
		expect(text).toContain("1 post");
		expect(text).not.toContain("1 posts");
	});
});

describe("swarm_wait in a real ToolExecutionComponent", () => {
	const UI = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
	const toolCx: DescribeContext = {
		cols: 100,
		reduceMotion: false,
		dark: true,
		supports: kind => kind === "tool",
		feature: () => true,
	};
	const args = { since: 3, mentionsOnly: true };

	afterEach(() => {
		vi.useRealTimers();
		stopSharedSpinnerTicker();
	});

	function card(tool: SwarmToolName, callArgs: unknown, ui = UI): ToolExecutionComponent {
		return new ToolExecutionComponent(tool, callArgs, {}, undefined, ui, "/tmp", "call-1");
	}

	function toolProps(view: NativeNode) {
		if (view.k !== "tool") throw new Error(`Expected a tool node, got ${view.k}`);
		return view.p;
	}

	function nodesOfKind(children: readonly NativeChild[] | undefined, kind: string): NativeNode[] {
		const found: NativeNode[] = [];
		for (const child of children ?? []) {
			if (!("k" in child)) continue;
			if (child.k === kind) found.push(child);
			found.push(...nodesOfKind(child.c, kind));
		}
		return found;
	}

	function started(tool: SwarmToolName, callArgs: unknown, ui = UI): ToolExecutionComponent {
		const component = card(tool, callArgs, ui);
		component.setArgsComplete("call-1");
		component.setExecutionStarted("call-1");
		return component;
	}

	it("describes a parked wait as pending, without an age or a took time", () => {
		const wait = card("swarm_wait", args);
		try {
			wait.setArgsComplete("call-1");
			const queued = toolProps(wait.describe(toolCx));
			expect(queued).toMatchObject({
				role: "omp.tool.swarm_wait",
				name: "swarm_wait",
				title: "Swarm wait",
				target: "after #3",
				status: "pending",
			});
			expect(queued?.note).toBeUndefined();

			wait.setExecutionStarted("call-1");
			const parked = toolProps(wait.describe(toolCx));
			expect(parked).toMatchObject({ status: "pending", note: "parked", target: "after #3", meta: ["mentions"] });
			expect(parked?.age).toBeUndefined();
			expect(parked?.took).toBeUndefined();
			expect(wait.isTranscriptBlockFinalized()).toBe(false);
		} finally {
			wait.dispose();
		}
	});

	it("lets any other swarm call that runs show its age", () => {
		const read = started("swarm_read", { since: 3 });
		try {
			const running = toolProps(read.describe(toolCx));
			expect(running).toMatchObject({ role: "omp.tool.swarm_read", status: "running" });
			expect(typeof running?.age).toBe("number");
			expect(running?.took).toBeUndefined();
		} finally {
			read.dispose();
		}
	});

	it("draws no elapsed counter in the fallback card while parked, unlike a running read", () => {
		const wait = started("swarm_wait", args);
		const read = started("swarm_read", { since: 3 });
		try {
			const parkedView = wait.describe();
			expect(parkedView.p).toMatchObject({ role: "omp.tool.swarm_wait" });
			expect(nodesOfKind(parkedView.c, "elapsed")).toEqual([]);
			expect(nodesOfKind(read.describe().c, "elapsed")).toHaveLength(1);
		} finally {
			wait.dispose();
			read.dispose();
		}
	});

	it("draws the parked note in the ANSI card and schedules no repaint however long it waits", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const wait = started("swarm_wait", args, {
			requestRender: () => {},
			requestComponentRender,
			resetDisplay: () => {},
		});
		try {
			const parked = visible(wait.render(100));
			expect(parked).toContain("Swarm wait: after #3");
			expect(parked).toContain("parked");
			vi.advanceTimersByTime(60_000);
			expect(requestComponentRender).not.toHaveBeenCalled();
			expect(visible(wait.render(100))).toBe(parked);
		} finally {
			wait.dispose();
		}
	});

	it("becomes an ordinary finished call once its result arrives, and finalizes", () => {
		const wait = started("swarm_wait", args);
		try {
			expect(wait.isTranscriptBlockFinalized()).toBe(false);
			wait.updateResult(waitResult.result, false, "call-1");

			const done = wait.describe(toolCx);
			const props = toolProps(done);
			expect(props).toMatchObject({ status: "done", target: "after #3", note: "interrupted" });
			expect(props?.meta).toEqual(["2 posts", "read #12", "head #14"]);
			expect(typeof props?.took).toBe("number");
			expect(props?.age).toBeUndefined();
			const posts = (done.c ?? []).flatMap(child =>
				"k" in child && child.k === "text" ? [plain(child.p?.text ?? child.p?.spans)] : [],
			);
			expect(posts).toEqual(["#11 coordinator\n@alice go", "#12 alice · parser\nlexer merged"]);
			expect(wait.isTranscriptBlockFinalized()).toBe(true);

			const text = visible(wait.render(100));
			expect(text).toContain("Swarm wait: after #3");
			expect(text).toContain("#11 coordinator");
			expect(text).not.toContain("parked");
			wait.setExpanded(true);
			expect(visible(wait.render(100))).toContain("lexer merged");
		} finally {
			wait.dispose();
		}
	});

	it("finalizes a refused wait as an error", () => {
		const wait = started("swarm_wait", args);
		try {
			const refused = caseNamed(CASES, "swarm_wait refusal");
			wait.updateResult(refused.result, false, "call-1");
			expect(toolProps(wait.describe(toolCx))).toMatchObject({ status: "error" });
			expect(toolProps(wait.describe(toolCx))?.age).toBeUndefined();
			expect(wait.isTranscriptBlockFinalized()).toBe(true);
			expect(visible(wait.render(100))).toContain("Member parse-1 already has a pending swarm_wait");
		} finally {
			wait.dispose();
		}
	});

	it("settles a parked wait the turn abandoned as cancelled, and finalizes it", () => {
		const wait = started("swarm_wait", args);
		try {
			expect(wait.isTranscriptBlockFinalized()).toBe(false);
			wait.seal();
			const props = toolProps(wait.describe(toolCx));
			expect(props?.status).toBe("cancelled");
			expect(props?.age).toBeUndefined();
			expect(wait.isTranscriptBlockFinalized()).toBe(true);
		} finally {
			wait.dispose();
		}
	});
});
