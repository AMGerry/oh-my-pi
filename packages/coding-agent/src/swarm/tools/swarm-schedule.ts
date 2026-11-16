import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import description from "../../prompts/tools/swarm-schedule.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import { scheduleSchema, type ScheduleParams, type SwarmScheduleResult } from "../api";
import { bindBoard, boardFailure, type BoardBinding, type BoardToolDetails } from "./board-tool";

export interface SwarmScheduleDetails extends BoardToolDetails {
	action: ScheduleParams["action"];
	result?: SwarmScheduleResult;
}

/** Manages recurring prompts owned by the calling swarm member. */
export class SwarmScheduleTool implements AgentTool<typeof scheduleSchema, SwarmScheduleDetails> {
	readonly name = "swarm_schedule";
	readonly label = "Swarm Schedule";
	readonly summary = "Schedule recurring swarm turns";
	readonly description = prompt.render(description);
	readonly parameters = scheduleSchema;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly approval = "exec" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: ScheduleParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SwarmScheduleDetails>> {
		let binding: BoardBinding | undefined;
		try {
			throwIfAborted(signal);
			binding = await bindBoard(this.session);
			const result = await binding.runtime.schedule(binding.actor, params);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { action: params.action, boardUri: result.boardUri, result },
			};
		} catch (error) {
			return boardFailure(error, binding, failure => ({ ...failure, action: params.action }));
		}
	}
}
