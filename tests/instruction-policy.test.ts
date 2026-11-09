import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const reviewer = read("agents/code-reviewer.md");
const profiles = ["code-reviewer-sol", "code-reviewer-sonnet", "code-reviewer-opus"];

test("review profiles delegate to the read-only canonical reviewer", () => {
	assert.match(reviewer, /^tools: .*\bread\b/m);
	assert.doesNotMatch(reviewer, /^tools: .*\b(?:edit|write|subagent)\b/m);
	for (const name of profiles) {
		assert.ok(read(`agents/${name}.md`).includes("agents/code-reviewer.md"));
	}
});
