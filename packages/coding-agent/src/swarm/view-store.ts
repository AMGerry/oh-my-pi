import * as fs from "node:fs";
import * as path from "node:path";
import {
	type NarratorView,
	parseNarratorView,
	parseSwarmPlan,
	type SwarmPlan,
} from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import { isEnoent, isEnotdir, pathIsWithin, peekFileSync, toError } from "@oh-my-pi/pi-utils";

/** Default and ceiling for the bytes read from one file (the narrator contract keeps view.json under 64 KB). */
const DEFAULT_MAX_BYTES = 64 * 1024;
const VIEW_FILE = "view.json";
const PLAN_FILE = "plan.json";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The latest good Overview data plus the reason the newest file content was refused, per file. */
export interface SwarmViewRead {
	view?: NarratorView;
	plan?: SwarmPlan;
	/** Why view.json is currently refused; `view` keeps the last good version. */
	error?: string;
	/** Why plan.json is currently refused; `plan` keeps the last good version. */
	planError?: string;
}

type FileRead =
	| { readonly kind: "missing" }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "text"; readonly text: string };

/** What one file contributes: the last good value, the current refusal and the content last judged. */
interface Slot<T> {
	readonly file: string;
	value?: T;
	error?: string;
	text?: string;
}

/**
 * Read one file of the board directory with at most `limit` bytes of content. A symlink that leaves
 * the directory, a non-regular file, an oversized file and invalid UTF-8 come back as `refused`;
 * an absent file comes back as `missing`.
 */
function readBoundedText(dir: string, name: string, limit: number): FileRead {
	try {
		const real = fs.realpathSync(path.join(dir, name));
		if (!pathIsWithin(fs.realpathSync(dir), real)) {
			return { kind: "refused", reason: `${name} resolves to a path outside the board directory` };
		}
		if (!fs.statSync(real).isFile()) return { kind: "refused", reason: `${name} is not a regular file` };
		// One extra byte separates "exactly at the limit" from "over the limit"; the rest of a larger file stays unread.
		return peekFileSync<FileRead>(real, limit + 1, bytes => {
			if (bytes.byteLength > limit) return { kind: "refused", reason: `${name} is larger than ${limit} bytes` };
			try {
				return { kind: "text", text: UTF8.decode(bytes) };
			} catch {
				return { kind: "refused", reason: `${name} is not valid UTF-8` };
			}
		});
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return { kind: "missing" };
		return { kind: "refused", reason: `${name} cannot be read: ${toError(error).message}` };
	}
}

/**
 * Reads the narrator's `view.json` and the coordinator's `plan.json` from one board directory and
 * keeps the last good value of each while later content is half written, oversized or invalid.
 *
 * The caller decides when to read (file-system events); a read costs two bounded file reads and
 * returns the same objects while the file content is unchanged. The cache belongs to this instance
 * and its directory.
 */
export class SwarmViewStore {
	readonly #root: string;
	readonly #limit: number;
	readonly #view: Slot<NarratorView> = { file: VIEW_FILE };
	readonly #plan: Slot<SwarmPlan> = { file: PLAN_FILE };

	constructor(
		readonly dir: string,
		maxBytes = DEFAULT_MAX_BYTES,
	) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
			throw new RangeError(`maxBytes must be a positive integer (got ${maxBytes})`);
		}
		this.#root = path.resolve(dir);
		this.#limit = Math.min(maxBytes, DEFAULT_MAX_BYTES);
	}

	/** Refresh both files and return the last good values with the reason for any refused content. */
	read(): SwarmViewRead {
		this.#refresh(this.#view, parseNarratorView);
		this.#refresh(this.#plan, parseSwarmPlan);
		const result: SwarmViewRead = {};
		if (this.#view.value !== undefined) result.view = this.#view.value;
		if (this.#plan.value !== undefined) result.plan = this.#plan.value;
		if (this.#view.error !== undefined) result.error = this.#view.error;
		if (this.#plan.error !== undefined) result.planError = this.#plan.error;
		return result;
	}

	#refresh<T>(slot: Slot<T>, parse: (value: unknown) => T): void {
		const read = readBoundedText(this.#root, slot.file, this.#limit);
		if (read.kind === "missing") {
			slot.value = undefined;
			slot.error = undefined;
			slot.text = undefined;
			return;
		}
		if (read.kind === "refused") {
			slot.error = read.reason;
			slot.text = undefined;
			return;
		}
		if (read.text === slot.text) return;
		slot.text = read.text;
		let parsed: unknown;
		try {
			parsed = JSON.parse(read.text);
		} catch (error) {
			slot.error = `${slot.file} is not valid JSON: ${toError(error).message}`;
			return;
		}
		try {
			slot.value = parse(parsed);
			slot.error = undefined;
		} catch (error) {
			slot.error = `${slot.file}: ${toError(error).message}`;
		}
	}
}
