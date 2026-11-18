import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMainThread } from "node:worker_threads";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { artifactsDirsFromRegistry } from "../internal-urls/registry-helpers";
import { sessionDirForCwd } from "../session/session-paths";
import { BoardStore } from "./board-store";
import { formatRoster } from "./format";
import { SwarmRuntime } from "./runtime";
import {
	type BoardPost,
	type MemberSnapshot,
	type MemberState,
	memberNameSchema,
	metadataSchema,
	SwarmRefusal,
	type SwarmSnapshot,
} from "./types";

/** A swarm board with the snapshot a viewer renders: live from the runtime, or read-only from its directory. */
export interface SwarmSurface {
	board: BoardStore;
	snapshot: SwarmSnapshot;
}

export interface SwarmSurfaceOptions {
	/** Coordinator artifacts directory; its `swarm` child is the preferred board. */
	artifactsDir?: string;
	/** Explicit board directories, each holding a `swarm.json`. */
	directories?: readonly string[];
	/** Runtime whose open boards are live; defaults to the main thread's local runtime. */
	runtime?: SwarmRuntime;
}

export type SwarmTab = "board" | "members" | "overview";

export interface SwarmUrlTarget {
	id?: string;
	tab: SwarmTab;
	since: number;
}

/** Posts rendered per snapshot page. */
const FEED_LIMIT = 200;
const SNAPSHOT_FILE = "board.snapshot.md";
const MEMBER_STATES: readonly MemberState[] = ["working", "waiting", "stopped", "killed"];
// `swarm://<id>/<path>?<query>#<fragment>`: the id is the host segment.
const SWARM_URL_RE = /^swarm:\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i;
/** Accepted tabs; `graph` is an alias for the board tab. */
const TABS: Record<string, SwarmTab> = { board: "board", members: "members", overview: "overview", graph: "board" };

/**
 * Parse a `swarm://` link: `swarm://` lists boards, `swarm://<id>?tab=board|members|overview|graph&since=N` opens one.
 * The id must be a swarm id, the query holds only `tab` and `since` (each once), and a path after the id is refused.
 */
export function parseSwarmUrl(href: string): SwarmUrlTarget {
	const match = SWARM_URL_RE.exec(href);
	if (!match) throw new SwarmRefusal(`Not a swarm:// URL: ${href}`);
	const [, rawId, rawPath = "", rawQuery = ""] = match;
	if (rawPath !== "" && rawPath !== "/")
		throw new SwarmRefusal(`swarm:// URLs name a board by id and a query; remove the path "${rawPath}"`);
	if (rawId !== "") assertSwarmId(rawId);
	let tab: SwarmTab = "board";
	let since = 0;
	const seen = new Set<string>();
	for (const [key, value] of new URLSearchParams(rawQuery)) {
		if (key !== "tab" && key !== "since")
			throw new SwarmRefusal(`Unsupported swarm:// query parameter "${key}"; use tab and since`);
		if (seen.has(key)) throw new SwarmRefusal(`The swarm:// query parameter "${key}" appears more than once`);
		seen.add(key);
		if (key === "tab") {
			if (!Object.hasOwn(TABS, value))
				throw new SwarmRefusal(`Unknown swarm tab "${value}"; use ${Object.keys(TABS).join(", ")}`);
			tab = TABS[value];
		} else {
			since = /^\d+$/.test(value) ? Number(value) : Number.NaN;
			if (!Number.isSafeInteger(since))
				throw new SwarmRefusal(`since must be a nonnegative integer sequence number, got "${value}"`);
		}
	}
	return { ...(rawId === "" ? {} : { id: rawId }), tab, since };
}

