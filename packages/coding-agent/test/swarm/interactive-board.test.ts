import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { SwarmBoardOverlay } from "@oh-my-pi/pi-tui/overlays/swarm-board";
import type { DescribeContext, NativeChild } from "@oh-my-pi/pi-tui/native/node";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import { extensionLinkScheme, setExtensionLinks } from "@oh-my-pi/pi-tui/render/extension-links";
import { getMarkdownTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { InputController } from "../../src/modes/controllers/input-controller";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { BoardStore } from "../../src/swarm/board-store";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { cfgSwarmBoardTab, cfgSwarmEnabled } from "../../src/swarm/settings";
import { EventBus } from "../../src/utils/event-bus";
import { addWorker, makeMember, SWARM_CAPABILITIES } from "./fixtures";
import * as externalOpener from "../../src/utils/open";

let directory: TempDir;
let auth: AuthStorage;
let session: AgentSession;
let mode: InteractiveMode;
let terminal: VirtualTerminal;
let runtime: SwarmRuntime;
let store: BoardStore;

beforeAll(async () => {
	await initTheme(false);
});
beforeEach(async () => {
	resetSettingsForTest();
	directory = TempDir.createSync("omp-swarm-ui-");
	await Settings.init({ inMemory: true, cwd: directory.path() });
	auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
	const models = new ModelRegistry(auth);
	const model = models.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("The test model must be registered");
	vi.useFakeTimers();
	setMotionEffects(false);
	const sessions = SessionManager.create(directory.path(), directory.path());
	session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["UI test"], tools: [], messages: [] } }),
		sessionManager: sessions,
		settings: Settings.isolated(),
		modelRegistry: models,
	});
	terminal = new VirtualTerminal(80, 24);
	const composer = new Composer({ terminal });
	mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, new EventBus(), composer);
	const artifacts = sessions.getArtifactsDir();
	if (!artifacts) throw new Error("The test session must have an artifacts directory");
	store = BoardStore.create(path.join(artifacts, "swarm"), {
		id: "test-swarm",
		title: "UI proof",
		coordinator: makeMember("coordinator-agent", { role: "coordinator", wakeMode: null }),
		capabilities: { ...SWARM_CAPABILITIES, customPage: true },
	});
	runtime = SwarmRuntime.local();
	runtime.open(store.dir);
	composer.setRuntimeChildren([mode.chatContainer, mode.editor]);
	composer.start({ playWelcomeIntro: false });
	new InputController(mode).setupKeyHandlers();
	mode.syncExtensionLinks();
	mode.ui.setFocus(mode.editor);
	mode.ui.renderNow();
});
afterEach(async () => {
	mode?.stop();
	await session?.dispose();
	SwarmRuntime.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	auth?.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
	setMotionEffects(true);
	setExtensionLinks([]);
	directory?.removeSync();
	resetSettingsForTest();
});

