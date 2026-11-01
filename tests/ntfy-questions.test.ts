import { describe, expect, it } from "bun:test";
import {
	applyReply,
	formatQuestion,
	resolveTopic,
	routeReply,
	tagOf,
	topicProblem,
	type PromptQuestion,
} from "../extensions/lib/ntfy-questions.ts";

const questions: readonly PromptQuestion[] = [
	{
		header: "Storage",
		question: "Which storage?",
		multiSelect: false,
		options: [
			{ label: "Postgres", description: "needs a server" },
			{ label: "SQLite", description: "single file" },
			{ label: "MySQL", description: "also a server" },
			{ label: "DuckDB", description: "embedded analytics" },
		],
	},
	{
		header: "Checks",
		question: "Which checks?",
		multiSelect: true,
		options: [
			{ label: "unit", description: "fast" },
			{ label: "integration", description: "slow" },
			{ label: "e2e", description: "slowest" },
		],
	},
];

describe("resolveTopic", () => {
	it("prefers the environment", () => {
		expect(resolveTopic({ NTFY_QUESTION_TOPIC: "ntfy.sh/from-env" }, "NTFY_QUESTION_TOPIC=ntfy.sh/from-file")).toBe(
			"ntfy.sh/from-env",
		);
	});

	it.each([
		["plain assignment", "NTFY_QUESTION_TOPIC=ntfy.sh/abc"],
		["exported assignment", "export NTFY_QUESTION_TOPIC=ntfy.sh/abc"],
		["quoted value", "NTFY_QUESTION_TOPIC='ntfy.sh/abc'"],
	])("reads a %s from the secrets file", (_name, secrets) => {
		expect(resolveTopic({}, `OTHER=1\n${secrets}\nANOTHER=2`)).toBe("ntfy.sh/abc");
	});

	it("stays undefined without configuration", () => {
		expect(resolveTopic({}, "KAGI_API_KEY=x")).toBeUndefined();
	});
});

describe("tagOf", () => {
	it("keeps the last six alphanumeric characters, lowercased", () => {
		expect(tagOf("call_ABCdef123")).toBe("def123");
	});
});

describe("formatQuestion", () => {
	const text = formatQuestion(questions);

	it.each([
		["1. Storage: Which storage? — pick one"],
		["   a. Postgres — needs a server"],
		["2. Checks: Which checks? — pick several"],
		["   c. e2e — slowest"],
		["decline: x"],
	])("renders %s", (line) => {
		expect(text).toContain(line);
	});

	it("names the tag only when several questionnaires are open", () => {
		expect(text).not.toContain("start with");
		expect(formatQuestion(questions, "abc123")).toContain("start with abc123");
	});
});

describe("routeReply", () => {
	it("accepts an untagged reply while one questionnaire is open", () => {
		expect(routeReply("1. a", ["abc123"])).toEqual({ kind: "routed", tag: "abc123", body: "1. a" });
	});

	it("strips the tag and preserves newlines", () => {
		expect(routeReply("abc123 1. a\n2. b", ["abc123", "def456"])).toEqual({
			kind: "routed",
			tag: "abc123",
			body: "1. a\n2. b",
		});
	});

	it("demands a tag when several questionnaires are open", () => {
		expect(routeReply("1. a", ["abc123", "def456"])).toEqual({
			kind: "hint",
			reason: "start the reply with one of abc123 or def456",
		});
	});
});

describe("applyReply", () => {
	it.each([
		["1. b\n2. a", "period separator"],
		["1) b\n2) a", "parenthesis separator"],
		["1: b\n2: a", "colon separator"],
		["1 b\n2 a", "bare space separator"],
	])("answers every question with %s (%s)", (body) => {
		expect(applyReply({}, body, questions)).toEqual({
			kind: "answer",
			answers: [
				{ questionIndex: 0, optionIndexes: [1] },
				{ questionIndex: 1, optionIndexes: [0] },
			],
		});
	});

	it.each([
		["2. a, c", "comma separated"],
		["2. a c", "space separated"],
		["2. ac", "run together"],
		["2. A, C", "uppercase"],
	])("reads multiple letters as %s (%s)", (line) => {
		const outcome = applyReply({ 0: { optionIndexes: [1] } }, line, questions);
		expect(outcome).toEqual({
			kind: "answer",
			answers: [
				{ questionIndex: 0, optionIndexes: [1] },
				{ questionIndex: 1, optionIndexes: [0, 2] },
			],
		});
	});

	it.each([
		["1. hello testing this is fake", "hello testing this is fake"],
		["1. idk", "idk"],
		["1. no, do the other one", "no, do the other one"],
	])("keeps %s as freeform text", (line, expected) => {
		const outcome = applyReply({ 1: { optionIndexes: [0] } }, line, questions);
		if (outcome.kind !== "answer") throw new Error(`expected an answer, got ${outcome.kind}`);
		expect(outcome.answers[0]).toEqual({ questionIndex: 0, text: expected });
	});

	it("refuses a lone letter that is not an option", () => {
		expect(applyReply({}, "1. e", questions)).toEqual({
			kind: "hint",
			reason: 'question 1 has no "e" (it has a, b, c, d)',
		});
	});

	it("refuses several letters for a single-select question", () => {
		expect(applyReply({}, "1. a, c", questions)).toEqual({
			kind: "hint",
			reason: "question 1 takes one letter (a, b, c, d)",
		});
	});

	it("refuses an unknown question number", () => {
		expect(applyReply({}, "3. a", questions)).toEqual({ kind: "hint", reason: "no question 3 (this one has 2)" });
	});

	it("refuses a line that is not answer shaped", () => {
		expect(applyReply({}, "b", questions)).toEqual({ kind: "hint", reason: '"b" is not shaped like "1. a"' });
	});

	it("accumulates answers across separate messages", () => {
		const first = applyReply({}, "1. b", questions);
		expect(first).toEqual({ kind: "partial", draft: { 0: { optionIndexes: [1] } }, missing: [1] });
		if (first.kind !== "partial") throw new Error("expected a partial answer");
		expect(applyReply(first.draft, "2. a", questions)).toEqual({
			kind: "answer",
			answers: [
				{ questionIndex: 0, optionIndexes: [1] },
				{ questionIndex: 1, optionIndexes: [0] },
			],
		});
	});

	it("lets a repeated question overwrite the earlier answer", () => {
		expect(applyReply({ 0: { optionIndexes: [0] } }, "1. c\n2. a", questions)).toEqual({
			kind: "answer",
			answers: [
				{ questionIndex: 0, optionIndexes: [2] },
				{ questionIndex: 1, optionIndexes: [0] },
			],
		});
	});

	it.each([["x"], ["cancel"], ["X"]])("declines on %s", (body) => {
		expect(applyReply({}, body, questions)).toEqual({ kind: "cancel" });
	});

	it("ignores an empty body", () => {
		expect(applyReply({}, "  \n ", questions)).toEqual({ kind: "ignore" });
	});
});

describe("topicProblem", () => {
	it.each([
		["ntfy.sh/sudoku-thirsting-outlast-moonrise-sneeze-partake-bullseye", undefined],
		[`ntfy.sh/${"a".repeat(64)}`, undefined],
		[`ntfy.sh/${"a".repeat(65)}`, "the topic name is 65 characters; ntfy allows 64"],
		["ntfy.sh/bad name", "the topic name has characters ntfy does not allow"],
		["ntfy.sh/", "the topic name is empty"],
	])("judges %s", (topic, expected) => {
		expect(topicProblem(topic)).toBe(expected);
	});
});
