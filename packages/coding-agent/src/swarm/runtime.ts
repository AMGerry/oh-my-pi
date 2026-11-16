import * as fs from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { BoardStore, type CreateBoardOptions } from "./board-store";
import type { BoardPost, BoardReadOptions, BoardReadResult } from "./types";

export type SwarmEvent =
	| { type: "post"; swarmId: string; post: BoardPost }
	| { type: "members" | "channels" | "view"; swarmId: string };
export type SwarmListener = (event: SwarmEvent) => void;

/** Main-thread owner of each session's board writer and live event subscriptions. */
export class SwarmRuntime {
	static #global: SwarmRuntime | undefined;

	static global(): SwarmRuntime {
		SwarmRuntime.#global ??= new SwarmRuntime();
		return SwarmRuntime.#global;
	}

	readonly #boards = new Map<string, BoardStore>();
	readonly #directories = new Map<string, string>();
	readonly #listeners = new Set<SwarmListener>();

	create(dir: string, options: CreateBoardOptions): BoardStore {
		if (this.#boards.has(options.id)) throw new Error(`Swarm ${options.id} is already open`);
		const board = BoardStore.create(dir, options);
		this.#boards.set(board.metadata.id, board);
		this.#directories.set(fs.realpathSync(board.dir), board.metadata.id);
		this.notify({ type: "members", swarmId: board.metadata.id });
		return board;
	}

	open(dir: string): BoardStore {
		const canonical = fs.realpathSync(path.resolve(dir));
		const existingId = this.#directories.get(canonical);
		if (existingId) return this.board(existingId);
		const board = BoardStore.open(canonical);
		if (this.#boards.has(board.metadata.id))
			throw new Error(`Swarm id ${board.metadata.id} belongs to another directory`);
		this.#boards.set(board.metadata.id, board);
		this.#directories.set(canonical, board.metadata.id);
		return board;
	}

	board(id: string): BoardStore {
		const board = this.#boards.get(id);
		if (!board) throw new Error(`Unknown swarm: ${id}`);
		return board;
	}

	list(): BoardStore[] {
		return [...this.#boards.values()];
	}

	/** The append is durable when observers receive the event. */
	post(id: string, agent: string, text: string, channel?: string): BoardPost {
		const post = this.board(id).append(agent, text, channel);
		this.notify({ type: "post", swarmId: id, post });
		return post;
	}

	read(id: string, agent: string, options: BoardReadOptions = {}): BoardReadResult {
		const result = this.board(id).read(agent, options);
		this.notify({ type: "members", swarmId: id });
		return result;
	}

	onChange(listener: SwarmListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	notify(event: SwarmEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(structuredClone(event));
			} catch (error) {
				logger.error("Swarm observer failed", { error: String(error), swarmId: event.swarmId });
			}
		}
	}
}
