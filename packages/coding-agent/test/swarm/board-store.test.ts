/**
 * BoardStore is the durable heart of a swarm: the append-only board, the per-member cursors and the metadata files.
 * Every test runs against real files in a temporary directory; failures are injected at the `node:fs` boundary.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { BoardStore } from "../../src/swarm/board-store";
import { type BoardPost, membersSchema } from "../../src/swarm/types";
import {
	addressedAmong,
	addWorker,
	BOARD_FILES,
	type BoardFixture,
	CAST,
	createBoardFixture,
	expectRefusal,
	makeChannel,
	makeMember,
	range,
	rawPost,
	SWARM_CAPABILITIES,
	seedSwarm,
	seqs,
	writeBoardPosts,
} from "./fixtures";

afterEach(() => {
	vi.restoreAllMocks();
});

function snapshotFiles(fx: BoardFixture): Record<string, string> {
	return Object.fromEntries(BOARD_FILES.map(name => [name, fx.text(name)]));
}

/** Make the next board write (a short write) or the next fsync fail once; later calls behave normally. */
function failNext(kind: "write" | "fsync"): void {
	let armed = true;
	if (kind === "fsync") {
		const realFsync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			if (armed) {
				armed = false;
				throw Object.assign(new Error("EIO: simulated fsync failure"), { code: "EIO" });
			}
			realFsync(fd);
		});
		return;
	}
	const realWrite = fs.writeFileSync;
	vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
		if (!armed) return realWrite(target, data, options);
		armed = false;
		const bytes =
			typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		if (typeof target === "number") fs.writeSync(target, bytes, 0, Math.min(12, bytes.length));
		throw Object.assign(new Error("ENOSPC: simulated short write"), { code: "ENOSPC" });
	});
}

describe("BoardStore create and open", () => {
	test("create refuses to overwrite an existing board, so a resumed session keeps its history", () => {
		using fx = createBoardFixture();
		fx.store.append("coordinator", "kept");
		const before = snapshotFiles(fx);

		expect(() =>
			BoardStore.create(fx.dir, {
				id: "other",
				title: "Other",
				coordinator: makeMember("other-agent", { role: "coordinator", wakeMode: null }),
				capabilities: SWARM_CAPABILITIES,
			}),
		).toThrow();

		expect(snapshotFiles(fx)).toEqual(before);
		expect(
			fx
				.reopen()
				.posts()
				.map(post => post.text),
		).toEqual(["kept"]);
	});

	test("an invalid swarm id creates no directory", () => {
		using fx = createBoardFixture();
		const dir = path.join(fx.root, "invalid");

		expect(() =>
			BoardStore.create(dir, {
				id: "Not A Valid Id",
				title: "Bad",
				coordinator: makeMember("c-agent", { role: "coordinator", wakeMode: null }),
				capabilities: SWARM_CAPABILITIES,
			}),
		).toThrow();

		expect(fs.existsSync(dir)).toBe(false);
	});

	test("a reopened board restores posts, roster, channels and cursors", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.append("coordinator", "@alice start");
		store.append("coordinator", "parser note", "parser");
		store.read("alice");

		const reopened = fx.reopen();

		expect(reopened.posts()).toEqual(store.posts());
		expect(reopened.listMembers()).toEqual(store.listMembers());
		expect(reopened.channels()).toEqual(store.channels());
		expect(reopened.head).toBe(2);
		expect(reopened.member("alice").lastReadSeq).toBe(2);
		expect(reopened.boardUri).toBe("swarm://test-swarm");
	});

	test("a gap in the sequence makes open fail instead of serving a damaged board", () => {
		using fx = createBoardFixture();
		writeBoardPosts(fx.dir, [rawPost(1, "coordinator", "one"), rawPost(3, "coordinator", "three")]);

		expect(() => fx.reopen({ readOnly: true })).toThrow(/sequence/);
		expect(() => fx.reopen()).toThrow(/sequence/);
	});
});

