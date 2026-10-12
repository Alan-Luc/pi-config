import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "bun:test";
import registerTechLead from "../extensions/tech-lead/index.ts";

const techLead = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");
const delivery = readFileSync(new URL("../skills/delivery-workflow/SKILL.md", import.meta.url), "utf8");
const durablePlan = readFileSync(new URL("../skills/durable-plan/SKILL.md", import.meta.url), "utf8");
const globalInstructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const reviewPrompt = readFileSync(new URL("../prompts/code_review.md", import.meta.url), "utf8");
const agents = Object.fromEntries(
	readdirSync(new URL("../agents/", import.meta.url))
		.filter((path) => path.endsWith(".md"))
		.map((path) => [path.replace(/\.md$/, ""), readFileSync(new URL(`../agents/${path}`, import.meta.url), "utf8")]),
);
const words = (text: string) => text.trim().split(/\s+/).length;

function includesAll(text: string, values: readonly string[]) {
	for (const value of values) assert.ok(text.includes(value), value);
}

test("startup instructions stay within component budgets", () => {
	assert.ok(words(techLead) <= 900, `tech-lead.md has ${words(techLead)} words`);
	assert.ok(words(globalInstructions) <= 700, `AGENTS.md has ${words(globalInstructions)} words`);
	assert.ok(techLead.includes("load `delivery-workflow`") && techLead.includes("Before the first non-trivial source edit"));
	assert.ok(!techLead.includes("node:os.tmpdir()/pi"));
	assert.ok(delivery.includes("require('node:os').tmpdir()"));
});

test("the router preserves direct, planning, approval, and authorization controls", () => {
	includesAll(techLead, [
		"Direct is default",
		"`plan with me`",
		"`brief plan`",
		"`take over`",
		"large approval gate",
		"load `durable-plan`",
		"A plan never authorizes commit, push",
		"Commit or push only with Alan's explicit authorization",
		"Apply Ponytail",
	]);
	assert.ok(durablePlan.includes("## Ticket context preflight"));
});

test("the router preserves tasks, five work seams, review order, and completion records", () => {
	includesAll(techLead, [
		"live task list for meaningful multi-step work",
		"`code-explorer`",
		"`implementation-engineer`",
		"`code-reviewer`",
		"`test-automation-engineer`",
		"`verification-runner`",
		"run focused changed-area checks",
		"review the exact complete task-owned patch once",
		"run the required broad integration recipe once",
		"one append-only daily work-log entry",
		"Create no handoff when no human-only action remains",
	]);
});

test("delivery reconnaissance is outcome-based and reusable", () => {
	includesAll(delivery, [
		"There is no mandatory first tool, tool order, batching shape, or call count",
		"Reuse prior bounded packets",
		"omissions as inconclusive",
		"Stop when governing artifacts",
		"Never delegate and duplicate the same investigation",
		"Source of truth:",
		"Verified facts:",
		"Read first:",
		"Open questions:",
	]);
});

test("delivery preserves candidate, review, remediation, and verifier trust boundaries", () => {
	includesAll(delivery, [
		"capture the starting candidate",
		"exact task-owned path set",
		"Patch artifact:",
		"Review paths:",
		"one independent bounded `code-reviewer`",
		"Remediate material findings in one pass",
		"one pure `subagent` `children` batch",
		"Do not mix ordinary tools",
		"`PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` unset",
		"parent captures the candidate again",
		"invalidates the whole batch",
	]);
	assert.ok(delivery.indexOf("task-owned job must be terminal") < delivery.indexOf("capture the final candidate"));
});

test("delivery preflights long commands and supports honest bounded evidence", () => {
	includesAll(delivery, [
		"repository-required runtime",
		"command/script existence",
		"network, authentication, database, or external-service identity",
		"authoritative focused or sharded recipes",
		"`- Not run: <reason>`",
		"Raw Bash and background-task output are not evidence",
	]);
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
	for (const removed of ["backend-engineer", "frontend-engineer", "code-reviewer-light", "requirements-clarifier"]) {
		assert.equal(existsSync(new URL(`../agents/${removed}.md`, import.meta.url)), false);
		assert.ok(!reviewPrompt.includes(removed));
	}
});

test("implementation and review roles preserve material behavior", () => {
	includesAll(agents["implementation-engineer"], ["trust boundaries", "semantic HTML", "accessibility", "strict types", "focused happy and meaningful failure-path tests", "verification_evidence"]);
	includesAll(agents["code-reviewer"], ["Patch artifact:", "Review paths:", "Use at most 12 combined", "wider risk", "P0", "P1", "P2", "Never edit"]);
	assert.match(agents["code-reviewer"], /^model: openai-codex\/gpt-5\.6-luna$/m);
	assert.ok(reviewPrompt.includes("explicit stronger-model override only for a large high-risk review"));
});

test("verification runner remains execution-only with linked-worktree support", () => {
	const runner = agents["verification-runner"];
	assert.match(runner, /^tools: read,bash,grep,find,verification_evidence$/m);
	assert.doesNotMatch(runner, /^tools: .*\b(?:edit|write|subagent|bg_run)\b/m);
	includesAll(runner, ["repositoryRoot when present", "Never select, add, remove, combine, wrap, or retry commands", "hidden nested dependency", "candidate ID equals the expected stable candidate"]);
});

test("global instructions retain Alan-specific conventions", () => {
	includesAll(globalInstructions, [
		"Never commit or push unless Alan explicitly asks",
		"`benchmark/<run-id>`",
		"Use BLUF",
		"Before non-trivial tools or delegation",
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
	let start: (event: { systemPromptOptions: { appendSystemPrompt?: string } }) => void = () => undefined;
	let solo: (args: string, ctx: unknown) => Promise<void> = async () => undefined;
	const notes: string[] = [];
	registerTechLead(
		{
			on: (_: string, handler: never) => ((start = handler), () => undefined),
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
	return { toggle: () => solo("", context), tools: () => active, prompt, notes };
}

test("solo mode removes delegation tools, swaps its section, and restores state", async () => {
	const all = ["read", "subagent", "bash", "subagent_resume", "subagent_kill"];
	const session = harness(all);
	assert.equal(session.prompt(), techLead);
	await session.toggle();
	assert.deepEqual(session.tools(), ["read", "bash"]);
	assert.ok(session.prompt().includes("Solo mode: work directly; do not delegate to subagents."));
	assert.ok(session.prompt().includes("load `delivery-workflow`"));
	assert.ok(session.prompt().includes("live task list for meaningful multi-step work"));
	assert.ok(!session.prompt().includes("The five work-seam agents are:"));
	await session.toggle();
	assert.deepEqual(session.tools(), all);
	assert.equal(session.prompt(), techLead);
	assert.equal(session.notes.length, 2);
});

test("a missing Slice and delegate heading fails fast", () => {
	assert.throws(() => registerTechLead({} as never, {}, "## Other\n"), /missing the "## Slice and delegate" heading/);
});
