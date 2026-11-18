/**
 * `omp swarm` — list persisted swarm boards, print one as Markdown, and run the headless self-test.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { IrcBus } from "../irc/bus";
import { SwarmBoardSource } from "../modes/swarm-board-runtime";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import adaptation from "../skills/swarm-adaptation.json";
import type { SwarmActor } from "../swarm/api";
import { BoardStore } from "../swarm/board-store";
import { SwarmCustomPageServer } from "../swarm/custom-page";
import { parseMentions } from "../swarm/mentions";
import { SwarmRuntime } from "../swarm/runtime";
import { type SchedulerClock, SwarmScheduler } from "../swarm/scheduler";
import { loadBundledSwarmSkills, SWARM_SKILL_NAMES } from "../swarm/skills";
import {
	formatSwarmUrl,
	getSwarmSurface,
	getSwarmSurfaceAt,
	listSwarmSurfaces,
	parseSwarmUrl,
	renderSwarmIndex,
	renderSwarmSnapshot,
	savedBoardDirectories,
	type SwarmSurface,
} from "../swarm/surface";
import { type MemberRole, type SwarmMember, SwarmRefusal } from "../swarm/types";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin-names";
import { defaultLoadModeForToolName } from "../tools/essential-tools";

export type SwarmCliAction = "list" | "board" | "selftest";

export interface SwarmCommandArgs {
	action: SwarmCliAction;
	id?: string;
	flags: { json: boolean; all: boolean; since?: number };
}

export interface SelftestStep {
	name: string;
	ok: boolean;
	detail: string;
}

const SWARM_TOOLS = ["swarm", "swarm_post", "swarm_read", "swarm_wait", "swarm_schedule"];
const STEP_TIMEOUT_MS = 10_000;
const MINUTE_MS = 60_000;

function verify(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function selftestMember(agentId: string, role: MemberRole): SwarmMember {
	return {
		agentId,
		sessionFile: null,
		model: "selftest/model",
		role,
		wakeMode: null,
		waitSince: null,
		lastReadSeq: 0,
		lastPostSeq: 0,
		lastPostTime: null,
		channels: [],
		workspace: "inherit",
		killed: false,
	};
}

/**
 * Exercise the swarm runtime end to end in a temporary directory with private registries: durable board, mention
 * parsing, event-driven waits, channels, the scheduler on a manual clock, the `swarm://` snapshot, the bundled
 * skills against their provenance manifest, the tool registration and the sandboxed custom page.
 */
