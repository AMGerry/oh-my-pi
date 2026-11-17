/**
 * Protocol handler for `swarm://` URLs: the read-only view of shared-board swarms.
 *
 * URL forms:
 * - `swarm://` - index of the boards this session can see
 * - `swarm://<id>[?tab=board|members|overview|graph][&since=N]` - Markdown snapshot of one board
 *
 * Boards the process runtime holds open render live; every other discovered board renders from its directory,
 * read-only. {@link SwarmProtocolHandler.locate} regenerates the board's `board.snapshot.md` and returns its path, so
 * renderers can hyperlink a swarm URL to a file that holds its current content.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import swarmPromptDoc from "../prompts/internal-urls/swarm.md" with { type: "text" };
import { getSwarmMemberContext } from "../swarm/context";
import { cfgSwarmEnabled } from "../swarm/settings";
import {
	findSwarmSurface,
	formatSwarmUrl,
	getSwarmSurface,
	listSwarmSurfaces,
	parseSwarmUrl,
	renderSwarmIndex,
	renderSwarmSnapshot,
	type SwarmSurfaceOptions,
	savedBoardDirectories,
	type SwarmSurface,
	writeSwarmSnapshotFile,
} from "../swarm/surface";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

/** `swarm.enabled` as the global settings hold it; the default applies before settings load. */
function swarmEnabled(): boolean {
	if (!isSettingsInitialized()) return cfgSwarmEnabled.default;
	try {
		return cfgSwarmEnabled.get(settings);
	} catch {
		return cfgSwarmEnabled.default;
	}
}

/**
 * Board discovery inputs for the calling session: its artifacts directory (the coordinator's `swarm` child holds the
 * board), and the board directory a member session is bound to.
 */
function surfaceOptions(context: ResolveContext | undefined): SwarmSurfaceOptions {
	const session = context?.session;
	const artifactsDir =
		session?.getArtifactsDir?.() ??
		(context?.sessionFile?.endsWith(".jsonl") ? context.sessionFile.slice(0, -".jsonl".length) : undefined);
	const directories: string[] = [];
	try {
		const bound = getSwarmMemberContext(session?.sessionManager?.getEntries() ?? []);
		if (bound) directories.push(bound.dir);
	} catch {
		// A session whose journal cannot be read contributes its artifacts directory alone.
	}
	return { ...(artifactsDir ? { artifactsDir } : {}), directories };
}

/** Project whose saved sessions join the board discovery. */
function boardCwd(context: ResolveContext | undefined): string {
	return context?.cwd ?? context?.session?.cwd ?? process.cwd();
}

/**
 * The board with this id: from the session's own discovery, then from the saved sessions of its project, then
 * from the saved sessions of every project.
 */
function findSavedSurface(
	id: string,
	options: SwarmSurfaceOptions,
	context: ResolveContext | undefined,
): SwarmSurface | undefined {
	const directories = options.directories ?? [];
	return (
		findSwarmSurface(id, options) ??
		findSwarmSurface(id, {
			...options,
			directories: [...directories, ...savedBoardDirectories(boardCwd(context))],
		}) ??
		findSwarmSurface(id, { ...options, directories: [...directories, ...savedBoardDirectories()] })
	);
}

function presented(error: unknown): ToolError {
	if (error instanceof ToolError) return error;
	return new ToolError(error instanceof Error ? error.message : String(error));
}

export class SwarmProtocolHandler implements ProtocolHandler {
	readonly scheme = "swarm";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: false,
		readTier: "read",
		linkable: true,
	};

	/** Advertised while `swarm.enabled` is on. */
	promptDoc(): string | undefined {
		return swarmEnabled() ? prompt.render(swarmPromptDoc).trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		try {
			const target = parseSwarmUrl(url.rawHref ?? url.href);
			const options = surfaceOptions(context);
			const content =
				target.id === undefined
					? renderSwarmIndex(
							listSwarmSurfaces({
								...options,
								directories: [...(options.directories ?? []), ...savedBoardDirectories(boardCwd(context))],
							}),
						)
					: renderSwarmSnapshot(
							findSavedSurface(target.id, options, context) ?? getSwarmSurface(target.id, options),
							target.since,
						);
			return {
				url: formatSwarmUrl(target),
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf8"),
			};
		} catch (error) {
			throw presented(error);
		}
	}

	/**
	 * The board's regenerated `board.snapshot.md` for the URL's `since`. The index, an unknown board and an
	 * unwritable board directory have no backing file and locate to null; a malformed URL or an unreadable board throws.
	 */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		try {
			const target = parseSwarmUrl(url.rawHref ?? url.href);
			if (target.id === undefined) return null;
			const surface = findSavedSurface(target.id, surfaceOptions(context), context);
			return surface ? (writeSwarmSnapshotFile(surface, target.since) ?? null) : null;
		} catch (error) {
			throw presented(error);
		}
	}
}
