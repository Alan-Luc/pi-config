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
		"Never push outside the CDC task-branch policy without Alan's explicit authorization.",
		"The parent CDC may push verified frozen candidates to task branches under the publication grant.",
		"Preserve existing guardrail checks and protected-branch restrictions.",
		"Require Alan's explicit authorization for other pushes.",
		"Local commits grant no push authority.",
		"Children never commit or push; only the parent commits.",
		"Allow routine prompt and configuration changes on `main`.",
	]) assert.ok(globalInstructions.includes(sentence), sentence);
	assert.equal(globalInstructions.split("Keep experiments on `benchmark/<run-id>`").length - 1, 1);
	assert.ok(!globalInstructions.includes("Never put experiments or changes to prompts or configuration on `main`"));
	assert.ok(lead.includes("Use the CDC task-branch policy in `AGENTS.md` for pushes."));
});

test("coverage exceptions have one canonical owner without reducing seats", () => {
	const correctness = lead.split("\n").find((line) => line.startsWith("| Correctness |"));
	assert.equal(correctness, "| Correctness | Pair for explicit review | One routinely; pair for explicit review unless Alan approves the single-seat trial | Reviewer pair |");
	assert.ok(lead.includes("For the single-seat Focused trial, select a reviewer from a different model family than the builder."));
	assert.ok(lead.includes("Preserve explicitly requested deeper coverage."));
	assert.ok(procedure.includes("Use the `tech-lead.md` matrix for correctness seat counts and the approved single-seat trial."));
	for (const duplicate of ["For routine Focused correctness", "For explicit Direct review", "For explicit Focused review", "Use pairs at Full"]) {
		assert.ok(!procedure.includes(duplicate), duplicate);
	}
});

test("reviewers require reachable triggers, scope, and bounded severity", () => {
	for (const sentence of [
		"Name the realistic input, caller, or state and its producer.",
		"Require scope within the ticket's Done means and Keep.",
		"Recommend a P2 fix only when small and local.",
		"Recommend fixes for qualifying P0 and P1 findings.",
		"Leave acceptance, fixes, and regression tests to the parent.",
	]) assert.ok(reviewer.includes(sentence), sentence);
	for (const sentence of [
		"Require each finding's realistic trigger and producer.",
		"Fix qualifying P0 and P1 findings.\nFix P2 only when small and local.",
		"Dismiss everything else with a one-line reason or record an outside-ticket follow-up.",
		"Add regression tests only for accepted findings.",
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
		"State “Done means …” for every ticket with a runnable or inspectable outcome.",
		"State “Keep …” with behavior that must remain unchanged.",
		"Finish when Done means is true, Keep holds, and the tier's pass is clear.",
		"Before the freeze, remove unexplained additions beyond Done means.",
		"At close, list remaining additions and their reasons.",
	]) assert.ok(lead.includes(sentence), sentence);
});
