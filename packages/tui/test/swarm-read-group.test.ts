/**
 * Consecutive `swarm_read` calls collapse into one ReadToolGroupComponent({ toolName: "swarm_read" }): board reads
 * draw as labelled rows (cursor, counts), expand to their `#seq` posts, and never carry file links. An ordinary
 * read group keeps its `read` role, title and file links.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { ChatTranscriptBuilder } from "../src/chat/chat-transcript-builder";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import {
	groupedReadUsageCallIds,
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
} from "../src/chat/read-tool-group";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { PREVIEW_LIMITS } from "../src/render/render-utils";
import { initTheme } from "../src/theme";
import { TUI } from "../src/tui";
import { visibleWidth } from "../src/utils";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	applyHyperlinkSetting("auto");
});

const BOARD = "swarm://swarm-0123456789abcdef0123456789abcdef";
const toolCx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "tool",
	feature: () => true,
};
const fallbackCx: DescribeContext = { ...toolCx, supports: () => false };

const LABEL_A = "main · 3 posts · read #3 · head #3";
const LABEL_B = "parser · 2 posts · read #5 · head #5";
const ARGS_A = { since: 0 };
const ARGS_B = { channel: "parser", since: 3 };

interface PostFixture {
	seq: number;
	agent: string;
	text: string;
	time: string;
	mentions: string[];
	all: boolean;
	channel?: string;
}

function post(seq: number, agent: string, text: string, channel?: string): PostFixture {
	return {
		seq,
		agent,
		text,
		time: "2026-03-01T10:00:00.000Z",
		mentions: [],
		all: false,
		...(channel ? { channel } : {}),
	};
}

/** The result `swarm_read` returns for a message read (coding-agent `SwarmReadTool`). */
function readResult(messages: PostFixture[], lastReadSeq: number, head: number) {
	const result = { messages, lastReadSeq, head, boardUri: BOARD };
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: { boardUri: BOARD, status: false, result },
	};
}

const RESULT_A = readResult(
	[
		post(1, "coordinator", "@alice take the lexer\nkeep it small"),
		post(2, "alice", "lexer started"),
		post(3, "carol", "tests green\nready"),
	],
	3,
	3,
);
const RESULT_B = readResult([post(4, "alice", "parser question", "parser"), post(5, "bob", "answer posted")], 5, 5);

function twoReads(options: ConstructorParameters<typeof ReadToolGroupComponent>[0] = {}): ReadToolGroupComponent {
	const group = new ReadToolGroupComponent({ toolName: "swarm_read", ...options });
	group.updateArgs(ARGS_A, "a");
	group.updateResult(RESULT_A, false, "a");
	group.updateArgs(ARGS_B, "b");
	group.updateResult(RESULT_B, false, "b");
	return group;
}

const visible = (lines: readonly string[]): string => sanitizeText(lines.join("\n"));

function plain(value: string | readonly { t: string }[] | undefined): string {
	return typeof value === "string" ? value : (value ?? []).map(part => part.t).join("");
}

function collect(children: readonly NativeChild[] | undefined, match: (node: NativeNode) => boolean): NativeNode[] {
	const found: NativeNode[] = [];
	for (const child of children ?? []) {
		if (!("k" in child)) continue;
		if (match(child)) found.push(child);
		found.push(...collect(child.c, match));
	}
	return found;
}

function texts(view: NativeNode): Array<{ text: string; lines: number | undefined }> {
	return collect(view.c, node => node.k === "text").flatMap(node =>
		node.k === "text" ? [{ text: plain(node.p?.text ?? node.p?.spans), lines: node.p?.lines }] : [],
	);
}

function sectionHeads(view: NativeNode): string[] {
	return collect(view.c, node => node.k === "section").flatMap(node =>
		node.k === "section" ? [plain(node.p?.head)] : [],
	);
}

function toolView(group: ReadToolGroupComponent, cx: DescribeContext = toolCx) {
	const view = group.describe(cx);
	if (view.k !== "tool") throw new Error(`Expected a tool node, got ${view.k}`);
	return view;
}