describe("interactive swarm board", () => {
	it("opens with Alt+B, paints native updates, and restores the editor on Escape", async () => {
		terminal.sendInput("\x1bb");
		const overlay = mode.ui.getFocused();
		expect(overlay).toBeInstanceOf(SwarmBoardOverlay);
		await runtime.post(
			{ id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" },
			"Live update from the native board",
		);
		mode.ui.renderNow();
		expect(Bun.stripANSI(terminal.getViewport().join("\n"))).toContain("Live update from the native board");
		expect(BoardStore.open(store.dir, { readOnly: true }).member("coordinator").lastReadSeq).toBe(0);
		terminal.sendInput("\x1b");
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.ui.hasOverlay()).toBe(false);
	});

	it("dispatches /swarm through the real command registry and respects tab preferences", async () => {
		cfgSwarmBoardTab.set(mode.settings, "members");
		expect(await executeBuiltinSlashCommand("/swarm", { ctx: mode })).toBe(true);
		const overlay = mode.ui.getFocused();
		if (!(overlay instanceof SwarmBoardOverlay)) throw new Error("Expected the board overlay");
		expect(overlay.tab).toBe("members");
		mode.showSwarmBoard("swarm://test-swarm?tab=overview");
		expect(mode.ui.getFocused()).toBe(overlay);
		expect(overlay.tab).toBe("overview");
		await mode.prepareSessionSwitch();
		expect(mode.ui.hasOverlay()).toBe(false);
	});

	it("opens the live board from a genuinely painted prose-link cell", () => {
		const link = new Markdown("[Open board](swarm://test-swarm?tab=overview)", 0, 0, getMarkdownTheme());
		mode.chatContainer.addChild(link);
		mode.ui.renderNow();
		expect(mode.composer.viewportLinkCount()).toBe(1);
		let clicked = false;
		for (let row = 0; row < 24 && !clicked; row++) {
			for (let col = 0; col < 80 && !clicked; col++) {
				if (mode.composer.viewportLinkAt(row, col)) clicked = mode.activateViewportLink(row, col);
			}
		}
		expect(clicked).toBe(true);
		const overlay = mode.ui.getFocused();
		if (!(overlay instanceof SwarmBoardOverlay)) throw new Error("Expected the live board");
		expect(overlay.tab).toBe("overview");
	});

	it("gates commands, keybindings and live-link claims with swarm.enabled", async () => {
		mode.showSwarmBoard();
		expect(mode.ui.hasOverlay()).toBe(true);
		expect(extensionLinkScheme("swarm://test-swarm")).toBe("swarm");
		cfgSwarmEnabled.set(mode.settings, false);
		await Promise.resolve();
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(extensionLinkScheme("swarm://test-swarm")).toBeUndefined();
		mode.editor.setText("alpha beta");
		terminal.sendInput("\x1bb");
		terminal.sendInput("|");
		expect(mode.editor.getText()).toBe("alpha |beta");
		expect(mode.ui.hasOverlay()).toBe(false);
		await executeBuiltinSlashCommand("/swarm", { ctx: mode });
		expect(mode.ui.hasOverlay()).toBe(false);
		mode.showSwarmBoard("swarm://test-swarm");
		expect(mode.ui.hasOverlay()).toBe(false);
		cfgSwarmEnabled.set(mode.settings, true);
		await Promise.resolve();
		expect(extensionLinkScheme("swarm://test-swarm")).toBe("swarm");
		terminal.sendInput("\x1bb");
		expect(mode.ui.getFocused()).toBeInstanceOf(SwarmBoardOverlay);
	});
});

describe("interactive custom page", () => {
	it("keeps the page alive after Escape and closes it when swarm is disabled", async () => {
		fs.writeFileSync(path.join(store.dir, "view.html"), "<h2>Native custom page</h2>");
		const opened = vi.spyOn(externalOpener, "openPath").mockImplementation(() => {});
		mode.showSwarmBoard("swarm://test-swarm?tab=overview");
		terminal.sendInput("o");
		const url = opened.mock.calls[0]?.[0];
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/page\/[a-f0-9]{48}\/$/);
		if (!url) throw new Error("Expected the custom page URL");
		expect((await fetch(url)).status).toBe(200);
		terminal.sendInput("\x1b");
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect((await fetch(url)).status).toBe(200);
		mode.showSwarmBoard("swarm://test-swarm?tab=overview");
		terminal.sendInput("o");
		expect(opened.mock.calls[1]?.[0]).toBe(url);
		cfgSwarmEnabled.set(mode.settings, false);
		await Promise.resolve();
		await expect(fetch(url)).rejects.toThrow();
	});

	it("opens artifact source in the bounded native report viewer", () => {
		const file = path.join(path.dirname(store.dir), "example.html");
		const content = "<h1>Artifact source</h1><script>throw new Error('must remain text')</script>";
		fs.writeFileSync(file, content);
		fs.writeFileSync(
			path.join(store.dir, "view.json"),
			JSON.stringify({
				version: 1,
				as_of_seq: 0,
				updated_at: "2026-10-06T04:20:00Z",
				headline: "Artifact ready",
				phase: { label: "Review", index: 1, total: 1 },
				attention: [
					{
						id: "artifact",
						kind: "review",
						severity: "low",
						title: "Review artifact",
						refs: [{ member: "coordinator" }],
						actions: [{ type: "file", target: file, label: "Read artifact" }],
					},
				],
				workstreams: [],
				milestones: [],
				risks: [],
			}),
		);
		const report = vi.spyOn(mode, "showCommandReport");
		const opened = vi.spyOn(externalOpener, "openPath").mockImplementation(() => {});
		mode.showSwarmBoard("swarm://test-swarm?tab=overview");
		const overlay = mode.ui.getFocused();
		if (!(overlay instanceof SwarmBoardOverlay)) throw new Error("Expected the overview");
		overlay.handleNativeEvent({
			type: "action",
			key: "artifact",
			act: `navigate:attention-artifact:${encodeURIComponent(`file:${file}`)}`,
			mods: [],
		});
		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0]?.[0].title).toBe("example.html");
		expect(Bun.stripANSI(report.mock.calls[0]![0].body.render(80).join("\n"))).toContain("Artifact source");
		expect(opened).toHaveBeenCalledTimes(0);
	});
});

