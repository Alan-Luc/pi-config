import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "bun:test";
import { formatSkillsForPrompt, loadSkillsFromDir } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";

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

test("the routed skill resolves its acceptance reference without presenting it as executed evidence", () => {
	const path = resolve(skillRoot, "SKILL.md");
	const body = readFileSync(path, "utf8");
	const link = body.match(/\[disposable acceptance cases\]\(([^)]+)\)/)?.[1];
	assert.ok(link);
	const cases = readFileSync(resolve(dirname(path), link), "utf8");
	assert.match(cases, /Contract only — these cases have not been executed/);
	assert.match(cases, /real supported interface/);
	const router = readFileSync(resolve(root, "extensions/tech-lead/tech-lead.md"), "utf8");
	assert.match(router, /explicitly requested GitLab MR babysitting, load `skills\/mr-babysit\/SKILL\.md`/);
});