/** The canonical link for a target; defaults (`tab=board`, `since=0`) are left out. */
export function formatSwarmUrl(target: { id?: string; tab?: SwarmTab; since?: number }): string {
	const query: string[] = [];
	if (target.tab && target.tab !== "board") query.push(`tab=${target.tab}`);
	if (target.since) query.push(`since=${target.since}`);
	return `swarm://${target.id ?? ""}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}

interface Candidate {
	/** Canonical board directory. */
	dir: string;
	/** The runtime's open store when this process owns the board. */
	live?: BoardStore;
}

interface Discovery {
	candidates: Candidate[];
	runtime?: SwarmRuntime;
}

function canonicalDir(dir: string): string | undefined {
	try {
		return fs.realpathSync.native(path.resolve(dir));
	} catch {
		return undefined;
	}
}

function registryArtifactsDirs(): string[] {
	try {
		return artifactsDirsFromRegistry();
	} catch (error) {
		logger.debug("Swarm discovery skipped the agent registry", { error: String(error) });
		return [];
	}
}

/**
 * Existing board directories in priority order: the preferred artifacts directory, explicit directories, boards the
 * runtime holds open, then every artifacts directory the agent registry knows. Canonical paths deduplicate directories.
 */
function discover(options: SwarmSurfaceOptions): Discovery {
	const runtime = options.runtime ?? (isMainThread ? SwarmRuntime.local() : undefined);
	const live = new Map<string, BoardStore>();
	for (const board of runtime?.list() ?? []) {
		const key = canonicalDir(board.dir);
		if (key) live.set(key, board);
	}
	const ordered = [
		...(options.artifactsDir ? [path.join(options.artifactsDir, "swarm")] : []),
		...(options.directories ?? []),
		...live.keys(),
		...registryArtifactsDirs().map(dir => path.join(dir, "swarm")),
	];
	const seen = new Set<string>();
	const candidates: Candidate[] = [];
	for (const dir of ordered) {
		const key = canonicalDir(dir);
		if (!key || seen.has(key) || !fs.existsSync(path.join(key, "swarm.json"))) continue;
		seen.add(key);
		candidates.push({ dir: key, live: live.get(key) });
	}
	return { candidates, runtime };
}

/**
 * Board directories kept in the artifacts of saved sessions: the sessions of the project at `cwd`, or of every
 * project when `cwd` is omitted.
 */
export function savedBoardDirectories(cwd?: string, sessionsRoot: string = getSessionsDir()): string[] {
	let projects: string[];
	if (cwd !== undefined) {
		projects = [sessionDirForCwd(cwd, sessionsRoot)];
	} else {
		try {
			projects = fs.readdirSync(sessionsRoot).map(name => path.join(sessionsRoot, name));
		} catch {
			return [];
		}
	}
	const boards: string[] = [];
	for (const project of projects) {
		let sessions: fs.Dirent[];
		try {
			sessions = fs.readdirSync(project, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (!session.isDirectory()) continue;
			const dir = path.join(project, session.name, "swarm");
			if (fs.existsSync(path.join(dir, "swarm.json"))) boards.push(dir);
		}
	}
	return boards;
}

/** The swarm id recorded in a candidate, read from `swarm.json` alone; undefined when that file is unusable. */
function boardIdOf(candidate: Candidate): string | undefined {
	if (candidate.live) return candidate.live.metadata.id;
	try {
		const metadata: unknown = JSON.parse(fs.readFileSync(path.join(candidate.dir, "swarm.json"), "utf8"));
		return metadataSchema.allows(metadata) ? metadata.id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Persisted boards display stopped or killed members and preserve their stored cursors.
 */
function persistedSnapshot(board: BoardStore): SwarmSnapshot {
	const posts = board.posts();
	return {
		id: board.metadata.id,
		title: board.title,
		head: board.head,
		dir: board.dir,
		capabilities: structuredClone(board.capabilities),
		boardUri: board.boardUri,
		members: board.listMembers().map((member): MemberSnapshot => ({
			...member,
			state: member.killed ? "killed" : "stopped",
			wakeMode: null,
			waitSince: null,
			unread: posts.filter(post => post.seq > member.lastReadSeq && board.visible(post, member.name)).length,
		})),
	};
}

function loadSurface(candidate: Candidate, runtime: SwarmRuntime | undefined): SwarmSurface {
	if (candidate.live && runtime)
		return { board: candidate.live, snapshot: runtime.snapshot(candidate.live.metadata.id) };
	let board: BoardStore;
	try {
		board = BoardStore.open(candidate.dir, { readOnly: true });
	} catch (error) {
		throw new Error(
			`Swarm board ${candidate.dir} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return { board, snapshot: persistedSnapshot(board) };
}

