import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it, test } from "bun:test";

const instructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const writingRules = instructions.split("## Writing rules\n")[1]?.split("\n## Delivery")[0];
assert.ok(writingRules, "Writing rules section is required");
const recipes = readFileSync(new URL("../skills/task-recipe/references/recipes.md", import.meta.url), "utf8");

export function lintProse(markdown: string): string[] {
	const prose = markdown
		.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
		.replace(/`[^`\n]+`/g, "literal")
		.replace(/\[([^\]]+)\]\([^\s)]+\)/g, "$1")
		.replace(/^#{1,6} .*$/gm, "")
		.replace(/^\s*(?:\d+\.|[-*])\s+/gm, "");
	const errors: string[] = [];
	for (const paragraph of prose.split(/\n\s*\n/)) {
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

it.each([
	{ name: "Writing rules", markdown: writingRules },
	{ name: "recipe pilot", markdown: recipes },
])("$name follows the three prose checks", ({ markdown }) => {
	assert.deepEqual(lintProse(markdown), []);
});

it.each([
	{ name: "long sentence", markdown: `${"word ".repeat(26).trim()}.`, error: "sentence: 26 words" },
	{ name: "word slash", markdown: "Check callers/tests.", error: "slash between words" },
	{ name: "term substitute", markdown: "Start the review round.", error: "use pass, not review round" },
])("rejects $name", ({ markdown, error }) => {
	assert.ok(lintProse(markdown).includes(error));
});

test("accepts the sentence limit and preserves literal punctuation", () => {
	assert.deepEqual(lintProse(`${"word ".repeat(25).trim()}.`), []);
	assert.deepEqual(lintProse("1. Inspect `callers/tests.ts`.\n2. Open [the file](src/review.md).\n\n```ts\nconst path = 'callers/tests';\n```\n"), []);
});
