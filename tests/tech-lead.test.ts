import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it, test } from "bun:test";
import registerTechLead from "../extensions/tech-lead/index.ts";
import { briefInstructions } from "../extensions/artifact-contracts/briefs.ts";
import { getEffectiveAgentDefinitions } from "../git/github.com/Alan-Luc/pi-subagents/src/agents/definitions.ts";
import { resolveSubagentTimeoutState } from "../git/github.com/Alan-Luc/pi-subagents/src/launch/policy.ts";

const techLead = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");
const durablePlan = readFileSync(new URL("../skills/durable-plan/SKILL.md", import.meta.url), "utf8");
const globalInstructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const reviewPrompt = readFileSync(new URL("../prompts/eviscerate-diff.md", import.meta.url), "utf8");
const taskRecipe = readFileSync(new URL("../skills/task-recipe/SKILL.md", import.meta.url), "utf8");
const recipeCards = readFileSync(new URL("../skills/task-recipe/references/recipes.md", import.meta.url), "utf8");
const takeOverPrompt = readFileSync(new URL("../prompts/take-over.md", import.meta.url), "utf8");
const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8")) as {
	modelThinkingLevels?: Record<string, string>;
};
const agents = Object.fromEntries(
	readdirSync(new URL("../agents/", import.meta.url))
		.filter((path) => path.endsWith(".md"))
		.map((path) => [path.replace(/\.md$/, ""), readFileSync(new URL(`../agents/${path}`, import.meta.url), "utf8")]),
);
const words = (text: string) => text.trim().split(/\s+/).length;
const deliveryOwners = [
	{
		invariantName: "prerequisites",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Before long work, check runtime, commands, network, authentication, database, and service identities.",
	},
	{
		invariantName: "candidate capture and task-owned paths",
		canonicalOwnerPath: "extensions/artifact-contracts/review-preparation.ts",
		requiredMarker: "registerReviewPreparation",
	},
	{
		invariantName: "ownership, callers, and contracts",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Map ownership, callers, contracts, risks, and checks. Stop reconnaissance when implementation is safe.",
	},
	{
		invariantName: "evidence packet",
		canonicalOwnerPath: "extensions/artifact-contracts/briefs.ts",
		requiredMarker: "Every `subagent` task (and each `children[].task`) must fill exactly this template",
	},
	{
		invariantName: "dependency slicing",
		canonicalOwnerPath: "extensions/tech-lead/tech-lead.md",
		requiredMarker: "Schedule by dependencies and owned paths to prevent conflicts and needless waits.",
	},
	{
		invariantName: "worker boundaries",
		canonicalOwnerPath: "agents/implementation-engineer.md",
		requiredMarker: "Own exactly the briefed objective and paths.",
	},
	{
		invariantName: "focused checks",
		canonicalOwnerPath: "skills/task-recipe/references/recipes.md",
		requiredMarker: "Run focused checks during iteration.",
	},
	{
		invariantName: "exact review artifact and hash",
		canonicalOwnerPath: "extensions/artifact-contracts/review-preparation.ts",
		requiredMarker: "patchSha256",
	},
	{
		invariantName: "material remediation",
		canonicalOwnerPath: "prompts/eviscerate-diff.md",
		requiredMarker: "After fixes, refresh affected checks, reviewer pairs, and live proof to preserve current clearance."
	},
	{
		invariantName: "broad integration and candidate recapture",
		canonicalOwnerPath: "prompts/eviscerate-diff.md",
		requiredMarker: "Give the success observer one applicable broad integration run to prevent duplicate runs.",
	},
	{
		invariantName: "background jobs",
		canonicalOwnerPath: "prompts/eviscerate-diff.md",
		requiredMarker: "Reconcile task-owned jobs before freezing to prevent hidden mutations.",
	},
	{
		invariantName: "background-first verification",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "use background `start` and `collect` by default",
	},
	{
		invariantName: "authorization",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Never push outside the CDC task-branch policy without Alan's explicit authorization",
	},
	{
		invariantName: "post-commit integration patch",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "After committing, inspect the exact base-to-HEAD patch for unintended changes",
	},
	{
		invariantName: "finish records",
		canonicalOwnerPath: "extensions/tech-lead/tech-lead.md",
		requiredMarker: "Record each slice once through `work_log` to prevent competing histories.",

	},
	{
		invariantName: "pre-dispatch ready set",
		canonicalOwnerPath: "git/github.com/Alan-Luc/pi-subagents/src/tools/subagent-tools.ts",
		requiredMarker: "Before a pure async launch, derive the full ready set from approved dependencies and exact path ownership; launch every ready disjoint helper slice in one children batch.",
	},
] as const;

function includesAll(text: string, values: readonly string[]) {
	for (const value of values) assert.ok(text.includes(value), value);
}