describe("ReadToolGroupComponent for swarm_read: terminal", () => {
	it("draws a pending board read as one row from its arguments", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs(ARGS_A, "a");
		const text = visible(group.render(100));
		expect(text).toContain("Swarm read");
		expect(text).toContain("main · after #0");
		expect(text).not.toMatch(/Swarm read \(\d/);
	});

	it("summarizes two reads as 'Swarm read (2)' with each read's cursor and counts", () => {
		const lines = twoReads().render(100);
		const text = visible(lines);
		expect(text.split("\n").some(line => line.includes("Swarm read (2)"))).toBe(true);
		expect(text).toContain(LABEL_A);
		expect(text).toContain(LABEL_B);
		// Without content previews the group stays a list of labelled rows.
		expect(text).not.toContain("take the lexer");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
	});

	it("previews each read's posts, clamped while collapsed", () => {
		const group = twoReads({ showContentPreview: true });
		const lines = group.render(100);
		const text = visible(lines);
		expect(text).toContain("Swarm read (2)");
		expect(text).toContain("Swarm read: main");
		expect(text).toContain("#1 coordinator");
		expect(text).toContain("take the lexer");
		expect(text).not.toContain("#3 carol");
		expect(text).toMatch(/\d+ more lines/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
	});

	it("shows every post with its #seq and text once expanded", () => {
		const group = twoReads({ showContentPreview: true });
		group.setExpanded(true);
		const text = visible(group.render(100));
		for (const expected of [
			"#1 coordinator",
			"@alice take the lexer",
			"keep it small",
			"#2 alice",
			"lexer started",
			"#3 carol",
			"tests green",
			"#4 alice · parser",
			"parser question",
			"#5 bob",
			"answer posted",
		]) {
			expect(text, expected).toContain(expected);
		}
		expect(text).not.toContain("more lines");
		group.setExpanded(false);
		expect(visible(group.render(100))).not.toContain("#3 carol");
	});

	it("previews a single read without a group header", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read", showContentPreview: true });
		group.updateArgs(ARGS_A, "a");
		group.updateResult(RESULT_A, false, "a");
		group.setExpanded(true);
		const text = visible(group.render(100));
		expect(text).toContain("Swarm read: main");
		expect(text).toContain("#3 carol");
		expect(text).not.toMatch(/Swarm read \(\d/);
	});

	it("marks a refused read as an error row with its reason", () => {
		const message = "All-channel reads require a coordinator, narrator or monitor";
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs({ channel: "*" }, "a");
		group.updateResult(
			{
				content: [{ type: "text", text: JSON.stringify({ error: message, boardUri: "" }) }],
				details: { boardUri: "", status: false, error: message },
				isError: true,
			},
			false,
			"a",
		);
		const text = visible(group.render(100));
		expect(text).toContain("Swarm read");
		expect(text).toContain("*");
		expect(JSON.stringify(toolView(group))).toContain(message);
		expect(toolView(group).p).toMatchObject({ status: "error", tone: "error" });
	});

	it("leaves the board link out of every row and preview", () => {
		const group = twoReads({ showContentPreview: true });
		group.setExpanded(true);
		expect(visible(group.render(100))).not.toContain("swarm://");
		expect(JSON.stringify(group.describe(toolCx))).not.toContain("swarm://");
		expect(JSON.stringify(group.describe(fallbackCx))).not.toContain("swarm://");
	});

	it("draws no file link on a label, even for a call that carries path arguments and with links forced on", () => {
		applyHyperlinkSetting("always");
		const group = new ReadToolGroupComponent({ toolName: "swarm_read", showContentPreview: true });
		group.updateArgs({ since: 0, path: "/etc/passwd", file_path: "/tmp/other" }, "a");
		group.updateResult(RESULT_A, false, "a");
		group.updateArgs(ARGS_B, "b");
		group.updateResult(RESULT_B, false, "b");
		const withPreviews = group.render(100).join("\n");
		expect(withPreviews).not.toContain("\x1b]8;");
		expect(withPreviews).not.toContain("file://");

		const rows = twoReads();
		expect(rows.render(100).join("\n")).not.toContain("\x1b]8;");
		for (const view of [group.describe(toolCx), group.describe(fallbackCx), rows.describe(toolCx)]) {
			const json = JSON.stringify(view);
			expect(json).not.toContain('"href"');
			expect(json).not.toContain("file://");
			expect(json).not.toContain("/etc/passwd");
		}
	});

	it("draws terminal escapes in posts and labels as plain text", () => {
		const hostile = `\x1b[?1049h\x1b[?1003h\x1b]8;;https://evil.example/\x07link\x1b]8;;\x07`;
		const result = readResult([post(1, `a${hostile}`, `text${hostile}`), post(2, "b", "plain")], 2, 2);
		const group = new ReadToolGroupComponent({ toolName: "swarm_read", showContentPreview: true });
		group.updateArgs({ channel: `x${hostile}` }, "a");
		group.updateResult(result, false, "a");
		group.setExpanded(true);
		const drawn = group
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(drawn).not.toContain("\x1b");
		expect(drawn).not.toContain("evil.example");
		expect(drawn).toContain("link");
		const native = JSON.stringify([group.describe(toolCx), group.describe(fallbackCx)]);
		expect(native).not.toContain("\\u001b");
		expect(native).not.toContain("evil.example");
	});
});

describe("ReadToolGroupComponent for swarm_read: native", () => {
	it("describes a single read as a read tool node named omp.tool.swarm_read", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs(ARGS_A, "a");
		group.updateResult(RESULT_A, false, "a");
		const view = toolView(group);
		expect(view.p).toMatchObject({
			role: "omp.tool.swarm_read",
			name: "swarm_read",
			title: "Swarm read",
			target: LABEL_A,
			targetKind: "text",
			status: "done",
			frame: "inline",
			collapsible: false,
		});
		expect(view.p).not.toHaveProperty("href");
		expect(group.toolName).toBe("swarm_read");
	});

	it("describes a pending read as running, from its call", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs(ARGS_B, "b");
		expect(toolView(group).p).toMatchObject({ target: "parser · after #3", status: "running" });
	});

	it("summarizes two reads as '2 reads' over one row per read", () => {
		const view = toolView(twoReads());
		expect(view.p).toMatchObject({
			role: "omp.tool.swarm_read",
			name: "swarm_read",
			target: "2 reads",
			status: "done",
		});
		expect(texts(view).map(item => item.text)).toEqual([LABEL_A, LABEL_B]);
		expect(view.p).not.toHaveProperty("href");
	});

	it("sections each read's posts under its label, clamped while collapsed and whole once expanded", () => {
		const group = twoReads({ showContentPreview: true });
		const closed = toolView(group);
		expect(closed.p).toMatchObject({ target: "2 reads", collapsible: true, collapsed: true });
		expect(sectionHeads(closed)).toEqual([LABEL_A, LABEL_B]);
		const closedTexts = texts(closed);
		expect(closedTexts).toHaveLength(2);
		expect(closedTexts[0]!.text).toBe(
			"#1 coordinator\n@alice take the lexer\nkeep it small\n#2 alice\nlexer started\n#3 carol\ntests green\nready",
		);
		expect(closedTexts[1]!.text).toBe("#4 alice · parser\nparser question\n#5 bob\nanswer posted");
		expect(closedTexts.map(item => item.lines)).toEqual([
			PREVIEW_LIMITS.OUTPUT_COLLAPSED,
			PREVIEW_LIMITS.OUTPUT_COLLAPSED,
		]);

		group.setExpanded(true);
		const open = toolView(group);
		expect(open.p).toMatchObject({ collapsed: false });
		expect(texts(open).map(item => item.lines)).toEqual([undefined, undefined]);
		expect(texts(open).map(item => item.text)).toEqual(closedTexts.map(item => item.text));
	});

	it("previews one read's posts directly under the node", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read", showContentPreview: true });
		group.updateArgs(ARGS_B, "b");
		group.updateResult(RESULT_B, false, "b");
		const view = toolView(group);
		expect(view.p).toMatchObject({ target: LABEL_B, collapsible: true });
		expect(sectionHeads(view)).toEqual([]);
		expect(texts(view).map(item => item.text)).toEqual(["#4 alice · parser\nparser question\n#5 bob\nanswer posted"]);
	});

	it("falls back to a bare card named omp.tool.swarm_read with 'Swarm read (N)' in its head", () => {
		const rows = twoReads().describe(fallbackCx);
		expect(rows.k).toBe("card");
		if (rows.k !== "card") return;
		expect(rows.p).toMatchObject({ role: "omp.tool.swarm_read", variant: "bare", status: "done" });
		expect(plain(rows.p?.head)).toBe("Swarm read (2)");
		const labels = collect(rows.c, node => node.k === "item").flatMap(node =>
			node.k === "item" ? [plain(node.p?.label)] : [],
		);
		expect(labels).toEqual([LABEL_A, LABEL_B]);

		const previews = twoReads({ showContentPreview: true }).describe(fallbackCx);
		const cards = collect(previews.c, node => node.k === "card");
		expect(cards.map(card => card.p?.role)).toEqual(["omp.tool.swarm_read.preview", "omp.tool.swarm_read.preview"]);
		expect(texts(previews).map(item => item.text.split("\n")[0])).toEqual(["#1 coordinator", "#4 alice · parser"]);
	});

	it("keeps its node stable until a read changes", () => {
		const group = twoReads();
		const first = group.describe(toolCx);
		expect(group.describe(toolCx)).toBe(first);
		group.updateArgs({ since: 5 }, "c");
		expect(group.describe(toolCx)).not.toBe(first);
	});
});

