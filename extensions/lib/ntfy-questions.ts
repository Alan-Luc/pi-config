export interface PromptOption {
	label: string;
	description: string;
}

export interface PromptQuestion {
	header: string;
	question: string;
	multiSelect: boolean;
	options: readonly PromptOption[];
}

export interface PromptPayload {
	toolCallId?: string;
	questions?: readonly PromptQuestion[];
}

export type DraftEntry = { optionIndexes: number[] } | { text: string };
export type Draft = Readonly<Record<number, DraftEntry>>;

export interface AnswerEntry {
	questionIndex: number;
	optionIndexes?: number[];
	text?: string;
}

export type ReplyOutcome =
	| { kind: "ignore" }
	| { kind: "hint"; reason: string }
	| { kind: "partial"; draft: Draft; missing: number[] }
	| { kind: "answer"; answers: AnswerEntry[] }
	| { kind: "cancel" };

export type RoutedReply = { kind: "hint"; reason: string } | { kind: "routed"; tag: string; body: string };

const TOPIC_KEY = "NTFY_QUESTION_TOPIC";

/** Control replies are ours; reading them back would answer our own hints forever. */
export const CONTROL_PREFIX = "🤖 ";

export function isControlMessage(body: string): boolean {
	return body.startsWith(CONTROL_PREFIX);
}

/** Env first: pi may be started without a login shell, so the secrets file is the fallback. */
export function resolveTopic(env: Record<string, string | undefined>, secretsText: string): string | undefined {
	const fromEnv = env[TOPIC_KEY]?.trim();
	if (fromEnv) return fromEnv;
	for (const line of secretsText.split("\n")) {
		const match = new RegExp(`^\\s*(?:export\\s+)?${TOPIC_KEY}\\s*=\\s*(.*)$`).exec(line);
		const value = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
		if (value) return value;
	}
	return undefined;
}

export function tagOf(toolCallId: string): string {
	return toolCallId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-6);
}

/** ntfy answers a topic name over 64 characters with a bare 404, so refuse before publishing. */
export function topicProblem(topic: string): string | undefined {
	const name = topic.includes("/") ? topic.slice(topic.indexOf("/") + 1) : topic;
	if (!name) return "the topic name is empty";
	if (name.length > 64) return `the topic name is ${name.length} characters; ntfy allows 64`;
	if (!/^[A-Za-z0-9_-]+$/.test(name)) return "the topic name has characters ntfy does not allow";
	return undefined;
}

const letter = (index: number): string => String.fromCharCode(97 + index);const lettersOf = (question: PromptQuestion): string => question.options.map((_option, n) => letter(n)).join(", ");

export function formatQuestion(questions: readonly PromptQuestion[], tag?: string, only?: readonly number[]): string {
	const chosen = questions.filter((_question, index) => !only || only.includes(index));
	const count = chosen.length;
	const total = `${count} question${count === 1 ? "" : "s"}`;
	const address = tag ? ` · start with ${tag}` : "";
	const lines = [`Pi asks ${total} — reply "1. a"${address}`];
	questions.forEach((question, index) => {
		if (only && !only.includes(index)) return;
		const pick = question.multiSelect ? `pick several, e.g. "${index + 1}. a, c"` : "pick one";
		lines.push("", `${index + 1}. ${question.header}: ${question.question} — ${pick}`);
		question.options.forEach((option, n) => lines.push(`   ${letter(n)}. ${option.label} — ${option.description}`));
	});
	lines.push("", "own words: put them where the letter goes · decline: x");
	return lines.join("\n");
}

/**
 * Untagged replies are accepted only while one questionnaire is open, so a reply that is still
 * sitting on the phone cannot answer a questionnaire that opened after it.
 */
export function routeReply(text: string, tags: readonly string[]): RoutedReply {
	const trimmed = text.trim();
	if (!trimmed) return { kind: "hint", reason: "empty reply" };
	const firstWord = trimmed.split(/\s+/)[0]!.toLowerCase();
	if (tags.includes(firstWord)) {
		return { kind: "routed", tag: firstWord, body: trimmed.slice(firstWord.length).trim() };
	}
	if (tags.length === 1) return { kind: "routed", tag: tags[0]!, body: trimmed };
	return { kind: "hint", reason: `start the reply with one of ${tags.join(" or ")}` };
}

/**
 * Answers may share a line when a separator is followed by another question marker, so
 * "1. b, 2. a" is two answers while "2. a, c" stays one multi-select answer.
 */
function splitAnswers(text: string): string[] {
	return text.split(/[,;]\s*(?=\d{1,2}\s*[.):]\s*\S)|\n/);
}

export function applyReply(draft: Draft, body: string, questions: readonly PromptQuestion[]): ReplyOutcome {
	const text = body.trim();
	if (!text) return { kind: "ignore" };
	if (/^(x|cancel)$/i.test(text)) return { kind: "cancel" };

	// A one-question questionnaire takes a bare reply: typing "2" or "my own words" is enough.
	if (questions.length === 1 && !/^\s*\d{1,2}\s*[.):-]?\s/m.test(text)) {
		const entry = interpret(text, questions[0]!, "1");
		if ("reason" in entry) return { kind: "hint", reason: entry.reason };
		return {
			kind: "answer",
			answers: [
				"text" in entry
					? { questionIndex: 0, text: entry.text }
					: { questionIndex: 0, optionIndexes: entry.optionIndexes },
			],
		};
	}

	const next: Record<number, DraftEntry> = { ...draft };
	let changed = false;
	for (const rawLine of splitAnswers(text)) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = /^(\d{1,2})\s*[.):-]?\s*(.+)$/.exec(line);
		if (!match) return { kind: "hint", reason: `"${line}" is not shaped like "1. a"` };
		const shown = match[1]!;
		const questionIndex = Number(shown) - 1;
		const question = questions[questionIndex];
		if (!question) {
			return { kind: "hint", reason: `no question ${shown} (this one has ${questions.length})` };
		}
		const entry = interpret(match[2]!.trim(), question, shown);
		if ("reason" in entry) return { kind: "hint", reason: entry.reason };
		next[questionIndex] = entry;
		changed = true;
	}
	if (!changed) return { kind: "ignore" };

	const missing = questions.map((_question, index) => index).filter((index) => next[index] === undefined);
	if (missing.length > 0) return { kind: "partial", draft: next, missing };
	return {
		kind: "answer",
		answers: questions.map((_question, index) => {
			const entry = next[index]!;
			return "text" in entry
				? { questionIndex: index, text: entry.text }
				: { questionIndex: index, optionIndexes: entry.optionIndexes };
		}),
	};
}

function interpret(value: string, question: PromptQuestion, shown: string): DraftEntry | { reason: string } {	const squashed = value.replace(/[\s,]+/g, "").toLowerCase();
	if (/^[a-z]+$/.test(squashed)) {
		const indexes = [...new Set(squashed.split(""))].map((character) => character.charCodeAt(0) - 97);
		if (indexes.every((index) => index < question.options.length)) {
			if (!question.multiSelect && indexes.length > 1) {
				return { reason: `question ${shown} takes one letter (${lettersOf(question)})` };
			}
			return { optionIndexes: indexes };
		}
		if (/^[a-z]$/i.test(value)) {
			return { reason: `question ${shown} has no "${value.toLowerCase()}" (it has ${lettersOf(question)})` };
		}
	}
	return { text: value };
}
