/**
 * Harness for the swarm end-to-end scenarios.
 *
 * A real coordinator `AgentSession` runs the native swarm tools under the registered main-agent id, attached to the
 * registry the way the SDK attaches its main session. Every member is a real native session started through `swarm add`,
 * with the real `write` and `read` tools working in a temporary git repository. One scripted model plays all of them:
 * each model call is answered by the policy of the member whose conversation it belongs to, and a policy reasons only
 * from that conversation (its briefing and the tool results it has been shown), as a model would.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { NarratorView } from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { SwarmTool } from "../../src/swarm/tools/swarm";
import { SwarmPostTool } from "../../src/swarm/tools/swarm-post";
import { SwarmReadTool } from "../../src/swarm/tools/swarm-read";
import { SwarmWaitTool } from "../../src/swarm/tools/swarm-wait";
import { type BoardPost, postSchema, sequenceSchema } from "../../src/swarm/types";
import { getBundledAgent } from "../../src/task/agents";
import * as discovery from "../../src/task/discovery";
import { TaskTool } from "../../src/task";
import type { ToolSession } from "../../src/tools";
import { TestSchedulerClock } from "./scheduler-clock";

// ---------------------------------------------------------------------------------------------------------------------
// The scenario: two independent files, a verifier, and (optionally) a narrator.
// ---------------------------------------------------------------------------------------------------------------------

const COORDINATOR = "coordinator";
const MODEL_ID = "swarm-script";

/** A deliverable: the file a worker writes and the line the verifier looks for in it. */
export interface Deliverable {
	path: string;
	content: string;
	needle: string;
}

export const LEXER: Deliverable = {
	path: "lexer.ts",
	content: 'export const KEYWORDS = ["let", "const", "fn"];\n',
	needle: "export const KEYWORDS",
};
export const FORMATTER: Deliverable = {
	path: "format.ts",
	content: 'export const INDENT = "  ";\n',
	needle: "export const INDENT",
};

export const SWARM_TITLE = "Lexer and formatter";
/** A fact only the user's request carries; the briefs hold everything a member needs without it. */
export const REQUEST_ONLY_FACT = "request-only-fact-7731";
export const USER_REQUEST = [
	"Build two independent source files and have a third member verify them.",
	`Background that only this request carries: ${REQUEST_ONLY_FACT}.`,
].join("\n");

function workBrief(file: Deliverable): string {
	return [
		`Write the file \`${file.path}\` in your working directory with exactly this content:`,
		"BEGIN-CONTENT",
		file.content.trimEnd(),
		"END-CONTENT",
		"Touch no other file. When the file exists, publish your completion report and wait for further work.",
	].join("\n");
}

/** The public brief each member receives, keyed by member name. */
export const BRIEFS = {
	"worker-a": workBrief(LEXER),
	"worker-b": workBrief(FORMATTER),
	verifier: [
		"Check the work of worker-a and worker-b. Stay parked until the coordinator names you with the board sequence",
		"numbers (#N) of their completion reports. Then read each referenced post with swarm_read, read the file that",
		"report names, and judge it against this acceptance list:",
		`- ${LEXER.path} must contain: ${LEXER.needle}`,
		`- ${FORMATTER.path} must contain: ${FORMATTER.needle}`,
		"Publish one post that opens with the coordinator mention and the tag [verified] or [rejected],",
		"with one verdict per file.",
	].join("\n"),
	narrator: [
		"Keep the Overview of this swarm current under SWARM_DIR. Cite a board sequence number or a member name for",
		"every item you publish, and keep the Overview as your only output.",
	].join("\n"),
};
export type MemberName = keyof typeof BRIEFS;

// ---------------------------------------------------------------------------------------------------------------------
// What a policy sees: the member's own conversation, read back into plain values.
// ---------------------------------------------------------------------------------------------------------------------

/** What a member does next: call one tool, or answer in text. */
export type Step = { tool: string; args: Record<string, unknown> } | { text: string };

/** A tool call a member made, with the text its result carried. */
export interface ToolCallRecord {
	name: string;
	args: Record<string, unknown>;
	/** Undefined while the call has no result in the conversation. */
	result: string | undefined;
	isError: boolean;
}

