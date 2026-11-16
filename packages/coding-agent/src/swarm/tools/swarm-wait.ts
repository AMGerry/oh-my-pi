import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import description from "../../prompts/tools/swarm-wait.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import { waitSchema, type SwarmWaitResult, type WaitParams } from "../api";
import { bindBoard, boardFailure, type BoardBinding, type BoardToolDetails } from "./board-tool";

export interface SwarmWaitDetails extends BoardToolDetails {
	/** Cursor the call parked behind. */
	since: number;
	/** Whether only posts naming the caller ended the wait. */
	mentionsOnly: boolean;
	/** The visible messages handed back, the advanced cursor and whether an interrupt ended the wait. */
	result?: SwarmWaitResult;
}

/**
 * Parks the caller on its swarm board until a visible post that names it arrives. The runtime holds the
 * waiter and resolves it from board events; an interrupt ends the park and returns the posts already visible.
 */
export class SwarmWaitTool implements AgentTool<typeof waitSchema, SwarmWaitDetails> {
	readonly name = "swarm_wait";
	readonly label = "Swarm Wait";
	readonly summary = "Park on the swarm board until a post addresses you";
	readonly description = prompt.render(description);
	readonly parameters = waitSchema;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly interruptible = true;
	readonly handlesToolInterrupt = true;
	readonly approval = "read" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: WaitParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SwarmWaitDetails>> {
		const since = params.since;
		const mentionsOnly = params.mentionsOnly ?? true;
		let binding: BoardBinding | undefined;
		try {
			// An interrupted call still binds and drains: the runtime resolves an aborted signal with the visible posts.
			binding = await bindBoard(this.session);
			const result = await binding.runtime.wait(binding.actor, { since, mentionsOnly }, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { boardUri: result.boardUri, since, mentionsOnly, result },
			};
		} catch (error) {
			return boardFailure(error, binding, failure => ({ ...failure, since, mentionsOnly }));
		}
	}
}