describe("interactive custom page navigation", () => {
	const actor = { id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" };
	const cx: DescribeContext = {
		cols: 100,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => true,
	};
	// Four posts and a coordinator cursor at #2: the board puts its Unread divider before #3.
	const ROWS = ["post-1", "post-2", "unread", "post-3", "post-4"];

	/** Open the page from the Overview tab the way the "o" key does; its URL is the one handed to the opener. */
	async function openPage(): Promise<{ overlay: SwarmBoardOverlay; url: string }> {
		for (const text of ["First", "Second", "Third", "Fourth"]) await runtime.post(actor, text);
		await runtime.read(actor, { since: 0, limit: 2 });
		fs.writeFileSync(path.join(store.dir, "view.html"), "<h2>Native custom page</h2>");
		const opened = vi.spyOn(externalOpener, "openPath").mockImplementation(() => {});
		mode.showSwarmBoard("swarm://test-swarm?tab=overview");
		const overlay = mode.ui.getFocused();
		if (!(overlay instanceof SwarmBoardOverlay)) throw new Error("Expected the board overlay");
		terminal.sendInput("o");
		const url = opened.mock.calls[0]?.[0];
		if (!url) throw new Error("Expected the custom page URL");
		return { overlay, url };
	}

	/** Navigate with the headers the page's Open button sends. */
	function fromPage(url: string, target: number): Promise<Response> {
		return fetch(new URL("navigate", url), {
			method: "POST",
			headers: { Origin: new URL(url).origin, "Content-Type": "application/json", "X-OMP-Swarm": "navigate" },
			body: JSON.stringify({ type: "board_post", target }),
		});
	}

	/** The board's row keys in display order, as the overlay's native description lists them. */
	function rowKeys(overlay: SwarmBoardOverlay): string[] {
		const pending: NativeChild[] = [overlay.describe(cx)];
		for (let next = pending.pop(); next; next = pending.pop()) {
			if (!("k" in next)) continue;
			if (next.key === "feed") return (next.c ?? []).flatMap(item => ("k" in item && item.key ? [item.key] : []));
			pending.push(...(next.c ?? []));
		}
		throw new Error("The board list is missing");
	}

	it("selects the quoted post on the open board and keeps the Unread divider before the same post", async () => {
		const { overlay, url } = await openPage();
		expect(overlay.tab).toBe("overview");

		// From Overview the quoted post opens the Board tab on that post.
		expect((await fromPage(url, 1)).status).toBe(204);
		expect(mode.ui.getFocused()).toBe(overlay);
		expect(overlay.tab).toBe("board");
		expect(overlay.selectedKey).toBe("post-1");
		expect(rowKeys(overlay)).toEqual(ROWS);

		// From the Board tab the divider holds its place while the selection moves in both directions.
		overlay.showTab("board", 4);
		expect(overlay.selectedKey).toBe("post-4");
		for (const target of [1, 3, 2]) {
			expect((await fromPage(url, target)).status).toBe(204);
			expect(mode.ui.getFocused()).toBe(overlay);
			expect(overlay.selectedKey).toBe(`post-${target}`);
			expect(rowKeys(overlay)).toEqual(ROWS);
		}

		// A post that arrives while the board is open is quotable, and the divider still precedes #3.
		await runtime.post(actor, "Fifth");
		expect((await fromPage(url, 5)).status).toBe(204);
		expect(overlay.selectedKey).toBe("post-5");
		expect(rowKeys(overlay)).toEqual([...ROWS, "post-5"]);
	});

	it("reopens a board closed with Escape on the quoted post, with the Unread divider before the same post", async () => {
		const { overlay, url } = await openPage();
		overlay.showTab("board");
		terminal.sendInput("\x1b");
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.ui.getFocused()).toBe(mode.editor);

		expect((await fromPage(url, 2)).status).toBe(204);
		const reopened = mode.ui.getFocused();
		if (!(reopened instanceof SwarmBoardOverlay)) throw new Error("Expected the reopened board");
		expect(reopened).not.toBe(overlay);
		expect(reopened.tab).toBe("board");
		expect(reopened.selectedKey).toBe("post-2");
		expect(rowKeys(reopened)).toEqual(ROWS);

		// The page stays usable: the next quote moves the selection on the reopened board.
		expect((await fromPage(url, 4)).status).toBe(204);
		expect(mode.ui.getFocused()).toBe(reopened);
		expect(reopened.selectedKey).toBe("post-4");
		expect(rowKeys(reopened)).toEqual(ROWS);
	});
});

