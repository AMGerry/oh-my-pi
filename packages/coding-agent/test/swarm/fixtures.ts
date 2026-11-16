/**
 * Shared fixtures for the swarm board tests: a real board directory under the OS temp dir, a standard cast of
 * members and channels, and read-back helpers that parse the files the store wrote.
 */
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BoardStore } from "../../src/swarm/board-store";
import {
	type BoardPost,
	postSchema,
	type SwarmCapabilities,
	type SwarmChannel,
	type SwarmMember,
	SwarmRefusal,
} from "../../src/swarm/types";

export const SWARM_CAPABILITIES: SwarmCapabilities = {
	channels: true,
	workspaces: false,
	narrator: true,
	monitor: true,
	graph: false,
	customPage: false,
};

/** The four files `BoardStore.create` writes into a board directory. */
export const BOARD_FILES = ["board.jsonl", "channels.json", "members.json", "swarm.json"] as const;
export type BoardFile = (typeof BOARD_FILES)[number];

/** Names of the standard cast installed by {@link seedSwarm}, in roster order. */
export const CAST = ["coordinator", "alice", "bob", "carol", "narrator", "monitor"] as const;

export function makeMember(agentId: string, overrides: Partial<SwarmMember> = {}): SwarmMember {
	return {
		agentId,
		sessionFile: null,
		model: "test/model",
		role: "worker",
		wakeMode: "mentions",
		waitSince: null,
		lastReadSeq: 0,
		lastPostSeq: 0,
		lastPostTime: null,
		channels: [],
		workspace: "inherit",
		killed: false,
		...overrides,
	};
}

export function makeChannel(overrides: Partial<SwarmChannel> = {}): SwarmChannel {
	return { topic: "", createdBy: "coordinator", subscribers: [], archived: false, ...overrides };
}

export function range(first: number, last: number): number[] {
	return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
}

export function seqs(posts: readonly BoardPost[]): number[] {
	return posts.map(post => post.seq);
}

/** Replace the board file with the given posts, one JSON object per line. */
export function writeBoardPosts(dir: string, posts: readonly BoardPost[]): void {
	fs.writeFileSync(path.join(dir, "board.jsonl"), posts.map(post => `${JSON.stringify(post)}\n`).join(""));
}

/** Assert that `action` throws the expected-refusal error type, optionally with a message fragment. */
export function expectRefusal(action: () => unknown, message?: RegExp): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(SwarmRefusal);
	if (message && thrown instanceof Error) expect(thrown.message).toMatch(message);
}

/** A board directory in the OS temp dir plus the store created on it; removed on dispose. */
export class BoardFixture implements Disposable {
	constructor(
		readonly root: string,
		readonly dir: string,
		readonly store: BoardStore,
	) {}

	file(name: BoardFile): string {
		return path.join(this.dir, name);
	}

	bytes(name: BoardFile): Buffer {
		return fs.readFileSync(this.file(name));
	}

	text(name: BoardFile): string {
		return fs.readFileSync(this.file(name), "utf8");
	}

	/** Every line of board.jsonl, validated against the post schema and independent of the store's memory. */
	durablePosts(): BoardPost[] {
		return this.text("board.jsonl")
			.split("\n")
			.filter(line => line !== "")
			.map(line => postSchema.assert(JSON.parse(line)));
	}

	/** Names of all entries in the board directory, sorted; a stray staging file would show up here. */
	listFiles(): string[] {
		return fs.readdirSync(this.dir).sort();
	}

	reopen(options: { readOnly?: boolean } = {}): BoardStore {
		return BoardStore.open(this.dir, options);
	}

	/** Remove the whole temporary tree; Windows may hold a handle briefly, so the removal retries. */
	[Symbol.dispose](): void {
		fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
	}
}

export function createBoardFixture(): BoardFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-board-"));
	const dir = path.join(root, "swarm");
	try {
		const store = BoardStore.create(dir, {
			id: "test-swarm",
			title: "Test swarm",
			coordinator: makeMember("coordinator-agent", { role: "coordinator", wakeMode: null }),
			capabilities: SWARM_CAPABILITIES,
		});
		return new BoardFixture(root, dir, store);
	} catch (error) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
		throw error;
	}
}

export function addWorker(store: BoardStore, name: string, overrides: Partial<SwarmMember> = {}): void {
	store.addMember(name, makeMember(`${name}-agent`, overrides));
}

/**
 * Install the standard cast: channels `parser` (alice) and `ui` (bob); workers alice (parser), bob (ui) and
 * carol (no channels); a narrator and a monitor. The coordinator already exists.
 */
export function seedSwarm(store: BoardStore): void {
	store.setChannel("parser", makeChannel({ topic: "lexer and parser", subscribers: ["alice"] }));
	store.setChannel("ui", makeChannel({ topic: "interface", subscribers: ["bob"] }));
	addWorker(store, "alice", { channels: ["parser"] });
	addWorker(store, "bob", { channels: ["ui"] });
	addWorker(store, "carol");
	addWorker(store, "narrator", { role: "narrator", wakeMode: "any" });
	addWorker(store, "monitor", { role: "monitor", wakeMode: "any" });
}

/** Names from `names` that the post addresses, in the order given. */
export function addressedAmong(store: BoardStore, post: BoardPost, names: readonly string[]): string[] {
	return names.filter(name => store.addresses(post, name));
}

/** A board post written directly, for tests that need a large or hand-damaged board file. */
export function rawPost(seq: number, agent: string, text: string): BoardPost {
	return { seq, agent, text, time: "2026-01-01T00:00:00.000Z", mentions: [], all: false };
}
