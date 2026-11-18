import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import description from "../../prompts/tools/swarm-post.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import { postSchema, type PostParams, type SwarmPostResult } from "../api";
import { bindBoard, boardFailure, type BoardBinding, type BoardToolDetails } from "./board-tool";

export interface SwarmPostDetails extends BoardToolDetails {
	/** The committed post, its delivery receipts and the caller's cursor; absent on refusal. */
	result?: SwarmPostResult;
}

/** Appends one post to the caller's swarm board and rings the members it addresses. */
export class SwarmPostTool implements AgentTool<typeof postSchema, SwarmPostDetails> {
	readonly name = "swarm_post";
	readonly label = "Swarm Post";
	readonly summary = "Post a message to the swarm board";
	readonly description = prompt.render(description);
	readonly parameters = postSchema;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly approval = "exec" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: PostParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SwarmPostDetails>> {
		let binding: BoardBinding | undefined;
		try {
			throwIfAborted(signal);
			binding = await bindBoard(this.session);
			const result = await binding.runtime.post(binding.actor, params.text, params.channel);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { boardUri: result.boardUri, result },
			};
		} catch (error) {
			return boardFailure(error, binding, failure => failure);
		}
	}
}
