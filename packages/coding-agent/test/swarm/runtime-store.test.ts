import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { BoardStore } from "../../src/swarm/board-store";
import { type SwarmEvent, SwarmRuntime } from "../../src/swarm/runtime";
import type { BoardPost } from "../../src/swarm/types";
import { makeMember, SWARM_CAPABILITIES } from "./fixtures";

const directories = new Set<string>();
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
	directories.clear();
});

function createRuntimeBoard(title: string): { runtime: SwarmRuntime; dir: string; board: BoardStore } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-swarm-runtime-"));
	directories.add(dir);
	const runtime = new SwarmRuntime();
	const board = runtime.create(dir, {
		id: "s-fixture",
		title,
		coordinator: makeMember("Main", { role: "coordinator", wakeMode: null }),
		capabilities: SWARM_CAPABILITIES,
	});
	return { runtime, dir, board };
}

test("runtime events observe the already durable board and only one writer per directory", () => {
	const { runtime, dir, board } = createRuntimeBoard("Durable events");
	const observed: Array<{ head: number; post: BoardPost | undefined; eventPost: BoardPost; lastPostSeq: number }> = [];
	const unsubscribe = runtime.onChange(event => {
		if (event.type !== "post") return;
		const disk = BoardStore.open(dir, { readOnly: true });
		observed.push({
			head: disk.head,
			post: disk.posts().at(-1),
			eventPost: event.post,
			lastPostSeq: disk.member("coordinator").lastPostSeq,
		});
	});
	expect(runtime.open(path.join(dir, "."))).toBe(board);
	const post = runtime.append(board.metadata.id, "coordinator", "A durable post");
	expect(observed).toEqual([{ head: 1, post, eventPost: post, lastPostSeq: 1 }]);
	unsubscribe();
	runtime.append(board.metadata.id, "coordinator", "A later post");
	expect(observed).toHaveLength(1);
	expect(new SwarmRuntime().open(dir).head).toBe(2);
});

test("a committed post rings the doorbell even when members.json cannot record it", () => {
	const { runtime, dir, board } = createRuntimeBoard("Commit before metadata");
	const realRename = fs.renameSync;
	vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
		if (path.basename(String(to)) === "members.json") {
			throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
		}
		realRename(from, to);
	});
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const events: SwarmEvent[] = [];
	runtime.onChange(event => events.push(event));

	const post = runtime.append(board.metadata.id, "coordinator", "Durable despite metadata");

	expect(warn).toHaveBeenCalledTimes(1);
	vi.restoreAllMocks();
	expect(events).toEqual([{ type: "post", swarmId: board.metadata.id, post }]);
	const view = BoardStore.open(dir, { readOnly: true });
	expect(view.posts()).toEqual([post]);
	expect(view.member("coordinator")).toMatchObject({ lastPostSeq: 1, lastPostTime: post.time });
});
