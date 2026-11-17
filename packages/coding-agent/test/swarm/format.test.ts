/**
 * formatSwarmStatus is the coordinator's status row: the swarm title, the member count per state and the
 * coordinator's unread posts, as separate parts so the row can style each one.
 */
import { describe, expect, it } from "bun:test";
import { formatSwarmStatus } from "../../src/swarm/format";
import type { MemberSnapshot, SwarmSnapshot } from "../../src/swarm/types";
import { makeMember, SWARM_CAPABILITIES } from "./fixtures";

type Row = Partial<Omit<MemberSnapshot, "name">> & { name: string };

function snapshot(title: string, rows: Row[]): SwarmSnapshot {
	return {
		id: "status-unit",
		title,
		head: 0,
		dir: "/tmp/status-unit",
		capabilities: SWARM_CAPABILITIES,
		boardUri: "swarm://status-unit",
		members: rows.map(({ name, ...row }) => ({
			...makeMember(`${name}-agent`),
			name,
			state: "stopped",
			unread: 0,
			...row,
		})),
	};
}

const COORDINATOR: Row = { name: "coordinator", role: "coordinator" };

describe("formatSwarmStatus", () => {
	it("leads with the title and counts the members per state in the order working, waiting, stopped, killed", () => {
		const parts = formatSwarmStatus(
			snapshot("Lexer team", [
				{ ...COORDINATOR, unread: 3 },
				{ name: "alice", state: "working" },
				{ name: "bob", state: "working" },
				{ name: "carol", state: "waiting" },
				{ name: "dave", state: "killed" },
				{ name: "erin", state: "stopped" },
				{ name: "frank", state: "stopped" },
			]),
		);
		expect(parts).toEqual(["Swarm Lexer team", "2 working", "1 waiting", "2 stopped", "1 killed", "3 unread"]);
	});

	it("leaves the coordinator out of the counts, whatever state it is in", () => {
		const alone = formatSwarmStatus(snapshot("Solo", [{ ...COORDINATOR, state: "working" }]));
		expect(alone).toEqual(["Swarm Solo"]);

		const staffed = formatSwarmStatus(
			snapshot("Staffed", [
				{ ...COORDINATOR, state: "waiting" },
				{ name: "alice", state: "waiting" },
			]),
		);
		expect(staffed).toEqual(["Swarm Staffed", "1 waiting"]);
	});

	it("counts narrator and monitor members by their own state", () => {
		const parts = formatSwarmStatus(
			snapshot("Observed", [
				COORDINATOR,
				{ name: "narrator", role: "narrator", state: "waiting" },
				{ name: "monitor", role: "monitor", state: "working" },
				{ name: "alice", state: "waiting" },
			]),
		);
		expect(parts).toEqual(["Swarm Observed", "1 working", "2 waiting"]);
	});

	it("omits every zero count and the unread part when the coordinator has none", () => {
		const parts = formatSwarmStatus(
			snapshot("Quiet", [COORDINATOR, { name: "alice", state: "waiting" }, { name: "bob", state: "waiting" }]),
		);
		expect(parts).toEqual(["Swarm Quiet", "2 waiting"]);
		expect(parts.some(part => part.startsWith("0 "))).toBe(false);
	});

	it("reports the coordinator's unread posts alone, not those of the other members", () => {
		const workersUnread = formatSwarmStatus(
			snapshot("Reading", [COORDINATOR, { name: "alice", state: "working", unread: 5 }]),
		);
		expect(workersUnread).toEqual(["Swarm Reading", "1 working"]);

		const coordinatorUnread = formatSwarmStatus(
			snapshot("Reading", [
				{ ...COORDINATOR, unread: 2 },
				{ name: "alice", state: "working", unread: 5 },
			]),
		);
		expect(coordinatorUnread).toEqual(["Swarm Reading", "1 working", "2 unread"]);

		const withoutCoordinator = formatSwarmStatus(
			snapshot("Headless", [{ name: "alice", state: "working", unread: 5 }]),
		);
		expect(withoutCoordinator).toEqual(["Swarm Headless", "1 working"]);
	});

	it("keeps the title on one line, whatever line breaks and table pipes it carries", () => {
		const multiline = formatSwarmStatus(snapshot("First line\n  second line\r\nthird", [COORDINATOR]));
		expect(multiline).toEqual(["Swarm First line second line third"]);

		const piped = formatSwarmStatus(snapshot("Left | right\nrest", [COORDINATOR]));
		expect(piped).toHaveLength(1);
		expect(piped[0]).not.toMatch(/[\r\n]/);
		expect(piped[0]).toMatch(/^Swarm Left .*right rest$/);

		expect(formatSwarmStatus(snapshot("", [COORDINATOR]))).toEqual(["Swarm —"]);
	});

	it("reads the snapshot without changing it", () => {
		const source = snapshot("Stable", [
			{ ...COORDINATOR, unread: 1 },
			{ name: "alice", state: "working" },
		]);
		const before = structuredClone(source);
		formatSwarmStatus(source);
		expect(source).toEqual(before);
	});
});
