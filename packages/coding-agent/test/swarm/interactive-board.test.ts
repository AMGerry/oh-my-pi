import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { SwarmBoardOverlay } from "@oh-my-pi/pi-tui/overlays/swarm-board";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import { extensionLinkScheme, setExtensionLinks } from "@oh-my-pi/pi-tui/render/extension-links";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
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
import { makeMember, SWARM_CAPABILITIES } from "./fixtures";

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
		capabilities: SWARM_CAPABILITIES,
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
