import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it, test } from "bun:test";
import registerTechLead from "../extensions/tech-lead/index.ts";
import { briefInstructions } from "../extensions/artifact-contracts/briefs.ts";
import { getEffectiveAgentDefinitions } from "../git/github.com/Alan-Luc/pi-subagents/src/agents/definitions.ts";

const techLead = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");
const durablePlan = readFileSync(new URL("../skills/durable-plan/SKILL.md", import.meta.url), "utf8");
const globalInstructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const reviewPrompt = readFileSync(new URL("../prompts/code_review.md", import.meta.url), "utf8");
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
		requiredMarker: "Preflight the required runtime, command or script, and relevant network, authentication, database, or external-service identity before long work.",
	},
	{
		invariantName: "candidate capture and task-owned paths",
		canonicalOwnerPath: "extensions/artifact-contracts/review-preparation.ts",
		requiredMarker: "registerReviewPreparation",
	},
	{
		invariantName: "ownership, callers, and contracts",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Bounded reconnaissance maps ownership, callers, contracts, risks, and checks; stop when implementation is safe.",
	},
	{
		invariantName: "evidence packet",
		canonicalOwnerPath: "extensions/artifact-contracts/briefs.ts",
		requiredMarker: "Every `subagent` task (and each `children[].task`) must fill exactly this template",
	},
	{
		invariantName: "dependency slicing",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Slice only real dependencies and keep unrelated work outside scope.",
	},
	{
		invariantName: "worker boundaries",
		canonicalOwnerPath: "agents/implementation-engineer.md",
		requiredMarker: "Own exactly the briefed objective and paths.",
	},
	{
		invariantName: "focused checks",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Run focused checks while iterating",
	},
	{
		invariantName: "exact review artifact and hash",
		canonicalOwnerPath: "extensions/artifact-contracts/review-preparation.ts",
		requiredMarker: "patchSha256",
	},
	{
		invariantName: "material remediation",
		canonicalOwnerPath: "prompts/code_review.md",
		requiredMarker: "If material fixes occur, rerun affected focused checks and start one remediation review",
	},
	{
		invariantName: "broad integration and candidate recapture",
		canonicalOwnerPath: "prompts/code_review.md",
		requiredMarker: "Run the required broad integration recipe once against the accepted candidate, then recapture the candidate.",
	},
	{
		invariantName: "background jobs",
		canonicalOwnerPath: "prompts/code_review.md",
		requiredMarker: "Before freezing the candidate, reconcile or kill every task-owned background job.",
	},
	{
		invariantName: "background-first verification",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Default to background `start`/`collect`; synchronous `run` requires",
	},
	{
		invariantName: "authorization",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Never push without Alan's explicit authorization",
	},
	{
		invariantName: "post-commit integration patch",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "After the final task commit, inspect the exact base-to-HEAD patch for unintended changes",
	},
	{
		invariantName: "finish records",
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Record each completed non-trivial implementation, review, or configuration slice in one append-only daily work-log entry.",
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

test("startup policy has one bounded aggregate budget", () => {
	const startup = [globalInstructions, techLead, briefInstructions()].join("\n");
	assert.ok(words(startup) <= 1_300, `startup instructions have ${words(startup)} words`);
	assert.doesNotMatch(techLead, /load `delivery-workflow`|The five work-seam agents are:|^Template:/m);
	assert.ok(!techLead.includes("node:os.tmpdir()/pi"));
});

test("common verification routes both skills and independent live checks alongside tests", () => {
	const routing = globalInstructions.split("\n").find((line) => line.includes("`live-verification`") && line.includes("`build-live-verification`"));
	assert.ok(routing, "both procedural skills have always-known verification routing");
	assert.match(routing, /live checks alongside tests in parallel when independent/);
	assert.match(routing, /prerequisites|shared mutable state/);
	assert.match(routing, /both results before claiming verified completion/);
});

test("temporary dogfooding reuses evidence and records friction without ceremonial work", () => {
	assert.ok(globalInstructions.includes("extensions/extension-dogfooding.md"));
	const dogfooding = readFileSync(new URL("../extensions/extension-dogfooding.md", import.meta.url), "utf8");
	includesAll(dogfooding, [
		"`inspect_context`", "`inspect_change`", "`verification_evidence` background `start`",
		"automatic terminal notification, then `collect`", "do not poll",
		"same established evidence", "session-local ID", "The parent owns sharing",
		"No extra agents, checks, packet refreshes, or benchmarks",
		"Alongside the final non-trivial work-log entry", "Expected help versus actual result",
		"Fallback/workaround and outcome", "No extension friction observed",
	]);
});

test("the router preserves direct, planning, and approval controls", () => {
	includesAll(techLead, [
		"Direct is default",
		"`plan with me`",
		"`brief plan`",
		"`take over`",
		"load `durable-plan`",
		"Use a large approval gate",
	]);
	includesAll(globalInstructions, [
		"The parent may create coherent passing local commits",
		"Never push without Alan's explicit authorization",
		"Children never commit",
	]);
	assert.ok(durablePlan.includes("## Ticket context preflight"));
});

test("the router preserves lifecycle ownership without leaking delegation manuals", () => {
	includesAll(techLead, [
		"Delegate only across a real ownership or expertise seam",
		"use its tool-owned delegation guidance and validated brief contract",
	]);
	includesAll(globalInstructions, ["Truly trivial direct work", "non-trivial"]);
	assert.doesNotMatch(techLead, /Apply Ponytail|Truly trivial direct work|A plan never authorizes push|The parent may create coherent passing local commits/);
	assert.doesNotMatch(techLead, /Template:|The five work-seam agents are:|PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN|ready set|worker result/);
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

test("the roster keeps four role owners with exact persisted model profiles", () => {
	assert.deepEqual(Object.keys(agents).sort(), [
		"code-explorer",
		"code-reviewer",
		"code-reviewer-opus",
		"code-reviewer-sol",
		"code-reviewer-sonnet",
		"implementation-engineer",
		"implementation-engineer-opus",
		"implementation-engineer-sol",
		"test-automation-engineer",
	]);
	for (const name of ["implementation-engineer", "test-automation-engineer"]) {
		assert.match(agents[name], /^tools: .*TaskCreate,TaskList,TaskGet,TaskUpdate$/m);
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
	{ name: "implementation-engineer", model: "openai-codex/gpt-6-luna", thinking: "medium", canonical: "implementation-engineer" },
	{ name: "test-automation-engineer", model: "openai-codex/gpt-6-luna", thinking: "high", canonical: "test-automation-engineer" },
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
		assert.equal(profile.allowModelOverride, false);
		assert.equal(profile.tools, owner.tools);
		assert.equal(profile.skills, owner.skills);
		assert.notEqual(profile.noContextFiles, true);
		assert.equal(profile.parentClosePolicy, "terminate");
		assert.equal(profile.spawning, false);
		if (name !== canonical) assert.ok(profile.body?.includes(`agents/${canonical}.md`));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("implementation and review roles preserve material behavior", () => {
	includesAll(globalInstructions, ["trust-boundary validation", "accessibility", "strict types"]);
	includesAll(agents["implementation-engineer"], ["focused happy and meaningful failure-path tests", "verification_evidence"]);
	includesAll(agents["code-reviewer"], ["Patch artifact:", "Review paths:", "Use at most 12 combined", "wider risk", "P0", "P1", "P2", "Never edit"]);
	assert.match(agents["code-reviewer"], /^model: openai-codex\/gpt-6-luna$/m);
	assert.ok(reviewPrompt.includes("`Review range: HEAD` for current worktree changes"));
	assert.ok(reviewPrompt.includes("`Review range: <base>...<head>` for a committed branch"));
	assert.ok(reviewPrompt.includes("one remediation review covering only the remediation delta and affected contracts"));
	assert.ok(reviewPrompt.includes("do not independently rereview an unchanged patch"));
});

it.each([
	{ name: "review prompt", instructions: reviewPrompt },
	{ name: "reviewer agent", instructions: agents["code-reviewer"] },
])("$name reuses evidence and distinguishes review targets", ({ instructions }) => {
	includesAll(instructions, [
		"only when Git evidence is missing or inputs changed",
		"do not repeat a recorded failure on unchanged inputs",
		"Establish the review target",
		"`{}`",
		"`base` and `head`",
		'"direct"',
		'"merge-base"',
		"An empty worktree packet does not mean there are no task changes",
	]);
	assert.match(instructions, /reuse supplied same-target Git evidence/i);
	assert.doesNotMatch(instructions, /(?:use|calling) `inspect_change` once/i);
});

test("global instructions retain Alan-specific conventions", () => {
	includesAll(globalInstructions, [
		"The parent may create coherent passing local commits during implementation",
		"Never push without Alan's explicit authorization",
		"`benchmark/<run-id>`",
		"Use BLUF",
		"Before non-trivial tools or delegation",
		"Prefer concurrent execution for disjoint work that speeds delivery or avoids blocking",
		"keep dependencies and risky shared writes sequential",
		"record outcomes after completion",
		"independently review only material-risk or multi-seam changes",
		"do not independently rereview an unchanged patch",
		"Label artifact links",
		"Quiz Alan only when explicitly asked",
		"For a requested walkthrough, explain each change",
		"On pushback, restate Alan's position",
		"Run the narrowest relevant check",
		"`it.each([...])`",
		"Use “malicious,” never “nasty,”",
		"Comment only non-obvious why",
		"three failed attempts",
	]);
});

test("common test-first standards reach roles without skill loading", () => {
	includesAll(globalInstructions, [
		"Before production behavior edits", "requirement-derived", "intended assertion failure",
		"red/green/refactor", "Quick implementation", "coordination ceremony",
		"genuinely impractical", "not a size or testing-cost exemption",
		"internal refactor", "tautological", "same surface", "persisted effects",
	]);
	assert.equal(existsSync(new URL("../skills/tdd/SKILL.md", import.meta.url)), false);
	for (const name of ["code-explorer", "test-automation-engineer"]) {
		assert.match(agents[name], /^skills: none$/m);
		assert.doesNotMatch(agents[name], /^no-context-files: true$/m);
	}
	includesAll(agents["implementation-engineer"], ["before production edits", "intended assertion", "red/green/refactor", "same surface"]);
	includesAll(agents["test-automation-engineer"], ["requirement-derived", "internal refactor", "tautological"]);
	includesAll(agents["code-explorer"], ["observable contracts", "test seams", "runtime prerequisites"]);
	includesAll(agents["code-reviewer"], ["test value", "intended red", "real-surface"]);
	includesAll(durablePlan, ["observable acceptance", "caller", "independent proposals", "shared", "judge-only"]);
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

it.each(["correctness-review", "structural-review", "deslop"])("the %s skill preserves selective routing and source provenance", (name) => {
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

test("review routing selects risk before capacity and keeps pair coverage honest", () => {
	includesAll(techLead, ["consequential architectural", "prompts/code_review.md", "eight live children", "capacity"]);
	includesAll(reviewPrompt, [
		"risk/coverage map", "identical briefs", "code-reviewer-sonnet", "code-reviewer-sol", "code-reviewer-opus",
		"eight live children", "complete pairs", "canonical role", "protected", "missing counterpart", "not votes",
		"correctness-review", "structural-review", "deslop", "fresh selected reviewer-profile",
	]);
	const cleanup = readFileSync(new URL("../skills/deslop/SKILL.md", import.meta.url), "utf8");
	includesAll(cleanup, ["Ponytail", "trust-boundary", "data-loss", "unchanged behavior", "not a mandatory extra"]);
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