/** Load exactly one existing board directory, using its live runtime state when available. */
export function getSwarmSurfaceAt(dir: string, runtime?: SwarmRuntime): SwarmSurface | undefined {
	const canonical = canonicalDir(dir);
	if (!canonical || !fs.existsSync(path.join(canonical, "swarm.json"))) return undefined;
	const liveRuntime = runtime ?? (isMainThread ? SwarmRuntime.local() : undefined);
	const live = liveRuntime?.list().find(board => canonicalDir(board.dir) === canonical);
	return loadSurface({ dir: canonical, live }, liveRuntime);
}

/** A swarm id is the `id` of `swarm.json`, checked by the schema that defines it. */
function assertSwarmId(id: string): void {
	if (!memberNameSchema.allows(id)) throw new SwarmRefusal(`"${id}" is not a swarm id; list boards with swarm://`);
}

function findIn(discovery: Discovery, id: string): SwarmSurface | undefined {
	for (const candidate of discovery.candidates) {
		if (boardIdOf(candidate) === id) return loadSurface(candidate, discovery.runtime);
	}
	return undefined;
}

/** Every readable board. A board that cannot be read is logged and left out; it never hides the others. */
export function listSwarmSurfaces(options: SwarmSurfaceOptions = {}): SwarmSurface[] {
	const discovery = discover(options);
	const surfaces: SwarmSurface[] = [];
	for (const candidate of discovery.candidates) {
		try {
			surfaces.push(loadSurface(candidate, discovery.runtime));
		} catch (error) {
			logger.warn("Swarm board skipped", { dir: candidate.dir, error: String(error) });
		}
	}
	return surfaces;
}

/** The board with this id, or undefined when no discovered directory holds it. An unreadable match throws its error. */
export function findSwarmSurface(id: string, options: SwarmSurfaceOptions = {}): SwarmSurface | undefined {
	assertSwarmId(id);
	return findIn(discover(options), id);
}

/** The board with this id. Unknown ids refuse with the known ids; an unreadable known board throws its own error. */
export function getSwarmSurface(id: string, options: SwarmSurfaceOptions = {}): SwarmSurface {
	assertSwarmId(id);
	const discovery = discover(options);
	const surface = findIn(discovery, id);
	if (surface) return surface;
	const known = discovery.candidates.flatMap(candidate => boardIdOf(candidate) ?? []);
	const unidentified = discovery.candidates.filter(candidate => boardIdOf(candidate) === undefined);
	throw new SwarmRefusal(
		`Unknown swarm: ${id}. Known swarms: ${known.join(", ") || "none"}${
			unidentified.length > 0 ? `; unreadable board directories: ${unidentified.map(c => c.dir).join(", ")}` : ""
		}. List boards with swarm://`,
	);
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\s*\r?\n\s*/g, " ");
}

function stateSummary(snapshot: SwarmSnapshot): string {
	const parts = MEMBER_STATES.flatMap(state => {
		const count = snapshot.members.filter(member => member.state === state).length;
		return count > 0 ? [`${count} ${state}`] : [];
	});
	return parts.join(", ") || "—";
}

function postHeading(post: BoardPost): string {
	const targets = [...post.mentions.map(mention => `@${mention}`), ...(post.all ? ["@all"] : [])];
	const parts = [`#${post.seq} ${post.agent}`, post.time];
	if (post.channel) parts.push(`#${post.channel}`);
	return `### ${parts.join(" · ")}${targets.length > 0 ? ` → ${targets.join(" ")}` : ""}`;
}