describe("ordinary read groups", () => {
	function plainReads(count: number): ReadToolGroupComponent {
		const group = new ReadToolGroupComponent({ showContentPreview: false });
		for (const index of Array.from({ length: count }, (_, i) => i)) {
			group.updateArgs({ path: `src/file${index}.ts` }, `r${index}`);
			group.updateResult(
				{
					content: [{ type: "text", text: "const x = 1;" }],
					details: { displayContent: { text: "const x = 1;", startLine: 1 } },
				},
				false,
				`r${index}`,
			);
		}
		return group;
	}

	it("stay 'read' by default", () => {
		const group = plainReads(2);
		expect(group.toolName).toBe("read");
		const view = toolView(group);
		expect(view.p).toMatchObject({ role: "omp.tool.read", name: "read", title: "Read" });
		const text = visible(group.render(100));
		expect(text.split("\n").some(line => line.includes("Read (2)"))).toBe(true);
		expect(text).not.toContain("Swarm read");
		const fallback = group.describe(fallbackCx);
		expect(fallback.p).toMatchObject({ role: "omp.tool.read" });
		expect(plain(fallback.k === "card" ? fallback.p?.head : undefined)).toBe("Read (2)");
	});

	it("keep file rows distinct from board labels", () => {
		const view = toolView(plainReads(1));
		expect(view.p).toMatchObject({ role: "omp.tool.read", targetKind: "path" });
		expect(view.p?.target).toContain("file0.ts");
	});

	it("an explicit read toolName is the same as the default", () => {
		const group = new ReadToolGroupComponent({ toolName: "read" });
		expect(group.toolName).toBe("read");
	});
});

