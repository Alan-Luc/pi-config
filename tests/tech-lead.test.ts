import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it, test } from "bun:test";
import registerTechLead from "../extensions/tech-lead/index.ts";
import { briefInstructions } from "../extensions/artifact-contracts/briefs.ts";

const techLead = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");
const durablePlan = readFileSync(new URL("../skills/durable-plan/SKILL.md", import.meta.url), "utf8");
const globalInstructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const reviewPrompt = readFileSync(new URL("../prompts/code_review.md", import.meta.url), "utf8");
const takeOverPrompt = readFileSync(new URL("../prompts/take-over.md", import.meta.url), "utf8");
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
		canonicalOwnerPath: "AGENTS.md",
		requiredMarker: "Before the first task-owned source edit, capture the starting candidate and exact task-owned path set.",
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
		canonicalOwnerPath: "prompts/code_review.md",
		requiredMarker: "Hash that patch and give the reviewer the candidate and hash",
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
		canonicalOwnerPath: "extensions/tech-lead/tech-lead.md",
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

test("the router preserves direct, planning, approval, and authorization controls", () => {
	includesAll(techLead, [
		"Direct is default",
		"`plan with me`",
		"`brief plan`",
		"`take over`",
		"load `durable-plan`",
		"Use a large approval gate",
		"A plan never authorizes push",
		"The parent may create coherent passing local commits",
		"push only with Alan's explicit authorization",
		"Apply Ponytail",
	]);
	assert.ok(durablePlan.includes("## Ticket context preflight"));
});

test("the router preserves lifecycle ownership without leaking delegation manuals", () => {
	includesAll(techLead, [
		"Delegate only across a real ownership or expertise seam",
		"use its tool-owned delegation guidance and validated brief contract",
		"Truly trivial direct work",
		"non-trivial",
	]);
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

test("the roster contains exactly five agents with deliberate tool scopes", () => {
	assert.deepEqual(Object.keys(agents).sort(), [
		"code-explorer",
		"code-reviewer",
		"implementation-engineer",
		"test-automation-engineer",
		"verification-runner",
	]);
	for (const name of ["implementation-engineer", "test-automation-engineer"]) {
		assert.match(agents[name], /^tools: .*TaskCreate,TaskList,TaskGet,TaskUpdate$/m);
		assert.ok(agents[name].includes("`- Not run: <reason>`"));
	}
	for (const name of ["code-explorer", "code-reviewer", "verification-runner"]) {
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

test("implementation and review roles preserve material behavior", () => {
	includesAll(agents["implementation-engineer"], ["trust boundaries", "semantic HTML", "accessibility", "strict types", "focused happy and meaningful failure-path tests", "verification_evidence"]);
	includesAll(agents["code-reviewer"], ["Patch artifact:", "Review paths:", "Use at most 12 combined", "wider risk", "P0", "P1", "P2", "Never edit"]);
	assert.match(agents["code-reviewer"], /^model: openai-codex\/gpt-5\.6-luna$/m);
	assert.ok(reviewPrompt.includes("one remediation review covering only the remediation delta and affected contracts"));
	assert.ok(reviewPrompt.includes("do not independently rereview an unchanged patch"));
});

test("verification runner remains execution-only with linked-worktree support", () => {
	const runner = agents["verification-runner"];
	assert.match(runner, /^tools: read,bash,grep,find,verification_evidence$/m);
	assert.doesNotMatch(runner, /^tools: .*\b(?:edit|write|subagent|bg_run|inspect_context|inspect_change)\b/m);
	includesAll(runner, ["repositoryRoot when present", "Never select, add, remove, combine, wrap, or retry commands", "hidden nested dependency", "candidate ID equals the expected stable candidate"]);
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
