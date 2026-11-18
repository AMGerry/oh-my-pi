import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SwarmBoardState } from "@oh-my-pi/pi-tui/overlays/swarm-board-types";
import { type NarratorAction, parseNarratorAction } from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SwarmRuntime } from "../swarm/runtime";
import { getSwarmSurface, getSwarmSurfaceAt } from "../swarm/surface";
import { SwarmViewStore } from "../swarm/view-store";

const WATCHED_FILES: Record<string, true> = {
	"swarm.json": true,
	"board.jsonl": true,
	"members.json": true,
	"channels.json": true,
	"view.json": true,
	"view.html": true,
	"plan.json": true,
};

export interface SwarmBoardSourceOptions {
	id?: string;
	artifactsDir: string;
	runtime?: SwarmRuntime;
	maxBytes?: number;
}

/** Runtime changes update live rows; directory events update narrator documents and readonly boards. */
export class SwarmBoardSource {
	readonly #runtime: SwarmRuntime;
	readonly #listeners = new Set<() => void>();
	#state: SwarmBoardState = { id: "", title: "Swarm", head: 0, posts: [], members: [] };
	#dir: string;
	#view: SwarmViewStore | undefined;
	#html?: string;
	#watcher: fs.FSWatcher | undefined;
	#watchPath: string | undefined;
	#stopRuntime: (() => void) | undefined;
	#queued = false;
	#disposed = false;
	#fingerprint = "";
	#pollTimer?: Timer;
	#watchFailure?: string;

	constructor(readonly options: SwarmBoardSourceOptions) {
		this.#runtime = options.runtime ?? SwarmRuntime.local();
		this.#dir = path.resolve(options.artifactsDir, "swarm");
		this.refresh();
	}

	getState(): SwarmBoardState {
		return this.#state;
	}
	get dir(): string {
		return this.#dir;
	}

	get customPageHtml(): string | undefined {
		return this.#html;
	}