export async function runSwarmSelftest(): Promise<SelftestStep[]> {
	const steps: SelftestStep[] = [];
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-selftest-"));
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const runtime = new SwarmRuntime(registry, lifecycle, new IrcBus(registry, lifecycle));
	const id = "selftest";
	const step = async (name: string, run: () => Promise<string> | string): Promise<void> => {
		const limit = Promise.withResolvers<never>();
		const timer = setTimeout(() => limit.reject(new Error(`timed out after ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS);
		try {
			steps.push({ name, ok: true, detail: await Promise.race([run(), limit.promise]) });
		} catch (error) {
			steps.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		const board = runtime.create(path.join(root, "swarm"), {
			id,
			title: "Swarm selftest",
			coordinator: selftestMember("Main", "coordinator"),
			capabilities: {
				channels: true,
				workspaces: true,
				narrator: true,
				monitor: true,
				graph: false,
				customPage: true,
			},
		});
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		for (const name of ["alice", "bob", "monitor"]) {
			const agentId = `Selftest-${name}`;
			board.addMember(name, selftestMember(agentId, name === "monitor" ? "monitor" : "worker"));
			registry.register({
				id: agentId,
				displayName: name,
				kind: "sub",
				parentId: "Main",
				session: null,
				status: "running",
			});
		}
		const actor = (name: string): SwarmActor => ({ id, name, agentId: board.member(name).agentId });
		const coordinator = actor("coordinator");

		await step("board store", () => {
			runtime.append(id, "coordinator", "@alice build the lexer");
			runtime.append(id, "coordinator", "@bob build the formatter");
			const durable = BoardStore.open(board.dir, { readOnly: true });
			const seqs = durable.posts().map(post => post.seq);
			verify(seqs.join() === "1,2", `expected seq 1,2 on disk, got ${seqs.join()}`);
			verify(durable.head === 2 && board.head === 2, "the durable head must equal the live head");
			return "2 durable posts with contiguous seq";
		});

		await step("mentions", () => {
			const parsed = parseMentions("@alice @ALL @#ui mail@bob.dev @alice-2, done");
			verify(parsed.all, "@ALL addresses everyone");
			verify(parsed.mentions.join() === "alice,#ui,alice-2", `unexpected mentions: ${parsed.mentions.join()}`);
			return "names, @all, @#channel and word boundaries";
		});

		await step("wait and selective wake", async () => {
			const idle = new AbortController();
			const alice = runtime.wait(actor("alice"), { since: 2 });
			const bob = runtime.wait(actor("bob"), { since: 2 }, idle.signal);
			const parked = runtime.snapshot(id).members.filter(member => member.state === "waiting");
			verify(parked.map(member => member.name).join() === "alice,bob", "both workers park as waiting");
			const posted = await runtime.post(coordinator, "@alice continue with the parser");
			const woken = await alice;
			verify(woken.messages.map(post => post.seq).join() === "3", "alice receives exactly post #3");
			verify(posted.receipts.map(receipt => receipt.name).join() === "alice", "the doorbell rings alice alone");
			verify(
				runtime
					.waiters(id)
					.map(waiter => waiter.name)
					.join() === "bob",
				"bob stays parked",
			);
			verify(board.member("bob").lastReadSeq === 0, "bob's cursor is unchanged");
			idle.abort();
			verify((await bob).interrupted === true, "an interrupt ends bob's park");
			verify(runtime.waiters(id).length === 0, "the waiter registry is empty after the interrupt");
			return "event-driven park, wake by name, cursor isolation, interrupt";
		});

		await step("channels", async () => {
			await runtime.channel(coordinator, { action: "channel", op: "create", channel: "ui", topic: "interface" });
			await runtime.channel(actor("alice"), { action: "channel", op: "subscribe", channel: "ui" });
			const post = runtime.append(id, "coordinator", "ui detail", "ui");
			const subscriber = await runtime.read(actor("alice"), { since: 3 });
			const outsider = await runtime.read(actor("bob"), { since: 3 });
			verify(
				subscriber.messages.some(message => message.seq === post.seq),
				"a subscriber reads the channel post",
			);
			verify(
				outsider.messages.every(message => message.seq !== post.seq),
				"other members read main alone",
			);
			return "channel posts reach subscribers";
		});

		await step("scheduler", async () => {
			let now = Date.UTC(2026, 0, 1, 0, 0, 30);
			let armed = 0;
			const deadlines = new Map<number, { at: number; callback: () => void }>();
			const clock: SchedulerClock = {
				now: () => now,
				arm(callback, delayMs) {
					const key = ++armed;
					deadlines.set(key, { at: now + delayMs, callback });
					return () => deadlines.delete(key);
				},
			};
			const advance = async (): Promise<void> => {
				now += MINUTE_MS;
				// A fired callback arms the next deadline one minute ahead, which this pass leaves in place.
				for (const [key, deadline] of deadlines) {
					if (deadline.at > now || !deadlines.delete(key)) continue;
					deadline.callback();
				}
				await new Promise<void>(resolve => setImmediate(resolve));
			};
			const fired: number[] = [];
			const tick = Promise.withResolvers<void>();
			const scheduler = new SwarmScheduler({
				clock,
				canRun: () => true,
				changed: () => {},
				run: async () => {
					fired.push(fired.length + 1);
					await tick.promise;
				},
			});
			try {
				const monitor = actor("monitor");
				const task = scheduler.create(monitor, { cron: "* * * * *", prompt: "Inspect stalls", daemon: true });
				await advance();
				verify(fired.join() === "1" && scheduler.list(monitor)[0]?.running, "the first minute fires one turn");
				await advance();
				verify(fired.join() === "1", "a tick during a running turn is skipped");
				tick.resolve();
				await new Promise<void>(resolve => setImmediate(resolve));
				await advance();
				verify(fired.join() === "1,2", "the next minute fires after the turn ended");
				scheduler.kill(monitor, task.id);
				verify(scheduler.list(coordinator).length === 0, "kill empties the schedule");
				verify(deadlines.size === 0, "an empty schedule holds no deadline");
			} finally {
				scheduler.dispose();
			}
			return "cron tick, overlap skip, kill, idle clock";
		});

		await step("swarm:// surface", () => {
			const surface = getSwarmSurfaceAt(board.dir, runtime);
			verify(surface, "the board directory resolves to a surface");
			const markdown = renderSwarmSnapshot(surface, 0);
			verify(markdown.includes("#1 coordinator") && markdown.includes("Swarm selftest"), "the snapshot lists posts");
			const target = parseSwarmUrl(formatSwarmUrl({ id, tab: "members", since: 2 }));
			verify(target.id === id && target.tab === "members" && target.since === 2, "swarm:// links round-trip");
			verify(surface.snapshot.boardUri === `swarm://${id}`, "boardUri names the board");
			return surface.snapshot.boardUri;
		});

		await step("bundled skills", async () => {
			const loaded = await loadBundledSwarmSkills({
				cwd: root,
				home: root,
				repoRoot: null,
				agentDir: path.join(root, "agent"),
			});
			const names = loaded.items.map(skill => skill.name);
			verify(names.join() === SWARM_SKILL_NAMES.join(), `unexpected bundled skills: ${names.join()}`);
			const bundle = path.dirname(path.dirname(loaded.items[0].path));
			for (const file of adaptation.files) {
				const digest = createHash("sha256")
					.update(await Bun.file(path.join(bundle, file.path)).bytes())
					.digest("hex");
				verify(digest === file.adaptedSha256, `${file.path} differs from its provenance hash`);
			}
			return `${names.length} skills, ${adaptation.files.length} files match the provenance manifest`;
		});

		await step("tools", () => {
			for (const name of SWARM_TOOLS) {
				verify(
					BUILTIN_TOOL_NAMES.some(builtin => builtin === name),
					`${name} is a builtin tool`,
				);
				verify(defaultLoadModeForToolName(name) === "essential", `${name} loads as an essential tool`);
			}
			return SWARM_TOOLS.join(", ");
		});

		await step("custom page", async () => {
			const page = path.join(board.dir, "view.html");
			fs.writeFileSync(page, '<main><h2>Selftest</h2><button type="button">Open</button></main>');
			const source = new SwarmBoardSource({ id, artifactsDir: root, runtime });
			let server: SwarmCustomPageServer | undefined;
			try {
				verify(source.customPageHtml?.includes("Selftest"), "the narrator page is accepted");
				server = new SwarmCustomPageServer({ source, onNavigate: () => {} });
				const host = await fetch(server.url);
				const hostPolicy = host.headers.get("content-security-policy") ?? "";
				verify(host.status === 200 && hostPolicy.includes("frame-src"), "the host page pins its frame source");
				const framePath = /"frame":"([^"]+)"/.exec(await host.text())?.[1];
				verify(framePath, "the host page names its frame");
				const frame = await fetch(new URL(framePath, server.url), { headers: { "Sec-Fetch-Dest": "iframe" } });
				const policy = frame.headers.get("content-security-policy") ?? "";
				for (const directive of ["sandbox allow-scripts", "connect-src 'none'", "trusted-types 'none'"])
					verify(policy.includes(directive), `the frame policy carries ${directive}`);
				verify((await frame.text()).includes("Selftest"), "the frame serves the narrator page");
				fs.writeFileSync(page, '<a href="https://example.invalid">leave</a>');
				source.refresh();
				verify(source.getState().customPageError?.includes("native-link"), "native links are refused");
				verify(source.customPageHtml?.includes("Selftest"), "the last accepted page stays in place");
			} finally {
				await server?.dispose();
				source.dispose();
			}
			return "loopback host, sandboxed frame policy, last accepted page";
		});
	} catch (error) {
		steps.push({ name: "setup", ok: false, detail: error instanceof Error ? error.message : String(error) });
	} finally {
		runtime.dispose();
		await lifecycle.dispose();
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
	return steps;
}