describe("grouping rules", () => {
	it("collapse every swarm_read call into a group, whatever its arguments", () => {
		for (const args of [{}, { since: 3 }, { status: true }, { channel: "parser", limit: 10 }, undefined, null, "x"]) {
			expect(readArgsCollapseIntoGroup(args, "swarm_read")).toBe(true);
		}
	});

	it("leave read targets and other tools to their own rules", () => {
		expect(readArgsCollapseIntoGroup({ path: "src/a.ts" })).toBe(true);
		expect(readArgsCollapseIntoGroup({ path: "src/a.ts" }, "read")).toBe(true);
		expect(readArgsCollapseIntoGroup({})).toBe(false);
		for (const name of ["swarm", "swarm_post", "swarm_wait", "swarm_schedule", "bash", "grep"]) {
			expect(readArgsCollapseIntoGroup({ path: "src/a.ts" }, name), name).toBe(false);
			expect(readArgsCollapseIntoGroup({}, name), name).toBe(false);
		}
	});

	const USAGE: AssistantMessage["usage"] = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	function assistant(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: USAGE,
			timestamp: 1,
		};
	}
	const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"][number] => ({
		type: "toolCall",
		id,
		name,
		arguments: args,
	});

	it("lets a turn of swarm_read calls own the group's usage row, and nothing mixed", () => {
		expect(
			groupedReadUsageCallIds(assistant([call("c1", "swarm_read", {}), call("c2", "swarm_read", { since: 2 })])),
		).toEqual(["c1", "c2"]);
		expect(
			groupedReadUsageCallIds(
				assistant([call("c1", "read", { path: "a.ts" }), call("c2", "read", { path: "b.ts" })]),
			),
		).toEqual(["c1", "c2"]);
		expect(
			groupedReadUsageCallIds(assistant([call("c1", "swarm_read", {}), call("c2", "read", { path: "a.ts" })])),
		).toBeUndefined();
		expect(
			groupedReadUsageCallIds(assistant([call("c1", "swarm_read", {}), call("c2", "swarm_post", { text: "x" })])),
		).toBeUndefined();
		expect(
			groupedReadUsageCallIds(assistant([call("c1", "swarm_read", {}), { type: "text", text: "Done reading." }])),
		).toBeUndefined();
	});
});

