import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { parseMentions } from "./mentions";
import {
	channelsSchema,
	memberNameSchema,
	memberSchema,
	membersSchema,
	metadataSchema,
	postSchema,
	SwarmRefusal,
	type BoardPost,
	type BoardReadOptions,
	type BoardReadResult,
	type SwarmCapabilities,
	type SwarmChannel,
	type SwarmMember,
	type SwarmMetadata,
} from "./types";

/** Atomic, durable metadata replacement; the temporary file belongs to this write. */
function writeJson(file: string, value: unknown): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, file);
		if (process.platform !== "win32") {
			const parent = fs.openSync(path.dirname(file), "r");
			try {
				fs.fsyncSync(parent);
			} finally {
				fs.closeSync(parent);
			}
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.rmSync(temporary, { force: true });
	}
}

export interface CreateBoardOptions {
	id: string;
	title: string;
	coordinator: SwarmMember;
	capabilities: SwarmCapabilities;
}

/** Durable board and per-member cursors, owned by the main-thread swarm runtime. */
export class BoardStore {
	readonly dir: string;
	readonly readOnly: boolean;
	readonly metadata: SwarmMetadata;
	readonly capabilities: SwarmCapabilities;
	#title: string;
	#members: Map<string, SwarmMember>;
	#channels: Map<string, SwarmChannel>;
	#posts: BoardPost[];
	/** Set once a board write fails after its descriptor opened; bytes of that post may be on disk. */
	#failedAppend: { error: unknown } | undefined;

