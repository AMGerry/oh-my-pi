import * as fs from "node:fs";
import * as path from "node:path";
import {
	type NarratorView,
	parseNarratorView,
	parseSwarmPlan,
	type SwarmPlan,
} from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import { isEnoent, isEnotdir, pathIsWithin, peekFileSync, toError } from "@oh-my-pi/pi-utils";

/** Default and ceiling for the bytes read from view.json and plan.json (narrator contract: under 64 KB). */
const DEFAULT_MAX_BYTES = 64 * 1024;
/** Ceiling for the bytes read from view.html (the narrator contract keeps the custom page under 48 KB). */
const MAX_HTML_BYTES = 48 * 1024;
const VIEW_FILE = "view.json";
const PLAN_FILE = "plan.json";
const HTML_FILE = "view.html";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const EMBEDDED_DOCUMENT =
	/<\s*\/?\s*(?:[\w.-]+:)?(?:iframe|frame|frameset|object|embed|fencedframe|portal|link|a|area)(?![\w.-])|srcdoc|shadowrootmode/i;

/** The latest good Overview data plus the reason the newest file content was refused, per file. */
export interface SwarmViewRead {
	view?: NarratorView;
	plan?: SwarmPlan;
	/** The narrator's custom page: the last accepted text of view.html, fragment or full document. */
	html?: string;
	/** Why view.json is currently refused; `view` keeps the last good version. */
	error?: string;
	/** Why plan.json is currently refused; `plan` keeps the last good version. */
	planError?: string;
	/** Why view.html is currently refused; `html` keeps the last accepted text. */
	htmlError?: string;
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

/** Turn the text of a file into its value; the message of a thrown error becomes the file's refusal reason. */
type Decode<T> = (text: string) => T;

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

/** Decode a JSON document and validate it with `parse`. */
function decodeJson<T>(file: string, parse: (value: unknown) => T): Decode<T> {
	return text => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`${file} is not valid JSON: ${toError(error).message}`);
		}
		try {
			return parse(parsed);
		} catch (error) {
			throw new Error(`${file}: ${toError(error).message}`);
		}
	};
}

/** Accept self-contained HTML fragments and full documents within the custom-page sandbox policy. */
function decodeHtml(text: string): string {
	if (text.trim() === "") throw new Error(`${HTML_FILE} is empty or holds only whitespace`);
	if (EMBEDDED_DOCUMENT.test(text)) throw new Error(`${HTML_FILE} contains embedded-document or native-link markup`);
	return text;
}

const decodeView = decodeJson(VIEW_FILE, parseNarratorView);
const decodePlan = decodeJson(PLAN_FILE, parseSwarmPlan);

/**
 * Reads the narrator's `view.json` and custom page `view.html` and the coordinator's `plan.json` from
 * one board directory and keeps the last accepted value when a later read or validation is refused.
 *
 * The caller decides when to read (file-system events); a read costs three bounded file reads and
 * returns the same objects while the file content is unchanged. A removed file drops its value. The
 * cache belongs to this instance and its directory.
 */
export class SwarmViewStore {
	readonly #root: string;
	readonly #limit: number;
	readonly #htmlLimit: number;
	readonly #view: Slot<NarratorView> = { file: VIEW_FILE };
	readonly #plan: Slot<SwarmPlan> = { file: PLAN_FILE };
	readonly #html: Slot<string> = { file: HTML_FILE };

	constructor(
		readonly dir: string,
		maxBytes = DEFAULT_MAX_BYTES,
	) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
			throw new RangeError(`maxBytes must be a positive integer (got ${maxBytes})`);
		}
		this.#root = path.resolve(dir);
		this.#limit = Math.min(maxBytes, DEFAULT_MAX_BYTES);
		this.#htmlLimit = Math.min(maxBytes, MAX_HTML_BYTES);
	}

	/** Refresh Overview data and the enabled custom page, preserving each file's last accepted value. */
	read(customPage = true): SwarmViewRead {
		this.#refresh(this.#view, this.#limit, decodeView);
		this.#refresh(this.#plan, this.#limit, decodePlan);
		if (customPage) this.#refresh(this.#html, this.#htmlLimit, decodeHtml);
		else {
			this.#html.value = undefined;
			this.#html.error = undefined;
			this.#html.text = undefined;
		}
		const result: SwarmViewRead = {};
		if (this.#view.value !== undefined) result.view = this.#view.value;
		if (this.#plan.value !== undefined) result.plan = this.#plan.value;
		if (this.#html.value !== undefined) result.html = this.#html.value;
		if (this.#view.error !== undefined) result.error = this.#view.error;
		if (this.#plan.error !== undefined) result.planError = this.#plan.error;
		if (this.#html.error !== undefined) result.htmlError = this.#html.error;
		return result;
	}

	#refresh<T>(slot: Slot<T>, limit: number, decode: Decode<T>): void {
		const read = readBoundedText(this.#root, slot.file, limit);
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
		try {
			slot.value = decode(read.text);
			slot.error = undefined;
		} catch (error) {
			slot.error = toError(error).message;
		}
	}
}
