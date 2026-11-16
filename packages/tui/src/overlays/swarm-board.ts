import type { Component } from "../tui";
import { ScrollView } from "../components/scroll-view";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { matchesKey } from "../keys";
import { motionEffectsEnabled } from "../motion-effects";
import { isNativeRendering } from "../native/state";
import { node, text } from "../native/describe";
import { actionButton, hintsRow, overlayCard } from "../native/overlay";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { plainText } from "../native/spans";
import { theme } from "../theme/theme";
import { truncateToWidth, wrapTextWithAnsi } from "../utils";
import { buildSwarmBoardRows, type SwarmBoardRow } from "./swarm-board-projection";
import type { SwarmBoardDeps, SwarmBoardState, SwarmBoardTab } from "./swarm-board-types";

const TABS: readonly SwarmBoardTab[] = ["board", "members", "overview"];
const TAB_LABELS: Record<SwarmBoardTab, string> = { board: "Board", members: "Members", overview: "Overview" };

/** Event-driven board sheet. Native keyed rows use the terminal's motion and focus behavior. */
export class SwarmBoardOverlay implements Component {
	readonly nativeOverlay = { role: "omp.overlay.swarm", size: "full", anchor: "center", head: "Swarm" } as const;
	readonly #scroll = new ScrollView([], { height: 0, scrollbar: "auto" });
	readonly #unsubscribe: () => void;
	#state: SwarmBoardState;
	#tab: SwarmBoardTab;
	#rows: SwarmBoardRow[];
	#selected = 0;
	#action = 0;
	#unreadSince: number;
	#disposed = false;
	#native: NativeNode | undefined;
	#transition = 0;
	#transitionTimer: NodeJS.Timeout | undefined;
	#rowStarts: number[] = [];
	#revealSelection = true;
	#lastWidth = 0;

	constructor(private readonly deps: SwarmBoardDeps) {
		this.#state = deps.getState();
		this.#tab = deps.initialTab ?? "board";
		this.#unreadSince =
			deps.since ?? this.#state.members.find(member => member.role === "coordinator")?.lastReadSeq ?? 0;
		this.#rows = buildSwarmBoardRows(this.#state, this.#tab, this.#unreadSince);
		if (this.#tab === "board") {
			const unread = this.#rows.findIndex(item => item.key === "unread");
			this.#selected = unread >= 0 ? unread : Math.max(0, this.#rows.length - 1);
		}
		this.#unsubscribe = deps.subscribe(() => this.#refresh());
		this.#animate();
	}

	get tab(): SwarmBoardTab {
		return this.#tab;
	}
	get selectedKey(): string | undefined {
		return this.#rows[this.#selected]?.key;
	}

	#refresh(): void {
		if (this.#disposed) return;
		const selected = this.selectedKey;
		const atEnd = this.#selected === this.#rows.length - 1;
		this.#state = this.deps.getState();
		this.#rows = buildSwarmBoardRows(this.#state, this.#tab, this.#unreadSince);
		const restored = this.#rows.findIndex(item => item.key === selected);
		this.#selected = atEnd ? Math.max(0, this.#rows.length - 1) : Math.max(0, restored);
		this.#action = 0;
		this.#revealSelection = true;
		this.#native = undefined;
		this.#animate();
		this.deps.requestRender();
	}

	showTab(tab: SwarmBoardTab, seq?: number): void {
		this.#tab = tab;
		this.#rows = buildSwarmBoardRows(this.#state, tab, this.#unreadSince);
		this.#selected =
			seq === undefined
				? 0
				: Math.max(
						0,
						this.#rows.findIndex(item => item.key === `post-${seq}`),
					);
		this.#action = 0;
		this.#scroll.scrollToTop();
		this.#revealSelection = true;
		this.#native = undefined;
		this.#animate();
		this.deps.requestRender();
	}

