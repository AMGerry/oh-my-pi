import type { NarratorAction, NarratorView, SwarmPlan } from "./swarm-view-model";

export type SwarmBoardTab = "board" | "members" | "overview";

export interface SwarmBoardPost {
	readonly seq: number;
	readonly agent: string;
	readonly text: string;
	readonly time: string;
	readonly channel?: string;
}

export interface SwarmBoardMember {
	readonly name: string;
	readonly agentId: string;
	readonly role: "coordinator" | "worker" | "narrator" | "monitor";
	readonly state: "working" | "waiting" | "stopped" | "killed";
	readonly model: string;
	readonly unread: number;
	readonly lastReadSeq: number;
	readonly lastPostSeq: number;
	readonly lastPostTime: string | null;
	readonly wakeMode: "mentions" | "any" | null;
	readonly waitSince: number | null;
	readonly channels: readonly string[];
	readonly error?: string;
}

/** Read-only projection of one board and its optional narrator documents. */
export interface SwarmBoardState {
	readonly id: string;
	readonly title: string;
	readonly head: number;
	readonly members: readonly SwarmBoardMember[];
	readonly posts: readonly SwarmBoardPost[];
	readonly view?: NarratorView;
	readonly plan?: SwarmPlan;
	readonly error?: string;
	readonly viewError?: string;
	readonly planError?: string;
	readonly customPageRevision?: string;
	readonly customPageError?: string;
}

export interface SwarmBoardDeps {
	readonly terminal: { readonly rows: number };
	getState(): SwarmBoardState;
	subscribe(listener: () => void): () => void;
	requestRender(): void;
	onClose(): void;
	onNavigate(action: NarratorAction): void;
	onCustomPage?(): void;
	refresh(): void;
	initialTab?: SwarmBoardTab;
	since?: number;
}
