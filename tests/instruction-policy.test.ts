import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const reviewer = read("agents/code-reviewer.md");
const procedure = read("prompts/eviscerate-diff.md");
const lead = read("extensions/tech-lead/tech-lead.md");

test("reviewers require reachable triggers, scope, and bounded severity", () => {
	for (const sentence of [
		"Name each finding's realistic trigger and who or what produces it.",
		"Accept a finding only if it falls within the ticket's Done means and Keep.",
		"For P2, accept the finding only if the fix is small and local.",
		"Accept P0 and P1 findings that meet these criteria.",
		"Report accepted findings to the parent for fixes.",
	]) assert.ok(reviewer.includes(sentence), sentence);
	for (const sentence of [
		"Apply [the canonical finding criteria](../agents/code-reviewer.md) before accepting findings for remediation.",
		"Fix accepted findings.",
		"For every other finding, give a one-line dismissal reason or record a follow-up outside this ticket.",
		"Add regression tests only for accepted findings.",
	]) assert.ok(procedure.includes(sentence), sentence);
	assert.ok(reviewer.includes("Leave remediation and regression tests to the parent under [the review procedure](../prompts/eviscerate-diff.md)"));
	assert.ok(!reviewer.includes("fix it"), "the read-only reviewer does not receive fix commands");
	assert.ok(!procedure.includes("Name each finding's realistic trigger"), "the procedure links to the criteria owner");
	assert.ok(procedure.includes("Use attack inputs that can reach the system through a real interface."));
	for (const name of ["code-reviewer-sol", "code-reviewer-sonnet"]) {
		assert.ok(read(`agents/${name}.md`).includes("canonical role body in `agents/code-reviewer.md`"));
	}
});

test("ticket completion has an observable boundary and accounts for additions", () => {
	for (const sentence of [
		"State Done means for every ticket as an outcome that can be run or inspected.",
		"State Keep for every ticket as behavior that must remain unchanged.",
		"When Done means is true, Keep holds, and the pass for the ticket's tier is clear, finish the ticket.",
		"Stop there.",
		"Before the freeze, remove additions that lack a reason beyond Done means.",
		"At close, list each addition beyond Done means and give its reason.",
	]) assert.ok(lead.includes(sentence), sentence);
});
