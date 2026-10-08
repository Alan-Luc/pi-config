import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";

const body = readFileSync(new URL("../skills/walkthrough/SKILL.md", import.meta.url), "utf8");
const scaffoldMatch = body.match(/## Presentation scaffold[\s\S]*?```markdown\n([\s\S]*?)\n```/);
assert.ok(scaffoldMatch, "walkthrough Markdown scaffold");
const scaffold = scaffoldMatch[1];

function guidance(heading: string): string {
	const marker = `### ${heading}`;
	const start = body.indexOf(marker);
	assert.ok(start >= 0, marker);
	const contentStart = start + marker.length;
	const next = body.indexOf("\n### ", contentStart);
	return body.slice(contentStart, next < 0 ? body.length : next);
}

test("walkthrough scaffold structurally fixes the behavior-first section order", () => {
	assert.deepEqual(scaffold.match(/^#{2,3} .+$/gm), [
		"## BLUF",
		"## 1. <short label>",
		"### Current problem",
		"### <Proposed implementation OR What changed>",
		"### Result",
		"## How the pieces fit together",
		"## Where the changes go",
		"## Implementation order / Verification results",
		"## Intentionally not changed",
		"## Follow-ups or known gaps",
	]);
});

test("logical change blocks repeat without fixing item or prose volume", () => {
	assert.match(body, /repeat\b.*numbered logical-change section.*every meaningful item/i);
	assert.match(body, /do not .*fixed number of logical changes, paragraphs, or diagrams/i);
	assert.match(guidance("Logical change blocks"), /choose exactly one of `### Proposed implementation` or `### What changed`/);
	assert.match(guidance("Logical change blocks"), /do not add a `Logical change blocks` wrapper/i);
});

test("planned and completed walkthroughs distinguish expected and observed evidence", () => {
	const blocks = guidance("Logical change blocks");
	assert.match(blocks, /Planned walkthroughs[\s\S]*expected checks/);
	assert.match(blocks, /Completed walkthroughs[\s\S]*observed results/);
	assert.match(blocks, /Never present an expected result as an observed result/);
	assert.match(blocks, /never emit both headings for one item/);
});

test("composition, verification, safety, and gap contracts remain explicit", () => {
	assert.match(guidance("How the pieces fit together"), /mandatory/);
	assert.deepEqual(
		[...guidance("Implementation order / Verification results").matchAll(/^- \*\*([^*]+):\*\*/gm)].map((match) => match[1]),
		["Commands", "Outcomes", "Manual checks", "Coverage gaps", "Risk evidence"],
	);
	assert.match(guidance("Where the changes go"), /credentials, tokens, private keys, personal data/);
	assert.match(guidance("Intentionally not changed"), /tradeoffs/);
	assert.match(guidance("Follow-ups or known gaps"), /known coverage gaps/);
	assert.match(body, /not an artifact schema/);
	assert.match(body, /Do not add a runtime validator/);
});
