// Initialize the production worker's service graph before selecting the probe services.
import "../../src/thread/services/index";
import * as path from "node:path";
import { MessagePort, parentPort } from "node:worker_threads";
import type { Model } from "@oh-my-pi/pi-ai";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type {
	AddMemberRequest,
	ScheduleParams,
	SwarmActor,
	SwarmCaller,
	SwarmControlResult,
	SwarmPostResult,
	SwarmReadResult,
	SwarmWaitResult,
	SwarmScheduleResult,
	WaitParams,
} from "../../src/swarm/api";
import type { SwarmMemberOutcome } from "../../src/swarm/context";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { swarmThreadService } from "../../src/thread/services/swarm";

export interface SwarmProbe {
	add(caller: SwarmCaller, request: AddMemberRequest): Promise<SwarmControlResult>;
	finish(name: string, outcome: SwarmMemberOutcome): Promise<void>;
	post(actor: SwarmActor, text: string): Promise<SwarmPostResult>;
	read(actor: SwarmActor): Promise<SwarmReadResult>;
	wait(actor: SwarmActor, options: WaitParams, signal?: AbortSignal): Promise<SwarmWaitResult>;
	schedule(actor: SwarmActor, options: ScheduleParams): Promise<SwarmScheduleResult>;
	switchPeerModel(id: string, model: Model): Promise<string | undefined>;
	writerGuard(): Promise<boolean>;
}
export interface SwarmProbeGlobals {
	ready(probe: SwarmProbe): void;
}

const port = parentPort;
if (!port) throw new Error("Swarm probe must run in a worker");
const finishers = new Map<string, (outcome: SwarmMemberOutcome) => void | Promise<void>>();
const probe: SwarmProbe = {
	post: (actor, text) => SwarmRuntime.global().post(actor, text),
	read: actor => SwarmRuntime.global().read(actor),
	wait: (actor, options, signal) => SwarmRuntime.global().wait(actor, options, signal),
	schedule: (actor, options) => SwarmRuntime.global().schedule(actor, options),
	add: (caller, request) =>
		SwarmRuntime.global().add(caller, request, async plan => {
			const agentId = `Bridge-${plan.name}`;
			return {
				agentId,
				model: plan.model,
				start: async (brief, onSettled) => {
					if (!brief.includes(plan.brief)) throw new Error("Complete brief was lost over RPC");
					finishers.set(plan.name, onSettled);
					AgentRegistry.global().register({
						id: agentId,
						displayName: plan.name,
						kind: "sub",
						parentId: caller.agentId,
						session: null,
						sessionFile: path.join(caller.cwd, `${plan.name}.jsonl`),
						status: "running",
					});
				},
			};
		}),
	finish: async (name, outcome) => {
		const finish = finishers.get(name);
		if (!finish) throw new Error(`Unknown member ${name}`);
		await finish(outcome);
	},
	switchPeerModel: async (id, model) => {
		const session = AgentRegistry.global().get(id)?.session;
		if (!session) throw new Error(`Missing session ${id}`);
		await session.setModelTemporary(model);
		return session.model?.id;
	},
	writerGuard: async () => {
		try {
			new SwarmRuntime();
			return false;
		} catch (error) {
			return error instanceof Error && error.message.includes("main thread");
		}
	},
};
function isProbeGlobals(value: unknown): value is SwarmProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}
const probeService: ThreadService = {
	name: "swarm-probe",
	boot(globals) {
		if (!isProbeGlobals(globals)) throw new Error("Swarm probe globals missing");
		globals.ready(probe);
	},
};
const services = [identityThreadService, agentsThreadService, swarmThreadService, probeService];
function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer
	);
}
function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}
let frameHandler: ((frame: RpcFrame) => void) | undefined;
port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		setCurrentThreadId(message.threadId);
		const link: WorkerThreadLink = new RpcLink(
			{
				send: frame => port.postMessage(frame),
				listen: handler => {
					frameHandler = handler;
					return () => {
						frameHandler = undefined;
					};
				},
			},
			{
				name: `${message.threadId}↔swarm-main`,
				sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
			},
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = { type: "subagent-worker-ready" };
		port.postMessage(ready);
		return;
	}
	if (isFrame(message)) frameHandler(message);
});
