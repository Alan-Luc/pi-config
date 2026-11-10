import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "bun:test";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dir, "..");
const skillRoot = resolve(root, "skills/mr-babysit");

test("native loader keeps MR babysitting explicitly invokable and out of automatic skill prompts", () => {
	const loaded = loadSkillsFromDir({ dir: skillRoot, source: "test" });
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	const skill = loaded.skills[0];
	assert.ok(skill);
	assert.equal(skill.name, "mr-babysit");
	assert.equal(skill.disableModelInvocation, true);
	assert.equal(formatSkillsForPrompt(loaded.skills), "");
});
