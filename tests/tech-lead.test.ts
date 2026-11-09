import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it, test } from "bun:test";
import registerTechLead from "../extensions/tech-lead/index.ts";
import { getEffectiveAgentDefinitions } from "../git/github.com/Alan-Luc/pi-subagents/src/agents/definitions.ts";

const agents = Object.fromEntries(
	readdirSync(new URL("../agents/", import.meta.url))
		.filter((path) => path.endsWith(".md"))
		.map((path) => [path.replace(/\.md$/, ""), readFileSync(new URL(`../agents/${path}`, import.meta.url), "utf8")]),
);
const techLead = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");
const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8")) as {
	modelThinkingLevels?: Record<string, string>;
};

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
		assert.ok(profile && owner, `loader resolves ${name} and ${canonical}`);
		assert.equal(profile.model, model);
		assert.equal(profile.thinking, thinking);
		assert.equal(profile.allowModelOverride, true);
		assert.equal(profile.thinkingOverrides, undefined);
		assert.equal(profile.tools, owner.tools);
		assert.equal(profile.skills, owner.skills);
		assert.notEqual(profile.noContextFiles, true);
		assert.equal(profile.parentClosePolicy, "terminate");
		assert.equal(profile.spawning, false);
		if (name === "live-verifier") {
			assert.equal(profile.tools, "read,bash,grep,find,inspect_context,inspect_change,verification_evidence,bg_run,bg_status,bg_logs,bg_kill,submit_agent_result");
			assert.equal(profile.skills, "none");
		}
		if (name !== canonical) assert.ok(profile.body?.includes(`agents/${canonical}.md`));
		assert.deepEqual(settings.modelThinkingLevels, {
			"openai-codex/gpt-6.1-sol": "medium",
			"openai-codex/gpt-6-luna": "high",
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
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
	const context = { ui: { notify: () => undefined } };
	const prompt = () => {
		const options: { appendSystemPrompt?: string } = {};
		start({ systemPromptOptions: options });
		return options.appendSystemPrompt ?? "";
	};
	return { initialize: () => sessionStart(), toggle: () => solo("", context), tools: () => active, prompt };
}

test("root startup excludes only unused task execution tools", () => {
	const retained = ["read", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "subagent", "bg_run", "bg_kill"];
	const session = harness([...retained, "TaskOutput", "TaskStop", "TaskExecute"]);
	session.initialize();
	assert.deepEqual(session.tools(), retained);
	session.initialize();
	assert.deepEqual(session.tools(), retained);
});

test("solo mode removes delegation tools and restores the original runtime state", async () => {
	const retained = ["read", "subagent", "bash", "subagent_resume", "subagent_kill", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate"];
	const session = harness([...retained, "TaskOutput", "TaskStop", "TaskExecute"]);
	session.initialize();
	const originalPrompt = session.prompt();
	await session.toggle();
	assert.deepEqual(session.tools(), ["read", "bash", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);
	assert.notEqual(session.prompt(), originalPrompt);
	await session.toggle();
	assert.deepEqual(session.tools(), retained);
	assert.equal(session.prompt(), originalPrompt);
});

test("a missing router section fails fast", () => {
	assert.throws(() => registerTechLead({} as never, {}, "## Other\n"));
});

test("profile capability boundaries remain configured", () => {
	assert.deepEqual(Object.keys(agents).sort(), [
		"code-explorer", "code-reviewer", "code-reviewer-opus", "code-reviewer-sol", "code-reviewer-sonnet",
		"implementation-engineer", "implementation-engineer-opus", "implementation-engineer-sol", "live-verifier",
		"mr-babysitter", "test-automation-engineer",
	]);
	for (const name of ["implementation-engineer", "test-automation-engineer"]) {
		assert.match(agents[name], /^tools: .*TaskCreate,TaskList,TaskGet,TaskUpdate,submit_agent_result$/m);
	}
	for (const name of ["code-explorer", "code-reviewer"]) {
		assert.doesNotMatch(agents[name], /^tools: .*\bTask(?:Create|List|Get|Update)\b/m);
	}
	for (const name of ["code-explorer", "code-reviewer", "implementation-engineer", "test-automation-engineer"]) {
		assert.match(agents[name], /^tools: .*inspect_context,inspect_change/m);
	}
	for (const name of ["code-explorer", "test-automation-engineer"]) {
		assert.match(agents[name], /^skills: none$/m);
		assert.doesNotMatch(agents[name], /^no-context-files: true$/m);
	}
	assert.match(agents["live-verifier"], /^flags: --no-mcp$/m);
	assert.match(agents["live-verifier"], /^deny-env: GITLAB_PERSONAL_ACCESS_TOKEN$/m);
});

test("removed agent profiles stay absent", () => {
	for (const name of ["backend-engineer", "frontend-engineer", "code-reviewer-light", "requirements-clarifier"]) {
		assert.equal(existsSync(new URL(`../agents/${name}.md`, import.meta.url)), false);
	}
});
