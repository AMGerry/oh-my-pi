/**
 * Mention parsing decides who a board post wakes. A false positive wakes a worker for nothing (it costs a turn);
 * a false negative leaves a named worker asleep. Each row below pins one boundary of that decision.
 */
import { describe, expect, test } from "bun:test";
import { parseMentions } from "../../src/swarm/mentions";

interface Row {
	name: string;
	text: string;
	mentions: string[];
	all?: boolean;
}

function run(rows: Row[]): void {
	test.each(rows)("$name", ({ text, mentions, all = false }) => {
		expect(parseMentions(text)).toEqual({ mentions, all });
	});
}

describe("parseMentions targets", () => {
	run([
		{ name: "@name addresses one member", text: "@alice please review", mentions: ["alice"] },
		{
			name: "@all is the broadcast flag, not a member name",
			text: "@all freeze the interface",
			mentions: [],
			all: true,
		},
		{ name: "@#channel keeps its # prefix", text: "@#parser is the AST stable?", mentions: ["#parser"] },
		{
			name: "names, @all and channels combine in one post",
			text: "@all rule: @alice owns @#parser, @bob verifies",
			mentions: ["alice", "#parser", "bob"],
			all: true,
		},
		{ name: "a repeated mention is reported once, in first-seen order", text: "@b @a @b @A", mentions: ["b", "a"] },
		{ name: "mentions on separate lines and after tabs", text: "line one\n@a\n\t@b", mentions: ["a", "b"] },
		{
			name: "@#main is parsed as a channel mention (the store refuses it on append)",
			text: "@#main hi",
			mentions: ["#main"],
		},
	]);
});

describe("parseMentions case", () => {
	run([
		{ name: "names are folded to lower case", text: "@Alice @DEV-1", mentions: ["alice", "dev-1"] },
		{ name: "@all is recognised in any case", text: "@ALL @All", mentions: [], all: true },
		{ name: "channel names are folded to lower case", text: "@#Parser", mentions: ["#parser"] },
		{ name: "ASCII capitals address the lowercase member", text: "@KIM @Sam @#UI", mentions: ["kim", "sam", "#ui"] },
		{ name: "a Kelvin sign is not the letter K", text: "@\u212Aim @ki\u212A", mentions: [] },
		{ name: "a long s is not the letter s", text: "@\u017Fam @a\u017F", mentions: [] },
		{ name: "a look-alike cannot start a channel name", text: "@#\u212Aernel", mentions: [] },
	]);
});

describe("parseMentions name boundaries", () => {
	run([
		{ name: "@ab-cd is one name and does not also address @ab", text: "@ab-cd go", mentions: ["ab-cd"] },
		{
			name: "@ab and @ab-cd in one post are two distinct targets",
			text: "@ab-cd and @ab",
			mentions: ["ab-cd", "ab"],
		},
		{ name: "@dev-10 does not address @dev-1 or the group @dev", text: "@dev-10", mentions: ["dev-10"] },
		{ name: "a group prefix is its own mention", text: "@dev @dev-1", mentions: ["dev", "dev-1"] },
		{ name: "@all-hands is a name, not the broadcast", text: "@all-hands", mentions: ["all-hands"] },
		{ name: "@allies is a name, not the broadcast", text: "@allies", mentions: ["allies"] },
		{ name: "an underscore continues the name", text: "@ab_cd", mentions: ["ab_cd"] },
		{ name: "digits continue the name", text: "@a1-2", mentions: ["a1-2"] },
		{ name: "@#c-d is a different channel than @#c", text: "@#c-d @#c", mentions: ["#c-d", "#c"] },
	]);
});