test("review pairs use persisted ordinary and difficult counterpart profiles", () => {
	includesAll(reviewPrompt, [
		"Pair `code-reviewer` with `code-reviewer-sonnet`",
		"For difficult risks, pair `code-reviewer-sol` with `code-reviewer-opus`",
	]);
	assert.ok(agents["code-reviewer-sol"].includes("paired with code-reviewer-opus"));
});

test("tech lead owns the current ceremony matrix and its conditional gates", () => {
	const matrix = techLead.split("| Ceremony | Direct | Focused | Full |")[1]?.split("\n\n")[0];
	assert.ok(matrix);
	const rows = matrix.split("\n").filter((line) => line.startsWith("|") && !line.startsWith("|---"));
	const rowNames = rows.map((line) => line.split("|")[1].trim());
	assert.deepEqual(rowNames, ["Selection", "Recipe and tasks", "Durable plan", "Extra approval", "Test first", "Live verification", "Correctness", "Structural review", "Work log"]);
	const row = (name: string) => rows.find((line) => line.split("|")[1].trim() === name) ?? "";
	const cells = (name: string) => row(name).split("|").slice(2, 5).map((cell) => cell.trim());
	assert.deepEqual(cells("Recipe and tasks"), ["", "Required", "Required"]);
	assert.deepEqual(cells("Extra approval"), ["", "", "Trust boundaries"]);
	assert.deepEqual(cells("Correctness"), ["Pair for explicit review", "One routinely; pair for explicit review unless Alan approves the single-seat trial", "Reviewer pair"]);
	assert.deepEqual(cells("Work log"), ["", "Each slice and pass", "Each slice and pass"]);
	includesAll(row("Selection"), ["Mechanical or prose", "unchanged behavior", "Bounded integration", "Consequential", "security", "data safety", "caller guarantees"]);
	includesAll(row("Durable plan"), ["Explicit planning", "approval gates", "existing plan", "Required"]);
	includesAll(row("Test first"), ["Check consuming surface", "Failing behavior test", "passing refactor tests", "meaningful failure paths"]);
	includesAll(row("Live verification"), ["One worker covers success and attack", "Separate success and attack workers"]);
	includesAll(row("Structural review"), ["Named risk only"]);
	includesAll(techLead, ["at least three ownership seams", "Retain existing coverage outside approved trials", "State the tier and reason before work", "Escalate on new evidence", "Require Alan's approval before downgrading", "Until Alan approves implementation, edit only the designated plan file during planning"]);
	assert.doesNotMatch(techLead, /^\| Small \|/m);
	assert.doesNotMatch(globalInstructions, /^\| (?:Ceremony|Direct|Small|Focused|Full) \|/m, "the tier table lives in tech-lead, not AGENTS.md");
	for (const consumer of [globalInstructions, durablePlan, taskRecipe, recipeCards, reviewPrompt, agents["live-verifier"], agents["code-reviewer"]]) {
		assert.doesNotMatch(consumer, /^\| (?:Direct|Small|Focused|Full) \|/m, "consumers link to the one policy owner instead of defining a tier table");
	}
	includesAll(techLead, ["Classify by risk using this matrix", "State the tier and reason before work", "Escalate on new evidence", "Require Alan's approval before downgrading"]);
	includesAll(durablePlan, ["canonical acceptance matrix for Direct, Focused, and Full in `tech-lead.md`", "approval-gated Focused work require one"]);
	includesAll(taskRecipe, ["tier matrix in `tech-lead.md`", "recipe selection and copy semantics"]);
	includesAll(recipeCards, ["canonical tier matrix in `tech-lead.md`"]);
	includesAll(agents["live-verifier"], ["For Focused, report separate success and attack observations from one worker", "For Full, report only your assigned success or attack coverage"]);
	includesAll(agents["code-reviewer"], ["Limit combined `read`, `grep`, and `find` calls to 12 for Focused and 24 for Difficult review"]);
	assert.doesNotMatch(agents["code-reviewer"], /\bSmall\b/);
	includesAll(reviewPrompt, ["Use the `tech-lead.md` matrix", "At Focused, assign one read-only `live-verifier` success and attack observations", "At Full, assign separate success and attack workers"]);
});

test("reviewers preserve the guardrails threat-model boundary and explicit dismissal reason", () => {
	const threatModel = readFileSync(new URL("../extensions/guardrails/README.md", import.meta.url), "utf8");
	includesAll(agents["code-reviewer"], ["guardrails threat model", "Dismiss an input as out-of-model only when that model excludes it", "with a one-line reason"]);
	includesAll(threatModel, ["Shell wrappers, obfuscation", "unsupported literal-command inputs", "State that reason explicitly", "A literal recognized mutation", "remains in model"]);
});

