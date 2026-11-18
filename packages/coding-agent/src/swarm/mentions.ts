export interface BoardMentions {
	mentions: string[];
	all: boolean;
}

/**
 * Parse whole, word-start mentions; channel mentions retain their # prefix. Names match ASCII letters of either case
 * exactly, so only ASCII text addresses a member, and combining marks continue the surrounding word.
 */
export function parseMentions(text: string): BoardMentions {
	const mentions = new Set<string>();
	let all = false;
	for (const match of text.matchAll(/(?<![\p{L}\p{M}\p{N}_@-])@(#?[A-Za-z][A-Za-z0-9_-]*)(?![\p{L}\p{M}\p{N}_-])/gu)) {
		const name = match[1].toLowerCase();
		if (name === "all") all = true;
		else mentions.add(name);
	}
	return { mentions: [...mentions], all };
}