describe("BoardStore append", () => {
	test("posts are numbered from 1 and only ever add bytes after the existing board", () => {
		using fx = createBoardFixture();
		let previous = fx.bytes("board.jsonl");
		const returned: BoardPost[] = [];

		for (const text of ["first", "second @all", "third"]) {
			returned.push(fx.store.append("coordinator", text));
			const current = fx.bytes("board.jsonl");
			expect(current.subarray(0, previous.length).equals(previous)).toBe(true);
			expect(current.length).toBeGreaterThan(previous.length);
			previous = current;
		}

		expect(seqs(returned)).toEqual([1, 2, 3]);
		expect(fx.durablePosts()).toEqual(returned);
		const text = previous.toString("utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(text.trimEnd().split("\n")).toHaveLength(3);

		const resumed = fx.reopen().append("coordinator", "after reopen");
		const grown = fx.bytes("board.jsonl");
		expect(resumed.seq).toBe(4);
		expect(grown.subarray(0, previous.length).equals(previous)).toBe(true);
	});

	test("metadata, cursor and channel changes never touch the board bytes", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		store.append("coordinator", "one");
		const before = fx.bytes("board.jsonl");

		seedSwarm(store);
		store.read("coordinator");
		store.updateMember("alice", { waitSince: 5 });
		store.setChannel("docs", makeChannel({ subscribers: ["alice"] }));
		store.setTitle("Renamed");

		expect(fx.bytes("board.jsonl").equals(before)).toBe(true);
	});

	test("a post keeps its text verbatim, its parsed addressing and an ISO timestamp, and survives reopen", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		const text = '  @Bob and @ALL, see @#Parser\r\nsecond line \u2028 \ud83d\ude80 "quoted" \\ back  ';

		const startedAt = Date.now();
		const post = store.append("coordinator", text, "ui");
		const finishedAt = Date.now();
		const plain = store.append("coordinator", "no channel here");

		expect(post).toEqual({
			seq: 1,
			agent: "coordinator",
			text,
			time: post.time,
			channel: "ui",
			mentions: ["bob", "#parser"],
			all: true,
		});
		const postedAt = Date.parse(post.time);
		expect(new Date(postedAt).toISOString()).toBe(post.time);
		expect(postedAt).toBeGreaterThanOrEqual(startedAt);
		expect(postedAt).toBeLessThanOrEqual(finishedAt);
		expect("channel" in plain).toBe(false);
		expect(fx.reopen().posts()).toEqual([post, plain]);
		expect(store.member("coordinator")).toMatchObject({ lastPostSeq: 2, lastPostTime: plain.time });
	});

	test("refused posts consume no sequence number and leave the board bytes alone", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		addWorker(store, "dave");
		store.updateMember("dave", { killed: true });
		store.append("coordinator", "first");
		const before = fx.bytes("board.jsonl");

		expectRefusal(() => store.append("coordinator", ""), /text/);
		expectRefusal(() => store.append("coordinator", "  \n\t "), /text/);
		expectRefusal(() => store.append("coordinator", "ping @#main"), /@all/);
		expectRefusal(() => store.append("coordinator", "PING @#MAIN."), /@all/);
		expectRefusal(() => store.append("ghost", "hello"), /Unknown swarm member/);
		expectRefusal(() => store.append("dave", "hello"), /killed/);

		expect(fx.bytes("board.jsonl").equals(before)).toBe(true);
		expect(store.head).toBe(1);
		const broadcast = store.append("coordinator", "use @all to address main");
		expect(broadcast).toMatchObject({ seq: 2, all: true });
	});

	test("a post goes to the poster's first channel by default and only to channels the poster may use", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		addWorker(store, "dave", { channels: ["parser", "ui"] });

		expect(store.append("alice", "in my area").channel).toBe("parser");
		expect(store.append("dave", "first channel wins").channel).toBe("parser");
		expect(store.append("dave", "explicit area", "ui").channel).toBe("ui");
		expect("channel" in store.append("alice", "for everyone", "main")).toBe(false);
		expect("channel" in store.append("carol", "no channels means main")).toBe(false);

		expectRefusal(() => store.append("alice", "wrong area", "ui"), /not subscribed/);
		expectRefusal(() => store.append("carol", "wrong area", "parser"), /not subscribed/);
		expectRefusal(() => store.append("coordinator", "no such area", "nowhere"), /unavailable/);

		store.setChannel("parser", makeChannel({ subscribers: ["alice"], archived: true }));
		expectRefusal(() => store.append("coordinator", "late note", "parser"), /unavailable/);
		expect(store.append("coordinator", "live area", "ui").channel).toBe("ui");
	});

	test("sequence numbers stay unique and contiguous when many appends start concurrently", async () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		const authors = ["coordinator", "alice", "bob", "carol"];
		const total = 120;

		const acknowledged = await Promise.all(
			Array.from({ length: total }, async (_, index) => {
				const author = authors[index % authors.length];
				// Different start offsets interleave the appends the way independent workers would.
				for (let turn = 0; turn < index % 5; turn++) await Promise.resolve();
				return store.append(author, `message ${index} from ${author}`);
			}),
		);

		expect(seqs(acknowledged).toSorted((a, b) => a - b)).toEqual(range(1, total));
		const durable = fx.durablePosts();
		expect(seqs(durable)).toEqual(range(1, total));
		for (const post of acknowledged) expect(durable[post.seq - 1]).toEqual(post);
		for (const author of authors) {
			const mine = seqs(acknowledged.filter(post => post.agent === author));
			expect(store.member(author).lastPostSeq).toBe(Math.max(...mine));
		}
		expect(fx.reopen().head).toBe(total);
	}, 60_000);

	test("an append is on disk and fsynced before it becomes visible", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		store.append("coordinator", "first");
		const observed: Array<{ visible: number[]; durable: number[] }> = [];
		const realFsync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			observed.push({
				visible: seqs(store.select("coordinator", { since: 0 })),
				durable: seqs(fx.durablePosts()),
			});
			realFsync(fd);
		});

		const post = store.append("coordinator", "second");
		vi.restoreAllMocks();

		expect(post.seq).toBe(2);
		// The board is synced after the line is written and before any reader can see the post.
		expect(observed.some(entry => entry.durable.includes(2) && !entry.visible.includes(2))).toBe(true);
		// At no sync did a reader see a post that was not yet on disk.
		for (const entry of observed) {
			for (const seq of entry.visible) expect(entry.durable).toContain(seq);
		}
	});

	test.each([
		{ kind: "write", durable: ["first"] },
		{ kind: "fsync", durable: ["first", "not acknowledged"] },
	] as const)(
		"a failed $kind locks the store for appends and leaves the bytes on disk as they are",
		({ kind, durable }) => {
			using fx = createBoardFixture();
			const { store } = fx;
			store.append("coordinator", "first");
			failNext(kind);

			expect(() => store.append("coordinator", "not acknowledged")).toThrow("simulated");
			vi.restoreAllMocks();
			const afterFailure = fx.bytes("board.jsonl");

			// The failed post was never acknowledged, so this store serves only the confirmed posts.
			expect(store.head).toBe(1);
			expect(seqs(store.select("coordinator", { since: 0 }))).toEqual([1]);
			// The next append would reuse the unconfirmed seq, so the store refuses it and the board keeps its bytes.
			expect(() => store.append("coordinator", "after failure")).toThrow(/locked for appends/);
			expect(fx.bytes("board.jsonl").equals(afterFailure)).toBe(true);
			// Cursor writes are metadata and keep working.
			expect(seqs(store.read("coordinator").messages)).toEqual([1]);

			// A read-only view serves every complete line on disk, including a fully written but unacknowledged post.
			expect(
				fx
					.reopen({ readOnly: true })
					.posts()
					.map(post => post.text),
			).toEqual([...durable]);
			// A writable open accepts only a board that ends on a complete line.
			if (kind === "write") expect(() => fx.reopen()).toThrow(/tail/);
			else expect(fx.reopen().head).toBe(2);
			expect(fx.bytes("board.jsonl").equals(afterFailure)).toBe(true);
		},
	);

	test("an fsynced post stays committed when members.json then fails, and every open rebuilds lastPost from the board", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.append("alice", "first");
		const savedMembers = fx.text("members.json");
		const realRename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (path.basename(String(to)) === "members.json") {
				throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
			}
			realRename(from, to);
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const post = store.append("alice", "second");

		expect(warn).toHaveBeenCalledTimes(1);
		vi.restoreAllMocks();
		expect(post).toMatchObject({ seq: 2, agent: "alice", text: "second" });
		expect(fx.durablePosts().at(-1)).toEqual(post);
		expect(fx.text("members.json")).toBe(savedMembers);
		expect(fx.listFiles()).toEqual([...BOARD_FILES]);
		const recorded = { lastPostSeq: 2, lastPostTime: post.time };
		expect(store.member("alice")).toMatchObject(recorded);
		// members.json still says #1; the read-only and the writable open both take lastPost from the board.
		expect(fx.reopen({ readOnly: true }).member("alice")).toMatchObject(recorded);
		expect(fx.reopen().member("alice")).toMatchObject(recorded);

		// The next ordinary metadata write records the in-memory lastPost, and appends continue.
		store.updateMember("carol", { waitSince: 4 });
		expect(membersSchema.assert(JSON.parse(fx.text("members.json"))).members.alice).toMatchObject(recorded);
		expect(store.append("alice", "third").seq).toBe(3);
	});
});

