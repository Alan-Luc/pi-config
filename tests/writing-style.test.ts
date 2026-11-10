import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { it, test } from "bun:test";

const instructionPaths = [
	"AGENTS.md",
	"extensions/tech-lead/tech-lead.md",
	...["agents", "prompts"].flatMap((directory) =>
		readdirSync(new URL(`../${directory}/`, import.meta.url))
			.filter((path) => path.endsWith(".md"))
			.map((path) => `${directory}/${path}`),
	),
	...readdirSync(new URL("../skills/", import.meta.url), { recursive: true })
		.filter((path) => path.endsWith(".md"))
		.map((path) => `skills/${path}`),
].sort();

export function lintProse(markdown: string): string[] {
	const prose = markdown
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
		.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
		.replace(/`[^`\n]+`/g, "literal")
		.replace(/\[([^\]]+)\]\([^\s)]+\)/g, "$1")
		.replace(/^#{1,6} .*$/gm, "")
		.replace(/^[ \t]*(?:\d+\.|[-*])[ \t]+/gm, "\n\n");
	const blocks = prose.split(/\n\s*\n/).flatMap((paragraph) =>
		paragraph.trimStart().startsWith("|")
			? paragraph.split("\n").flatMap((row) => row.split("|").filter((cell) => cell.trim() && !/^[-:\s]+$/.test(cell)))
			: [paragraph],
	);
	const errors: string[] = [];
	for (const paragraph of blocks) {
		for (const sentence of paragraph.split(/[.!?](?:\s|$)/)) {
			const words = sentence.trim().split(/\s+/).filter(Boolean).length;
			if (words > 25) errors.push(`sentence: ${words} words`);
		}
	}
	if (/\p{L}\/\p{L}/u.test(prose)) errors.push("slash between words");
	for (const [substitute, term] of [
		["review round", "pass"],
		["review board", "panel"],
		["code lock", "freeze"],
		["review snapshot", "candidate"],
		["review sign-off", "clearance"],
		["ceremony level", "tier"],
		["work post", "station"],
	]) {
		if (prose.toLowerCase().includes(substitute)) errors.push(`use ${term}, not ${substitute}`);
	}
	return errors;
}

it.each(instructionPaths)("%s follows the three prose checks", (path) => {
	const markdown = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
	if (path === "AGENTS.md") {
		const writingRules = markdown.split("## Writing rules\n")[1]?.split("\n## Delivery")[0];
		assert.ok(writingRules, "Writing rules section is required");
	}
	assert.deepEqual(lintProse(markdown), []);
});

it.each([
	{ name: "long sentence", markdown: `${"word ".repeat(26).trim()}.`, error: "sentence: 26 words" },
	{ name: "word slash", markdown: "Check callers/tests.", error: "slash between words" },
	{ name: "term substitute", markdown: "Start the review round.", error: "use pass, not review round" },
])("rejects $name", ({ markdown, error }) => {
	assert.ok(lintProse(markdown).includes(error));
});

test("ignores routing metadata and preserves technical terms", () => {
	assert.deepEqual(lintProse(`---\nmodel: provider/model\ndescription: ${"word ".repeat(26).trim()}.\n---\n\nPreserve idempotent operations, trust boundaries, and immutable snapshots.\n`), []);
});

test("checks table cells separately", () => {
	assert.deepEqual(lintProse(`| First | Second |\n|---|---|\n| ${"word ".repeat(15).trim()} | ${"word ".repeat(15).trim()} |\n`), []);
	assert.ok(lintProse(`| First |\n|---|\n| ${"word ".repeat(26).trim()} |\n`).includes("sentence: 26 words"));
});

test("accepts the sentence limit and preserves literal punctuation", () => {
	assert.deepEqual(lintProse(`${"word ".repeat(25).trim()}.`), []);
	assert.deepEqual(lintProse("1. Inspect `callers/tests.ts`.\n2. Open [the file](src/review.md).\n\n```ts\nconst path = 'callers/tests';\n```\n"), []);
});
