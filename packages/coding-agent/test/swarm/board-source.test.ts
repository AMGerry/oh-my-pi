import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SwarmBoardSource } from "../../src/modes/swarm-board-runtime";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { SwarmRuntime } from "../../src/swarm/runtime";
import { BOARD_FILES, type BoardFixture, createBoardFixture } from "./fixtures";
import { BoardStore } from "../../src/swarm/board-store";

const fixtures: BoardFixture[] = [];
const runtimes: Array<{ runtime: SwarmRuntime; lifecycle: AgentLifecycleManager }> = [];
const sources: SwarmBoardSource[] = [];

function fixture(live = false) {
	const board = createBoardFixture();
	fixtures.push(board);
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const runtime = new SwarmRuntime(registry, lifecycle);
	runtimes.push({ runtime, lifecycle });
	if (live) runtime.open(board.dir);
	return { board, runtime };
}

function source(board: BoardFixture, runtime: SwarmRuntime, maxBytes?: number) {
	const reader = new SwarmBoardSource({ artifactsDir: board.root, runtime, maxBytes });
	sources.push(reader);
	return reader;
}

function view(headline: string) {
	return {
		version: 1,
		as_of_seq: 0,
		updated_at: "2026-10-06T04:20:00Z",
		headline,
		phase: { label: "Build", index: 1, total: 2 },
		attention: [],
		workstreams: [],
		milestones: [],
		risks: [],
	};
}

