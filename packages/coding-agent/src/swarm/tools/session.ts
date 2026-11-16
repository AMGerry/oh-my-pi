import type { ToolSession } from "../../tools";
import type { SwarmCaller } from "../api";
import { getSwarmMemberContext } from "../context";
import { cfgSwarmEnabled, cfgSwarmMaxMembers } from "../settings";
import { SwarmRefusal } from "../types";

/** Materialize the native session before binding its shared board and persisted child conversations. */
export async function getSwarmCaller(session: ToolSession): Promise<SwarmCaller> {
	if (!cfgSwarmEnabled.get(session.settings)) throw new SwarmRefusal("Swarm is disabled in settings");
	await session.sessionManager?.ensureOnDisk();
	await session.sessionManager?.flush();
	const agentId = session.getAgentId?.();
	const sessionFile = session.getSessionFile();
	const artifactsDir = session.getArtifactsDir?.();
	const model = session.getActiveModelString?.();
	if (!agentId || !sessionFile || !artifactsDir || !model)
		throw new SwarmRefusal(
			"Swarm requires a registered, persisted session with an active model and artifacts directory",
		);
	return {
		agentId,
		sessionFile,
		artifactsDir,
		model,
		cwd: session.cwd,
		context: getSwarmMemberContext(session.sessionManager?.getEntries() ?? []),
		maxMembers: cfgSwarmMaxMembers.get(session.settings),
	};
}