	showSince(tab: SwarmBoardTab, since: number): void {
		this.#unreadSince = since;
		const first = this.#state.posts.find(post => post.seq > since);
		this.showTab(tab, first?.seq ?? this.#state.posts.at(-1)?.seq);
	}

	#select(index: number): void {
		this.#selected = Math.max(0, Math.min(this.#rows.length - 1, index));
		this.#action = 0;
		this.#revealSelection = true;
		this.#native = undefined;
		this.deps.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.deps.onClose();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const step = matchesKey(data, "shift+tab") ? -1 : 1;
			this.showTab(TABS[(TABS.indexOf(this.#tab) + step + TABS.length) % TABS.length]!);
		} else if (data === "j" || matchesKey(data, "down")) this.#select(this.#selected + 1);
		else if (data === "k" || matchesKey(data, "up")) this.#select(this.#selected - 1);
		else if (matchesKey(data, "home") || data === "g") this.#select(0);
		else if (matchesKey(data, "end") || data === "G") this.#select(this.#rows.length - 1);
		else if (matchesKey(data, "enter")) this.#activate(this.#selected, this.#action);
		else if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const count = this.#rows[this.#selected]?.actions?.length ?? 0;
			if (count) this.#action = (this.#action + (matchesKey(data, "left") ? -1 : 1) + count) % count;
			this.#native = undefined;
			this.deps.requestRender();
		} else if (data === "r") this.deps.refresh();
		else if (this.#scroll.handleScrollKey(data)) {
			this.#revealSelection = false;
			this.deps.requestRender();
		}
	}

	#activate(index: number, actionIndex: number): void {
		const action = this.#rows[index]?.actions?.[actionIndex];
		if (!action) return;
		if (action.type === "board_post" && this.#state.posts.some(post => post.seq === action.target))
			this.showTab("board", action.target);
		else this.deps.onNavigate(action);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" && event.key.endsWith("tabs")) {
			if (TABS.some(tab => tab === event.item)) this.showTab(event.item as SwarmBoardTab);
		} else if (event.type === "select" || event.type === "activate") {
			const index = this.#rows.findIndex(item => item.key === event.item);
			if (index >= 0) {
				this.#select(index);
				if (event.type === "activate") this.#activate(index, 0);
			}
		} else if (event.type === "action") {
			if (event.act === "close") this.deps.onClose();
			else if (event.act === "refresh") this.deps.refresh();
			else {
				for (const [index, item] of this.#rows.entries()) {
					const action =
						item.actions?.findIndex(
							candidate =>
								event.act ===
								`navigate:${encodeURIComponent(item.key)}:${encodeURIComponent(`${candidate.type}:${candidate.target}`)}`,
						) ?? -1;
					if (action >= 0) {
						this.#select(index);
						this.#activate(index, action);
						break;
					}
				}
			}
		}
	}

	/** Brief ANSI entrance/refresh feedback; the timer ends after six frames. */
	#animate(): void {
		clearTimeout(this.#transitionTimer);
		this.#transitionTimer = undefined;
		this.#transition = 0;
		if (this.#disposed || isNativeRendering() || !motionEffectsEnabled()) return;
		this.#transition = 6;
		const tick = () => {
			this.#transitionTimer = undefined;
			if (this.#disposed) return;
			this.#transition = motionEffectsEnabled() ? Math.max(0, this.#transition - 1) : 0;
			this.deps.requestRender();
			if (this.#transition > 0) this.#transitionTimer = setTimeout(tick, 30);
		};
		this.#transitionTimer = setTimeout(tick, 30);
	}

	render(width: number): string[] {
		const columns = Math.max(0, Math.floor(width));
		const height = Math.max(0, Math.floor(this.deps.terminal.rows));
		if (columns < 8 || height < 6) {
			const selected = this.#rows[this.#selected];
			return [
				`Swarm · #${this.#state.head}`,
				TAB_LABELS[this.#tab],
				...(selected ? [selected.title, ...(selected.text ? [selected.text] : [])] : []),
				"Esc Close",
			]
				.flatMap(value => (columns > 0 ? wrapTextWithAnsi(value, columns) : []))
				.slice(0, height);
		}
		const inner = columns - 4;
		const content: string[] = [];
		this.#rowStarts = [];
		for (const [index, item] of this.#rows.entries()) {
			this.#rowStarts.push(content.length);
			const selected = index === this.#selected;
			const prefix = selected ? `${theme.fg("accent", theme.nav.cursor)} ` : "  ";
			const inset = this.#transition > 0 ? " ".repeat(Math.min(2, Math.ceil(this.#transition / 3))) : "";
			const room = Math.max(1, inner - 3 - inset.length);
			const title = theme.fg(
				selected ? "accent" : item.tone === "muted" ? "dim" : (item.tone ?? "text"),
				item.title,
			);
			for (const [line, value] of wrapTextWithAnsi(title, room).entries())
				content.push(`${line === 0 ? prefix : "  "}${inset}${value}`);
			for (const value of item.text ? wrapTextWithAnsi(item.text, room) : []) content.push(`  ${inset}${value}`);
			if (item.meta)
				for (const value of wrapTextWithAnsi(theme.fg("dim", item.meta), room)) content.push(`  ${inset}${value}`);
			if (item.actions?.length && (selected || this.#tab === "overview")) {
				const actions = item.actions
					.map((action, actionIndex) =>
						selected && actionIndex === this.#action
							? theme.fg("accent", `[${plainText(action.label)}]`)
							: plainText(action.label),
					)
					.join("  ");
				for (const value of wrapTextWithAnsi(actions, room)) content.push(`  ${inset}${value}`);
			}
			content.push("");
		}
		this.#scroll.setHeight(height - 5);
		this.#scroll.setLines(content);
		if (this.#revealSelection || columns !== this.#lastWidth) {
			this.#scroll.setActiveRow(this.#rowStarts[this.#selected]);
			this.#revealSelection = false;
		} else this.#scroll.setActiveRow(undefined);
		this.#lastWidth = columns;
		const tabs = TABS.map(tab =>
			tab === this.#tab ? theme.bold(theme.fg("accent", TAB_LABELS[tab])) : theme.fg("muted", TAB_LABELS[tab]),
		).join("   ");
		const actions = this.#rows[this.#selected]?.actions?.length ?? 0;
		const footer = [
			"j/k Move",
			"Tab View",
			...(actions ? ["Enter Open"] : []),
			...(actions > 1 ? ["←/→ Action"] : []),
			"r Refresh",
			"Esc Close",
		].join(" · ");
		return [
			topBorder(columns, `Swarm · ${plainText(this.#state.title)} · #${this.#state.head}`),
			row(truncateToWidth(tabs, inner), columns),
			divider(columns),
			...this.#scroll.render(inner).map(line => row(truncateToWidth(line, inner), columns)),
			row(truncateToWidth(footer, inner), columns),
			bottomBorder(columns),
		];
	}

	describe(_cx: DescribeContext): NativeNode {
		if (this.#native) return this.#native;
		const items = this.#rows.map(item =>
			node(
				"item",
				{
					label: item.title,
					value: item.meta,
					tone: item.tone,
				},
				[
					...(item.text ? [text(item.text, { wrap: "word" })] : []),
					...(item.actions?.length
						? [
								node(
									"row",
									{ gap: "sm", wrap: true },
									item.actions.map(action =>
										actionButton(
											plainText(action.label),
											`navigate:${encodeURIComponent(item.key)}:${encodeURIComponent(`${action.type}:${action.target}`)}`,
										),
									),
								),
							]
						: []),
				],
				item.key,
			),
		);
		this.#native = overlayCard("omp.overlay.swarm", `${plainText(this.#state.title)} · #${this.#state.head}`, [
			node(
				"tabs",
				{ items: TABS.map(tab => ({ id: tab, label: TAB_LABELS[tab] })), active: this.#tab },
				undefined,
				"tabs",
			),
			node(
				"list",
				{ selected: this.selectedKey, actions: { click: "select", dblclick: "activate" }, grow: 1 },
				items,
				"feed",
			),
			node("row", { gap: "md", wrap: true }, [
				hintsRow([
					{ keys: ["tab"], label: "View" },
					{ keys: ["up", "down"], label: "Move" },
				]),
				actionButton("Refresh", "refresh", { keys: "r" }),
				actionButton("Close", "close", { keys: "escape" }),
			]),
		]);
		return this.#native;
	}

	invalidate(): void {
		this.#native = undefined;
		this.#scroll.invalidate();
		this.#lastWidth = 0;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#transitionTimer);
		this.#transitionTimer = undefined;
		this.#unsubscribe();
		this.#scroll.dispose();
	}
}