describe("BoardStore members", () => {
	test("reserved, malformed and reused names are refused without touching the roster", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		addWorker(store, "alice");
		store.updateMember("alice", { killed: true });
		const sealed = fx.text("members.json");

		for (const name of ["all", "coordinator"]) expectRefusal(() => addWorker(store, name));
		for (const name of ["Alice", "9lives", "", "a_b", "a b", "x".repeat(41)]) {
			expectRefusal(() => addWorker(store, name));
		}
		// A killed member's name is gone for good.
		expectRefusal(() => addWorker(store, "alice"), /already been used/);

		expect(store.listMembers().map(member => member.name)).toEqual(["coordinator", "alice"]);
		expect(fx.text("members.json")).toBe(sealed);

		addWorker(store, "x".repeat(40));
		addWorker(store, "dev-10");
		expect(
			fx
				.reopen()
				.listMembers()
				.map(member => member.name),
		).toEqual(["coordinator", "alice", "x".repeat(40), "dev-10"]);
	});

	test("a malformed member record is rejected before anything is written", () => {
		using fx = createBoardFixture();
		const before = fx.text("members.json");

		expect(() => fx.store.addMember("dave", Object.assign(makeMember("dave-agent"), { role: "boss" }))).toThrow(
			/role/,
		);

		expect(fx.text("members.json")).toBe(before);
		expectRefusal(() => fx.store.member("dave"), /Unknown swarm member/);
	});

	test("updateMember removes an optional field set to undefined and still requires every mandatory one", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		addWorker(store, "alice");
		store.updateMember("alice", { error: "quota" });
		expect(fx.reopen().member("alice").error).toBe("quota");

		store.updateMember("alice", { error: undefined, waitSince: 3 });

		expect("error" in store.member("alice")).toBe(false);
		expect(store.member("alice").waitSince).toBe(3);
		expect("error" in membersSchema.assert(JSON.parse(fx.text("members.json"))).members.alice).toBe(false);
		expect("error" in fx.reopen().member("alice")).toBe(false);

		const saved = fx.text("members.json");
		expect(() => store.updateMember("alice", { model: undefined })).toThrow(/model/);
		expect(store.member("alice").model).toBe("test/model");
		expect(fx.text("members.json")).toBe(saved);
	});

	test("updateMember changes one member, persists it, and rejects an invalid change whole", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		const alice = store.member("alice");
		const others = store.listMembers().filter(member => member.name !== "alice");

		store.updateMember("alice", { wakeMode: "any", waitSince: 7, error: "quota" });

		expect(store.member("alice")).toEqual({ ...alice, wakeMode: "any", waitSince: 7, error: "quota" });
		expect(store.listMembers().filter(member => member.name !== "alice")).toEqual(others);
		expect(fx.reopen().member("alice")).toEqual(store.member("alice"));

		const saved = fx.text("members.json");
		expect(() => store.updateMember("alice", { lastReadSeq: -1 })).toThrow(/lastReadSeq/);
		expect(store.member("alice").lastReadSeq).toBe(0);
		expect(fx.text("members.json")).toBe(saved);
		expectRefusal(() => store.updateMember("ghost", { waitSince: 1 }), /Unknown swarm member/);
	});

	test("records handed out are copies, so a caller cannot move a cursor or edit history by mutating them", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.append("coordinator", "@alice hello");

		store.member("alice").lastReadSeq = 99;
		store.listMembers()[0].channels.push("hacked");
		store.channels().get("parser")?.subscribers.push("mallory");
		store.posts()[0].text = "tampered";
		store.select("alice")[0].text = "tampered";

		expect(store.member("alice").lastReadSeq).toBe(0);
		expect(store.member("coordinator").channels).toEqual([]);
		expect(store.channels().get("parser")?.subscribers).toEqual(["alice"]);
		expect(store.posts()[0].text).toBe("@alice hello");
		expect(store.select("alice")[0].text).toBe("@alice hello");
	});

	test("setChannel refuses main, malformed names and malformed records without touching channels.json", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		store.setChannel("parser", makeChannel({ topic: "lexer", subscribers: ["alice"] }));
		const saved = fx.text("channels.json");

		expectRefusal(() => store.setChannel("main", makeChannel()), /main is implicit/);
		expectRefusal(() => store.setChannel("Parser Two", makeChannel()));
		expectRefusal(() => store.setChannel("a_b", makeChannel()));
		expect(() => store.setChannel("broken", Object.assign(makeChannel(), { subscribers: "alice" }))).toThrow(
			/subscribers/,
		);

		expect(fx.text("channels.json")).toBe(saved);
		expect([...store.channels().keys()]).toEqual(["parser"]);
		expect([...fx.reopen().channels().keys()]).toEqual(["parser"]);
	});
});

