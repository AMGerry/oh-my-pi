import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../../tools";
import { ToolAbortError } from "../../tools/tool-errors";
import type { SwarmActor, SwarmApi } from "../api";
import { SwarmRuntime } from "../runtime";
import { SwarmRefusal } from "../types";
import { getSwarmCaller } from "./session";

/** The session's identity on its board, resolved once per tool call. */
export interface BoardBinding {
	runtime: SwarmApi;
	actor: SwarmActor;
}

/** Details every board tool reports, including its refusals. */
export interface BoardToolDetails {
	/** `swarm://` link of the live board; empty until the session has a board. */
	boardUri: string;
	error?: string;
}

/** Bind the calling session to its swarm through the shared runtime. */
export async function bindBoard(session: ToolSession): Promise<BoardBinding> {
	const caller = await getSwarmCaller(session);
	const runtime = SwarmRuntime.global();
	return { runtime, actor: await runtime.ensure(caller) };
}

/** The board link of a bound session; empty when the board is unavailable to this actor. */
async function boardUriOf(binding: BoardBinding | undefined): Promise<string> {
	if (!binding) return "";
	try {
		return (await binding.runtime.status(binding.actor)).boardUri;
	} catch {
		return "";
	}
}

/**
 * Report a failed board call in the swarm tools' conventions: aborts and unexpected errors propagate
 * (the latter as `ToolError`), expected refusals become an `isError` result that carries the board link.
 */
export async function boardFailure<TDetails extends BoardToolDetails>(
	error: unknown,
	binding: BoardBinding | undefined,
	describe: (failure: { error: string; boardUri: string }) => TDetails,
): Promise<AgentToolResult<TDetails>> {
	if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
	if (!(error instanceof SwarmRefusal)) {
		if (error instanceof ToolError) throw error;
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	const boardUri = await boardUriOf(binding);
	return {
		content: [{ type: "text", text: JSON.stringify({ error: error.message, boardUri }) }],
		details: describe({ error: error.message, boardUri }),
		isError: true,
	};
}
