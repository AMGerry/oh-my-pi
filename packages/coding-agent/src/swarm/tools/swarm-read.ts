import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import description from "../../prompts/tools/swarm-read.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import { readSchema, type ReadParams, type SwarmControlResult, type SwarmReadResult } from "../api";
import { formatRoster } from "../format";
import type { BoardReadOptions } from "../types";
import { bindBoard, boardFailure, type BoardBinding, type BoardToolDetails } from "./board-tool";

export interface SwarmReadDetails extends BoardToolDetails {
	/** True when the call asked for the roster table; false reads messages. */
	status: boolean;
	/** The messages, cursor and head of a message read. */
	result?: SwarmReadResult;
	/** The complete swarm snapshot behind a roster read. */
	snapshot?: SwarmControlResult;
}

/** Reads the caller's view of the board by cursor, or the roster of members. */
export class SwarmReadTool implements AgentTool<typeof readSchema, SwarmReadDetails> {
	readonly name = "swarm_read";
	readonly label = "Swarm Read";
	readonly summary = "Read swarm board messages by cursor or the member roster";
	readonly description = prompt.render(description);
	readonly parameters = readSchema;
	readonly loadMode = "essential" as const;
	readonly strict = true;
	readonly approval = "read" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: ReadParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SwarmReadDetails>> {
		const status = params.status === true;
		let binding: BoardBinding | undefined;
		try {
			throwIfAborted(signal);
			binding = await bindBoard(this.session);
			const { runtime, actor } = binding;
			if (status) {
				const snapshot = await runtime.status(actor);
				return {
					content: [{ type: "text", text: formatRoster(snapshot, { self: actor.name }) }],
					details: { boardUri: snapshot.boardUri, status, snapshot },
				};
			}
			const options: BoardReadOptions = {
				...(params.since !== undefined && { since: params.since }),
				...(params.limit !== undefined && { limit: params.limit }),
				...(params.channel !== undefined && { channel: params.channel }),
			};
			const result = await runtime.read(actor, options);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { boardUri: result.boardUri, status, result },
			};
		} catch (error) {
			return boardFailure(error, binding, failure => ({ ...failure, status }));
		}
	}
}
