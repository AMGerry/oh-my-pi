import { lexDocument, plainInlineTokens } from "../components/markdown";

export type SwarmProsePart = { kind: "markdown"; text: string } | { kind: "board"; text: string; href: string };

/** Board links on their own prose line become native navigation targets. */
export function splitSwarmProseLinks(input: string): SwarmProsePart[] {
	const source = input.replace(/\r\n?/g, "\n");
	const links: Array<{ start: number; end: number; text: string; href: string }> = [];
	let cursor = 0;
	for (const block of lexDocument(source)) {
		const start = source.indexOf(block.raw, cursor);
		if (start < 0) continue;
		cursor = start + block.raw.length;
		if (block.type !== "paragraph") continue;
		let inlineCursor = start;
		for (const token of block.tokens ?? []) {
			const at = source.indexOf(token.raw, inlineCursor);
			if (at < 0) continue;
			inlineCursor = at + token.raw.length;
			if (token.type !== "link" || typeof token.href !== "string" || !/^swarm:\/\//i.test(token.href)) continue;
			const lineStart = source.lastIndexOf("\n", at - 1) + 1;
			const nextLine = source.indexOf("\n", inlineCursor);
			const lineEnd = nextLine < 0 ? source.length : nextLine;
			if (source.slice(lineStart, at).trim() || source.slice(inlineCursor, lineEnd).trim()) continue;
			links.push({ start: lineStart, end: lineEnd, text: plainInlineTokens(token.tokens ?? []), href: token.href });
		}
		let lineStart = start;
		for (const line of block.raw.split("\n")) {
			const candidate = line.trim();
			// A bare line ends its sentence outside the link, as the inline `swarm://` tokenizer reads it.
			const href =
				candidate.startsWith("<") && candidate.endsWith(">")
					? candidate.slice(1, -1)
					: candidate.replace(/[.,!?;:)\]}]+$/, "");
			if (/^swarm:\/\/[^\s<>`]+$/i.test(href))
				links.push({ start: lineStart, end: lineStart + line.length, text: href, href });
			lineStart += line.length + 1;
		}
	}
	if (!links.length) return [{ kind: "markdown", text: input }];
	links.sort((left, right) => left.start - right.start);
	const parts: SwarmProsePart[] = [];
	let consumed = 0;
	for (const link of links) {
		if (link.start < consumed) continue;
		const before = source.slice(consumed, link.start);
		if (before.trim()) parts.push({ kind: "markdown", text: before });
		parts.push({ kind: "board", text: link.text || link.href, href: link.href });
		consumed = link.end;
	}
	const rest = source.slice(consumed);
	if (rest.trim()) parts.push({ kind: "markdown", text: rest });
	return parts;
}
