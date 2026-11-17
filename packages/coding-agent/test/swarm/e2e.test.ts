/**
 * Swarm end to end: a real coordinator session, registered as the main agent,
 * starts real native members that work in a temporary git repository, driven by one scripted model. See `e2e-fixture.ts`
 * for the harness.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SwarmViewStore } from "../../src/swarm/view-store";
import { BRIEFS, createSwarmE2E, FORMATTER, LEXER, REQUEST_ONLY_FACT, SWARM_TITLE } from "./e2e-fixture";

const E2E_TIMEOUT_MS = 30_000;
const PARKED = ["verifier", "worker-a", "worker-b"] as const;

describe("swarm end to end: a scripted two-worker task", () => {
	it(
		"runs briefs, work, [done] reports, a #seq hand-off and a verdict, and ends with the board link",
		async () => {
			await using f = await createSwarmE2E();
			await f.runRequest();
			await f.until(() => PARKED.every(name => f.runtime.waiters().some(waiter => waiter.name === name)));
			const board = f.runtime.list()[0]!;
			const posts = board.posts();
			expect(f.script.failures).toEqual([]);

			// Step 1: the coordinator titles the swarm and adds three members, each with its brief on the board.
			expect(board.title).toBe(SWARM_TITLE);
			expect(board.listMembers().map(member => [member.name, member.role])).toEqual([
				["coordinator", "coordinator"],
				["worker-a", "worker"],
				["worker-b", "worker"],
				["verifier", "worker"],
			]);
			for (const name of PARKED) {
				expect(
					posts.find(post => post.text === `@${name} ${BRIEFS[name]}`),
					`${name}'s public brief`,
				).toMatchObject({
					agent: "coordinator",
					mentions: [name],
					all: false,
				});
				// Step 4: the member's first message carries that whole brief, and the request's own fact never reached it.
				const member = f.script.members[name];
				expect(member.opening, name).toContain(BRIEFS[name]);
				expect(member.opening, name).toBe(member.briefing);
				expect(member.context, name).not.toContain(REQUEST_ONLY_FACT);
			}

			// Step 1: the coordinator only ran swarm tools, so every product file came from a worker.
			const coordinatorCalls = f.script.members.coordinator.calls.map(call => call.name);
			for (const name of coordinatorCalls)
				expect(["swarm", "swarm_post", "swarm_read", "swarm_wait"]).toContain(name);
			expect(coordinatorCalls.filter(name => name === "swarm")).toHaveLength(4);
			const writes = Object.fromEntries(
				["coordinator", ...PARKED].map(name => [
					name,
					f.script.members[name].calls.filter(call => call.name === "write").map(call => call.arguments.path),
				]),
			);
			expect(writes).toEqual({ coordinator: [], "worker-a": ["lexer.ts"], "worker-b": ["format.ts"], verifier: [] });
			expect(await f.status()).toEqual(["?? format.ts", "?? lexer.ts"]);
			expect((await fs.readFile(path.join(f.cwd, LEXER.path), "utf8")).replaceAll("\r\n", "\n")).toBe(LEXER.content);
			expect((await fs.readFile(path.join(f.cwd, FORMATTER.path), "utf8")).replaceAll("\r\n", "\n")).toBe(
				FORMATTER.content,
			);

			// Step 5: each worker reports `[done]` to the coordinator once.
			const reportsA = posts.filter(post => post.agent === "worker-a");
			const reportsB = posts.filter(post => post.agent === "worker-b");
			expect(reportsA.map(post => post.text)).toEqual(["@coordinator [done] wrote lexer.ts"]);
			expect(reportsB.map(post => post.text)).toEqual(["@coordinator [done] wrote format.ts"]);
			expect(reportsA[0]?.mentions).toEqual(["coordinator"]);
			expect(reportsB[0]?.mentions).toEqual(["coordinator"]);
			const seqA = reportsA[0]!.seq;
			const seqB = reportsB[0]!.seq;

			// Step 5: the coordinator hands the verifier the two #seq numbers and no report body.
			const handoffs = posts.filter(
				post => post.agent === "coordinator" && post.text.startsWith("@verifier verify"),
			);
			expect(handoffs.map(post => post.text)).toEqual([
				`@verifier verify the completion reports #${seqA} and #${seqB}`,
			]);
			expect(handoffs[0]!.seq).toBeGreaterThan(Math.max(seqA, seqB));
			for (const post of posts.filter(candidate => candidate.agent === "coordinator")) {
				for (const body of ["[done]", "wrote lexer.ts", "wrote format.ts"]) {
					expect(post.text, `#${post.seq}`).not.toContain(body);
				}
			}

			// Step 5: the verifier reads both posts and both files itself, judges them, and reports once.
			const verifierCalls = f.script.members.verifier.calls;
			expect(verifierCalls.find(call => call.name === "swarm_read")?.arguments).toMatchObject({
				since: Math.min(seqA, seqB) - 1,
			});
			expect(
				verifierCalls
					.filter(call => call.name === "read")
					.map(call => call.arguments.path)
					.sort(),
			).toEqual(["format.ts", "lexer.ts"]);
			const verdicts = posts.filter(post => post.agent === "verifier");
			expect(verdicts.map(post => post.text)).toEqual([
				`@coordinator [verified] #${seqA} lexer.ts ok; #${seqB} format.ts ok`,
			]);
			expect(verdicts[0]).toMatchObject({ mentions: ["coordinator"] });
			expect(verdicts[0]!.seq).toBeGreaterThan(handoffs[0]!.seq);

			// Step 6: the final answer carries the real board link on its own line.
			expect(board.boardUri).toMatch(/^swarm:\/\/swarm-[0-9a-f]{32}$/);
			const answer =
				f.coordinator
					.getLastAssistantMessage()
					?.content.flatMap(part => (part.type === "text" ? [part.text] : []))
					.join("\n") ?? "";
			expect(
				answer
					.split(/\r?\n/)
					.map(line => line.trim())
					.filter(line => line.includes("swarm://")),
			).toEqual([board.boardUri]);
			expect(answer).toContain(`verdict #${verdicts[0]!.seq}`);

			// Step 2: every member is parked behind its own cursor with no timer armed, and no turn ran beyond the script.
			const waiters = f.runtime
				.waiters(board.metadata.id)
				.sort((left, right) => left.name.localeCompare(right.name));
			expect(waiters.map(waiter => [waiter.name, waiter.mentionsOnly])).toEqual([
				["verifier", true],
				["worker-a", true],
				["worker-b", true],
			]);
			for (const waiter of waiters) {
				expect(board.member(waiter.name), waiter.name).toMatchObject({
					wakeMode: "mentions",
					waitSince: waiter.since,
					lastReadSeq: waiter.since,
				});
			}
			expect(
				f.runtime
					.snapshot(board.metadata.id)
					.members.filter(member => member.role !== "coordinator")
					.map(member => member.state),
			).toEqual(["waiting", "waiting", "waiting"]);
			expect(f.clock.pending.size).toBe(0);
			// Parked members hold no work against the coordinator: its run ends and nothing can resume it.
			await Promise.race([f.coordinator.waitForRunEnd(), f.script.failed]);
			expect(f.coordinator.isRunActive).toBe(false);
			expect(f.coordinator.wakeSources).toBeUndefined();
			for (const name of PARKED)
				expect(f.script.members[name].turns, name).toBe(f.script.members[name].calls.length);
			expect(
				Object.fromEntries(PARKED.map(name => [name, f.script.members[name].calls.map(call => call.name)])),
			).toEqual({
				"worker-a": ["write", "swarm_post", "swarm_wait"],
				"worker-b": ["write", "swarm_post", "swarm_wait"],
				verifier: ["swarm_wait", "swarm_read", "read", "read", "swarm_post", "swarm_wait"],
			});
			expect(f.script.failures).toEqual([]);
		},
		E2E_TIMEOUT_MS,
	);

	it(
		"wakes nobody for a post that names nobody and only the addressed member for a post that names one",
		async () => {
			await using f = await createSwarmE2E();
			await f.runRequest();
			await f.until(() => PARKED.every(name => f.runtime.waiters().some(waiter => waiter.name === name)));
			const board = f.runtime.list()[0]!;
			const id = board.metadata.id;
			const turnsBefore = Object.fromEntries(PARKED.map(name => [name, f.script.members[name].turns]));
			const cursorsBefore = Object.fromEntries(PARKED.map(name => [name, board.member(name).lastReadSeq]));
			const waitersBefore = f.runtime.waiters(id).sort((left, right) => left.name.localeCompare(right.name));
			expect(waitersBefore).toHaveLength(3);

			// A post that names nobody rings nobody: no receipt, no settled waiter, no model call.
			const quiet = await f.post.execute("quiet", { text: "An observation that names nobody" });
			expect(quiet.details?.result?.receipts).toEqual([]);
			expect(f.runtime.waiters(id).sort((left, right) => left.name.localeCompare(right.name))).toEqual(
				waitersBefore,
			);
			expect(Object.fromEntries(PARKED.map(name => [name, f.script.members[name].turns]))).toEqual(turnsBefore);

			// A post naming worker-a wakes worker-a alone, behind its own cursor.
			const wake = await f.post.execute("wake", { text: "@worker-a add one more keyword to the lexer" });
			const woken = wake.details!.result!;
			expect(woken.receipts).toMatchObject([{ name: "worker-a", outcome: "woken" }]);
			await f.until(() =>
				f.runtime.waiters(id).some(waiter => waiter.name === "worker-a" && waiter.since === woken.post.seq),
			);
			expect(f.script.members["worker-a"].turns).toBe(turnsBefore["worker-a"]! + 1);
			expect(f.script.members["worker-b"].turns).toBe(turnsBefore["worker-b"]);
			expect(f.script.members.verifier.turns).toBe(turnsBefore.verifier);
			expect(board.member("worker-a").lastReadSeq).toBe(woken.post.seq);
			expect(board.member("worker-b").lastReadSeq).toBe(cursorsBefore["worker-b"]);
			expect(board.member("verifier").lastReadSeq).toBe(cursorsBefore.verifier);
			const waitersAfter = f.runtime.waiters(id).sort((left, right) => left.name.localeCompare(right.name));
			expect(waitersAfter.filter(waiter => waiter.name !== "worker-a")).toEqual(
				waitersBefore.filter(waiter => waiter.name !== "worker-a"),
			);

			// The woken conversation continues with its own brief and now holds both new posts; the others do not.
			const awake = f.script.members["worker-a"].context;
			expect(awake).toContain(JSON.stringify(BRIEFS["worker-a"]).slice(1, -1));
			expect(awake).toContain("An observation that names nobody");
			expect(awake).toContain("add one more keyword to the lexer");
			expect(f.script.members["worker-b"].context).not.toContain("add one more keyword to the lexer");
			expect(f.script.members.verifier.context).not.toContain("add one more keyword to the lexer");
			expect(f.clock.pending.size).toBe(0);
			await Promise.race([f.coordinator.waitForRunEnd(), f.script.failed]);
			expect(f.coordinator.isRunActive).toBe(false);
			expect(f.coordinator.wakeSources).toBeUndefined();
			expect(f.script.failures).toEqual([]);
		},
		E2E_TIMEOUT_MS,
	);

	it(
		"keeps a narrator's view.json current and cited without a post, and keeps the last good parse across a broken write",
		async () => {
			await using f = await createSwarmE2E({ narrator: true });
			await f.runRequest();
			await f.until(() =>
				[...PARKED, "narrator"].every(name => f.runtime.waiters().some(waiter => waiter.name === name)),
			);
			const board = f.runtime.list()[0]!;
			const id = board.metadata.id;
			const store = new SwarmViewStore(board.dir);
			await f.until(() => store.read().view?.as_of_seq === board.head);

			// The Overview is valid, as of the head, and every item cites a post that exists or a member of the roster.
			const first = store.read();
			expect(first.error).toBeUndefined();
			const view = first.view!;
			expect(view.as_of_seq).toBe(board.head);
			expect(view.workstreams.map(item => [item.id, item.state]).sort()).toEqual([
				["ws-verifier", "done"],
				["ws-worker-a", "done"],
				["ws-worker-b", "done"],
			]);
			const seqs = new Set(board.posts().map(post => post.seq));
			const names = new Set(board.listMembers().map(member => member.name));
			const items = [...view.attention, ...view.workstreams, ...view.milestones, ...view.risks];
			expect(items.length).toBeGreaterThan(0);
			for (const item of items) {
				expect(item.refs.length, item.id).toBeGreaterThan(0);
				for (const ref of item.refs) {
					if ("seq" in ref) expect(seqs.has(ref.seq), `${item.id} cites #${ref.seq}`).toBe(true);
					else expect(names.has(ref.member), `${item.id} cites ${ref.member}`).toBe(true);
				}
			}

			// The narrator never posted, and it sits parked for any post.
			expect(board.posts().filter(post => post.agent === "narrator")).toEqual([]);
			expect(board.member("narrator")).toMatchObject({ role: "narrator", lastPostSeq: 0, lastPostTime: null });
			expect(f.runtime.waiters(id).find(waiter => waiter.name === "narrator")).toMatchObject({
				mentionsOnly: false,
			});

			// A half-written view.json is refused with a reason while the last good parse stays.
			await fs.writeFile(path.join(board.dir, "view.json"), '{"version": 1, "as_of_seq": ');
			const broken = store.read();
			expect(broken.view).toBe(view);
			expect(broken.error).toContain("view.json");

			// The next post wakes the narrator, which writes a current view that replaces the refused one.
			const nudge = await f.post.execute("nudge", { text: "The board changed again" });
			const nudged = nudge.details!.result!;
			expect(nudged.receipts).toMatchObject([{ name: "narrator", outcome: "woken" }]);
			await f.until(() => {
				const healed = store.read();
				return (
					healed.error === undefined &&
					healed.view?.as_of_seq === nudged.post.seq &&
					f.runtime.waiters(id).some(waiter => waiter.name === "narrator")
				);
			});
			expect(store.read().view?.as_of_seq).toBe(board.head);
			expect(board.posts().filter(post => post.agent === "narrator")).toEqual([]);
			expect(f.script.failures).toEqual([]);
		},
		E2E_TIMEOUT_MS,
	);
});