/** Run one `omp swarm` action; the returned number is the process exit code. */
export async function runSwarmCommand(cmd: SwarmCommandArgs, cwd: string): Promise<number> {
	if (cmd.action === "selftest") {
		const steps = await runSwarmSelftest();
		const failed = steps.filter(item => !item.ok);
		if (cmd.flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, steps })}\n`);
		} else {
			const width = Math.max(...steps.map(item => item.name.length));
			for (const item of steps)
				process.stdout.write(`${item.ok ? "ok  " : "FAIL"}  ${item.name.padEnd(width)}  ${item.detail}\n`);
			process.stdout.write(`swarm selftest: ${steps.length - failed.length}/${steps.length} steps passed\n`);
		}
		return failed.length === 0 ? 0 : 1;
	}
	if (cmd.action === "list") {
		if (cmd.id !== undefined) throw new CliUsageError("usage: omp swarm list [--all] [--json]");
		const surfaces = listSwarmSurfaces({ directories: savedBoardDirectories(cmd.flags.all ? undefined : cwd) });
		process.stdout.write(
			cmd.flags.json ? `${JSON.stringify(surfaces.map(surface => surface.snapshot))}\n` : renderSwarmIndex(surfaces),
		);
		return 0;
	}
	if (cmd.id === undefined) throw new CliUsageError("usage: omp swarm board <id> [--since <seq>] [--json]");
	const since = cmd.flags.since ?? 0;
	if (since < 0) throw new CliUsageError("--since takes a nonnegative sequence number");
	const directories = savedBoardDirectories();
	let surface: SwarmSurface;
	try {
		surface = getSwarmSurface(cmd.id, { directories });
	} catch (error) {
		if (error instanceof SwarmRefusal) throw new CliUsageError(error.message);
		throw error;
	}
	process.stdout.write(
		cmd.flags.json
			? `${JSON.stringify({
					...surface.snapshot,
					posts: surface.board.posts().filter(post => post.seq > since),
				})}\n`
			: renderSwarmSnapshot(surface, since),
	);
	return 0;
}
