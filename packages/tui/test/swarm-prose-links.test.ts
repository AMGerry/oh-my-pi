import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { setTranscriptActionHandler } from "../src/chat/transcript-actions";
import { extensionLinkLabels, setExtensionLinks } from "../src/render/extension-links";
import { splitSwarmProseLinks } from "../src/render/swarm-links";
import type { DescribeContext } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import { initTheme } from "../src/theme";

const CX: DescribeContext = { cols: 80, reduceMotion: true, dark: true, supports: () => true, feature: () => true };
const URL = "swarm://test-swarm?tab=overview&since=2";

function message(source: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: source }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	setTranscriptActionHandler(undefined);
	setExtensionLinks([]);
	setNativeRendering(false);
	vi.restoreAllMocks();
});

describe("board links in assistant prose", () => {
	it.each([
		`[Board](${URL})`,
		`Ready.\n[Board](${URL})\nNext step.`,
		`Ready.\r\n[Board](${URL})\r\nNext step.`,
		`<${URL}>`,
		URL,
		`Open it:\n${URL}.`,
		`[**Board**](${URL})`,
		`[Board][board]\n\n[board]: ${URL}`,
	])("finds the standalone board link in %s", source => {
		const links = splitSwarmProseLinks(source).filter(part => part.kind === "board");
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ href: URL });
	});

	it.each([
		`\`\`\`md\n[Board](${URL})\n\`\`\``,
		`\`[Board](${URL})\``,
		`    [Board](${URL})`,
		`![Board](${URL})`,
		`[Web](https://example.com)`,
	])("keeps non-action content as Markdown: %s", source => {
		expect(splitSwarmProseLinks(source)).toEqual([{ kind: "markdown", text: source }]);
	});

	it("preserves surrounding Markdown and web reference definitions", () => {
		const source = `# Result\n\n[Board](${URL})\n\nSee [the report][report].\n\n[report]: https://example.com/report`;
		const parts = splitSwarmProseLinks(source);
		expect(parts[0]).toMatchObject({ kind: "markdown", text: "# Result\n\n" });
		expect(parts.at(-1)).toMatchObject({ kind: "markdown" });
		expect(parts.at(-1)?.text).toContain("[report]: https://example.com/report");
	});

	it.each([`[Board](${URL})`, URL, `<${URL}>`])(
		"keeps the live URI in ANSI hit targets even when a snapshot file was resolved: %s",
		source => {
			setExtensionLinks(["swarm"]);
			const component = new AssistantMessageComponent(
				message(source),
				false,
				undefined,
				[],
				undefined,
				true,
				new Map([[URL, "file:///tmp/board.snapshot.md"]]),
			);
			const labels = component.render(80).flatMap(line => extensionLinkLabels(line));
			expect(labels.map(label => label.url)).toContain(URL);
			expect(labels.some(label => label.url.startsWith("file:"))).toBe(false);
		},
	);

	it("routes the native prose link through the live board action and keeps its node stable", () => {
		setNativeRendering(true);
		setExtensionLinks(["swarm"]);
		const clicked = vi.fn();
		setTranscriptActionHandler(clicked);
		const component = new AssistantMessageComponent(
			message(`Ready.\n\n[Board](${URL})`),
			false,
			undefined,
			[],
			undefined,
			true,
			new Map([[URL, "file:///tmp/board.snapshot.md"]]),
		);
		const first = component.describe(CX);
		expect(JSON.stringify(first)).toContain(`swarm-board:${URL}`);
		expect(JSON.stringify(first)).not.toContain("file:///tmp/board.snapshot.md");
		expect(component.describe(CX)).toBe(first);
		component.handleNativeEvent({ type: "action", key: "t0.board.1", act: `swarm-board:${URL}` });
		expect(clicked).toHaveBeenCalledWith({ act: "swarm-board", url: URL });
		component.handleNativeEvent({ type: "action", key: "t0.board.1", act: "swarm-board:swarm://unrendered" });
		expect(clicked).toHaveBeenCalledTimes(1);
		setExtensionLinks([]);
		const disabled = component.describe(CX);
		expect(JSON.stringify(disabled)).not.toContain(`swarm-board:${URL}`);
		component.handleNativeEvent({ type: "action", key: "t0.board.1", act: `swarm-board:${URL}` });
		expect(clicked).toHaveBeenCalledTimes(1);
	});
});
