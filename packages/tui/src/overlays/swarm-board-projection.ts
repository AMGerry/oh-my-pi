import { plainText } from "../native/spans";
import type { SwarmBoardState, SwarmBoardTab } from "./swarm-board-types";
import type { NarratorAction, NarratorRef } from "./swarm-view-model";

export interface SwarmBoardRow {
	readonly key: string;
	readonly title: string;
	readonly text?: string;
	readonly meta?: string;
	readonly tone?: "accent" | "muted" | "warning" | "error" | "success";
	readonly actions?: readonly NarratorAction[];
}

/** Present board evidence and narrator claims as distinct, navigable rows. */
export function buildSwarmBoardRows(state: SwarmBoardState, tab: SwarmBoardTab, unreadSince: number): SwarmBoardRow[] {
	const rows: SwarmBoardRow[] = [];
	if (state.error) rows.push({ key: "source-error", title: "Board unavailable", text: state.error, tone: "error" });
	if (tab === "board") {
		let divided = false;
		for (const post of state.posts) {
			if (!divided && post.seq > unreadSince) {
				rows.push({ key: "unread", title: "Unread", tone: "accent" });
				divided = true;
			}
			rows.push({
				key: `post-${post.seq}`,
				title: `#${post.seq}  ${post.agent}`,
				text: post.text,
				meta: `${post.channel ?? "main"} · ${post.time}`,
				actions: [{ type: "open_conv", target: post.agent, label: post.agent }],
			});
		}
		if (!state.posts.length) rows.push({ key: "empty-board", title: "Board is empty", tone: "muted" });
	} else if (tab === "members") {
		for (const member of state.members) {
			const wake =
				member.wakeMode === null ? "" : `${member.wakeMode} after #${member.waitSince ?? member.lastReadSeq}`;
			const activity = member.lastPostTime ? `Last post #${member.lastPostSeq} · ${member.lastPostTime}` : "";
			rows.push({
				key: `member-${member.name}`,
				title: `${member.name} · ${member.state}`,
				meta: `${member.role} · ${member.unread} unread`,
				text: [
					member.model,
					state.view?.now?.[member.name],
					wake,
					activity,
					member.error ? `Error: ${member.error}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				tone: member.error
					? "error"
					: member.state === "working"
						? "accent"
						: member.state === "killed"
							? "muted"
							: undefined,
				actions: [{ type: "open_conv", target: member.name, label: "Conversation" }],
			});
		}
	} else {
		if (state.viewError)
			rows.push({ key: "view-error", title: "Overview update rejected", text: state.viewError, tone: "warning" });
		if (state.planError)
			rows.push({ key: "plan-error", title: "Plan update rejected", text: state.planError, tone: "warning" });
		if (state.customPageError)
			rows.push({
				key: "custom-page-error",
				title: "Custom page update rejected",
				text: state.customPageError,
				tone: "warning",
			});
		const view = state.view;
		const plan = state.plan;
		if (view) {
			const posts = new Set(state.posts.map(post => post.seq));
			const members = new Set(state.members.map(member => member.name));
			const cited = (
				key: string,
				title: string,
				text: string | undefined,
				refs: readonly NarratorRef[],
				meta?: string,
				actions: readonly NarratorAction[] = [],
			): SwarmBoardRow => {
				const known = refs.every(ref =>
					"seq" in ref ? posts.has(ref.seq) && ref.seq <= view.as_of_seq : members.has(ref.member),
				);
				const navigation = new Map<string, NarratorAction>();
				for (const action of actions) navigation.set(`${action.type}:${action.target}`, action);
				for (const ref of refs) {
					const action: NarratorAction =
						"seq" in ref
							? { type: "board_post", target: ref.seq, label: `#${ref.seq}` }
							: { type: "open_conv", target: ref.member, label: ref.member };
					if (!navigation.has(`${action.type}:${action.target}`))
						navigation.set(`${action.type}:${action.target}`, action);
				}
				return {
					key,
					title,
					text,
					meta: [meta, known && view.as_of_seq <= state.head ? "" : "Unverified"].filter(Boolean).join(" · "),
					actions: [...navigation.values()],
				};
			};
			rows.push({
				key: "goal",
				title: view.goal?.title ?? plan?.goal.title ?? state.title,
				text: view.goal?.line ?? plan?.goal.line,
				tone: "accent",
			});
			const freshness =
				view.as_of_seq < state.head
					? `Stale · board #${state.head}`
					: view.as_of_seq > state.head
						? "Unverified"
						: "Current";
			rows.push({
				key: "as-of",
				title: `As of #${view.as_of_seq} · ${freshness}`,
				text:
					view.running_summary && view.running_summary !== view.headline
						? `${view.headline}\n${view.running_summary}`
						: view.headline,
				meta: view.updated_at,
				tone: freshness === "Current" ? "muted" : "warning",
				actions:
					view.as_of_seq > 0 ? [{ type: "board_post", target: view.as_of_seq, label: `#${view.as_of_seq}` }] : [],
			});
			if (view.phase)
				rows.push({ key: "phase", title: `${view.phase.label} · ${view.phase.index}/${view.phase.total}` });
			const streams = new Map((view.workstreams ?? []).map(item => [item.id, item]));
			const attention = new Map((view.attention ?? []).map(item => [item.id, item]));
			const addAttention = (id: string) => {
				const item = attention.get(id);
				if (!item) return;
				const waiting = ["decision", "review", "quota"].includes(item.kind) ? "Awaiting coordinator" : item.kind;
				rows.push(
					cited(
						`attention-${item.id}`,
						item.short?.title ?? item.title,
						item.short?.line ?? item.why,
						item.refs,
						`${waiting} · ${item.severity}`,
						item.actions,
					),
				);
			};
			const addStream = (id: string) => {
				const item = streams.get(id);
				if (!item) return;
				const progress = item.progress ? `${item.progress.done}/${item.progress.total}` : "";
				rows.push(
					cited(
						`stream-${item.id}`,
						item.short?.title ?? item.title,
						item.short?.line ?? item.note,
						item.refs,
						[item.state, item.owners.join(", "), progress].filter(Boolean).join(" · "),
					),
				);
			};
			if (view.threads?.length) {
				for (const thread of view.threads) {
					rows.push({
						key: `thread-${thread.id}`,
						title: thread.title,
						text: [thread.goal, thread.now].filter(Boolean).join("\n"),
						tone: "accent",
					});
					for (const id of thread.attention) addAttention(id);
					for (const id of thread.workstreams) addStream(id);
				}
				const placed = new Set(view.threads.flatMap(thread => thread.attention));
				for (const id of attention.keys()) if (!placed.has(id)) addAttention(id);
			} else {
				for (const id of attention.keys()) addAttention(id);
				for (const id of streams.keys()) addStream(id);
			}
			for (const item of view.milestones ?? [])
				rows.push(cited(`milestone-${item.id}`, item.text, undefined, item.refs, "Milestone"));
			for (const item of view.risks ?? [])
				rows.push(cited(`risk-${item.id}`, item.text, undefined, item.refs, "Risk"));
			for (const [index, frame] of (view.reel?.frames ?? []).entries()) {
				rows.push(
					cited(`reel-${index}`, frame.caption, undefined, [{ seq: frame.seq }], "Reel", [
						{ type: "file", target: frame.path, label: "Open frame" },
					]),
				);
			}
			if (view.feedback_ack)
				rows.push({
					key: "feedback",
					title: `Feedback through #${view.feedback_ack.through_seq}`,
					text: view.feedback_ack.text,
				});
		} else {
			rows.push({ key: "goal", title: plan?.goal.title ?? state.title, text: plan?.goal.line, tone: "accent" });
			const groups = plan?.threads ?? [
				{
					id: "work",
					title: "Work",
					goal: "",
					tasks: state.members.filter(member => member.role === "worker").map(member => member.name),
				},
			];
			for (const group of groups) {
				rows.push({ key: `group-${group.id}`, title: group.title, text: group.goal || undefined, tone: "accent" });
				for (const name of group.tasks) {
					const member = state.members.find(candidate => candidate.name === name);
					const post = state.posts.findLast(candidate => candidate.agent === name);
					const reported = post?.text.match(/(?:^|\s)\[(done|blocked|stuck|error|review)\]/i)?.[1]?.toLowerCase();
					rows.push({
						key: `task-${name}`,
						title: plan?.tasks[name] ?? name,
						meta: `${name} · ${member?.state ?? "Unverified"}${reported ? ` · reported ${reported}` : ""}`,
						text: member?.error,
						actions: post
							? [{ type: "board_post", target: post.seq, label: `#${post.seq}` }]
							: [{ type: "open_conv", target: name, label: name }],
					});
				}
			}
			if (!groups.some(group => group.tasks.length))
				rows.push({ key: "empty-work", title: "Waiting for the first assignment", tone: "muted" });
		}
	}
	return rows.map(row => ({
		...row,
		title: plainText(row.title),
		text: row.text === undefined ? undefined : plainText(row.text),
		meta: row.meta === undefined ? undefined : plainText(row.meta),
	}));
}
