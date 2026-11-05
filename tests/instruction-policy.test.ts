import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const reviewer = read("agents/code-reviewer.md");
const procedure = read("prompts/eviscerate-diff.md");
const lead = read("extensions/tech-lead/tech-lead.md");

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
		"Fix qualifying P0 and P1 findings; fix P2 only when small and local to bound cleanup.",
		"Dismiss everything else with a one-line reason or record an outside-ticket follow-up to preserve disposition.",
		"Add regression tests only for accepted findings to exclude rejected premises.",
	]) assert.ok(procedure.includes(sentence), sentence);
	assert.ok(reviewer.includes("Leave acceptance, fixes, and regression tests to the parent"));
	assert.ok(!reviewer.includes("fix it"), "the read-only reviewer does not receive fix commands");
	assert.ok(procedure.includes("Require attack inputs reachable through a real interface"));
	for (const name of ["code-reviewer-sol", "code-reviewer-sonnet"]) {
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