afterEach(async () => {
	for (const reader of sources.splice(0)) reader.dispose();
	for (const item of runtimes.splice(0)) {
		item.runtime.dispose();
		await item.lifecycle.dispose();
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const board of fixtures.splice(0)) board[Symbol.dispose]();
	resetRegisteredArtifactDirsForTests();
	SwarmRuntime.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("SwarmBoardSource", () => {
	it("renders a native post synchronously and preserves the persisted read cursor", async () => {
		const { board, runtime } = fixture(true);
		const before = BOARD_FILES.map(name => board.bytes(name).toString("base64"));
		const reader = source(board, runtime);
		const changed = vi.fn();
		const unsubscribe = reader.subscribe(changed);
		reader.refresh();
		expect(BOARD_FILES.map(name => board.bytes(name).toString("base64"))).toEqual(before);
		const started = performance.now();
		await runtime.post({ id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" }, "Live board proof");
		expect(reader.getState().head).toBe(1);
		expect(reader.getState().posts[0]?.text).toBe("Live board proof");
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(changed).toHaveBeenCalledTimes(1);
		const committed = BOARD_FILES.map(name => board.bytes(name).toString("base64"));
		reader.refresh();
		reader.resolveAction({ type: "board_post", target: 1, label: "#1" });
		expect(BOARD_FILES.map(name => board.bytes(name).toString("base64"))).toEqual(committed);
		unsubscribe();
		await runtime.post({ id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" }, "After close");
		expect(changed).toHaveBeenCalledTimes(1);
		expect(reader.getState().head).toBe(1);
	});

	it("observes persisted posts from directory events", async () => {
		const { board, runtime } = fixture();
		const reader = source(board, runtime);
		const changed = Promise.withResolvers<void>();
		reader.subscribe(() => {
			if (reader.getState().head === 1) changed.resolve();
		});
		board.store.append("coordinator", "Persisted writer");
		await changed.promise;
		expect(reader.getState().posts[0]?.text).toBe("Persisted writer");
		expect(reader.getState().members[0]?.state).toBe("stopped");
	});

	it("keeps the last good overview through malformed and oversized writes, then accepts replacement and deletion", async () => {
		const { board, runtime } = fixture();
		const target = path.join(board.dir, "view.json");
		fs.writeFileSync(target, JSON.stringify(view("First accepted view")));
		const reader = source(board, runtime, 1_024);
		const good = reader.getState().view;
		expect(good?.headline).toBe("First accepted view");
		const rejected = Promise.withResolvers<void>();
		const stop = reader.subscribe(() => {
			if (reader.getState().viewError) rejected.resolve();
		});
		fs.writeFileSync(target, "{broken");
		await rejected.promise;
		expect(reader.getState().view).toBe(good);
		expect(reader.getState().viewError).toBeTruthy();
		stop();
		fs.writeFileSync(target, JSON.stringify(view("x".repeat(2_048))));
		reader.refresh();
		expect(reader.getState().view).toBe(good);
		expect(reader.getState().viewError).toBeTruthy();
		const accepted = Promise.withResolvers<void>();
		const stopAccepted = reader.subscribe(() => {
			if (reader.getState().view?.headline === "Replacement") accepted.resolve();
		});
		fs.writeFileSync(`${target}.tmp`, JSON.stringify(view("Replacement")));
		fs.renameSync(`${target}.tmp`, target);
		await accepted.promise;
		expect(reader.getState().viewError).toBeUndefined();
		stopAccepted();
		fs.unlinkSync(target);
		reader.refresh();
		expect(reader.getState().view).toBeUndefined();
		expect(reader.getState().viewError).toBeUndefined();
	});

	it("stays timer-free with a directory watcher and stops its fallback clock on close", () => {
		vi.useFakeTimers();
		const { board, runtime } = fixture();
		const reader = source(board, runtime);
		const stop = reader.subscribe(() => {});
		expect(vi.getTimerCount()).toBe(0);
		stop();
		vi.spyOn(fs, "watch").mockImplementation(() => {
			throw new Error("Watch unavailable for this filesystem");
		});
		const changed = vi.fn();
		const stopFallback = reader.subscribe(changed);
		expect(vi.getTimerCount()).toBe(1);
		board.store.append("coordinator", "Fallback update");
		vi.advanceTimersByTime(499);
		expect(reader.getState().head).toBe(0);
		vi.advanceTimersByTime(1);
		expect(reader.getState().head).toBe(1);
		expect(changed).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2_000);
		expect(changed).toHaveBeenCalledTimes(1);
		stopFallback();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps other subscribers updating when one observer throws", async () => {
		const { board, runtime } = fixture(true);
		const reader = source(board, runtime);
		reader.subscribe(() => {
			throw new Error("Broken observer");
		});
		const changed = vi.fn();
		reader.subscribe(changed);
		await runtime.post({ id: "test-swarm", name: "coordinator", agentId: "coordinator-agent" }, "Still updates");
		expect(changed).toHaveBeenCalledTimes(1);
		expect(reader.getState().head).toBe(1);
	});

	it("validates citations, members, HTTPS URLs and artifact file containment", () => {
		const { board, runtime } = fixture();
		board.store.append("coordinator", "Evidence");
		const reader = source(board, runtime);
		const file = path.join(board.root, "report.txt");
		fs.writeFileSync(file, "report");
		expect(reader.resolveAction({ type: "file", target: file, label: "Report" }).target).toBe(fs.realpathSync(file));
		expect(() =>
			reader.resolveAction({ type: "file", target: path.join(board.root, ".."), label: "Outside" }),
		).toThrow(/artifacts/);
		expect(() => reader.resolveAction({ type: "file", target: board.dir, label: "Directory" })).toThrow(/file/);
		expect(reader.resolveAction({ type: "board_post", target: 1, label: "#1" }).target).toBe(1);
		expect(() => reader.resolveAction({ type: "board_post", target: 9, label: "#9" })).toThrow(/unavailable/);
		expect(reader.resolveAction({ type: "open_conv", target: "coordinator", label: "Coordinator" }).target).toBe(
			"coordinator",
		);
		expect(() => reader.resolveAction({ type: "open_conv", target: "unknown", label: "Unknown" })).toThrow(/member/);
		expect(reader.resolveAction({ type: "url", target: "https://example.com/report", label: "Web" }).target).toBe(
			"https://example.com/report",
		);
		for (const target of ["http://example.com", "javascript:alert(1)", "https://user:secret@example.com"]) {
			expect(() => reader.resolveAction({ type: "url", target, label: "Rejected" })).toThrow(/HTTPS/);
		}
	});
});

it.each([undefined, "test-swarm"])("refreshes only the selected board (%s)", id => {
	const { board, runtime } = fixture();
	const { board: other } = fixture();
	fs.writeFileSync(other.file("swarm.json"), JSON.stringify({ ...other.store.metadata, id: "other-swarm" }));
	registerArtifactsDir(other.root);
	const opened = vi.spyOn(BoardStore, "open");
	const reader = new SwarmBoardSource({ artifactsDir: board.root, runtime, id });
	sources.push(reader);
	reader.subscribe(() => {});
	reader.refresh();
	expect(reader.getState().id).toBe("test-swarm");
	expect(opened.mock.calls.map(call => path.resolve(call[0]))).not.toContain(path.resolve(other.dir));
});
