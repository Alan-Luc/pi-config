import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import registerTechLead from "../extensions/tech-lead/index.ts";

const body = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");
const codeReviewPrompt = readFileSync(new URL("../prompts/code_review.md", import.meta.url), "utf8");
const lightReviewer = readFileSync(new URL("../agents/code-reviewer-light.md", import.meta.url), "utf8");
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

test("authorized local commits preserve coherent passing slice boundaries", () => {
	assert.ok(globalInstructions.includes("One explicit task-level authorization to create local commits covers all coherent, passing slice commits"));
	assert.ok(globalInstructions.includes("it never authorizes a push"));
	assert.ok(globalInstructions.includes("Each commit expresses one intent, includes its associated tests, and leaves the repository buildable"));
	assert.ok(globalInstructions.includes("Do not split behavior from tests"));
	assert.ok(globalInstructions.includes("Keep full integration review across the complete commit set"));
	assert.ok(body.includes("record the pre-task HEAD before the first commit"));
	assert.ok(body.includes("use `inspect_change` on the stable delta to seed check selection"));
	assert.ok(body.includes("refresh `inspect_change` and the accepted slice artifact"));
	assert.ok(body.includes("staged file list and diff exactly match that artifact"));
	assert.ok(body.includes("a mismatch must be unstaged and its ownership resolved"));
	assert.ok(body.includes("Only then may the parent commit; children never commit"));
	assert.ok(body.includes("excludes sibling or unrelated changes"));
	assert.ok(body.includes("never a push"));
	assert.ok(!body.includes("verified increments without committing"));
});

test("authorized slice commits follow inspect, check, review, refresh, stage, commit order", () => {
	const inspect = body.indexOf("use `inspect_change` on the stable delta");
	const check = body.indexOf("run focused checks", inspect);
	const review = body.indexOf("obtain a completed bounded review", check);
	const remediate = body.indexOf("remediate material findings", review);
	const recheck = body.indexOf("rerun affected checks", remediate);
	const refresh = body.indexOf("refresh `inspect_change` and the accepted slice artifact", recheck);
	const stage = body.indexOf("stages the accepted slice", refresh);
	const verify = body.indexOf("verifies that the staged file list and diff exactly match", stage);
	const commit = body.indexOf("Only then may the parent commit", verify);
	assert.ok(inspect >= 0 && inspect < check && check < review && review < remediate && remediate < recheck);
	assert.ok(recheck < refresh && refresh < stage && stage < verify && verify < commit);
});

test("authorized slice commits retain a final cross-commit review", () => {
	const sliceReview = body.indexOf("obtain a completed bounded review");
	const sliceCommit = body.indexOf("Only then may the parent commit", sliceReview);
	const integrationReview = body.indexOf("capture and review one exact pre-task-base-to-final-HEAD integration diff", sliceCommit);
	assert.ok(sliceReview >= 0 && sliceReview < sliceCommit && sliceCommit < integrationReview);
	assert.ok(body.includes("even when the worktree is clean"));
	assert.ok(codeReviewPrompt.includes("recorded pre-task base and final HEAD"));
	assert.ok(codeReviewPrompt.includes("one exact integration patch across the complete commit set"));
	assert.ok(codeReviewPrompt.includes("Use `inspect_change` only for any residual worktree delta"));
});

test("global naming guidance requires obvious purpose-first names", () => {
	assert.ok(globalInstructions.includes("**Purpose-first naming**"));
	assert.ok(globalInstructions.includes("Use action verbs for operations and precise nouns for files, types, and values"));
	assert.ok(globalInstructions.includes("unless they are exact domain terms"));
	assert.ok(globalInstructions.includes("Do not use comments to compensate for unclear names"));
});

test("business logic uses named data instead of magic indexes", () => {
	assert.ok(globalInstructions.includes("**Named business data**"));
	assert.ok(globalInstructions.includes("Use named fields or keys for heterogeneous business data"));
	assert.ok(globalInstructions.includes("avoid magic indexes and parallel arrays"));
	assert.ok(globalInstructions.includes("then convert once before applying business logic"));
});

