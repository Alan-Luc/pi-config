import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";

const body = readFileSync(new URL("../skills/walkthrough/SKILL.md", import.meta.url), "utf8");
const scaffoldMatch = body.match(/## Presentation scaffold[\s\S]*?```markdown\n([\s\S]*?)\n```/);
assert.ok(scaffoldMatch, "walkthrough Markdown scaffold");
const scaffold = scaffoldMatch[1];

test("walkthrough scaffold structurally fixes the behavior-first section order", () => {
	assert.deepEqual([...scaffold.matchAll(/^(#{2,3}) .+$/gm)].map((match) => match[1].length), [2, 2, 3, 3, 3, 2, 2, 2, 2, 2]);
});
