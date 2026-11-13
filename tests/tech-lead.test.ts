import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "bun:test";
import registerTechLead from "../extensions/tech-lead/index.ts";
import { getLocalAgentDefinitions } from "./fixtures/agent-definitions.ts";

const techLeadPath = new URL("../extensions/tech-lead/tech-lead.md", import.meta.url);
const techLead = readFileSync(techLeadPath, "utf8");
const agents = Object.fromEntries(
	readdirSync(new URL("../agents/", import.meta.url))
		.filter((path) => path.endsWith(".md"))
		.map((path) => [path.replace(/\.md$/, ""), readFileSync(new URL(`../agents/${path}`, import.meta.url), "utf8")]),
);
const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8")) as {
	modelThinkingLevels?: Record<string, string>;
};

const definitions = new Map(getLocalAgentDefinitions().map((definition) => [definition.name, definition]));

test("safety policy sections remain present", () => {
	for (const [document, heading] of [
		[techLead, "## Slice and delegate"],
		[techLead, "## Alan-facing communication"],
		[agents["code-reviewer"], "## Findings"],
		[readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8"), "## Hard lines"],
		[readFileSync(new URL("../prompts/eviscerate-diff.md", import.meta.url), "utf8"), "## Select coverage"],
		[readFileSync(new URL("../skills/live-verification/SKILL.md", import.meta.url), "utf8"), "## Run the real thing"],
	]) {
		const section = document.split(`${heading}\n`)[1]?.split(/\n## /)[0];
		assert.ok(section?.trim(), `${heading} section is missing or empty`);
		if (heading === "## Hard lines") {
			assert.match(section, /Push only frozen, cleared candidates to task branches\./);
			assert.match(section, /Exception: for default branches, require Alan's explicit push request and verify GitHub owner `Alan-Luc`\./);
			assert.match(section, /never push to protected branches/i);
			assert.doesNotMatch(section, /never push.*default/i);
			assert.match(section, /never force-push/i);
		}
	}
});

test("agent definitions expose valid model and effort settings", () => {
	const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
	for (const name of Object.keys(agents)) {
		const profile = definitions.get(name);
		assert.ok(profile, `${name} is discoverable`);
		assert.equal(profile.path, new URL(`../agents/${name}.md`, import.meta.url).pathname);
		assert.match(profile.model ?? "", /^[^/\s]+\/[^/\s]+$/);
		assert.ok(levels.has(profile.thinking ?? ""), `${name} has a supported thinking level`);
		assert.equal(typeof profile.allowModelOverride, "boolean");
		assert.ok(profile.tools?.length, `${name} has an explicit loadout`);
		assert.equal(profile.spawning, false, `${name} cannot launch children`);
		assert.notEqual(profile.noContextFiles, true, `${name} retains project instructions`);
		assert.equal(profile.parentClosePolicy, "terminate");
	}
	for (const [model, level] of Object.entries(settings.modelThinkingLevels ?? {})) {
		assert.match(model, /^[^/\s]+\/[^/\s]+$/);
		assert.ok(levels.has(level));
	}
});

test("agent profiles keep their loadout and runtime controls", () => {
	for (const name of ["implementation-engineer", "test-automation-engineer", "code-reviewer", "code-reviewer-sol", "code-reviewer-sonnet", "code-reviewer-opus", "live-verifier"]) {
		const profile = definitions.get(name);
		assert.ok(profile, `${name} profile is missing`);
		assert.equal(profile.flags, "--no-mcp");
		assert.ok(profile.denyEnv?.includes("GITLAB_PERSONAL_ACCESS_TOKEN"));
		assert.equal(profile.parentClosePolicy, "terminate");
	}
	assert.equal((definitions.get("code-explorer")?.flags ?? "").split(/\s+/).includes("--no-mcp"), false);
	for (const name of Object.keys(agents)) assert.equal(definitions.get(name)?.name, name);
	for (const name of ["code-explorer", "test-automation-engineer"]) assert.equal(definitions.get(name)?.skills, "none");
	for (const name of ["code-explorer", "code-reviewer", "live-verifier"]) {
		const tools = new Set(definitions.get(name)?.tools?.split(","));
		for (const forbidden of ["edit", "write", "subagent", "TaskCreate", "TaskUpdate"]) assert.equal(tools.has(forbidden), false, `${name} cannot use ${forbidden}`);
		for (const required of ["read", "inspect_context", "inspect_change"]) assert.ok(tools.has(required), `${name} exposes ${required}`);
	}
	for (const name of ["implementation-engineer", "test-automation-engineer"]) {
		const tools = new Set(definitions.get(name)?.tools?.split(","));
		for (const required of ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "submit_agent_result", "inspect_context", "inspect_change"]) assert.ok(tools.has(required), `${name} exposes ${required}`);
	}
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
	assert.notEqual(session.prompt(), techLead);
	assert.ok(session.prompt().includes("Solo mode: work directly; do not delegate to subagents."));
	assert.ok(session.prompt().includes("Do not claim paired review or model diversity in solo mode"));
	assert.ok(session.prompt().includes("disclose required coverage gaps"));
	assert.ok(!session.prompt().includes("delivery-workflow"));
	assert.ok(!session.prompt().includes("Template:"));
	assert.ok(!session.prompt().includes("The five work-seam agents are:"));
	assert.deepEqual(session.tools(), ["read", "bash", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
	await session.toggle();
	assert.deepEqual(session.tools(), retained);
	assert.equal(session.prompt(), techLead);
	assert.equal(session.notes.length, 2);
});

test("a missing Slice and delegate heading fails fast", () => {
	assert.throws(() => registerTechLead({} as never, {}, "## Other\n"), /missing the "## Slice and delegate" heading/);
});

test("removed agent profiles stay absent", () => {
	for (const name of ["backend-engineer", "frontend-engineer", "code-reviewer-light", "requirements-clarifier"]) {
		assert.equal(existsSync(new URL(`../agents/${name}.md`, import.meta.url)), false);
	}
});
