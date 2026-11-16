import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type {
	AddMemberRequest,
	ChannelRequest,
	PrepareSwarmMember,
	SwarmActor,
	SwarmApi,
	SwarmCaller,
	SwarmControlResult,
} from "../../swarm/api";
import { SwarmRuntime } from "../../swarm/runtime";
import { SwarmRefusal } from "../../swarm/types";
import { registerRpcError, type RemoteObject, type RpcMethod, type RpcServe } from "../rpc";
import type { ThreadService } from "../services";

const SWARM_KIND = "swarm-runtime";
registerRpcError("SwarmRefusal", message => new SwarmRefusal(message));

export type SwarmProtocol = {
	ensure: RpcMethod<[caller: SwarmCaller], SwarmActor>;
	status: RpcMethod<[actor: SwarmActor], SwarmControlResult>;
	add: RpcMethod<
		[caller: SwarmCaller, request: AddMemberRequest, prepare: PrepareSwarmMember, signal?: AbortSignal],
		SwarmControlResult
	>;
	kill: RpcMethod<[actor: SwarmActor, name: string], SwarmControlResult>;
	title: RpcMethod<[actor: SwarmActor, title: string], SwarmControlResult>;
	channel: RpcMethod<[actor: SwarmActor, request: ChannelRequest], SwarmControlResult>;
	switchModel: RpcMethod<
		[actor: SwarmActor, name: string | undefined, model: Model, thinkingLevel?: ConfiguredThinkingLevel],
		SwarmControlResult
	>;
};

const serve: RpcServe<SwarmRuntime, SwarmProtocol> = {
	ensure: (runtime, caller) => runtime.ensure(caller),
	status: (runtime, actor) => runtime.status(actor),
	add: (runtime, caller, request, prepare, signal) => runtime.add(caller, request, prepare, signal),
	kill: (runtime, actor, name) => runtime.kill(actor, name),
	title: (runtime, actor, title) => runtime.title(actor, title),
	channel: (runtime, actor, request) => runtime.channel(actor, request),
	switchModel: (runtime, actor, name, model, thinkingLevel) => runtime.switchModel(actor, name, model, thinkingLevel),
};

export class RemoteSwarmRuntime implements SwarmApi {
	constructor(private readonly remote: RemoteObject<SwarmProtocol>) {}
	ensure(caller: SwarmCaller): Promise<SwarmActor> {
		return this.remote.call("ensure", caller);
	}
	status(actor: SwarmActor): Promise<SwarmControlResult> {
		return this.remote.call("status", actor);
	}
	add(
		caller: SwarmCaller,
		request: AddMemberRequest,
		prepare: PrepareSwarmMember,
		signal?: AbortSignal,
	): Promise<SwarmControlResult> {
		return this.remote.call("add", caller, request, prepare, signal);
	}
	kill(actor: SwarmActor, name: string): Promise<SwarmControlResult> {
		return this.remote.call("kill", actor, name);
	}
	title(actor: SwarmActor, title: string): Promise<SwarmControlResult> {
		return this.remote.call("title", actor, title);
	}
	channel(actor: SwarmActor, request: ChannelRequest): Promise<SwarmControlResult> {
		return this.remote.call("channel", actor, request);
	}
	switchModel(
		actor: SwarmActor,
		name: string | undefined,
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
	): Promise<SwarmControlResult> {
		return this.remote.call("switchModel", actor, name, model, thinkingLevel);
	}
}

export const swarmThreadService: ThreadService = {
	name: "swarm",
	installMain({ link }) {
		link.exportClass<SwarmRuntime, SwarmProtocol>(
			SWARM_KIND,
			(value): value is SwarmRuntime => value instanceof SwarmRuntime,
			serve,
		);
	},
	globals: () => SwarmRuntime.local(),
	installWorker(link) {
		link.importClass<RemoteSwarmRuntime, SwarmProtocol>(SWARM_KIND, remote => new RemoteSwarmRuntime(remote));
	},
	boot(globals) {
		if (!(globals instanceof RemoteSwarmRuntime)) throw new Error("Worker swarm runtime was not bridged from main");
		SwarmRuntime.installGlobal(globals);
	},
};