test("startup policy reports its aggregate word target without obscuring instructions", () => {
	const startup = [globalInstructions, techLead, briefInstructions()].join("\n");
	console.info(`Startup instructions: ${words(startup)} words (target: 1,500; clarity and safety take precedence).`);
	assert.doesNotMatch(techLead, /load `delivery-workflow`|The five work-seam agents are:|^Template:/m);
	assert.ok(!techLead.includes("node:os.tmpdir()/pi"));
});

test("common verification routes both skills and independent live checks alongside tests", () => {
	const routing = globalInstructions.split("\n").find((line) => line.includes("`live-verification`") && line.includes("`build-live-verification`"));
	assert.ok(routing, "both procedural skills have always-known verification routing");
	assert.match(routing, /Parallelize independent live checks and tests/);
	assert.match(routing, /prerequisites|shared mutable state/);
	assert.match(routing, /Require both results/);
});

test("temporary dogfooding reuses evidence and records friction without ceremonial work", () => {
	assert.ok(globalInstructions.includes("extensions/extension-dogfooding.md"));
	const dogfooding = readFileSync(new URL("../extensions/extension-dogfooding.md", import.meta.url), "utf8");
	includesAll(dogfooding, [
		"`inspect_context`", "`inspect_change`", "`verification_evidence` background `start`",
		"automatic terminal notification, then `collect`", "Do not poll",
		"same established evidence", "session-local ID", "The parent owns sharing",
		"Do not add agents, checks, packet refreshes, or benchmarks",
		"Alongside the final non-trivial work-log entry", "Expected help versus actual result",
		"fallback, workaround, outcome", "No extension friction observed",
	]);
});

