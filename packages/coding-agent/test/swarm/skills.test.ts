import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import {
	disableProvider,
	getAllProvidersInfo,
	getProviderInfo,
	initializeWithSettings,
	reset as resetCapabilities,
	setDisabledProviders,
} from "../../src/capability";
import { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { getSessionSlashCommands } from "../../src/extensibility/extensions/get-commands-handler";
import {
	loadSkills,
	loadSkillsFromDir,
	resetActiveSkillsForTests,
	type LoadSkillsOptions,
} from "../../src/extensibility/skills";
import { DefaultResourceLoader } from "../../src/extensibility/legacy-pi-coding-agent-shim";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { SkillProtocolHandler } from "../../src/internal-urls/skill-protocol";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { createExtensionDashboardRuntime } from "../../src/modes/components/extensions/dashboard-runtime";
import { resolveRpcSkillInvocation } from "../../src/modes/rpc/rpc-mode";
import { createAgentSession } from "../../src/sdk";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import adaptation from "../../src/skills/swarm-adaptation.json";
import { cfgSwarmEnabled } from "../../src/swarm/settings";
import { BUNDLED_SWARM_PROVIDER_ID, loadBundledSwarmSkills, SWARM_SKILL_NAMES } from "../../src/swarm/skills";
import { buildSystemPrompt } from "../../src/system-prompt";
import { createTools } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

let directory: TempDir;
let settings: Settings;
let agentDir: string;
let loadOptions: LoadSkillsOptions;
let releaseSettings: (() => void) | undefined;
const skillRoot = path.resolve(import.meta.dirname, "../../src/skills");

beforeEach(async () => {
	directory = TempDir.createSync("@omp-swarm-skills-");
	agentDir = path.join(directory.path(), "agent");
	resetSettingsForTest();
	settings = await Settings.init({ inMemory: true, cwd: directory.path(), agentDir });
	releaseSettings = initializeWithSettings(settings);
	setDisabledProviders(
		getAllProvidersInfo()
			.map(provider => provider.id)
			.filter(id => id !== "native" && id !== BUNDLED_SWARM_PROVIDER_ID),
	);
	resetCapabilities();
	loadOptions = {
		cwd: directory.path(),
		agentDir,
		settings,
		enablePiUser: true,
		enablePiProject: false,
		enableAgentsUser: false,
		enableAgentsProject: false,
		enableCodexUser: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
	};
});
afterEach(() => {
	releaseSettings?.();
	releaseSettings = undefined;
	resetCapabilities();
	resetActiveSkillsForTests();
	vi.restoreAllMocks();
	vi.useRealTimers();
	directory.removeSync();
	resetSettingsForTest();
});

describe("native swarm skills", () => {
	it("reproduces every original byte by reversing the recorded adaptations", async () => {
		expect(adaptation.schemaVersion).toBe(1);
		expect(adaptation.files.map(file => file.path).sort()).toEqual([
			"swarm/SKILL.md",
			"swarm/logo.svg",
			"swarm_monitor/SKILL.md",
			"swarm_narrator/SKILL.md",
			"swarm_pane/SKILL.md",
		]);
		for (const file of adaptation.files) {
			const bytes = await fs.readFile(path.join(skillRoot, file.path));
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.adaptedSha256);
			let original = bytes.toString("utf8");
			for (const operation of [...file.operations].reverse()) {
				const parts = original.split(operation.after);
				expect(parts.length - 1).toBe(operation.count);
				original = parts.join(operation.before);
			}
			expect(createHash("sha256").update(original).digest("hex")).toBe(file.originalSha256);
		}
	});

	it("discovers four bundled skills at priority 10 and reads all embedded assets through skill://", async () => {
		const { skills, warnings } = await loadSkills(loadOptions);
		expect(warnings).toEqual([]);
		expect(skills.map(skill => skill.name)).toEqual([...SWARM_SKILL_NAMES]);
		expect(getProviderInfo(BUNDLED_SWARM_PROVIDER_ID)?.priority).toBe(10);
		const protocol = new SkillProtocolHandler();
		for (const file of adaptation.files) {
			const url = parseInternalUrl(`skill://${file.path}`);
			const resource = await protocol.resolve(url, { skills });
			expect(createHash("sha256").update(resource.content).digest("hex")).toBe(file.adaptedSha256);
		}
		const first = skills.find(skill => skill.name === "swarm")!;
		const bare = await protocol.resolve(parseInternalUrl("skill://swarm"), { skills });
		expect(bare.content).toBe(await Bun.file(first.filePath).text());
		const prompt = await buildSystemPrompt({ cwd: directory.path(), skills, toolNames: ["read"] });
		expect(prompt.systemPrompt.join("\n")).toContain("swarm_monitor");
		expect(skills.every(skill => !skill.hide)).toBe(true);
	});

	it("uses an authored user copy as the single authoritative skill", async () => {
		const target = path.join(agentDir, "skills/swarm/SKILL.md");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, "---\nname: swarm\ndescription: User coordinator\n---\nUser-owned workflow.\n");
		const { skills, warnings } = await loadSkills(loadOptions);
		expect(warnings).toEqual([]);
		expect(skills.map(skill => skill.name)).toEqual([...SWARM_SKILL_NAMES]);
		const chosen = skills.find(skill => skill.name === "swarm")!;
		expect(chosen.filePath).toBe(target);
		expect(chosen.description).toBe("User coordinator");
		const resource = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://swarm"), { skills });
		expect(resource.content).toContain("User-owned workflow.");
	});

	it("lets a later custom-directory skill replace the bundled fallback", async () => {
		const target = path.join(directory.path(), "custom/swarm/SKILL.md");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, "---\nname: swarm\ndescription: Custom coordinator\n---\nCustom workflow.\n");
		const { skills, warnings } = await loadSkills({
			...loadOptions,
			customDirectories: [path.join(directory.path(), "custom")],
		});
		expect(warnings).toEqual([]);
		expect(skills.map(skill => skill.name)).toEqual([...SWARM_SKILL_NAMES]);
		expect(skills.find(skill => skill.name === "swarm")?.filePath).toBe(target);
	});

	it("loads the same user-local resources when the bundled provider is disabled", async () => {
		disableProvider(BUNDLED_SWARM_PROVIDER_ID);
		for (const file of adaptation.files) {
			const target = path.join(agentDir, "skills", file.path);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.copyFile(path.join(skillRoot, file.path), target);
		}
		const discovered = await loadSkills(loadOptions);
		const scanned = await loadSkillsFromDir({ dir: path.join(agentDir, "skills"), source: "native:user" });
		expect(discovered.warnings).toEqual([]);
		expect(scanned.warnings).toEqual([]);
		expect(discovered.skills.map(skill => [skill.name, skill.disableSlashCommand, skill.hide])).toEqual(
			scanned.skills.map(skill => [skill.name, skill.disableSlashCommand, skill.hide]),
		);
		for (const name of SWARM_SKILL_NAMES) {
			const result = await new SkillProtocolHandler().resolve(parseInternalUrl(`skill://${name}`), discovered);
			expect(result.content).toBe(await Bun.file(path.join(skillRoot, name, "SKILL.md")).text());
		}
	});

	it("suppresses helper commands in the native editor, extensions and RPC while retaining URI access", async () => {
		const { skills } = await loadSkills(loadOptions);
		const auth = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(auth);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model must exist");
		await initTheme(false);
		vi.useFakeTimers();
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Skill test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(directory.path(), directory.path()),
			settings,
			modelRegistry,
			skills,
			skillsSettings: { enabled: true, enableSkillCommands: true },
		});
		const composer = new Composer({ terminal: new VirtualTerminal(80, 24) });
		const mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, new EventBus(), composer);
		try {
			await mode.refreshSlashCommandState(directory.path(), []);
			expect([...mode.skillCommands.keys()]).toEqual(["skill:swarm"]);
			expect(
				getSessionSlashCommands(session)
					.filter(command => command.source === "skill")
					.map(command => command.name),
			).toEqual(["skill:swarm"]);
			for (const name of SWARM_SKILL_NAMES.filter(name => name !== "swarm")) {
				expect(resolveRpcSkillInvocation(session, `/skill:${name}`)).toBeNull();
				const resource = await new SkillProtocolHandler().resolve(parseInternalUrl(`skill://${name}`), {
					skills: session.skills,
				});
				expect(resource.content).toContain(`name: ${name}`);
			}
			expect(resolveRpcSkillInvocation(session, "/skill:swarm")?.skill.name).toBe("swarm");
		} finally {
			mode.stop();
			await session.dispose();
			auth.close();
		}
	});

	it("removes bundled, local and custom swarm skills and all five tools when disabled", async () => {
		const target = path.join(agentDir, "skills/swarm/SKILL.md");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(path.join(skillRoot, "swarm/SKILL.md"), target);
		cfgSwarmEnabled.set(settings, false);
		const { skills, warnings } = await loadSkills({
			...loadOptions,
			customDirectories: [path.join(agentDir, "skills")],
		});
		expect(skills).toEqual([]);
		expect(warnings).toEqual([]);
		expect(await Bun.file(path.join(agentDir, "cache/bundled-skills")).exists()).toBe(false);
		const tools = await createTools(
			{
				cwd: directory.path(),
				settings,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			},
			["swarm", "swarm_post", "swarm_read", "swarm_wait", "swarm_schedule"],
		);
		expect(tools.filter(tool => tool.name.startsWith("swarm"))).toEqual([]);
	});

	it("uses the session switch independently of another session's enabled bundle cache", async () => {
		expect((await loadSkills(loadOptions)).skills).toHaveLength(4);
		const disabled = Settings.isolated({ "swarm.enabled": false });
		expect((await loadSkills({ ...loadOptions, settings: disabled })).skills).toEqual([]);
		expect((await loadSkills(loadOptions)).skills).toHaveLength(4);
		cfgSwarmEnabled.set(settings, false);
		const enabled = Settings.isolated({ "swarm.enabled": true });
		expect((await loadSkills({ ...loadOptions, settings: enabled })).skills).toHaveLength(4);
	});

	it("repairs changed cache bytes and preserves stable paths across discoveries", async () => {
		const context = { cwd: directory.path(), home: directory.path(), repoRoot: null, agentDir };
		const first = await loadBundledSwarmSkills(context);
		await Bun.write(first.items[0].path, "changed cache");
		const again = await loadBundledSwarmSkills(context);
		expect(again.items.map(skill => skill.path)).toEqual(first.items.map(skill => skill.path));
		expect(await Bun.file(again.items[0].path).text()).toBe(
			await Bun.file(path.join(skillRoot, "swarm/SKILL.md")).text(),
		);
	});

	it.each([
		{ fixed: false, initiallyEnabled: true },
		{ fixed: true, initiallyEnabled: true },
		{ fixed: true, initiallyEnabled: false },
	])(
		"refreshes the SDK session's skills and tools across feature switches (%j)",
		async ({ fixed, initiallyEnabled }) => {
			const fixedSkills = fixed ? (await loadSkills(loadOptions)).skills : undefined;
			cfgSwarmEnabled.set(settings, initiallyEnabled);
			const auth = createInMemoryAuthStorage();
			const modelRegistry = new ModelRegistry(auth);
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Test model must exist");
			const { session } = await createAgentSession({
				cwd: directory.path(),
				agentDir,
				settings,
				modelRegistry,
				model,
				skills: fixedSkills,
				sessionManager: SessionManager.inMemory(directory.path()),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				workspaceTree: {
					rootPath: directory.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				toolNames: ["read", "swarm", "swarm_post", "swarm_read", "swarm_wait", "swarm_schedule"],
			});
			try {
				expect(session.skills.map(skill => skill.name)).toEqual(initiallyEnabled ? [...SWARM_SKILL_NAMES] : []);
				expect(session.getActiveToolNames().includes("swarm")).toBe(initiallyEnabled);
				for (const enabled of [!initiallyEnabled, initiallyEnabled]) {
					cfgSwarmEnabled.set(settings, enabled);
					await Promise.resolve();
					// Drain the skill refresh followed by the tool reconcile on the registry lock.
					await session.runToolRegistryMutation(async () => {});
					await session.runToolRegistryMutation(async () => {});
					expect(session.skills.map(skill => skill.name)).toEqual(enabled ? [...SWARM_SKILL_NAMES] : []);
					expect(session.getActiveToolNames().includes("swarm")).toBe(enabled);
					expect(session.systemPrompt.join("\n").includes("swarm_monitor")).toBe(enabled);
					expect(session.getActiveToolNames()).toContain("read");
				}
			} finally {
				await session.dispose();
				auth.close();
			}
		},
	);

	it("uses the dashboard session's switch for bundled and authored swarm skills", async () => {
		const target = path.join(agentDir, "skills/swarm/SKILL.md");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, "---\nname: swarm\ndescription: My coordinator\n---\nUser workflow.\n");
		const dashboard = createExtensionDashboardRuntime({ cwd: directory.path(), settings });
		for (const enabled of [true, false, true]) {
			cfgSwarmEnabled.set(settings, enabled);
			const rows = await dashboard.loadExtensions([]);
			const names = new Set(rows.filter(row => row.kind === "skill").map(row => row.name));
			for (const name of SWARM_SKILL_NAMES) expect(names.has(name)).toBe(enabled);
		}
	});

	it("discovers legacy resource-loader skills under its own session settings", async () => {
		for (const enabled of [false, true]) {
			cfgSwarmEnabled.set(settings, !enabled);
			const loader = new DefaultResourceLoader({
				cwd: directory.path(),
				agentDir,
				settingsManager: Settings.isolated({ "swarm.enabled": enabled }),
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			expect(loader.getSkills().skills.map(skill => skill.name)).toEqual(enabled ? [...SWARM_SKILL_NAMES] : []);
		}
	});

	it("rejects a redirected bundle directory before writing through it", async () => {
		const context = { cwd: directory.path(), home: directory.path(), repoRoot: null, agentDir };
		const first = await loadBundledSwarmSkills(context);
		const memberRoot = path.dirname(first.items[0].path);
		const redirected = path.join(directory.path(), "redirected");
		await fs.rename(memberRoot, redirected);
		await fs.symlink(redirected, memberRoot, process.platform === "win32" ? "junction" : "dir");
		await Bun.write(path.join(redirected, "SKILL.md"), "Keep this file");
		await expect(loadBundledSwarmSkills(context)).rejects.toThrow("must be a directory within its bundle");
		expect(await Bun.file(path.join(redirected, "SKILL.md")).text()).toBe("Keep this file");
	});
});