function renderFeed(surface: SwarmSurface, since: number): string[] {
	const { board, snapshot } = surface;
	const id = snapshot.id;
	const after = board.posts().filter(post => post.seq > since);
	const lines = ["## Feed", ""];
	if (after.length === 0) {
		lines.push(since === 0 ? "No posts yet." : `No posts after #${since}; the board head is #${snapshot.head}.`);
		return lines;
	}
	const shown = after.slice(0, FEED_LIMIT);
	const last = shown[shown.length - 1].seq;
	lines.push(`Posts #${shown[0].seq}–#${last} of ${snapshot.head}, in sequence order.`);
	if (last < snapshot.head) {
		lines.push(
			`Next page: ${formatSwarmUrl({ id, since: last })}. Latest posts: ${formatSwarmUrl({ id, since: Math.max(0, snapshot.head - FEED_LIMIT) })}.`,
		);
	}
	for (const post of shown) {
		lines.push("", postHeading(post), ...post.text.split(/\r?\n/).map(line => (line === "" ? ">" : `> ${line}`)));
	}
	return lines;
}

/**
 * Markdown for one board: title, head and capabilities, the roster (role, state, model, wake, read cursor, unread,
 * last post), the channels, and the feed with `#seq` headings. The feed lists up to 200 posts after `since`, oldest
 * first, and links the next page.
 */
export function renderSwarmSnapshot(surface: SwarmSurface, since = 0): string {
	const { board, snapshot } = surface;
	const sections = [
		formatRoster(snapshot),
		board.readOnly
			? "Access: read-only copy of the persisted board; members are not loaded in this process."
			: "Access: live board owned by this process.",
	];
	const channels = [...board.channels()];
	if (channels.length > 0) {
		sections.push(
			[
				"## Channels",
				"",
				...channels.map(([name, channel]) => {
					const parts = [`- #${name}`];
					if (channel.topic) parts.push(cell(channel.topic));
					parts.push(`subscribers: ${channel.subscribers.join(", ") || "—"}`);
					if (channel.archived) parts.push("archived");
					return parts.join(" · ");
				}),
			].join("\n"),
		);
	}
	sections.push(renderFeed(surface, since).join("\n"));
	return `${sections.join("\n\n")}\n`;
}

/** Markdown listing of boards, one row each, linking `swarm://<id>`. */
export function renderSwarmIndex(surfaces: readonly SwarmSurface[]): string {
	if (surfaces.length === 0)
		return "# Swarm boards\n\nA board appears here once a coordinator session creates its team with the `swarm` tool.\n";
	const rows = surfaces.map(({ board, snapshot }) =>
		[
			snapshot.boardUri,
			cell(snapshot.title) || "—",
			`#${snapshot.head}`,
			stateSummary(snapshot),
			board.readOnly ? "read-only" : "live",
			cell(snapshot.dir),
		].join(" | "),
	);
	return [
		"# Swarm boards",
		"",
		"| Swarm | Title | Head | Members | Access | Directory |",
		"| --- | --- | --- | --- | --- | --- |",
		...rows.map(row => `| ${row} |`),
		"",
	].join("\n");
}

/**
 * Regenerate `board.snapshot.md` next to the board's data files and return its path. The file is written to a
 * temporary sibling and renamed into place; identical content leaves the file alone. The board's own records are
 * not touched. Returns undefined when the directory cannot be written.
 */
export function writeSwarmSnapshotFile(surface: SwarmSurface, since = 0): string | undefined {
	const file = path.join(surface.board.dir, SNAPSHOT_FILE);
	const content = renderSwarmSnapshot(surface, since);
	try {
		if (fs.readFileSync(file, "utf8") === content) return file;
	} catch {
		// A missing or unreadable previous snapshot is replaced below.
	}
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, file);
		return file;
	} catch (error) {
		logger.warn("Swarm snapshot file was not written", { file, error: String(error) });
		return undefined;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}