test("one recipe skill owns card selection and six checkable cards without a second router", () => {
	includesAll(techLead, ["For Focused and Full work, load `task-recipe`", "Honor stops, pauses, unknown authorization, and real gates", "Otherwise, execute authorized work"]);
	includesAll(taskRecipe, [
		"sole authority", "steps verbatim into live tasks", "skipped: <reason>",
		"Direct work is exempt", "whether or not it is committed",
		"router owns scheduling, resumption and continuation", "selection and copy semantics only",
		"retain the currently loaded role defaults", "live proof belong at the pass",
	]);
	assert.deepEqual([...recipeCards.matchAll(/^## (.+)$/gm)].map((match) => match[1]), [
		"Bug fix", "Feature", "Refactor", "Investigation", "Review", "Harness change",
	]);
	for (const card of recipeCards.split(/^## /m).slice(1)) {
		const steps = card.split("\n").filter((line) => /^\d+\. /.test(line));
		assert.ok(steps.length > 0, "each card has copyable steps");
		for (const [index, step] of steps.entries()) {
			assert.ok(step.startsWith(`${index + 1}. `), "steps use consecutive numbers");
			assert.match(step, /^\d+\. .+\. ✓ .+$/, "each step has an action and an observable check");
		}
		assert.match(card, /\*\*Done means:\*\* .+/, "each card ends in a checkable result");
	}
	includesAll(recipeCards, ["assertion fails for the intended reason", "Confirm that tests pass before refactoring. Use characterization instead of inventing a failing test.", "Diagnose before proposing a patch", "prompts/spike.md", "prompts/eviscerate-diff.md", "plausible broken condition", "representative safe rerun or interruption"]);
	for (const path of ["skills/task-recipe/SKILL.md", "skills/task-recipe/references/recipes.md"]) {
		const file = new URL(`../${path}`, import.meta.url);
		for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
			const target = new URL(match[1].split("#")[0], file);
			assert.ok(existsSync(target), `${path} has a missing relative link: ${match[1]}`);
		}
	}
});

test("router schedules work by dependencies and preserves approval gates", () => {
	includesAll(techLead, ["Schedule by dependencies and owned paths", "Continue independent ready work after side questions", "Block on evidenced safety, correctness, prerequisite, or verification defects", "Honor stops, pauses, unknown authorization, and real gates", "Require Alan's approval before downgrading"]);
});

test("router preserves owned-checkout execution and planning read-only controls", () => {
	includesAll(techLead, [
		"Target the owned checkout in every command.",
		"Treat `cd` as local to one call.",
		"Launch writers from the owned checkout or keep writes local because briefs cannot confine paths.",
		"For planning requests, present goals, scope, decisions, slices, checks, and questions to inform build approval",
		"Until Alan approves implementation, edit only the designated plan file during planning.",
		"Treat delivery receipts and stale reports as incomplete results.",
		"Repair delivery or report unknown outcomes instead of assuming completion.",
		"For independent coordinator sessions, use supported manage, adopt, publish, and inbox operations.",
		"Schedule by dependencies and owned paths",
	]);
	includesAll(reviewPrompt, [
		"For applicable live risks, check boundaries, retries, cancellation, and negative effects",
		"After fixes, refresh affected checks, reviewer pairs, and live proof",
		"Start a fresh reviewer session for each changed-source delta",
		"Give the success observer one applicable broad integration run",
	]);
});

test("oversized staged advisories skip deterministically without partitioning", () => {
	const deslop = readFileSync(new URL("../skills/deslop/SKILL.md", import.meta.url), "utf8");
	includesAll(deslop, ["frozen UTF-8 staged patch", "12 KiB", "250 added lines", "excluding `+++` headers", "do not dispatch or partition", "`deslop: skipped (oversized)`", "Equality is eligible", "30-second", "`deslop: timed out`"]);
	assert.doesNotMatch(deslop, /partition it among|fresh Haiku\/low instances|non-overlapping paths or hunks/);
	assert.ok(recipeCards.includes("../../deslop/SKILL.md"), "recipes link to the advisory owner");
});

test("task effort follows actual uncertainty within each model's supported levels", () => {
	includesAll(taskRecipe, [
		"smallest justified effort once", "short rationale in its existing brief",
		"A ticket's tier or a role title does not determine", "Builder and reviewer profiles lock their configured models and effort",
		"chosen model's supported levels", "Do not substitute a model without saying so",
		"Review and design profiles retain their explicitly pinned effort", "Use `off` only where the chosen model supports it",
		"exact triggers, reproduction steps, log lines, error lines", "No diagnosis, contract choice or unresolved failure-path design",
		"worker reports the concrete missing fact", "parent reclassifies that subtask",
		"not permission to silently drop a requested level or escalate models",
	]);
	assert.doesNotMatch(taskRecipe, /thinking-overrides|opted-in role|Missing opt-in/);
	assert.deepEqual([...taskRecipe.matchAll(/^\| `(off|low|medium|high)` \|/gm)].map((match) => match[1]), ["off", "low", "medium", "high"]);
});

test("the router preserves direct, planning, and approval controls", () => {
	includesAll(techLead, [
		"Classify by risk using this matrix",
		"For ticket-shaped or resumed work, load `durable-plan`",
		"For planning requests, present goals, scope, decisions, slices, checks, and questions",
		"Until Alan approves implementation, edit only the designated plan file during planning.",
	]);
	includesAll(globalInstructions, [
		"Commit passing, coherent slices locally",
		"Never push outside the CDC task-branch policy without Alan's explicit authorization",
		"Children never commit",
	]);
	assert.ok(durablePlan.includes("## Ticket context preflight"));
});

test("the router preserves lifecycle ownership without leaking delegation manuals", () => {
	includesAll(techLead, [
		"Delegate across real expertise or ownership boundaries",
		"Use tool-owned briefs and delivery procedures",
		"Target the owned checkout in every command.",
	]);
	includesAll(techLead, ["prompts/eviscerate-diff.md", "Preserve explicitly requested deep review coverage"]);
	includesAll(techLead, ["State the tier and reason before work", "Escalate on new evidence", "Require Alan's approval before downgrading", "Require approval for explicit requests", "For gated Direct work", "Until Alan approves implementation, edit only the designated plan file during planning"]);
	for (const consumer of [globalInstructions, reviewPrompt, durablePlan]) assert.doesNotMatch(consumer, /^\| (Direct|Full) \|/m, "work-tier definitions stay in tech-lead, separate from reviewer depth profiles");
	for (const owner of [globalInstructions, techLead, reviewPrompt, durablePlan]) assert.doesNotMatch(owner, /truly trivial|quick iterations|very small, low-risk/i);
	assert.doesNotMatch(techLead, /Apply Ponytail|Truly trivial direct work|A plan never authorizes push|The parent may create coherent passing local commits/);
	assert.doesNotMatch(techLead, /Template:|The five work-seam agents are:|PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN|worker result/);
	assert.doesNotMatch(takeOverPrompt, /roster|Template:|PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN/);
	for (const promptPath of ["brief-plan.md", "plan-with-me.md"]) {
		const prompt = readFileSync(new URL(`../prompts/${promptPath}`, import.meta.url), "utf8");
		assert.doesNotMatch(prompt, /does not need a plan/, promptPath);
	}
});

it.each(deliveryOwners)("delivery invariant: $invariantName", ({ canonicalOwnerPath, requiredMarker }) => {
	const owner = readFileSync(new URL(`../${canonicalOwnerPath}`, import.meta.url), "utf8");
	assert.ok(owner.includes(requiredMarker), `${canonicalOwnerPath} is missing ${requiredMarker}`);
});

test("the roster includes the canonical live verifier and explicit MR observer with exact model profiles", () => {
	assert.deepEqual(Object.keys(agents).sort(), [
		"code-explorer",
		"code-reviewer",
		"code-reviewer-opus",
		"code-reviewer-sol",
		"code-reviewer-sonnet",
		"implementation-engineer",
		"implementation-engineer-opus",
		"implementation-engineer-sol",
		"live-verifier",
		"mr-babysitter",
		"test-automation-engineer",
	]);
	for (const name of ["implementation-engineer", "test-automation-engineer"]) {
		assert.match(agents[name], /^tools: .*TaskCreate,TaskList,TaskGet,TaskUpdate,submit_agent_result$/m);
	}
	assert.ok(globalInstructions.includes("Not run: <reason>"));
	assert.match(agents["code-explorer"], /^thinking: low$/m);
	assert.match(agents["code-reviewer"], /^thinking: high$/m);
	assert.match(agents["implementation-engineer"], /^thinking: medium$/m);
	assert.match(agents["test-automation-engineer"], /^thinking: high$/m);
	assert.deepEqual(settings.modelThinkingLevels, {
		"openai-codex/gpt-6.1-sol": "medium",
		"openai-codex/gpt-6-luna": "high",
	});
	for (const name of ["code-explorer", "code-reviewer"]) {
		assert.doesNotMatch(agents[name], /^tools: .*\bTask(?:Create|List|Get|Update)\b/m);
	}
	for (const name of ["code-explorer", "code-reviewer", "implementation-engineer", "test-automation-engineer"]) {
		assert.match(agents[name], /^tools: .*inspect_context,inspect_change/m);
	}
	assert.match(agents["code-reviewer"], /Use `inspect_context` only for unresolved named callers/);
	for (const name of ["code-explorer", "implementation-engineer", "test-automation-engineer"]) {
		assert.match(agents[name], /`inspect_context`[^.\n]*\bwhen\b/);
		assert.match(agents[name], /`inspect_change`[^.\n]*\bwhen\b/);
	}
	for (const removed of ["backend-engineer", "frontend-engineer", "code-reviewer-light", "requirements-clarifier"]) {
		assert.equal(existsSync(new URL(`../agents/${removed}.md`, import.meta.url)), false);
		assert.ok(!reviewPrompt.includes(removed));
	}
});

it.each([
	{ name: "code-explorer", model: "openai-codex/gpt-6-luna", thinking: "low", canonical: "code-explorer" },
	{ name: "mr-babysitter", model: "openai-codex/gpt-6-luna", thinking: "medium", canonical: "mr-babysitter" },
	{ name: "implementation-engineer", model: "openai-codex/gpt-6-luna", thinking: "medium", canonical: "implementation-engineer" },
	{ name: "test-automation-engineer", model: "openai-codex/gpt-6-luna", thinking: "high", canonical: "test-automation-engineer" },
	{ name: "live-verifier", model: "openai-codex/gpt-6-luna", thinking: "low", canonical: "live-verifier" },
	{ name: "code-reviewer", model: "openai-codex/gpt-6-luna", thinking: "high", canonical: "code-reviewer" },
	{ name: "code-reviewer-sonnet", model: "anthropic/claude-sonnet-5-5", thinking: "high", canonical: "code-reviewer" },
	{ name: "code-reviewer-sol", model: "openai-codex/gpt-6.1-sol", thinking: "high", canonical: "code-reviewer" },
	{ name: "code-reviewer-opus", model: "anthropic/claude-opus-5-5", thinking: "high", canonical: "code-reviewer" },
	{ name: "implementation-engineer-sol", model: "openai-codex/gpt-6.1-sol", thinking: "high", canonical: "implementation-engineer" },
	{ name: "implementation-engineer-opus", model: "anthropic/claude-opus-5-5", thinking: "high", canonical: "implementation-engineer" },
])("the installed loader resolves $name without inferred overrides", ({ name, model, thinking, canonical }) => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = new URL("../", import.meta.url).pathname;
	try {
		const definitions = getEffectiveAgentDefinitions(process.env.PI_CODING_AGENT_DIR);
		const profile = definitions.find((definition) => definition.name === name);
		const owner = definitions.find((definition) => definition.name === canonical);
		assert.ok(profile && owner);
		assert.equal(profile.model, model);
		assert.equal(profile.thinking, thinking);
		assert.equal(profile.allowModelOverride, !/^(implementation-engineer|code-reviewer)(-|$)/.test(name));
		assert.equal(profile.thinkingOverrides, undefined);
		assert.equal(profile.tools, owner.tools);
		assert.equal(profile.skills, owner.skills);
		if (name === "live-verifier") {
			assert.equal(profile.tools, "read,bash,grep,find,inspect_context,inspect_change,verification_evidence,bg_run,bg_status,bg_logs,bg_kill,submit_agent_result");
			assert.equal(profile.skills, "none");
		}
		assert.notEqual(profile.noContextFiles, true);
		assert.equal(profile.parentClosePolicy, "terminate");
		assert.equal(profile.spawning, false);
		if (name !== canonical) assert.ok(profile.body?.includes(`agents/${canonical}.md`));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("live verifier is a distinct fixed-low read-only role and test writing stays with its owner", () => {
	const verifier = agents["live-verifier"];
	assert.match(verifier, /^model: openai-codex\/gpt-6-luna$/m);
	assert.match(verifier, /^thinking: low$/m);
	assert.match(verifier, /^allow-model-override: true$/m);
	assert.match(verifier, /^tools: read,bash,grep,find,inspect_context,inspect_change,verification_evidence,bg_run,bg_status,bg_logs,bg_kill,submit_agent_result$/m);
	assert.match(verifier, /^flags: --no-mcp$/m);
	assert.match(verifier, /^deny-env: GITLAB_PERSONAL_ACCESS_TOKEN$/m);
	assert.match(verifier, /^skills: none$/m);
	assert.match(verifier, /skills\/live-verification\/SKILL\.md/);
	includesAll(verifier, [
		"keep required checks and receipts in one live runtime",
		"use bounded synchronous `verification_evidence` `run`",
		"Do not use `caller_ping` to wait or keep the helper alive",
		"Do not report receipts from a prior runtime as current `Verified by`",
		"Preserve asynchronous `start` and `collect` when task ownership genuinely persists",
		"not a synchronous default",
	]);
	assert.doesNotMatch(verifier, /(?:^|,)\s*(?:edit|write|subagent|TaskCreate|TaskUpdate)(?:,|$)/m);
	assert.doesNotMatch(verifier, /^thinking-overrides:/m);
	assert.match(agents["test-automation-engineer"], /^thinking: high$/m);
	assert.match(agents["test-automation-engineer"], /Add the smallest explicit, deterministic cases/);
	assert.doesNotMatch(agents["test-automation-engineer"], /For the full-review live-verification lane/);
});

test("implementation and review roles preserve material behavior", () => {
	includesAll(globalInstructions, ["trust-boundary validation", "accessibility", "strict types"]);
	includesAll(agents["implementation-engineer"], ["focused happy and meaningful failure-path tests", "verification_evidence"]);
	includesAll(agents["code-reviewer"], [
		"Patch artifact:", "Review paths:",
		"Limit combined `read`, `grep`, and `find` calls to 12 for Focused and 24 for Difficult review",
		"wider-risk brief", "P0", "P1", "P2", "Leave edits",
		"P0:** Exploitable security, data loss, or broken core correctness.",
		"P1:** Material correctness, expected-scale performance, dependency, critical test gap",
		"P2:** Minor maintainability or test debt.",
	]);
	assert.match(agents["code-reviewer"], /^model: openai-codex\/gpt-6-luna$/m);
	assert.ok(reviewPrompt.includes("For pre-existing changes, supply `Review range: HEAD`"));
	assert.ok(reviewPrompt.includes("or `Review range: <base>...<head>`"));
	assert.ok(reviewPrompt.includes("Review the fix delta and affected contracts instead of the whole panel"));
	assert.ok(reviewPrompt.includes("agents/live-verifier.md"));
	assert.ok(reviewPrompt.includes("Route authorized tooling creation through `build-live-verification`"));
	assert.ok(reviewPrompt.includes("Require current selected clearance on the final candidate"));
	assert.ok(reviewPrompt.includes("Reuse supplied Git evidence for unchanged targets"));
});

it.each([
	{ name: "review prompt", instructions: reviewPrompt },
	{ name: "reviewer agent", instructions: agents["code-reviewer"] },
])("$name reuses evidence and distinguishes review targets", ({ instructions }) => {
	if (instructions === reviewPrompt) {
		assert.ok(instructions.includes("Treat omissions and empty packets as incomplete evidence"));
	} else {
		assert.ok(instructions.includes("Treat omitted or empty Git packets as incomplete evidence."));
	}
	assert.match(instructions, /Reuse supplied (?:.* )?evidence/);
	assert.match(instructions, /Refresh .* evidence/);
	assert.doesNotMatch(instructions, /(?:use|calling) `inspect_change` once/i);
	if (instructions === reviewPrompt) {
		includesAll(instructions, ['"direct"', '"merge-base"', "`{}`"]);
		assert.match(instructions, /\bbase\b[\s\S]*\bhead\b/);
	} else {
		includesAll(instructions, ["Review target: plan", "Review target: staged", "Patch artifact:", "Review paths:"]);
	}
});

test("global instructions retain Alan-specific conventions", () => {
	includesAll(globalInstructions, [
		"Commit passing, coherent slices locally",
		"Never push outside the CDC task-branch policy without Alan's explicit authorization",
		"`benchmark/<run-id>`",
		"reuse unchanged reviews",
		"Run narrow checks during iteration and broad suites for final integration",
		"`it.each([...])`",
		"Use “malicious,” not “nasty,”",
		"Comment only for invisible external constraints or workaround reasons",
		"three failed attempts",
	]);
	includesAll(techLead, ["Lead with the conclusion", "At checkpoints, report findings, next steps, and blockers", "Label repo-relative links", "Quiz only on request", "For walkthroughs, explain changes with examples before editing", "On pushback, restate Alan's position"]);
});

test("common test-first standards reach roles without skill loading", () => {
	includesAll(globalInstructions, [
		"Before production behavior edits", "requirement-derived", "intended assertion failure",
		"red, green, and refactor", "Check mechanical and documentation changes directly", "Characterize refactors with passing tests",
		"genuinely impractical", "Size and testing cost grant no exemption",
		"internal refactors", "tautological", "same surface", "including persistence",
	]);
	assert.equal(existsSync(new URL("../skills/tdd/SKILL.md", import.meta.url)), false);
	for (const name of ["code-explorer", "test-automation-engineer"]) {
		assert.match(agents[name], /^skills: none$/m);
		assert.doesNotMatch(agents[name], /^no-context-files: true$/m);
	}
	includesAll(agents["implementation-engineer"], ["Before production edits", "intended assertion", "red, green, and refactor", "same surface"]);
	includesAll(agents["test-automation-engineer"], ["requirement-derived", "internal refactor", "tautological"]);
	includesAll(agents["code-explorer"], ["observable contracts", "test seams", "runtime prerequisites"]);
	includesAll(agents["code-reviewer"], ["requirement-derived tests", "intended red", "real-interface evidence"]);
	includesAll(durablePlan, ["observable acceptance", "caller", "independent proposals", "shared", "judge-only", "Direct work is exempt", "direct consuming-surface check"]);
});

test("solo runtime discloses unavailable cross-model evidence", async () => {
	const session = harness(["read", "bash", "subagent", "subagent_resume", "subagent_kill"]);
	session.initialize();
	await session.toggle();
	assert.ok(session.prompt().includes("Do not claim paired review or model diversity in solo mode"));
	assert.ok(session.prompt().includes("disclose required coverage gaps"));
	assert.deepEqual(session.tools(), ["read", "bash"]);
	await session.toggle();
	assert.equal(session.prompt(), techLead);
});

it.each(["thermonuclear-correctness-review", "thermonuclear-structural-review", "deslop"])("the %s skill preserves selective routing and source provenance", (name) => {
	const directory = new URL(`../skills/${name}/`, import.meta.url);
	const skill = readFileSync(new URL("SKILL.md", directory), "utf8");
	assert.ok(skill.includes(`name: ${name}`));
	assert.match(skill, /^description: .+/m);
	assert.match(skill, /^license: MIT$/m);
	assert.doesNotMatch(skill, /^disable-model-invocation: true$/m);
	includesAll(skill, ["eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10", "candidate", "[License](LICENSE)"]);
	const license = readFileSync(new URL("LICENSE", directory), "utf8");
	includesAll(license, ["Copyright (c) 2026 Cursor", "Permission is hereby granted", "THE SOFTWARE IS PROVIDED"]);
	for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) {
		if (!match[1].includes("://")) assert.ok(existsSync(new URL(match[1], directory)), match[1]);
	}
});

it.each([
	{ owner: "parent pass", text: reviewPrompt },
	{ owner: "reviewer", text: agents["code-reviewer"] },
	{ owner: "builder", text: agents["implementation-engineer"] },
	{ owner: "recipe", text: recipeCards },
])("review hardening preserves exact triggers and nonbehavior exceptions in $owner", ({ text }) => {
	assert.match(text, /exact triggering input(?:\/| and )state/);
	assert.match(text, /before/i);
	assert.ok(text.includes("direct check"));
	assert.match(text, /(?:green|passing) characterization/);
});

test("review procedure preserves accepted-only regression and affected live-proof refresh", () => {
	includesAll(reviewPrompt, [
		"Add regression tests only for accepted findings",
		"Require scope within Done means and Keep",
		"After fixes, refresh affected checks, reviewer pairs, and live proof",
		"For applicable live risks, check boundaries, retries, cancellation, and negative effects",
		"Start a fresh reviewer session for each changed-source delta",
		"Require current selected clearance on the final candidate",
	]);
	assert.match(reviewPrompt, /Stop when Done means is true, Keep holds, and the tier's pass is clear/);
	includesAll(recipeCards, [
		"Complete selected review, integration, and live clearance cover the final candidate.",
		"In the pass summary, record fixes or dismissals with evidence and a reason.",
	]);
});

test("policy-selected review preserves independent coverage and bounded findings", () => {
	includesAll(techLead, ["Consequential changes to security, data safety, trust, persistence, or caller guarantees", "at least three ownership seams", "Reviewer pair", "Separate success and attack workers", "Preserve explicitly requested deep review coverage"]);
	includesAll(reviewPrompt, [
		"code-reviewer-sonnet", "code-reviewer-sol", "identical briefs and frozen metadata",
		"Use the `tech-lead.md` matrix for correctness seat counts and the approved single-seat trial.",
		"shared reviewer registry for metadata, hashes, and paths", "At Full, assign separate success and attack workers",
		"For applicable live risks, check boundaries, retries, cancellation, and negative effects",
		"Require each finding's realistic trigger and producer",
		"Require scope within Done means and Keep",
		"Add regression tests only for accepted findings",
		"After fixes, refresh affected checks, reviewer pairs, and live proof",
		"Start a fresh reviewer session for each changed-source delta",
	]);
	const cleanup = readFileSync(new URL("../skills/deslop/SKILL.md", import.meta.url), "utf8");
	includesAll(cleanup, ["Ponytail", "trust-boundary", "data-loss", "unchanged behavior", "read-only", "parent"]);
});

test("main sessions append the router while children do not", () => {
	const starts: Array<(event: { systemPromptOptions: { appendSystemPrompt?: string } }) => void> = [];
	registerTechLead(
		{ on: (event: string, handler: never) => (event === "before_agent_start" && starts.push(handler), () => undefined), registerCommand: () => undefined } as never,
		{},
	);
	const prompt = { appendSystemPrompt: "Prior" };
	starts[0]({ systemPromptOptions: prompt });
	assert.equal(prompt.appendSystemPrompt, `Prior\n\n${techLead}`);

	const childEvents: string[] = [];
	registerTechLead(
		{ on: (event: string) => (childEvents.push(event), () => undefined), registerCommand: (name: string) => childEvents.push(name) } as never,
		{ PI_SUBAGENT_AGENT: "implementation-engineer" },
	);
	assert.deepEqual(childEvents, []);
});

function harness(tools: string[]) {
	let active = tools;
	let sessionStart: () => void = () => undefined;
	let start: (event: { systemPromptOptions: { appendSystemPrompt?: string } }) => void = () => undefined;
	let solo: (args: string, ctx: unknown) => Promise<void> = async () => undefined;
	const notes: string[] = [];
	registerTechLead(
		{
			on: (event: string, handler: never) => {
				if (event === "session_start") sessionStart = handler;
				if (event === "before_agent_start") start = handler;
				return () => undefined;
			},
			registerCommand: (name: string, options: { handler: never }) => name === "solo" && (solo = options.handler),
			getActiveTools: () => active,
			setActiveTools: (next: string[]) => (active = next),
		} as never,
		{},
	);
	const context = { ui: { notify: (message: string) => notes.push(message) } };
	const prompt = () => {
		const options: { appendSystemPrompt?: string } = {};
		start({ systemPromptOptions: options });
		return options.appendSystemPrompt ?? "";
	};
	return { initialize: () => sessionStart(), toggle: () => solo("", context), tools: () => active, prompt, notes };
}

test("root startup excludes only unused task execution tools", () => {
	const retained = ["read", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "subagent", "bg_run", "bg_kill"];
	const session = harness([...retained, "TaskOutput", "TaskStop", "TaskExecute"]);
	session.initialize();
	assert.deepEqual(session.tools(), retained);
	session.initialize();
	assert.deepEqual(session.tools(), retained);
});

test("solo mode removes delegation tools, swaps its section, and restores state", async () => {
	const retained = ["read", "subagent", "bash", "subagent_resume", "subagent_kill", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate"];
	const session = harness([...retained, "TaskOutput", "TaskStop", "TaskExecute"]);
	session.initialize();
	assert.equal(session.prompt(), techLead);
	await session.toggle();
	assert.deepEqual(session.tools(), ["read", "bash", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
	assert.ok(session.prompt().includes("Solo mode: work directly; do not delegate to subagents."));
	assert.ok(!session.prompt().includes("delivery-workflow"));
	assert.ok(!session.prompt().includes("Template:"));
	assert.ok(!session.prompt().includes("The five work-seam agents are:"));
	await session.toggle();
	assert.deepEqual(session.tools(), retained);
	assert.equal(session.prompt(), techLead);
	assert.equal(session.notes.length, 2);
});

test("a missing Slice and delegate heading fails fast", () => {
	assert.throws(() => registerTechLead({} as never, {}, "## Other\n"), /missing the "## Slice and delegate" heading/);
});