describe("BoardStore metadata files are replaced atomically", () => {
	test("members.json is published from a complete, fsynced staged copy while the old file stays whole", () => {
		using fx = createBoardFixture();
		const oldText = fx.text("members.json");
		const events: string[] = [];
		let liveAtRename = "";
		let stagedMembers: string[] = [];
		const realRename = fs.renameSync;
		const realFsync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			events.push("fsync");
			realFsync(fd);
		});
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (path.basename(String(to)) === "members.json") {
				events.push("rename");
				liveAtRename = fs.readFileSync(String(to), "utf8");
				stagedMembers = Object.keys(
					membersSchema.assert(JSON.parse(fs.readFileSync(String(from), "utf8"))).members,
				);
			}
			realRename(from, to);
		});

		addWorker(fx.store, "alice");
		vi.restoreAllMocks();

		expect(events.slice(0, 2)).toEqual(["fsync", "rename"]);
		expect(liveAtRename).toBe(oldText);
		expect(stagedMembers).toEqual(["coordinator", "alice"]);
		expect(Object.keys(membersSchema.assert(JSON.parse(fx.text("members.json"))).members)).toEqual([
			"coordinator",
			"alice",
		]);
		expect(fx.listFiles()).toEqual([...BOARD_FILES]);
	});

	test("a write that dies midway leaves the previous members.json and no staging file", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		addWorker(store, "alice");
		const before = fx.text("members.json");
		failNext("write");

		expect(() => addWorker(store, "bob")).toThrow("simulated");
		vi.restoreAllMocks();

		expect(fx.text("members.json")).toBe(before);
		expect(fx.listFiles()).toEqual([...BOARD_FILES]);
		expect(store.listMembers().map(member => member.name)).toEqual(["coordinator", "alice"]);
		expect(
			fx
				.reopen()
				.listMembers()
				.map(member => member.name),
		).toEqual(["coordinator", "alice"]);

		// The name was not burned by the failed attempt.
		addWorker(store, "bob");
		expect(
			fx
				.reopen()
				.listMembers()
				.map(member => member.name),
		).toEqual(["coordinator", "alice", "bob"]);
	});

	test("a failed rename changes neither the files nor the in-memory state, and no unread post is lost", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.append("coordinator", "one");
		store.append("coordinator", "two");
		const capture = () => ({
			members: fx.text("members.json"),
			channels: fx.text("channels.json"),
			roster: store.listMembers(),
			channelMap: store.channels(),
			files: fx.listFiles(),
		});
		const before = capture();
		const realRename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (path.basename(String(to)).endsWith(".json")) {
				throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
			}
			realRename(from, to);
		});

		expect(() => addWorker(store, "dave")).toThrow("EPERM");
		expect(() => store.updateMember("alice", { lastReadSeq: 2 })).toThrow("EPERM");
		expect(() => store.read("alice")).toThrow("EPERM");
		expect(() => store.setChannel("docs", makeChannel())).toThrow("EPERM");
		const afterFailures = capture();
		vi.restoreAllMocks();

		expect(afterFailures).toEqual(before);
		// Nothing was half applied: the same operations now succeed, and the unread posts are still delivered.
		addWorker(store, "dave");
		store.setChannel("docs", makeChannel());
		expect(seqs(store.read("alice").messages)).toEqual([1, 2]);
		expect(fx.reopen().member("alice").lastReadSeq).toBe(2);
	});
});

