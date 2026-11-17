import type { MemberSnapshot, SwarmCapabilities, SwarmSnapshot } from "./types";

export interface RosterOptions {
	/** Member whose row carries the `(you)` marker. */
	self?: string;
}

const EMPTY = "—";

function cell(value: string | number | null | undefined): string {
	if (value === null || value === undefined || value === "") return EMPTY;
	return String(value)
		.replaceAll("|", "\\|")
		.replace(/\s*\r?\n\s*/g, " ");
}

function enabledCapabilities(capabilities: SwarmCapabilities): string {
	const names = Object.entries(capabilities)
		.filter(([, enabled]) => enabled)
		.map(([name]) => name);
	return names.length > 0 ? names.join(", ") : EMPTY;
}

function wakeCell(member: MemberSnapshot): string {
	if (member.wakeMode === null) return EMPTY;
	const trigger = member.wakeMode === "mentions" ? "mentions" : "any post";
	return member.waitSince === null ? trigger : `${trigger} after #${member.waitSince}`;
}

function lastPostCell(member: MemberSnapshot): string {
	if (member.lastPostSeq === 0 || member.lastPostTime === null) return EMPTY;
	return `#${member.lastPostSeq} ${member.lastPostTime}`;
}

function noteCell(member: MemberSnapshot): string {
	const notes: string[] = [];
	if (member.error) notes.push(`error: ${member.error}`);
	if (member.group) notes.push(`group: ${member.group}`);
	if (member.forkOf) notes.push(`fork of ${member.forkOf}`);
	return notes.join("; ");
}

const COLUMNS = [
	"Member",
	"Role",
	"State",
	"Wake",
	"Read",
	"Unread",
	"Last post",
	"Model",
	"Channels",
	"Workspace",
	"Note",
] as const;

/** Render a swarm snapshot as a header block and a Markdown roster table, one row per member. */
export function formatRoster(snapshot: SwarmSnapshot, options: RosterOptions = {}): string {
	const lines = [`# Swarm ${cell(snapshot.title)} (${snapshot.id})`];
	if (snapshot.boardUri) lines.push(`Board: ${snapshot.boardUri}`);
	lines.push(
		`Head: #${snapshot.head}`,
		`Directory: ${snapshot.dir}`,
		`Capabilities: ${enabledCapabilities(snapshot.capabilities)}`,
		"",
		`| ${COLUMNS.join(" | ")} |`,
		`| ${COLUMNS.map(() => "---").join(" | ")} |`,
	);
	for (const member of snapshot.members) {
		const row = [
			options.self === member.name ? `${member.name} (you)` : member.name,
			member.role,
			member.state,
			wakeCell(member),
			`#${member.lastReadSeq}`,
			member.unread,
			lastPostCell(member),
			member.model,
			member.channels.join(", ") || "main",
			member.workspace,
			noteCell(member),
		];
		lines.push(`| ${row.map(cell).join(" | ")} |`);
	}
	return lines.join("\n");
}

const STATUS_STATES = ["working", "waiting", "stopped", "killed"] as const;

/**
 * Parts of the coordinator's status row: the title, the member count per state and the coordinator's unread
 * posts. Zero counts are left out.
 */
export function formatSwarmStatus(snapshot: SwarmSnapshot): string[] {
	const members = snapshot.members.filter(member => member.role !== "coordinator");
	const parts = [`Swarm ${cell(snapshot.title)}`];
	for (const state of STATUS_STATES) {
		const count = members.filter(member => member.state === state).length;
		if (count > 0) parts.push(`${count} ${state}`);
	}
	const unread = snapshot.members.find(member => member.role === "coordinator")?.unread ?? 0;
	if (unread > 0) parts.push(`${unread} unread`);
	return parts;
}