describe("transcript rebuild", () => {
	const ts = "2026-03-01T10:00:00Z";
	const savedPreferences = { ...chatTranscriptDisplayPreferences };
	beforeEach(() => {
		// A read group previews content only when the host preference says so; pin it for stable labels.
		setChatTranscriptDisplayPreferences({
			readToolResultPreview: false,
			hideToolActivity: false,
			showTokenUsage: false,
			showTurnTime: false,
		});
	});
	afterEach(() => {
		setChatTranscriptDisplayPreferences(savedPreferences);
	});
	const assistantEntry = (id: string, calls: AssistantMessage["content"]): TranscriptEntryLike => ({
		type: "message",
		id,
		parentId: null,
		timestamp: ts,
		message: {
			role: "assistant",
			content: calls,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		},
	});
	const callEntry = (
		id: string,
		name: string,
		args: Record<string, unknown>,
	): AssistantMessage["content"][number] => ({
		type: "toolCall",
		id,
		name,
		arguments: args,
	});
	const resultEntry = (
		id: string,
		toolCallId: string,
		toolName: string,
		content: Array<{ type: "text"; text: string }>,
		details?: unknown,
	): TranscriptEntryLike => ({
		type: "message",
		id,
		parentId: null,
		timestamp: ts,
		message: { role: "toolResult", toolCallId, toolName, content, details, isError: false, timestamp: 2 },
	});
	const swarmResult = (id: string, toolCallId: string, result: typeof RESULT_A) =>
		resultEntry(id, toolCallId, "swarm_read", [{ type: "text", text: result.content[0]!.text }], result.details);

	function build(entries: TranscriptEntryLike[]): { groups: ReadToolGroupComponent[]; dispose: () => void } {
		const builder = new ChatTranscriptBuilder({
			ui: new TUI(new VirtualTerminal()),
			cwd: "/tmp",
			requestRender: () => {},
		});
		builder.rebuild(entries);
		const groups = builder.container.children.filter(
			(child): child is ReadToolGroupComponent => child instanceof ReadToolGroupComponent,
		);
		return { groups, dispose: () => builder.dispose() };
	}

	it("folds two swarm_read calls of one turn into one swarm_read group", () => {
		const { groups, dispose } = build([
			assistantEntry("a1", [callEntry("c1", "swarm_read", ARGS_A), callEntry("c2", "swarm_read", ARGS_B)]),
			swarmResult("r1", "c1", RESULT_A),
			swarmResult("r2", "c2", RESULT_B),
		]);
		try {
			expect(groups).toHaveLength(1);
			expect(groups[0]!.toolName).toBe("swarm_read");
			const text = visible(groups[0]!.render(100));
			expect(text).toContain("Swarm read (2)");
			expect(text).toContain(LABEL_A);
			expect(text).toContain(LABEL_B);
			expect(JSON.stringify(groups[0]!.describe(toolCx))).toContain("omp.tool.swarm_read");
		} finally {
			dispose();
		}
	});

	it("keeps swarm_read and read in separate groups, in call order", () => {
		const { groups, dispose } = build([
			assistantEntry("a1", [
				callEntry("c1", "swarm_read", ARGS_A),
				callEntry("c2", "read", { path: "src/a.ts" }),
				callEntry("c3", "swarm_read", ARGS_B),
			]),
			swarmResult("r1", "c1", RESULT_A),
			resultEntry("r2", "c2", "read", [{ type: "text", text: "const a = 1;" }], {
				displayContent: { text: "const a = 1;", startLine: 1 },
			}),
			swarmResult("r3", "c3", RESULT_B),
		]);
		try {
			expect(groups.map(group => group.toolName)).toEqual(["swarm_read", "read", "swarm_read"]);
			expect(visible(groups[1]!.render(100))).toContain("Read");
			expect(visible(groups[1]!.render(100))).not.toContain("Swarm read");
			expect(visible(groups[0]!.render(100))).toContain(LABEL_A);
			expect(visible(groups[2]!.render(100))).toContain(LABEL_B);
		} finally {
			dispose();
		}
	});
});

