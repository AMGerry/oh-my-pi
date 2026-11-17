import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatModelStringWithRouting, resolveModelOverride } from "../../config/model-resolver";
import description from "../../prompts/tools/swarm.md" with { type: "text" };
import { AgentRegistry } from "../../registry/agent-registry";
import { TaskTool } from "../../task";
import { getBundledAgent } from "../../task/agents";
import { SWARM_MEMBER_AGENT } from "../context";
import {
	assertPerCallModelApproved,
	parentModelGrantPattern,
	PerCallModelError,
	type PerCallModelGrants,
} from "../../task/model-approval";
import { invalidModelSelectorReason, StructuredSubagentError } from "../../task/structured-subagent";
import type { ToolSession } from "../../tools";
import { ToolAbortError, throwIfAborted } from "../../tools/tool-errors";
import { controlSchema, type ControlParams, type SwarmControlResult } from "../api";
import { SwarmRuntime } from "../runtime";
import { SwarmRefusal } from "../types";
import { getSwarmCaller } from "./session";

export interface SwarmToolDetails {
	action: ControlParams["action"];
	result?: SwarmControlResult & { models?: Array<{ model: string; name: string }> };
	error?: string;
}

export class SwarmTool implements AgentTool<typeof controlSchema, SwarmToolDetails> {
	readonly name = "swarm";
	readonly label = "Swarm";
	readonly summary = "Manage a persistent shared-board team";
	readonly description = prompt.render(description);
	readonly parameters = controlSchema;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly approval = "exec" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: ControlParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SwarmToolDetails>> {
		let boardUri = "";
		try {
			throwIfAborted(signal);
			const caller = await getSwarmCaller(this.session);
			const runtime = SwarmRuntime.global();
			const actor = await runtime.ensure(caller);
			const initial = await runtime.status(actor);
			boardUri = initial.boardUri;
			let result: SwarmToolDetails["result"];
			switch (params.action) {
				case "status":
					result = initial;
					break;
				case "add": {
					const task = await TaskTool.create(this.session);
					result = await runtime.add(caller, params, plan => task.prepareSwarmMember(plan), signal);
					break;
				}
				case "kill":
					result = await runtime.kill(actor, params.name);
					break;
				case "title":
					result = await runtime.title(actor, params.title);
					break;
				case "channel":
					result = await runtime.channel(actor, params);
					break;
				case "models":
				case "model": {
					const registry = this.session.modelRegistry;
					if (!registry) throw new SwarmRefusal("The session's model registry is unavailable");
					const coordinator = initial.members.find(member => member.role === "coordinator")!;
					const parent = (this.session.agentRegistry ?? AgentRegistry.global()).get(coordinator.agentId)?.session
						?.model;
					const agent = getBundledAgent(SWARM_MEMBER_AGENT)!;
					const grants: PerCallModelGrants = {
						settings: this.session.settings,
						agentName: agent.name,
						agentSource: agent.source,
						agentModel: agent.model,
						parentModelPattern: parent ? parentModelGrantPattern(parent) : coordinator.model,
					};
					if (params.action === "models") {
						const models: Array<{ model: string; name: string }> = [];
						for (const model of registry.getAvailable("chat")) {
							try {
								assertPerCallModelApproved(model, grants, registry);
							} catch (error) {
								if (error instanceof PerCallModelError) continue;
								throw error;
							}
							models.push({ model: formatModelStringWithRouting(model), name: model.name });
						}
						result = { ...initial, models };
					} else {
						const problem = invalidModelSelectorReason(params.model, "swarm model", {
							settings: this.session.settings,
							invocationKind: "swarm",
						});
						if (problem) throw new SwarmRefusal(problem);
						const selection = resolveModelOverride([params.model], registry, this.session.settings, {
							exactOnly: true,
						});
						if (!selection.model) throw new SwarmRefusal(`Requested model ${params.model} is unavailable`);
						assertPerCallModelApproved(selection.model, grants, registry);
						result = await runtime.switchModel(actor, params.name, selection.model, selection.thinkingLevel);
					}
					break;
				}
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { action: params.action, result },
			};
		} catch (error) {
			if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
			if (
				error instanceof SwarmRefusal ||
				error instanceof PerCallModelError ||
				(error instanceof StructuredSubagentError && error.kind === "preflight")
			) {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: error.message, boardUri }) }],
					details: { action: params.action, error: error.message },
					isError: true,
				};
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	}
}