describe("interactive swarm status row", () => {
	const actor = { id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" };
	// The window in which the observer sync coalesces runtime events (SUBAGENT_OBSERVER_UI_COALESCE_MS).
	const COALESCE_MS = 100;

	it("paints one row with the title and the counts after a post and after a roster change, once per burst of events", async () => {
		// The startup path installs the runtime subscription; these tests start from the constructed mode alone.
		mode.syncRunningSubagentBadge();
		const widget = vi.spyOn(mode, "setHookWidget");
		const board = runtime.board("test-swarm");
		addWorker(board, "alice");
		addWorker(board, "bob");
		expect(mode.hookWidgetContainerAbove.render(80)).toEqual([]);

		await runtime.post(actor, "First");
		await runtime.post(actor, "Second");
		vi.advanceTimersByTime(COALESCE_MS - 1);
		expect(widget).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(widget).toHaveBeenCalledTimes(1);
		expect(widget.mock.calls[0]?.[0]).toBe("omp.swarm.status");
		expect(mode.hookWidgetContainerAbove.children).toHaveLength(1);
		expect(mode.hookWidgetContainerAbove.render(80).map(line => Bun.stripANSI(line).trim())).toEqual([
			["Swarm UI proof", "2 stopped", "2 unread"].join(theme.sep.dot),
		]);

		// A roster change: alice parks on the board and reads as waiting.
		const park = new AbortController();
		const parked = runtime.wait(
			{ id: "test-swarm", name: "alice", agentId: "alice-agent" },
			{ since: 2 },
			park.signal,
		);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(widget).toHaveBeenCalledTimes(2);
		expect(mode.hookWidgetContainerAbove.children).toHaveLength(1);
		expect(mode.hookWidgetContainerAbove.render(80).map(line => Bun.stripANSI(line).trim())).toEqual([
			["Swarm UI proof", "1 waiting", "1 stopped", "2 unread"].join(theme.sep.dot),
		]);
		park.abort();
		await parked;
	});

	it("sets the widget again only when the row changes", async () => {
		mode.syncRunningSubagentBadge();
		const widget = vi.spyOn(mode, "setHookWidget");
		await runtime.post(actor, "First");
		vi.advanceTimersByTime(COALESCE_MS);
		expect(widget).toHaveBeenCalledTimes(1);
		const painted = mode.hookWidgetContainerAbove.children[0];
		expect(painted).toBeDefined();

		// A runtime event that leaves the title, the counts and the unread number as they were.
		runtime.notify({ type: "members", swarmId: "test-swarm" });
		vi.advanceTimersByTime(COALESCE_MS);
		expect(widget).toHaveBeenCalledTimes(1);
		expect(mode.hookWidgetContainerAbove.children[0]).toBe(painted);

		await runtime.post(actor, "Second");
		vi.advanceTimersByTime(COALESCE_MS);
		expect(widget).toHaveBeenCalledTimes(2);
		expect(mode.hookWidgetContainerAbove.render(80).map(line => Bun.stripANSI(line).trim())).toEqual([
			["Swarm UI proof", "2 unread"].join(theme.sep.dot),
		]);
	});

	it("removes the row when swarm is disabled, keeps it away while disabled, and paints it again when enabled", async () => {
		mode.syncRunningSubagentBadge();
		const widget = vi.spyOn(mode, "setHookWidget");
		await runtime.post(actor, "First");
		vi.advanceTimersByTime(COALESCE_MS);
		expect(mode.hookWidgetContainerAbove.render(80)).toHaveLength(1);

		cfgSwarmEnabled.set(mode.settings, false);
		await Promise.resolve();
		expect(widget).toHaveBeenLastCalledWith("omp.swarm.status", undefined);
		expect(mode.hookWidgetContainerAbove.children).toHaveLength(0);
		expect(mode.hookWidgetContainerAbove.render(80)).toEqual([]);

		await runtime.post(actor, "Second");
		vi.advanceTimersByTime(COALESCE_MS);
		expect(mode.hookWidgetContainerAbove.render(80)).toEqual([]);

		cfgSwarmEnabled.set(mode.settings, true);
		await Promise.resolve();
		expect(mode.hookWidgetContainerAbove.render(80).map(line => Bun.stripANSI(line).trim())).toEqual([
			["Swarm UI proof", "2 unread"].join(theme.sep.dot),
		]);
	});
});