/** One model call, from the calling member's point of view. */
export interface TurnView {
	member: string;
	/** The first message that names this member (its briefing and brief); the first user message for the coordinator. */
	briefing: string;
	/** The first user message of the conversation, whoever it names. */
	opening: string;
	/** Every tool call so far, oldest first. */
	calls: readonly ToolCallRecord[];
	/** Every board post the member has been shown by a `swarm_read`, `swarm_wait` or `swarm_post` result, by seq. */
	posts: readonly BoardPost[];
	/** The cursor the member holds: `lastReadSeq` of its latest board result, else the cursor its briefing states. */
	cursor: number | undefined;
	/** The board link from the latest result that carried one. */
	boardUri: string | undefined;
	/** Stop the script with a reason; the harness fails the waiting test with it. */
	fail(reason: string): Step;
}

export type MemberPolicy = (view: TurnView) => Step;

const linkShape = type({ boardUri: "string" });
const messagesShape = type({ messages: postSchema.array(), lastReadSeq: sequenceSchema });
const postedShape = type({ post: postSchema, lastReadSeq: sequenceSchema });

function parseJson(text: string | undefined): unknown {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function collectCalls(messages: readonly Message[]): ToolCallRecord[] {
	const results = new Map<string, ToolResultMessage>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const calls: ToolCallRecord[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const result = results.get(block.id);
			calls.push({
				name: block.name,
				args: block.arguments,
				result: result?.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
				isError: result?.isError === true,
			});
		}
	}
	return calls;
}