describe("BoardStore read-only view", () => {
	test("tolerates a torn final line and serves the durable prefix", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		store.append("coordinator", "one");
		store.append("coordinator", "two @all");
		store.append("coordinator", "three \u00e9 \ud83d\ude80 tail");
		const full = fx.bytes("board.jsonl");
		const lines = full.toString("utf8").split("\n");
		const prefixBytes = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`);
		const third = Buffer.from(lines[2]);
		const accentAt = third.indexOf("\u00e9");
		const rocketAt = third.indexOf("\ud83d\ude80");
		const cuts = [1, Math.floor(third.length / 2), accentAt + 1, rocketAt + 2, third.length - 1];
		const durablePrefix = fx.durablePosts().slice(0, 2);

		for (const cut of cuts) {
			fs.writeFileSync(fx.file("board.jsonl"), full.subarray(0, prefixBytes + cut));
			const view = fx.reopen({ readOnly: true });

			expect(view.posts()).toEqual(durablePrefix);
			expect(view.head).toBe(2);
			expect(seqs(view.select("coordinator"))).toEqual([1, 2]);
			expect(fx.bytes("board.jsonl").length).toBe(prefixBytes + cut);
		}

		// A writer would append after the torn bytes, so a writable open refuses rather than guess.
		expect(() => fx.reopen()).toThrow(/tail/);
		expect(fx.bytes("board.jsonl").length).toBe(prefixBytes + third.length - 1);
	});

	test("a board whose only line is torn reads as empty", () => {
		using fx = createBoardFixture();
		fx.store.append("coordinator", "only post");
		fs.writeFileSync(fx.file("board.jsonl"), fx.bytes("board.jsonl").subarray(0, 9));

		const view = fx.reopen({ readOnly: true });

		expect(view.head).toBe(0);
		expect(view.select("coordinator")).toEqual([]);
	});

	test("never writes: every mutation is refused and every file stays byte-identical", () => {
		using fx = createBoardFixture();
		seedSwarm(fx.store);
		fx.store.append("coordinator", "@alice hello");
		const before = snapshotFiles(fx);
		const view = fx.reopen({ readOnly: true });

		expectRefusal(() => view.append("coordinator", "no"), /read-only/);
		expectRefusal(() => addWorker(view, "dave"), /read-only/);
		expectRefusal(() => view.updateMember("alice", { waitSince: 3 }), /read-only/);
		expectRefusal(() => view.setChannel("docs", makeChannel()), /read-only/);
		expectRefusal(() => view.setTitle("Other"), /read-only/);

		expect(seqs(view.select("alice"))).toEqual([1]);
		expect(view.member("alice").waitSince).toBeNull();
		expect(snapshotFiles(fx)).toEqual(before);
	});
});

describe("BoardStore cursors", () => {
	test("each member has its own cursor; reads and posts move only the caller's, and restore survives reopen", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		for (let index = 1; index <= 6; index++) store.append("coordinator", `m${index}`);

		expect(seqs(store.read("alice", { limit: 2 }).messages)).toEqual([1, 2]);
		expect(seqs(store.read("bob").messages)).toEqual([1, 2, 3, 4, 5, 6]);
		// Posting is not reading: carol's cursor stays put while she writes.
		const carolPost = store.append("carol", "carol speaks");

		const cursors = () => Object.fromEntries(store.listMembers().map(member => [member.name, member.lastReadSeq]));
		expect(cursors()).toEqual({ coordinator: 0, alice: 2, bob: 6, carol: 0, narrator: 0, monitor: 0 });
		expect(store.member("carol")).toMatchObject({ lastPostSeq: carolPost.seq, lastReadSeq: 0 });
		expect(store.member("alice").lastPostSeq).toBe(0);

		const reopened = fx.reopen();
		expect(Object.fromEntries(reopened.listMembers().map(member => [member.name, member.lastReadSeq]))).toEqual(
			cursors(),
		);
		// Restored cursors continue exactly where each member stopped: nothing repeated, nothing missed.
		expect(seqs(reopened.read("alice").messages)).toEqual([3, 4, 5, 6, 7]);
		expect(seqs(reopened.read("bob").messages)).toEqual([7]);
		// carol's own post is hers already; everything else she has not read yet is delivered.
		const fromOthers = reopened.read("carol").messages.filter(post => post.agent !== "carol");
		expect(seqs(fromOthers)).toEqual(range(1, 6));
		expect(seqs(reopened.read("alice").messages)).toEqual([]);
	});

	test("a read advances the cursor only to the last post it actually returned", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.append("coordinator", "m1");
		store.append("coordinator", "u2", "ui");
		store.append("coordinator", "m3");
		store.append("coordinator", "u4", "ui");
		store.append("coordinator", "m5");

		// carol has no channels, so posts 2 and 4 are not hers to see.
		const first = store.read("carol", { limit: 2 });
		expect(seqs(first.messages)).toEqual([1, 3]);
		expect(first.lastReadSeq).toBe(3);
		expect(first.head).toBe(5);
		expect(store.member("carol").lastReadSeq).toBe(3);

		const second = store.read("carol", { limit: 2 });
		expect(seqs(second.messages)).toEqual([5]);
		expect(second.lastReadSeq).toBe(5);

		// Posts she cannot see never move her cursor, however far the head runs ahead.
		store.append("coordinator", "u6", "ui");
		const idle = store.read("carol");
		expect(idle.messages).toEqual([]);
		expect(idle.lastReadSeq).toBe(5);
		expect(idle.head).toBe(6);
		expect(store.member("carol").lastReadSeq).toBe(5);

		// Replaying from an older point never moves the cursor back; select is a pure peek.
		expect(seqs(store.read("carol", { since: 0 }).messages)).toEqual([1, 3, 5]);
		expect(store.member("carol").lastReadSeq).toBe(5);
		store.append("coordinator", "m7");
		expect(seqs(store.select("carol"))).toEqual([7]);
		expect(store.member("carol").lastReadSeq).toBe(5);
	});

	test("reads default to 200 posts and the next read continues without a gap", () => {
		using fx = createBoardFixture();
		writeBoardPosts(
			fx.dir,
			range(1, 205).map(seq => rawPost(seq, "coordinator", `post ${seq}`)),
		);
		const store = fx.reopen();

		const first = store.read("coordinator");
		expect(first.messages).toHaveLength(200);
		expect(first.lastReadSeq).toBe(200);
		expect(first.head).toBe(205);
		expect(seqs(store.read("coordinator").messages)).toEqual(range(201, 205));
		expect(store.read("coordinator").messages).toEqual([]);
		expect(seqs(store.read("coordinator", { since: 0, limit: 3 }).messages)).toEqual([1, 2, 3]);
		expect(store.member("coordinator").lastReadSeq).toBe(205);
	});

	test("reads validate since, limit and channel scope", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.append("coordinator", "m1");
		store.append("coordinator", "p2", "parser");

		for (const since of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
			expectRefusal(() => store.select("alice", { since }), /since/);
		}
		for (const limit of [0, 2001, 1.5, Number.NaN]) {
			expectRefusal(() => store.select("alice", { limit }), /limit/);
		}
		expect(store.select("alice", { limit: 2000 })).toHaveLength(2);
		expect(store.select("alice", { limit: 1 })).toHaveLength(1);

		// Only coordinator, narrator and monitor may read every channel at once.
		expectRefusal(() => store.select("alice", { channel: "*" }), /All-channel/);
		expectRefusal(() => store.read("carol", { channel: "*" }), /All-channel/);
		for (const name of ["coordinator", "narrator", "monitor"]) {
			expect(seqs(store.select(name, { channel: "*" }))).toEqual([1, 2]);
		}
		expectRefusal(() => store.select("ghost"), /Unknown swarm member/);
	});

	test("paged readers interleaved with a writer each see every visible post exactly once", async () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		const total = 30;
		const areas = ["main", "parser", "ui"];
		const channelOf = new Map<number, string>();
		let writing = true;

		const write = async () => {
			for (let index = 0; index < total; index++) {
				const area = areas[index % areas.length];
				const post = store.append("coordinator", `post ${index}`, area);
				channelOf.set(post.seq, area);
				await Promise.resolve();
			}
			writing = false;
		};
		const readAll = async (name: string, into: number[]) => {
			for (;;) {
				const stillWriting = writing;
				const page = store.read(name, { limit: 3 });
				into.push(...seqs(page.messages));
				if (!stillWriting && page.messages.length === 0) return;
				await Promise.resolve();
			}
		};
		const alice: number[] = [];
		const bob: number[] = [];
		const coordinator: number[] = [];

		await Promise.all([write(), readAll("alice", alice), readAll("bob", bob), readAll("coordinator", coordinator)]);

		const allSeqs = range(1, total);
		const expectedFor = (area: string) => allSeqs.filter(seq => channelOf.get(seq) !== area);
		expect(alice).toEqual(expectedFor("ui"));
		expect(bob).toEqual(expectedFor("parser"));
		expect(coordinator).toEqual(allSeqs);
		expect(store.member("alice").lastReadSeq).toBe(Math.max(...alice));
		expect(store.member("bob").lastReadSeq).toBe(Math.max(...bob));
		expect(store.member("coordinator").lastReadSeq).toBe(total);
	}, 60_000);
});

/** Four posts: parser #1, ui #2, main #3, and a parser post that names carol #4. */
function postAcrossChannels(fx: BoardFixture): void {
	fx.store.append("coordinator", "parser note", "parser");
	fx.store.append("coordinator", "ui note", "ui");
	fx.store.append("coordinator", "for everyone");
	fx.store.append("coordinator", "@carol please help", "parser");
}

describe("BoardStore visibility", () => {
	test("the default view is main plus the member's own channels; coordinator, narrator and monitor see everything", () => {
		using fx = createBoardFixture();
		seedSwarm(fx.store);
		postAcrossChannels(fx);
		const view = (name: string) => seqs(fx.store.select(name));

		expect(view("alice")).toEqual([1, 3, 4]);
		expect(view("bob")).toEqual([2, 3]);
		// carol has no channels: main, plus the one parser post that names her.
		expect(view("carol")).toEqual([3, 4]);
		for (const name of ["coordinator", "narrator", "monitor"]) expect(view(name)).toEqual([1, 2, 3, 4]);
	});

	test("an explicit channel read narrows to that channel; outsiders see only what names them", () => {
		using fx = createBoardFixture();
		seedSwarm(fx.store);
		postAcrossChannels(fx);
		const pick = (name: string, channel: string) => seqs(fx.store.select(name, { channel }));

		expect(pick("alice", "parser")).toEqual([1, 4]);
		expect(pick("alice", "main")).toEqual([3]);
		expect(pick("alice", "ui")).toEqual([]);
		expect(pick("carol", "parser")).toEqual([4]);
		expect(pick("carol", "ui")).toEqual([]);
		expect(pick("coordinator", "ui")).toEqual([2]);
		expect(pick("coordinator", "main")).toEqual([3]);
		for (const name of ["coordinator", "narrator", "monitor"]) expect(pick(name, "*")).toEqual([1, 2, 3, 4]);
	});

	test("a subscription hides earlier channel history from the default view, not from an explicit read", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.updateMember("alice", { subscribedSince: { parser: 2 } });
		store.append("coordinator", "early", "parser");
		store.append("coordinator", "@alice look at this", "parser");
		store.append("coordinator", "after joining", "parser");
		store.append("coordinator", "all hands");

		// #1 predates the subscription; #2 names alice and so still reaches her.
		expect(seqs(store.select("alice"))).toEqual([2, 3, 4]);
		expect(seqs(store.select("alice", { channel: "parser" }))).toEqual([1, 2, 3]);
	});

	test("@name, @all and @#channel posts cross channels, and addressing is separate from visibility", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		const named = store.append("coordinator", "@alice review the AST", "ui");
		const everyone = store.append("coordinator", "@all freeze the interface", "ui");
		const channelCall = store.append("coordinator", "@#parser is the AST stable?", "ui");
		const chatter = store.append("coordinator", "ui chatter", "ui");
		const addressed = (post: BoardPost) => addressedAmong(store, post, CAST);

		expect(addressed(named)).toEqual(["alice"]);
		expect(addressed(everyone)).toEqual([...CAST]);
		// A channel call reaches its subscribers plus the roles that follow every channel.
		expect(addressed(channelCall)).toEqual(["coordinator", "alice", "narrator", "monitor"]);
		expect(addressed(chatter)).toEqual([]);

		expect(seqs(store.select("alice"))).toEqual([1, 2, 3]);
		expect(seqs(store.select("carol"))).toEqual([2]);
		expect(seqs(store.select("bob"))).toEqual([1, 2, 3, 4]);
		expect(seqs(store.select("coordinator"))).toEqual([1, 2, 3, 4]);

		const inMain = store.append("coordinator", "@#parser heads up");
		expect(addressedAmong(store, inMain, CAST)).toEqual(["coordinator", "alice", "narrator", "monitor"]);
		expect(store.visible(inMain, "carol")).toBe(true);
		expect(store.addresses(inMain, "carol")).toBe(false);
	});

	test("an archived or unknown channel calls nobody, and an archived channel's history stays readable", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		store.append("coordinator", "old area note", "parser");
		const callArchived = store.append("coordinator", "@#parser status?", "ui");
		const callUnknown = store.append("coordinator", "@#ghost anyone?", "ui");

		expect(addressedAmong(store, callArchived, CAST)).toEqual(["coordinator", "alice", "narrator", "monitor"]);
		expect(seqs(store.select("alice"))).toEqual([1, 2]);
		expect(addressedAmong(store, callUnknown, CAST)).toEqual([]);

		store.setChannel("parser", makeChannel({ subscribers: ["alice"], archived: true }));

		expect(addressedAmong(store, callArchived, CAST)).toEqual([]);
		expect(addressedAmong(store, callUnknown, CAST)).toEqual([]);
		expect(seqs(store.select("alice"))).toEqual([1]);
		expect(seqs(store.select("alice", { channel: "parser" }))).toEqual([1]);
		expectRefusal(() => store.append("coordinator", "late", "parser"), /unavailable/);
	});

	test("@group reaches every numbered member, while a longer or shorter name reaches only itself", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		for (const name of ["dev-1", "dev-2", "dev-10"]) addWorker(store, name, { group: "dev" });
		for (const name of ["ab", "ab-cd", "devops"]) addWorker(store, name);
		const names = ["dev-1", "dev-2", "dev-10", "ab", "ab-cd", "devops"];
		const reach = (text: string) => addressedAmong(store, store.append("coordinator", text), names);

		expect(reach("@dev run the suite")).toEqual(["dev-1", "dev-2", "dev-10"]);
		expect(reach("@dev-1 only you")).toEqual(["dev-1"]);
		expect(reach("@dev-10 only you")).toEqual(["dev-10"]);
		expect(reach("@AB please")).toEqual(["ab"]);
		expect(reach("@ab-cd please")).toEqual(["ab-cd"]);
		expect(reach("@devops please")).toEqual(["devops"]);
		expect(reach("mail ab@example.com")).toEqual([]);
	});

	test("the narrator relay marker reaches a numbered replacement but no other role", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		addWorker(store, "narrator-2", { role: "narrator", wakeMode: "any" });
		const relay = store.append("coordinator", "@narrator user feedback: make it shorter");

		expect(addressedAmong(store, relay, [...CAST, "narrator-2"])).toEqual(["narrator", "narrator-2"]);
	});
});

describe("BoardStore hasPending", () => {
	test("ignores a worker's own posts, with or without addressing and including a mention of itself", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		addWorker(store, "alice");
		store.append("alice", "ready");
		store.append("alice", "@alice a note to myself");
		store.append("alice", "@all heads up");

		for (const mentionsOnly of [false, true]) {
			expect(store.hasPending("alice", 0, mentionsOnly), `mentionsOnly ${mentionsOnly}`).toBe(false);
		}
		// The same posts are news to the coordinator: they are visible to it, and the `@all` one names it.
		expect(store.hasPending("coordinator", 0, false)).toBe(true);
		expect(store.hasPending("coordinator", 0, true)).toBe(true);
	});

	test("ignores the coordinator's own posts, including a mention of itself, until another member posts", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		addWorker(store, "alice");
		store.append("coordinator", "@coordinator remember the plan");
		store.append("coordinator", "plain progress");

		for (const mentionsOnly of [false, true]) {
			expect(store.hasPending("coordinator", 0, mentionsOnly), `mentionsOnly ${mentionsOnly}`).toBe(false);
		}
		store.append("alice", "@coordinator [done] first slice");
		expect(store.hasPending("coordinator", 0, true)).toBe(true);
		expect(store.hasPending("coordinator", 0, false)).toBe(true);
		expect(store.hasPending("coordinator", 3, false)).toBe(false);
	});

	test("turns true as soon as another member's visible post follows, and keeps the mention filter for others' posts", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		addWorker(store, "alice");
		addWorker(store, "bob");
		store.append("alice", "ready");
		expect(store.hasPending("alice", 0, false)).toBe(false);

		const chatter = store.append("bob", "unaddressed chatter");
		expect(store.hasPending("alice", 0, false)).toBe(true);
		expect(store.hasPending("alice", 0, true)).toBe(false);
		expect(store.hasPending("alice", chatter.seq, false)).toBe(false);

		const call = store.append("coordinator", "@alice take the next step");
		expect(store.hasPending("alice", 0, true)).toBe(true);
		expect(store.hasPending("alice", 0, false)).toBe(true);
		expect(store.hasPending("alice", call.seq, true)).toBe(false);

		// Another member's post before `since` is behind the cursor, and the member's own later post still adds nothing.
		store.append("alice", "on it");
		expect(store.hasPending("alice", call.seq, false)).toBe(false);
		expect(store.hasPending("alice", call.seq, true)).toBe(false);
	});

	test("still reports nothing for an invisible post of another member, and keeps refusing a bad cursor", () => {
		using fx = createBoardFixture();
		const { store } = fx;
		seedSwarm(store);
		const hidden = store.append("bob", "ui detail");
		expect(hidden.channel).toBe("ui");
		expect(store.hasPending("carol", 0, false)).toBe(false);
		expect(store.hasPending("bob", 0, false)).toBe(false);
		expect(store.hasPending("coordinator", 0, false)).toBe(true);
		expectRefusal(() => store.hasPending("alice", -1, false), /nonnegative/);
	});
});