describe("parseMentions punctuation", () => {
	run([
		{ name: "comma", text: "Hello @alice, welcome", mentions: ["alice"] },
		{ name: "full stop ends a sentence", text: "Thanks @alice.", mentions: ["alice"] },
		{ name: "colon", text: "@alice: please look", mentions: ["alice"] },
		{ name: "exclamation and question marks", text: "@alice! @bob?", mentions: ["alice", "bob"] },
		{
			name: "brackets and quotes around the mention",
			text: '(@alice) "@bob" [@carol]',
			mentions: ["alice", "bob", "carol"],
		},
		{ name: "possessive apostrophe", text: "@alice's patch", mentions: ["alice"] },
		{
			name: "typographic apostrophe and ellipsis",
			text: "@alice\u2019s patch\u2026 @bob\u2026",
			mentions: ["alice", "bob"],
		},
		{ name: "slash and em dash after the name", text: "@alice/@bob\u2014done", mentions: ["alice", "bob"] },
		{
			name: "@all followed by punctuation is still the broadcast",
			text: "@all, listen. @ALL!",
			mentions: [],
			all: true,
		},
		{ name: "a channel mention followed by punctuation", text: "@#Parser, are you ready", mentions: ["#parser"] },
		{ name: "a non-breaking space ends the name", text: "@alice\u00a0now", mentions: ["alice"] },
	]);
});

describe("parseMentions word start", () => {
	run([
		{ name: "an email address is not a mention", text: "mail bob@example.com today", mentions: [] },
		{ name: "an email in angle brackets is not a mention", text: "<bob@example.com>", mentions: [] },
		{ name: "an email-shaped @all is not the broadcast", text: "bob@all", mentions: [] },
		{ name: "@ preceded by a digit is not a mention", text: "build1@alice", mentions: [] },
		{ name: "@ preceded by another @ is not a mention", text: "@@alice", mentions: [] },
		{ name: "@ preceded by a hyphen is not a mention", text: "-@alice", mentions: [] },
		{ name: "@ preceded by an underscore is not a mention", text: "_@alice", mentions: [] },
		{ name: "a channel mention glued to a preceding word is not a mention", text: "mail@#parser", mentions: [] },
		{ name: "a lone @ names nobody", text: "@ alice", mentions: [] },
		{ name: "a name must start with a letter: digit", text: "@1alice", mentions: [] },
		{ name: "a name must start with a letter: hyphen", text: "@-alice", mentions: [] },
		{ name: "a bare channel marker names nobody", text: "@# @#1 @##c", mentions: [] },
		{ name: "@#all is a channel, not the broadcast", text: "@#all", mentions: ["#all"] },
		{ name: "an @ glued to a preceding name is not a second mention", text: "@a@b", mentions: ["a"] },
	]);
});

describe("parseMentions Unicode boundaries", () => {
	run([
		{ name: "an accented letter after the name makes it another word", text: "@ab\u00e9", mentions: [] },
		{ name: "a non-Latin letter after the name makes it another word", text: "@ab\u65e5\u672c", mentions: [] },
		{ name: "a non-ASCII digit after the name makes it another word", text: "@ab\u0663", mentions: [] },
		{ name: "a non-ASCII digit cannot start a name", text: "@\u0663ab", mentions: [] },
		{ name: "an accented letter before the @ makes it part of a word", text: "\u00e9@ab", mentions: [] },
		{ name: "a non-Latin letter before the @ makes it part of a word", text: "\u65e5\u672c@ab", mentions: [] },
		{ name: "a space after non-Latin text restores the word start", text: "\u65e5\u672c @ab", mentions: ["ab"] },
		{ name: "a zero-width space after the name is a boundary", text: "@ab\u200b", mentions: ["ab"] },
		{ name: "an ASCII mention next to emoji", text: "\ud83d\ude80@ab \ud83d\ude80", mentions: ["ab"] },
		{ name: "a combining mark after the name makes it another word", text: "@abe\u0301 @ab\u0308c", mentions: [] },
		{ name: "a combining mark inside the name makes it another word", text: "@a\u0301b", mentions: [] },
		{ name: "a combining mark before the @ makes it part of a word", text: "e\u0301@ab", mentions: [] },
		{ name: "a space after a combining mark restores the word start", text: "e\u0301 @ab", mentions: ["ab"] },
	]);
});