test("normal Tech Lead mode defaults independent research to background explorers", () => {
	assert.ok(body.includes("Outside Solo mode, delegate non-trivial independent research to asynchronous background `code-explorer` agents by default"));
	assert.ok(body.includes("one per genuine disjoint seam in a single launch"));
	assert.ok(body.includes("must not duplicate delegated investigation"));
	assert.ok(body.includes("Trivial lookups and tightly coupled same-seam traces stay direct, as do governing-artifact and prerequisite reads required before delegation"));
	assert.ok(body.includes("it owns scoping and synthesis"));
});

test("light-review producers match the guarded dispatch contract", () => {
	for (const surface of [body, codeReviewPrompt, lightReviewer]) {
		assert.ok(surface.includes("Patch artifact:"));
		assert.ok(surface.includes("Review paths:"));
	}
	for (const producer of [body, codeReviewPrompt]) {
		assert.ok(producer.includes("node:os.tmpdir()/pi"));
		assert.ok(!producer.includes("under `/tmp/pi/`"));
	}
});

test("post-reconnaissance briefs reuse a parent-owned evidence packet", () => {
	for (const producer of [body, codeReviewPrompt]) {
		for (const contract of [
			"Source of truth: <active plan and decision paths with relevant headings or None>",
			"Verified facts: <facts the parent directly confirmed; include evidence when useful>",
			"Read first: <smallest exact paths/ranges>",
			"Open questions: <only unanswered questions this worker owns>",
		]) {
			assert.ok(producer.includes(contract), contract);
		}
	}
	assert.ok(body.includes("The parent owns and synthesizes this packet"));
	assert.ok(body.includes("Siblings reuse `Source of truth` and `Verified facts`"));
	assert.ok(body.includes("Initial discovery scouts may start with minimal `Verified facts`"));
	assert.ok(body.includes("report contradictory evidence instead of silently repeating broad reconnaissance"));
});

test("current-change workflows reuse one bounded inspect_change packet", () => {
	for (const producer of [body, codeReviewPrompt]) {
		assert.ok(producer.includes("call `inspect_change` once"));
		assert.ok(producer.includes("verification recipes"));
		assert.ok(producer.includes("fall back once"));
		assert.ok(producer.includes("does not replace the exact patch artifact"));
	}
	assert.ok(body.includes("instead of repeating covered Git or file reads"));
	assert.ok(body.includes("Skip it when the task is not about current changes"));
	assert.ok(body.includes("refresh `inspect_change` once if the prior packet predates edits"));
	assert.ok(codeReviewPrompt.includes("without an exact supplied diff/artifact"));
	assert.ok(codeReviewPrompt.includes("once after the delta is stable"));
	assert.ok(codeReviewPrompt.includes("Follow up only for explicit omissions or required caller/contract evidence outside the packet"));
});

test("repository-context workflows reuse one bounded inspect_context packet", () => {
	for (const producer of [body, codeReviewPrompt]) {
		assert.ok(producer.includes("call `inspect_context` once"));
		assert.ok(producer.includes("Reuse the packet and investigate only material gaps"));
	}
	assert.ok(body.includes("with a high-signal literal query before manual discovery or explorer dispatch"));
	assert.ok(body.includes("skip it when exact paths already govern or a direct lookup is enough"));
	assert.ok(codeReviewPrompt.includes("When ownership, caller, or contract context remains unclear after fixing the change scope"));
	assert.ok(codeReviewPrompt.includes("before manual discovery or `code-explorer` dispatch"));

	const inspectChange = body.indexOf("call `inspect_change` once");
	const inspectContext = body.indexOf("call `inspect_context` once");
	const explorerDispatch = body.indexOf("delegate non-trivial independent research", inspectContext);
	assert.ok(inspectChange >= 0 && inspectChange < inspectContext && inspectContext < explorerDispatch);
});

test("focused checks and review precede final broad verification", () => {
	const focused = body.indexOf("Run the narrowest changed-area checks");
	const review = body.indexOf("dispatch the bounded independent review", focused);
	const broad = body.indexOf("Run the required broad/full suite once", review);
	assert.ok(focused >= 0 && focused < review && review < broad);
	assert.ok(body.includes("state the reason before an earlier broad run"));
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
