import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const reviewer = read("agents/code-reviewer.md");
const procedure = read("prompts/eviscerate-diff.md");
const lead = read("extensions/tech-lead/tech-lead.md");
const globalInstructions = read("AGENTS.md");

test("CDC authority distinguishes standing task-branch grants from other pushes", () => {
	for (const sentence of [
		"Never push outside the CDC task-branch policy without Alan\'s explicit authorization.",
		"The parent CDC may push verified frozen candidates to task branches under the publication grant.",
		"Preserve existing guardrail checks and protected-branch restrictions.",
		"Require Alan\'s explicit authorization for other pushes.",
		"Local commits grant no push authority.",
		"Children never commit or push; only the parent commits.",
		"Allow routine prompt and configuration changes on `main`.",
	]) assert.ok(globalInstructions.includes(sentence), sentence);
	assert.equal(globalInstructions.split("Keep experiments on `benchmark/<run-id>`").length - 1, 1);
	assert.ok(!globalInstructions.includes("Never put experiments or changes to prompts or configuration on `main`"));
	assert.ok(lead.includes("Use the CDC task-branch policy in `AGENTS.md` for pushes."));
});

test("reviewers require reachable triggers, scope, and bounded severity", () => {
	for (const sentence of [
		"Name the realistic input, caller, or state and its producer to establish that the trigger can occur here.",
		"Require scope within the ticket's Done means and Keep to prevent unrelated remediation.",
		"Recommend a P2 fix only when small and local to keep minor cleanup bounded.",
		"Recommend fixes for qualifying P0 and P1 findings to address material failures.",
		"Leave acceptance, fixes, and regression tests to the parent to keep adjudication separate.",
	]) assert.ok(reviewer.includes(sentence), sentence);
	for (const sentence of [
		"Require each finding's realistic trigger and producer to exclude hypothetical failures.",
		"Fix qualifying P0 and P1 findings.\nFix P2 only when small and local to bound cleanup.",
		"Dismiss everything else with a one-line reason or record an outside-ticket follow-up to preserve disposition.",
		"Add regression tests only for accepted findings to exclude rejected premises.",
	]) assert.ok(procedure.includes(sentence), sentence);
	assert.ok(reviewer.includes("Leave acceptance, fixes, and regression tests to the parent"));
	assert.ok(!reviewer.includes("fix it"), "the read-only reviewer does not receive fix commands");
	assert.ok(procedure.includes("Require attack inputs reachable through a real interface"));
	for (const name of ["code-reviewer-sol", "code-reviewer-sonnet", "code-reviewer-opus"]) {
		assert.ok(read(`agents/${name}.md`).includes("canonical role body in `agents/code-reviewer.md`"));
	}
});

test("ticket completion has an observable boundary and accounts for additions", () => {
	for (const sentence of [
		"State “Done means …” for every ticket with a runnable or inspectable outcome to make completion testable.",
		"State “Keep …” with behavior that must remain unchanged to prevent regressions.",
		"Finish when Done means is true, Keep holds, and the tier's pass is clear.",
		"Before the freeze, remove unexplained additions beyond Done means to bound the candidate.",
		"At close, list remaining additions and their reasons to expose their cost.",
	]) assert.ok(lead.includes(sentence), sentence);
});