	private constructor(dir: string, readOnly: boolean) {
		this.dir = path.resolve(dir);
		this.readOnly = readOnly;
		this.metadata = metadataSchema.assert(JSON.parse(fs.readFileSync(path.join(this.dir, "swarm.json"), "utf8")));
		const members = membersSchema.assert(JSON.parse(fs.readFileSync(path.join(this.dir, "members.json"), "utf8")));
		const channels = channelsSchema.assert(JSON.parse(fs.readFileSync(path.join(this.dir, "channels.json"), "utf8")));
		this.#title = members.title;
		this.capabilities = members.capabilities;
		this.#members = new Map(Object.entries(members.members));
		this.#channels = new Map(Object.entries(channels));
		for (const key of [...this.#members.keys(), ...this.#channels.keys()]) memberNameSchema.assert(key);
		this.#posts = this.#loadPosts();
		// lastPost* derives from the board: members.json can lag behind a committed post.
		const lastPosts = new Map<string, BoardPost>();
		for (const post of this.#posts) lastPosts.set(post.agent, post);
		for (const [name, member] of this.#members) {
			const last = lastPosts.get(name);
			member.lastPostSeq = last?.seq ?? 0;
			member.lastPostTime = last?.time ?? null;
		}
	}

	static create(dir: string, options: CreateBoardOptions): BoardStore {
		const metadata = metadataSchema.assert({
			version: 1,
			id: options.id,
			title: options.title,
			created: new Date().toISOString(),
			coordinator: options.coordinator.agentId,
		});
		const members = membersSchema.assert({
			title: options.title,
			members: { coordinator: options.coordinator },
			capabilities: options.capabilities,
		});
		fs.mkdirSync(dir, { recursive: true });
		// Exclusive creation preserves a board already owned by a resumed session.
		const fd = fs.openSync(path.join(dir, "board.jsonl"), "wx", 0o600);
		fs.closeSync(fd);
		writeJson(path.join(dir, "members.json"), members);
		writeJson(path.join(dir, "channels.json"), {});
		writeJson(path.join(dir, "swarm.json"), metadata);
		return new BoardStore(dir, false);
	}

	static open(dir: string, options: { readOnly?: boolean } = {}): BoardStore {
		return new BoardStore(dir, options.readOnly ?? false);
	}

	get title(): string {
		return this.#title;
	}

	get head(): number {
		return this.#posts.length;
	}

	get boardUri(): string {
		return `swarm://${this.metadata.id}`;
	}

	#loadPosts(): BoardPost[] {
		const contents = fs.readFileSync(path.join(this.dir, "board.jsonl"), "utf8");
		const completeEnd = contents.lastIndexOf("\n") + 1;
		if (!this.readOnly && completeEnd !== contents.length) {
			throw new Error(`Incomplete board tail in ${this.dir}; open read-only to inspect the durable prefix`);
		}
		const posts: BoardPost[] = [];
		for (const line of contents.slice(0, completeEnd).split("\n")) {
			if (line === "") continue;
			const post = postSchema.assert(JSON.parse(line));
			if (post.seq !== posts.length + 1) throw new Error(`Noncontiguous board sequence at #${post.seq}`);
			posts.push(post);
		}
		return posts;
	}

	member(name: string): SwarmMember {
		const member = this.#members.get(name);
		if (!member) throw new SwarmRefusal(`Unknown swarm member: ${name}`);
		return structuredClone(member);
	}

	listMembers(): Array<SwarmMember & { name: string }> {
		return [...this.#members].map(([name, member]) => ({ name, ...structuredClone(member) }));
	}

	channels(): Map<string, SwarmChannel> {
		return structuredClone(this.#channels);
	}

	posts(): BoardPost[] {
		return structuredClone(this.#posts);
	}

	#assertWritable(): void {
		if (this.readOnly) throw new SwarmRefusal("This board is open read-only");
	}

	#writeMembers(members: Map<string, SwarmMember>, title: string): void {
		writeJson(path.join(this.dir, "members.json"), {
			title,
			members: Object.fromEntries(members),
			capabilities: this.capabilities,
		});
	}

	#saveMembers(members: Map<string, SwarmMember>, title = this.#title): void {
		this.#assertWritable();
		this.#writeMembers(members, title);
		this.#members = members;
		this.#title = title;
	}

	setTitle(title: string): void {
		if (!title.trim()) throw new SwarmRefusal("A swarm title must contain text");
		this.#saveMembers(new Map(this.#members), title.trim());
		writeJson(path.join(this.dir, "swarm.json"), { ...this.metadata, title: this.#title });
		this.metadata.title = this.#title;
	}

	addMember(name: string, member: SwarmMember): void {
		if (!memberNameSchema.allows(name) || name === "all" || name === "coordinator") {
			throw new SwarmRefusal(
				"Use a lowercase member name of 1–40 letters, digits or hyphens; all and coordinator are reserved",
			);
		}
		if (this.#members.has(name)) throw new SwarmRefusal(`Member name ${name} has already been used`);
		const next = new Map(this.#members);
		next.set(name, structuredClone(memberSchema.assert(member)));
		this.#saveMembers(next);
	}

	/** A change whose value is undefined removes that field; the result must still be a complete member. */
	updateMember(name: string, changes: Partial<SwarmMember>): void {
		const merged = Object.fromEntries(
			Object.entries({ ...this.member(name), ...structuredClone(changes) }).filter(
				([, value]) => value !== undefined,
			),
		);
		const next = new Map(this.#members);
		next.set(name, memberSchema.assert(merged));
		this.#saveMembers(next);
	}

	setChannel(name: string, channel: SwarmChannel): void {
		this.#assertWritable();
		if (!memberNameSchema.allows(name) || name === "main")
			throw new SwarmRefusal("main is implicit; choose a named channel");
		const next = new Map(this.#channels);
		next.set(name, structuredClone(channel));
		const validated = channelsSchema.assert(Object.fromEntries(next));
		writeJson(path.join(this.dir, "channels.json"), validated);
		this.#channels = next;
	}

	/** Append and fsync the post before exposing it to subscribers; the fsynced line is the commit. */
	append(agent: string, text: string, channel?: string): BoardPost {
		this.#assertWritable();
		if (this.#failedAppend) {
			throw new Error(`Board ${this.dir} is locked for appends after an unconfirmed write; reopen it to continue`, {
				cause: this.#failedAppend.error,
			});
		}
		const member = this.member(agent);
		if (member.killed) throw new SwarmRefusal(`Member ${agent} is killed`);
		if (!text.trim()) throw new SwarmRefusal("A board post must contain text");
		const addressed = parseMentions(text);
		if (addressed.mentions.includes("#main")) throw new SwarmRefusal("Use @all to address main");
		const destination = channel ?? member.channels[0] ?? "main";
		if (destination !== "main") {
			const area = this.#channels.get(destination);
			if (!area || area.archived) throw new SwarmRefusal(`Channel ${destination} is unavailable for posts`);
			if (member.role === "worker" && !member.channels.includes(destination)) {
				throw new SwarmRefusal(`Member ${agent} is not subscribed to ${destination}`);
			}
		}
		const post = postSchema.assert({
			seq: this.head + 1,
			agent,
			text,
			time: new Date().toISOString(),
			...(destination === "main" ? {} : { channel: destination }),
			...addressed,
		});
		const fd = fs.openSync(path.join(this.dir, "board.jsonl"), "a", 0o600);
		try {
			fs.writeFileSync(fd, `${JSON.stringify(post)}\n`, "utf8");
			fs.fsyncSync(fd);
		} catch (error) {
			// Part or all of the line may be on disk, so writing this seq again would corrupt the log.
			this.#failedAppend = { error };
			throw error;
		} finally {
			try {
				fs.closeSync(fd);
			} catch (error) {
				logger.warn("Swarm board descriptor failed to close", { dir: this.dir, error: String(error) });
			}
		}
		this.#posts.push(post);
		const next = new Map(this.#members);
		next.set(agent, { ...member, lastPostSeq: post.seq, lastPostTime: post.time });
		this.#members = next;
		try {
			this.#writeMembers(next, this.#title);
		} catch (error) {
			logger.warn("Swarm members.json missed a committed post; lastPost is rebuilt from the board on open", {
				dir: this.dir,
				seq: post.seq,
				error: String(error),
			});
		}
		return structuredClone(post);
	}

	/** Addressing is independent of channel visibility; explicit names cross channels. */
	addresses(post: BoardPost, name: string): boolean {
		const member = this.member(name);
		if (post.all || post.mentions.includes(name) || (member.group && post.mentions.includes(member.group)))
			return true;
		// The narrator relay marker also reaches a numbered replacement.
		if (member.role === "narrator" && post.mentions.includes("narrator")) return true;
		return post.mentions.some(mention => {
			if (!mention.startsWith("#")) return false;
			const channel = this.#channels.get(mention.slice(1));
			return !!channel && !channel.archived && (member.role !== "worker" || channel.subscribers.includes(name));
		});
	}

	visible(post: BoardPost, name: string, explicitChannel?: string): boolean {
		const member = this.member(name);
		const channel = post.channel ?? "main";
		if (explicitChannel && explicitChannel !== "*" && channel !== explicitChannel) return false;
		if (member.role !== "worker" || channel === "main" || this.addresses(post, name)) return true;
		if (!member.channels.includes(channel)) return false;
		return explicitChannel !== undefined || post.seq > (member.subscribedSince?.[channel] ?? 0);
	}

	select(name: string, options: BoardReadOptions = {}): BoardPost[] {
		const member = this.member(name);
		const since = options.since ?? member.lastReadSeq;
		const limit = options.limit ?? 200;
		if (!Number.isSafeInteger(since) || since < 0) throw new SwarmRefusal("since must be a nonnegative safe integer");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
			throw new SwarmRefusal("limit must be between 1 and 2000");
		if (options.channel === "*" && member.role === "worker")
			throw new SwarmRefusal("All-channel reads require a coordinator, narrator or monitor");
		return structuredClone(
			this.#posts.filter(post => post.seq > since && this.visible(post, name, options.channel)).slice(0, limit),
		);
	}

	/** Test the wake condition across the visible backlog while reads remain paged. */
	hasPending(name: string, since: number, mentionsOnly: boolean): boolean {
		this.member(name);
		if (!Number.isSafeInteger(since) || since < 0) throw new SwarmRefusal("since must be a nonnegative safe integer");
		return this.#posts.some(
			post => post.seq > since && this.visible(post, name) && (!mentionsOnly || this.addresses(post, name)),
		);
	}

	read(name: string, options: BoardReadOptions = {}): BoardReadResult {
		const messages = this.select(name, options);
		const prior = this.member(name).lastReadSeq;
		const lastReadSeq = Math.max(prior, messages.at(-1)?.seq ?? prior);
		if (lastReadSeq !== prior) this.updateMember(name, { lastReadSeq });
		return { messages, lastReadSeq, head: this.head };
	}
}
