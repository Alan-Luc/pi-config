import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import registerTechLead from "../extensions/tech-lead/index.ts";

const body = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");
const durablePlan = readFileSync(new URL("../skills/durable-plan/SKILL.md", import.meta.url), "utf8");
const handoffWriter = readFileSync(new URL("../agents/handoff-writer.md", import.meta.url), "utf8");
const globalInstructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

test("main sessions append tech-lead instructions without dropping prior prompts", () => {
	const starts: Array<(event: { systemPromptOptions: { appendSystemPrompt?: string } }) => void> = [];
	registerTechLead(
		{ on: (event: string, handler: never) => (event === "before_agent_start" && starts.push(handler), () => undefined), registerCommand: () => undefined } as never,
		{},
	);
	assert.equal(starts.length, 1);

	const unset: { appendSystemPrompt?: string } = {};
	starts[0]( { systemPromptOptions: unset });
	assert.equal(unset.appendSystemPrompt, body);

	const prior = { appendSystemPrompt: "Prior prompt" };
	starts[0]({ systemPromptOptions: prior });
	assert.equal(prior.appendSystemPrompt, `Prior prompt\n\n${body}`);
});

test("ticket work loads prior decisions before implementation", () => {
	assert.ok(body.includes("For ticket-shaped work, load `durable-plan` before questions, edits, or delegation"));
	assert.ok(body.includes("Do not silently drop or override explicit requirements or recorded decisions"));
	assert.ok(body.includes("Do not skip required context to satisfy an arbitrary count"));
	assert.ok(body.includes("light-review briefs also carry the original request, governing plan or decision paths"));
	assert.ok(durablePlan.includes("## Ticket context preflight"));
	assert.ok(durablePlan.includes("This preflight supplies context; it does not by itself create a plan or add an approval gate."));
	assert.ok(!body.includes("direct work usually needs 0-3 checks"));
});

test("artifact links include their type and visible repo-relative path", () => {
	for (const label of ["Work log:", "Plan:", "Handoff:", "Decision:", "Report:"]) {
		assert.ok(globalInstructions.includes(label));
	}
	assert.ok(globalInstructions.includes("keep the repo-relative path as the visible link text"));
	assert.ok(globalInstructions.includes("Never output an unlabeled artifact-path list"));
});

test("normal Tech Lead mode defaults independent research to background explorers", () => {
	assert.ok(body.includes("Outside Solo mode, delegate non-trivial independent research to asynchronous background `code-explorer` agents by default"));
	assert.ok(body.includes("one per genuine disjoint seam in a single launch"));
	assert.ok(body.includes("must not duplicate delegated investigation"));
	assert.ok(body.includes("Trivial lookups and tightly coupled same-seam traces stay direct, as do governing-artifact and prerequisite reads required before delegation"));
	assert.ok(body.includes("it owns scoping and synthesis"));
});

test("completion and decision records use the native append-only work log", () => {
	assert.ok(body.includes("use the native `work_log` tool to append material"));
	assert.ok(body.includes("use the native `work_log` tool to append the daily work log"));
	assert.ok(body.includes("Never edit a daily work log with generic file tools"));
	assert.ok(!body.includes("retro-session"));
});

test("handoffs contain only human actions and references to completed work", () => {
	const appendBarrier = body.indexOf("await its verified result before any dependent handoff or final response");
	const handoffDispatch = body.indexOf("When an action remains, launch one fresh asynchronous `subagent`");
	assert.ok(appendBarrier >= 0 && appendBarrier < handoffDispatch);
	assert.ok(body.includes("Do not duplicate completed work or verification from the work log"));
	assert.ok(body.includes("await it before the final response"));
	for (const required of [
		"- Verified outcome.",
		"- One or more exact human-only actions",
		"- Blockers to those actions",
		"- Next state.",
		"- Active plan path",
		"- Exact repo-relative daily work-log path and exact repo-relative task-handoff path.",
	]) {
		assert.ok(handoffWriter.includes(required), required);
	}
	assert.ok(handoffWriter.includes("1. Alan's actions."));
	assert.ok(handoffWriter.includes("2. Blockers."));
	assert.ok(handoffWriter.includes("3. Resume references."));
	assert.ok(handoffWriter.includes("daily work log as the source for completed work and checks"));
	assert.ok(!handoffWriter.includes("1. Agent work."));
	assert.ok(!handoffWriter.includes("3. Verification."));
});

test("subagent children register no prompt hook", () => {
	const events: string[] = [];
	registerTechLead(
		{ on: (event: string) => (events.push(event), () => undefined), registerCommand: (name: string) => events.push(name) } as never,
		{ PI_SUBAGENT_AGENT: "backend-engineer" },
	);
	assert.deepEqual(events, []);
});

function harness(tools: string[]) {
	let active = tools;
	let start: (event: { systemPromptOptions: { appendSystemPrompt?: string } }) => void = () => undefined;
	let solo: (args: string, ctx: unknown) => Promise<void> = async () => undefined;
	const notes: string[] = [];
	registerTechLead(
		{
			on: (_: string, handler: never) => ((start = handler), () => undefined),
			registerCommand: (name: string, o: { handler: never }) => name === "solo" && (solo = o.handler),
			getActiveTools: () => active,
			setActiveTools: (t: string[]) => (active = t),
		} as never,
		{},
	);
	const ctx = { ui: { notify: (m: string) => notes.push(m) } };
	const prompt = () => {
		const o: { appendSystemPrompt?: string } = {};
		start({ systemPromptOptions: o });
		return o.appendSystemPrompt;
	};
	return { toggle: () => solo("", ctx), tools: () => active, prompt, notes };
}

test("/solo is off by default, swaps section and tools on, restores off", async () => {
	const all = ["read", "subagent", "bash", "subagent_resume", "subagent_kill"];
	const h = harness(all);
	assert.equal(h.prompt(), body);
	assert.deepEqual(h.tools(), all);

	await h.toggle();
	assert.deepEqual(h.tools(), ["read", "bash"]);
	const solo = h.prompt() ?? "";
	assert.ok(solo.includes("## Slice and delegate\n\nSolo mode: work directly; do not delegate to subagents.\n"));
	assert.ok(solo.includes("Outside Solo mode, delegate non-trivial independent research"));
	assert.ok(solo.includes("stay direct, as do governing-artifact and prerequisite reads required before delegation"));
	assert.ok(solo.includes("## Review and integration"));
	assert.ok(!solo.includes("## Reconnaissance\n\n## Slice") && solo.includes("## Reconnaissance"));

	await h.toggle();
	assert.deepEqual(h.tools(), all);
	assert.equal(h.prompt(), body);
	assert.equal(h.notes.length, 2);
});

test("a missing Slice and delegate heading throws", () => {
	assert.throws(() => registerTechLead({} as never, {}, "## Other\n"), /missing the "## Slice and delegate" heading/);
});