describe("expanding a swarm_read group whose content previews are off", () => {
	// The user path: the group's expand toggle (Ctrl+O, or the native root node's toggle) opens every read's posts.
	const FULL_TEXT_A =
		"#1 coordinator\n@alice take the lexer\nkeep it small\n#2 alice\nlexer started\n#3 carol\ntests green\nready";
	const FULL_TEXT_B = "#4 alice · parser\nparser question\n#5 bob\nanswer posted";

	it("shows each read's #seq and text in the terminal once expanded, and the labelled rows again once collapsed", () => {
		const group = twoReads();
		const rows = visible(group.render(100));
		expect(rows).toContain(LABEL_A);
		expect(rows).not.toContain("take the lexer");

		group.setExpanded(true);
		const lines = group.render(100);
		const open = visible(lines);
		expect(open).toContain("Swarm read (2)");
		for (const expected of [
			"Swarm read: main",
			"#1 coordinator",
			"@alice take the lexer",
			"keep it small",
			"#2 alice",
			"lexer started",
			"#3 carol",
			"tests green",
			"Swarm read: parser",
			"#4 alice · parser",
			"parser question",
			"#5 bob",
			"answer posted",
		]) {
			expect(open, expected).toContain(expected);
		}
		expect(open).not.toContain("more lines");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);

		group.setExpanded(false);
		const closed = visible(group.render(100));
		expect(closed).toContain(LABEL_A);
		expect(closed).toContain(LABEL_B);
		expect(closed).not.toContain("take the lexer");
	});

	it("describes the expanded group natively with each read's posts under its label", () => {
		const group = twoReads();
		const closed = toolView(group);
		expect(closed.p).toMatchObject({ target: "2 reads", collapsible: false });
		expect(sectionHeads(closed)).toEqual([]);
		expect(texts(closed).map(item => item.text)).toEqual([LABEL_A, LABEL_B]);

		group.setExpanded(true);
		const open = toolView(group);
		expect(open.p).toMatchObject({
			role: "omp.tool.swarm_read",
			name: "swarm_read",
			target: "2 reads",
			collapsible: true,
			collapsed: false,
		});
		expect(sectionHeads(open)).toEqual([LABEL_A, LABEL_B]);
		expect(texts(open)).toEqual([
			{ text: FULL_TEXT_A, lines: undefined },
			{ text: FULL_TEXT_B, lines: undefined },
		]);
		expect(JSON.stringify(open)).not.toContain('"href"');

		group.setExpanded(false);
		const folded = toolView(group);
		expect(folded.p).toMatchObject({ collapsible: false });
		expect(sectionHeads(folded)).toEqual([]);
	});

	it("follows the native root toggle the same way", () => {
		const group = twoReads();
		group.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(sectionHeads(toolView(group))).toEqual([LABEL_A, LABEL_B]);
		expect(visible(group.render(100))).toContain("#3 carol");
		group.handleNativeEvent({ type: "toggle", key: "", collapsed: true });
		expect(sectionHeads(toolView(group))).toEqual([]);
		expect(visible(group.render(100))).not.toContain("#3 carol");
	});

	it("opens a single read's posts directly under its tool node, and in the fallback card", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs(ARGS_B, "b");
		group.updateResult(RESULT_B, false, "b");
		expect(toolView(group).p).toMatchObject({ target: LABEL_B, collapsible: false });
		expect(texts(toolView(group))).toEqual([]);

		group.setExpanded(true);
		const open = toolView(group);
		expect(open.p).toMatchObject({ target: LABEL_B, collapsible: true, collapsed: false });
		expect(texts(open)).toEqual([{ text: FULL_TEXT_B, lines: undefined }]);
		expect(visible(group.render(100))).toContain("answer posted");

		const fallback = group.describe(fallbackCx);
		expect(fallback.p).toMatchObject({ role: "omp.tool.swarm_read" });
		const cards = collect(fallback.c, node => node.k === "card");
		expect(cards.map(card => card.p?.role)).toEqual(["omp.tool.swarm_read.preview"]);
		expect(texts(fallback).map(item => item.text)).toEqual([FULL_TEXT_B]);
	});

	it("leaves a pending read as its label when expanded, and opens it once its result lands", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs(ARGS_A, "a");
		group.setExpanded(true);
		expect(visible(group.render(100))).toContain("main · after #0");
		expect(texts(toolView(group))).toEqual([]);

		group.updateResult(RESULT_A, false, "a");
		expect(visible(group.render(100))).toContain("#3 carol");
		expect(texts(toolView(group))).toEqual([{ text: FULL_TEXT_A, lines: undefined }]);
	});

	it("opens a read that joins an expanded group", () => {
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs(ARGS_A, "a");
		group.updateResult(RESULT_A, false, "a");
		group.setExpanded(true);
		group.updateArgs(ARGS_B, "b");
		group.updateResult(RESULT_B, false, "b");
		const text = visible(group.render(100));
		expect(text).toContain("Swarm read (2)");
		expect(text).toContain("#3 carol");
		expect(text).toContain("answer posted");
		expect(texts(toolView(group)).map(item => item.text)).toEqual([FULL_TEXT_A, FULL_TEXT_B]);
	});

	it("opens a refused read's reason in the expanded group", () => {
		const message = "All-channel reads require a coordinator, narrator or monitor";
		const group = new ReadToolGroupComponent({ toolName: "swarm_read" });
		group.updateArgs({ channel: "*" }, "a");
		group.updateResult(
			{
				content: [{ type: "text", text: JSON.stringify({ error: message, boardUri: "" }) }],
				details: { boardUri: "", status: false, error: message },
				isError: true,
			},
			false,
			"a",
		);
		group.setExpanded(true);
		expect(toolView(group).p).toMatchObject({ status: "error", tone: "error" });
		expect(JSON.stringify(toolView(group))).toContain(message);
	});
});