function buildTurnView(context: Context, stop: (reason: string) => Step): TurnView {
	const texts = context.messages.flatMap(message =>
		message.role === "user" || message.role === "developer"
			? [
					{
						role: message.role,
						text:
							typeof message.content === "string"
								? message.content
								: message.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
					},
				]
			: [],
	);
	const opening = texts.find(entry => entry.role === "user")?.text ?? "";
	let member = COORDINATOR;
	let briefing = opening;
	for (const { text } of texts) {
		const name = /^Name: ([a-z][a-z0-9-]*)\s*$/m.exec(text)?.[1];
		if (!name) continue;
		member = name;
		briefing = text;
		break;
	}
	const start = /^Initial lastReadSeq: (\d+)\s*$/m.exec(briefing)?.[1];
	let cursor = start === undefined ? undefined : Number(start);
	const calls = collectCalls(context.messages);
	const posts = new Map<number, BoardPost>();
	let boardUri: string | undefined;
	for (const entry of calls) {
		const value = parseJson(entry.result);
		if (linkShape.allows(value)) boardUri = value.boardUri;
		if (messagesShape.allows(value)) {
			for (const post of value.messages) posts.set(post.seq, post);
			cursor = value.lastReadSeq;
		} else if (postedShape.allows(value)) {
			posts.set(value.post.seq, value.post);
			cursor = value.lastReadSeq;
		}
	}
	return {
		member,
		opening,
		briefing,
		calls,
		posts: [...posts.values()].sort((left, right) => left.seq - right.seq),
		cursor,
		boardUri,
		fail: reason => stop(`${member}: ${reason}`),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// The scripted model.
// ---------------------------------------------------------------------------------------------------------------------

/** A tool call the script emitted for a member. */
export interface EmittedCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** What the script saw of one member and answered it. */
export class MemberRecord {
	/** Model calls answered for the member. */
	turns = 0;
	/** The message that named the member, as its first model call saw it. */
	briefing = "";
	/** The first user message of the member's conversation, as its first model call saw it. */
	opening = "";
	/** The member's whole conversation, serialized as its latest model call saw it. */
	context = "";
	/** Every tool call the script made for the member, in order. */
	calls: EmittedCall[] = [];
}

/**
 * One mock model shared by every member of the scenario. It answers a call with the policy registered for the member the
 * conversation belongs to, and records what each member was asked and answered.
 */
export class ScriptedModel {
	readonly model: MockModel;
	/** One record per scripted member, keyed by member name. */
	readonly members: Record<string, MemberRecord>;
	/** Why the script could not continue; empty while every turn found its policy and its inputs. */
	readonly failures: string[] = [];
	/** Rejects with the first failure, so a test that waits on the swarm stops there instead of timing out. */
	readonly failed: Promise<never>;
	/** While true, every call is answered in plain text, so sessions that are being torn down stop asking for tools. */
	closed = false;
	readonly #reject: (error: Error) => void;

	constructor(readonly policies: Record<string, MemberPolicy>) {
		this.members = Object.fromEntries(Object.keys(policies).map(name => [name, new MemberRecord()]));
		const failure = Promise.withResolvers<never>();
		failure.promise.catch(() => {});
		this.failed = failure.promise;
		this.#reject = failure.reject;
		this.model = createMockModel({ id: MODEL_ID, handler: context => this.#respond(context) });
	}

	#stop(reason: string): Step {
		this.failures.push(reason);
		if (this.failures.length === 1) this.#reject(new Error(`Swarm script stopped: ${reason}`));
		return { text: `The script stopped: ${reason}` };
	}

	#respond(context: Context): MockResponse {
		if (this.closed) return { content: ["The harness is closed."] };
		const view = buildTurnView(context, reason => this.#stop(reason));
		const record = this.members[view.member];
		const policy = this.policies[view.member];
		if (record) {
			record.turns += 1;
			if (record.turns === 1) {
				record.briefing = view.briefing;
				record.opening = view.opening;
			}
			record.context = JSON.stringify(context.messages);
		}
		let step: Step;
		try {
			step = policy ? policy(view) : this.#stop(`no policy plays ${view.member}`);
		} catch (error) {
			step = this.#stop(`${view.member}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if ("text" in step) return { content: [step.text] };
		record?.calls.push({ name: step.tool, arguments: step.args });
		return { content: [{ type: "toolCall", name: step.tool, arguments: step.args }] };
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Member policies.
// ---------------------------------------------------------------------------------------------------------------------

/** The file and content a work brief asks for. */
function parseWorkBrief(briefing: string): { path: string; content: string } | undefined {
	const match =
		/Write the file `([^`]+)` in your working directory with exactly this content:\r?\nBEGIN-CONTENT\r?\n([\s\S]*?)\r?\nEND-CONTENT/.exec(
			briefing,
		);
	if (!match?.[1] || match[2] === undefined) return undefined;
	return { path: match[1], content: `${match[2]}\n` };
}

/** The `- <path> must contain: <text>` acceptance lines of a verifier brief. */
function parseAcceptance(briefing: string): Map<string, string> {
	const acceptance = new Map<string, string>();
	for (const match of briefing.matchAll(/^- (\S+) must contain: (.+)$/gm)) {
		if (match[1] && match[2]) acceptance.set(match[1], match[2].trim());
	}
	return acceptance;
}

/**
 * Titles the swarm, adds every member with its public brief, reads the board, hands the two completion reports to the
 * verifier by `#seq` alone, and answers with the board link once the verifier has judged. It owns no file tool.
 */
export function coordinatorPolicy(members: readonly MemberName[]): MemberPolicy {
	return view => {
		const errored = view.calls.find(entry => entry.isError);
		if (errored) return view.fail(`${errored.name} failed: ${errored.result}`);
		if (!view.calls.some(entry => entry.name === "swarm" && entry.args.action === "title"))
			return { tool: "swarm", args: { action: "title", title: SWARM_TITLE } };
		for (const name of members) {
			const added = view.calls.some(
				entry => entry.name === "swarm" && entry.args.action === "add" && entry.args.name === name,
			);
			if (!added) return { tool: "swarm", args: { action: "add", name, brief: BRIEFS[name] } };
		}
		const reportA = view.posts.find(post => post.agent === "worker-a" && post.text.includes("[done]"));
		const reportB = view.posts.find(post => post.agent === "worker-b" && post.text.includes("[done]"));
		const verdict = view.posts.find(post => post.agent === "verifier" && /\[(verified|rejected)\]/.test(post.text));
		if (verdict) {
			if (!reportA || !reportB || !view.boardUri) return view.fail("the verdict arrived without reports or a link");
			const outcome = verdict.text.includes("[verified]") ? "verified" : "rejected";
			return {
				text: [
					`Both pieces are ${outcome} (reports #${reportA.seq} and #${reportB.seq}, verdict #${verdict.seq}).`,
					"",
					view.boardUri,
					"",
				].join("\n"),
			};
		}
		const forwarded = view.calls.some(entry => entry.name === "swarm_post");
		if (reportA && reportB && !forwarded) {
			return {
				tool: "swarm_post",
				args: { text: `@verifier verify the completion reports #${reportA.seq} and #${reportB.seq}` },
			};
		}
		if (!view.calls.some(entry => entry.name === "swarm_read")) return { tool: "swarm_read", args: { since: 0 } };
		return { tool: "swarm_wait", args: { since: view.cursor ?? 0 } };
	};
}

/** Writes the file its brief names, reports `[done]` to the coordinator, then parks behind its cursor. */
export const workerPolicy: MemberPolicy = view => {
	const errored = view.calls.find(entry => entry.isError);
	if (errored) return view.fail(`${errored.name} failed: ${errored.result}`);
	const work = parseWorkBrief(view.briefing);
	if (!work) return view.fail("the brief names no file to write");
	if (!view.calls.some(entry => entry.name === "write"))
		return { tool: "write", args: { path: work.path, content: work.content } };
	if (!view.calls.some(entry => entry.name === "swarm_post"))
		return { tool: "swarm_post", args: { text: `@coordinator [done] wrote ${work.path}` } };
	if (view.cursor === undefined) return view.fail("the briefing carries no cursor");
	return { tool: "swarm_wait", args: { since: view.cursor } };
};

/**
 * Parks until the coordinator names it with report numbers, reads those posts and the files they name itself, judges the
 * files against its brief's acceptance list, reports to the coordinator and parks again.
 */
export const verifierPolicy: MemberPolicy = view => {
	const errored = view.calls.find(entry => entry.isError);
	if (errored) return view.fail(`${errored.name} failed: ${errored.result}`);
	if (view.cursor === undefined) return view.fail("the briefing carries no cursor");
	const referral = view.posts.findLast(
		post => post.agent === COORDINATOR && post.mentions.includes("verifier") && /#\d+/.test(post.text),
	);
	if (!referral) return { tool: "swarm_wait", args: { since: view.cursor } };
	const refs = [...referral.text.matchAll(/#(\d+)/g)].map(match => Number(match[1]));
	if (!view.calls.some(entry => entry.name === "swarm_read"))
		return { tool: "swarm_read", args: { since: Math.min(...refs) - 1, limit: 50 } };
	const paths: string[] = [];
	for (const seq of refs) {
		const report = view.posts.find(post => post.seq === seq);
		const reported = report ? /([\w.-]+\.ts)\b/.exec(report.text)?.[1] : undefined;
		if (!reported) return view.fail(`post #${seq} is not visible or names no file`);
		paths.push(reported);
	}
	for (const filePath of paths) {
		if (!view.calls.some(entry => entry.name === "read" && entry.args.path === filePath))
			return { tool: "read", args: { path: filePath } };
	}
	if (!view.calls.some(entry => entry.name === "swarm_post")) {
		const acceptance = parseAcceptance(view.briefing);
		const verdicts = paths.map((filePath, index) => {
			const content = view.calls.findLast(entry => entry.name === "read" && entry.args.path === filePath)?.result;
			const needle = acceptance.get(filePath);
			const ok = needle !== undefined && content !== undefined && content.includes(needle);
			return { ok, text: `#${refs[index]} ${filePath} ${ok ? "ok" : "fails"}` };
		});
		const tag = verdicts.every(verdict => verdict.ok) ? "verified" : "rejected";
		return {
			tool: "swarm_post",
			args: { text: `@coordinator [${tag}] ${verdicts.map(verdict => verdict.text).join("; ")}` },
		};
	}
	return { tool: "swarm_wait", args: { since: view.cursor } };
};

/** The Overview document for the board as the narrator has read it up to `asOf`. */
function narratorView(view: TurnView, asOf: number): NarratorView {
	const briefs = new Map<string, BoardPost>();
	for (const post of view.posts) {
		if (post.agent !== COORDINATOR) continue;
		const addressee = /^@([a-z][a-z0-9-]*) /.exec(post.text)?.[1];
		if (addressee && addressee !== "narrator" && !briefs.has(addressee)) briefs.set(addressee, post);
	}
	const reports = new Map<string, BoardPost>();
	for (const name of briefs.keys()) {
		const report = view.posts.find(post => post.agent === name && /\[(done|verified|rejected)\]/.test(post.text));
		if (report) reports.set(name, report);
	}
	const workstreams: NarratorView["workstreams"] = [...briefs].map(([name, brief]) => {
		const report = reports.get(name);
		return {
			id: `ws-${name}`,
			title: `Work of ${name}`,
			owners: [name],
			state: report ? ("done" as const) : ("active" as const),
			refs: report ? [{ seq: brief.seq }, { seq: report.seq }] : [{ seq: brief.seq }],
		};
	});
	const reportA = reports.get("worker-a");
	const reportB = reports.get("worker-b");
	return {
		version: 1,
		as_of_seq: asOf,
		updated_at: new Date().toISOString(),
		headline: `Board at #${asOf}`,
		phase: { label: "Execution", index: 1, total: 1 },
		attention: [],
		workstreams,
		milestones:
			reportA && reportB
				? [
						{
							id: "reports-in",
							text: "Both completion reports are on the board",
							refs: [{ seq: reportA.seq }, { seq: reportB.seq }],
						},
					]
				: [],
		risks: [],
	};
}

/**
 * Reads the board, writes `view.json` under SWARM_DIR as of the cursor it holds, and parks for any post. It never posts.
 */
export const narratorPolicy: MemberPolicy = view => {
	const errored = view.calls.find(entry => entry.isError);
	if (errored) return view.fail(`${errored.name} failed: ${errored.result}`);
	const dir = /^SWARM_DIR: (.+?)\s*$/m.exec(view.briefing)?.[1];
	if (!dir) return view.fail("the briefing names no SWARM_DIR");
	const last = view.calls.at(-1);
	if (!last) return { tool: "swarm_read", args: { since: 0 } };
	if (view.cursor === undefined) return view.fail("no board data to describe");
	if (last.name === "write") return { tool: "swarm_wait", args: { since: view.cursor, mentionsOnly: false } };
	return {
		tool: "write",
		args: {
			path: path.join(dir, "view.json"),
			content: `${JSON.stringify(narratorView(view, view.cursor), null, 2)}\n`,
		},
	};
};

// ---------------------------------------------------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [code, output, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${error || output}`);
	return output;
}

async function initRepository(cwd: string, root: string): Promise<void> {
	await git(cwd, "init", "-q", "-b", "main");
	const config: Array<[string, string]> = [
		["user.name", "Swarm e2e"],
		["user.email", "swarm-e2e@example.invalid"],
		["commit.gpgsign", "false"],
		["core.autocrlf", "false"],
		["core.hooksPath", path.join(root, "hooks")],
	];
	for (const [key, value] of config) await git(cwd, "config", key, value);
	await fs.writeFile(path.join(cwd, "README.md"), "Swarm e2e fixture\n");
	await git(cwd, "add", "README.md");
	await git(cwd, "commit", "-q", "-m", "base");
}

/** Tools every worker, the verifier and the narrator start with; the coordinator holds the swarm tools only. */
const MEMBER_TOOLS = ["read", "write", "swarm_post", "swarm_read", "swarm_wait"];

export interface SwarmE2EOptions {
	/** Add a narrator member after the workers and the verifier. */
	narrator?: boolean;
}

export interface SwarmE2E extends AsyncDisposable {
	/** The temporary git repository every member works in. */
	readonly cwd: string;
	readonly script: ScriptedModel;
	readonly runtime: SwarmRuntime;
	/** The scheduler clock of the runtime; nothing in these scenarios arms it. */
	readonly clock: TestSchedulerClock;
	/** The coordinator session, registered as the main agent. */
	readonly coordinator: AgentSession;
	/** The coordinator's own `swarm_post` tool, for posts the scenario makes after the task is done. */
	readonly post: SwarmPostTool;
	/** Hand the user request to the coordinator and wait for its answer; rejects if the script stops first. */
	runRequest(): Promise<void>;
	/** Resolve once `condition` holds, re-checked on every swarm event; reject if the script stops first. */
	until(condition: () => boolean): Promise<void>;
	/** `git status --porcelain` lines of the repository, sorted. */
	status(): Promise<string[]>;
}

let nextFixture = 0;

export async function createSwarmE2E(options: SwarmE2EOptions = {}): Promise<SwarmE2E> {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	SwarmRuntime.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-swarm-e2e-"));
	const cwd = path.join(root, "repo");
	await fs.mkdir(cwd);
	await initRepository(cwd, root);

	const members: MemberName[] = [
		"worker-a",
		"worker-b",
		"verifier",
		...(options.narrator ? (["narrator"] as const) : []),
	];
	const script = new ScriptedModel({
		[COORDINATOR]: coordinatorPolicy(members),
		"worker-a": workerPolicy,
		"worker-b": workerPolicy,
		verifier: verifierPolicy,
		narrator: narratorPolicy,
	});
	const model = script.model;

	const sourceId = `swarm-e2e-${++nextFixture}`;
	registerMockApi(sourceId);
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
	vi.spyOn(modelRegistry, "getAll").mockReturnValue([model]);
	const find = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === model.provider && id === model.id ? model : find(provider, id),
	);
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ ...getBundledAgent("swarm-member")!, tools: MEMBER_TOOLS }],
		projectAgentsDir: null,
	});
	// Each member's run ends with work after its session is released (its output file, its artifact handles);
	// teardown waits for that work through the member's own settle callback before it removes the repository.
	const memberRuns: Promise<void>[] = [];
	const prepareSwarmMember = TaskTool.prototype.prepareSwarmMember;
	vi.spyOn(TaskTool.prototype, "prepareSwarmMember").mockImplementation(async function (this: TaskTool, plan) {
		const prepared = await prepareSwarmMember.call(this, plan);
		return {
			...prepared,
			start(brief, onSettled) {
				const run = Promise.withResolvers<void>();
				memberRuns.push(run.promise);
				return prepared.start(brief, async outcome => {
					try {
						await onSettled(outcome);
					} finally {
						run.resolve();
					}
				});
			},
		};
	});
	const settings = Settings.isolated({
		"task.maxRecursionDepth": 3,
		"task.workerThreads": 0,
		"task.isolation.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"task.prewalk": false,
		"task.agentIdleTtlMs": 0,
		modelRoles: { review: `mock/${MODEL_ID}`, task: `mock/${MODEL_ID}` },
	});
	const journal = SessionManager.create(cwd, path.join(root, "sessions"));
	await journal.ensureOnDisk();
	await journal.flush();

	// The SDK's main-session path: pre-register the id, build the session under it, then attach the session to the ref.
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const mainRef = registry.register({
		id: MAIN_AGENT_ID,
		displayName: "Main",
		kind: "main",
		session: null,
		sessionFile: journal.getSessionFile() ?? null,
		status: "running",
	});
	const coordinator = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["You coordinate a swarm."], tools: [], messages: [] },
			convertToLlm,
			streamFn: model.stream,
		}),
		sessionManager: journal,
		settings,
		modelRegistry,
		agentId: MAIN_AGENT_ID,
		agentKind: "main",
		agentRegistry: registry,
	});
	if (
		!registry.attachSession(MAIN_AGENT_ID, coordinator, journal.getSessionFile() ?? null, mainRef) ||
		!registry.setStatus(MAIN_AGENT_ID, "running", mainRef)
	) {
		throw new Error(`Agent "${MAIN_AGENT_ID}" was replaced during session initialization.`);
	}
	const clock = new TestSchedulerClock();
	const runtime = new SwarmRuntime(registry, lifecycle, undefined, clock);
	SwarmRuntime.installGlobal(runtime);
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		sessionManager: journal,
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: true,
		noContextFiles: true,
		contextFiles: [],
		skills: [],
		rules: [],
		skipPythonPreflight: true,
		getSessionFile: () => journal.getSessionFile() ?? null,
		getArtifactsDir: () => journal.getArtifactsDir(),
		getSessionSpawns: () => "*",
		getAgentId: () => MAIN_AGENT_ID,
		getActiveModel: () => model,
		getActiveModelString: () => `mock/${MODEL_ID}`,
		agentRegistry: registry,
		agentLifecycle: () => lifecycle,
	};
	const post = new SwarmPostTool(toolSession);
	coordinator.agent.setTools([
		new SwarmTool(toolSession),
		post,
		new SwarmReadTool(toolSession),
		new SwarmWaitTool(toolSession),
	]);

	return {
		cwd,
		script,
		runtime,
		clock,
		coordinator,
		post,
		async runRequest() {
			await Promise.race([
				coordinator.prompt(USER_REQUEST, { userInitiated: true, runCommands: false, expandPromptTemplates: false }),
				script.failed,
			]);
		},
		async until(condition) {
			const done = Promise.withResolvers<void>();
			const stop = runtime.onChange(() => {
				if (condition()) done.resolve();
			});
			if (condition()) done.resolve();
			try {
				await Promise.race([done.promise, script.failed]);
			} finally {
				stop();
			}
		},
		async status() {
			const output = await git(cwd, "status", "--porcelain", "--untracked-files=all");
			return output
				.split(/\r?\n/)
				.filter(line => line !== "")
				.sort();
		},
		async [Symbol.asyncDispose]() {
			script.closed = true;
			// Parked waits end first, so every session unwinds on the closed script before it is released.
			runtime.dispose();
			await lifecycle.dispose();
			await Promise.all(memberRuns);
			await coordinator.dispose();
			await journal.close();
			authStorage.close();
			unregisterCustomApis(sourceId);
			vi.restoreAllMocks();
			SwarmRuntime.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