	subscribe(listener: () => void): () => void {
		if (this.#disposed) throw new Error("The board source is closed");
		this.#listeners.add(listener);
		this.#stopRuntime ??= this.#runtime.onChange(event => {
			if (!this.#state.id || this.#state.id === event.swarmId) this.refresh();
		});
		this.#watch();
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size > 0) return;
			this.#watcher?.close();
			this.#watcher = undefined;
			this.#watchPath = undefined;
			this.#stopRuntime?.();
			this.#stopRuntime = undefined;
			clearTimeout(this.#pollTimer);
			this.#pollTimer = undefined;
		};
	}

	refresh(): void {
		if (this.#disposed) return;
		let next: SwarmBoardState;
		try {
			const options = { artifactsDir: this.options.artifactsDir, runtime: this.#runtime };
			const requestedDir = path.resolve(this.options.artifactsDir, "swarm");
			const ownDir = fs.existsSync(requestedDir) ? fs.realpathSync(requestedDir) : requestedDir;
			let surface =
				this.options.id && this.#state.id !== this.options.id
					? getSwarmSurface(this.options.id, options)
					: getSwarmSurfaceAt(this.options.id ? this.#dir : ownDir, this.#runtime);
			if (this.options.id && surface?.snapshot.id !== this.options.id)
				surface = getSwarmSurface(this.options.id, options);
			if (!surface && fs.existsSync(path.join(ownDir, "swarm.json")))
				throw new Error("The session's swarm board could not be read.");
			if (!surface) {
				this.#html = undefined;
				next = { id: "", title: "Swarm", head: 0, posts: [], members: [] };
			} else {
				if (!this.#view || surface.board.dir !== this.#dir) {
					this.#dir = surface.board.dir;
					this.#view = new SwarmViewStore(this.#dir, this.options.maxBytes);
				}
				const customPage = surface.board.capabilities.customPage;
				const documents = this.#view.read(customPage);
				this.#html = customPage ? documents.html : undefined;
				next = {
					...surface.snapshot,
					posts: surface.board.posts(),
					view: documents.view,
					plan: documents.plan,
					viewError: documents.error,
					planError: documents.planError,
					customPageRevision:
						this.#html === undefined ? undefined : createHash("sha256").update(this.#html).digest("hex"),
					customPageError: customPage ? documents.htmlError : undefined,
				};
			}
		} catch (error) {
			next = { ...this.#state, error: error instanceof Error ? error.message : String(error) };
		}
		const fingerprint = JSON.stringify(next);
		if (fingerprint !== this.#fingerprint) {
			this.#fingerprint = fingerprint;
			this.#state = next;
			const observers = [...this.#listeners];
			for (const listener of observers) {
				try {
					listener();
				} catch (error) {
					logger.warn("Swarm board observer failed", { error: String(error) });
				}
			}
		}
		this.#watch();
	}

	#watch(): void {
		if (this.#disposed || this.#listeners.size === 0) return;
		let target = this.#dir;
		while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
		if (this.#watcher && target === this.#watchPath) return;
		this.#watcher?.close();
		this.#watcher = undefined;
		this.#watchPath = undefined;
		try {
			const child = path.relative(target, this.#dir).split(path.sep)[0];
			const watcher = fs.watch(target, { persistent: false }, (_event, name) => {
				if (
					name !== null &&
					(child ? name !== child : !Object.hasOwn(WATCHED_FILES, name) && name !== path.basename(this.#dir))
				)
					return;
				if (this.#queued) return;
				this.#queued = true;
				queueMicrotask(() => {
					this.#queued = false;
					if (this.#listeners.size > 0) this.refresh();
				});
			});
			this.#watcher = watcher;
			this.#watchPath = target;
			this.#watchFailure = undefined;
			clearTimeout(this.#pollTimer);
			this.#pollTimer = undefined;
			watcher.on("error", error => {
				if (this.#watcher !== watcher) return;
				watcher.close();
				this.#watcher = undefined;
				this.#watchPath = undefined;
				logger.warn("Swarm board watch switched to periodic refresh", { dir: target, error: error.message });
				this.#scheduleFallback();
			});
		} catch (error) {
			const message = String(error);
			if (message !== this.#watchFailure) {
				this.#watchFailure = message;
				logger.warn("Swarm board watch switched to periodic refresh", { dir: target, error: message });
			}
			this.#scheduleFallback();
		}
	}

	#scheduleFallback(): void {
		if (this.#disposed || this.#listeners.size === 0 || this.#watcher || this.#pollTimer) return;
		this.#pollTimer = setTimeout(() => {
			this.#pollTimer = undefined;
			this.refresh();
			this.#scheduleFallback();
		}, 500);
		this.#pollTimer.unref();
	}

	/** Validate navigation against the current evidence and this session's artifact tree. */
	resolveAction(request: unknown): NarratorAction {
		const action = parseNarratorAction(request);
		if (action.type === "board_post") {
			if (!this.#state.posts.some(post => post.seq === action.target))
				throw new Error(`Board post #${action.target} is unavailable`);
		} else if (action.type === "open_conv") {
			if (!this.#state.members.some(member => member.name === action.target))
				throw new Error(`Unknown swarm member: ${action.target}`);
		} else if (action.type === "url") {
			const target = new URL(action.target);
			if (target.protocol !== "https:" || target.username || target.password)
				throw new Error("Overview links require a credential-free HTTPS URL.");
			return { ...action, target: target.href };
		} else {
			const root = fs.realpathSync(path.dirname(this.#dir));
			const target = fs.realpathSync(path.resolve(root, action.target));
			const relative = path.relative(root, target);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
				throw new Error("Overview files must belong to this session's artifacts");
			if (!fs.statSync(target).isFile()) throw new Error("The overview target must be a file");
			return { ...action, target };
		}
		return action;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#watcher?.close();
		this.#watcher = undefined;
		this.#stopRuntime?.();
		this.#stopRuntime = undefined;
		this.#listeners.clear();
		clearTimeout(this.#pollTimer);
		this.#pollTimer = undefined;
	}
}
