import assert from "node:assert/strict";
import { expect, it, test } from "bun:test";
import { resolve } from "node:path";
import type { AgentSession } from "../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { getEffectiveAgentDefinitions } from "../git/github.com/Alan-Luc/pi-subagents/src/agents/definitions.ts";
import { buildParentEnvSnapshot, resolveDenyEnvPatterns } from "../git/github.com/Alan-Luc/pi-subagents/src/launch/child-env.ts";

const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
if (!installRoot) throw new Error("PI_MANAGED_INSTALL_ROOT is required for copied-host MCP tests");
const version = await Bun.file(resolve(installRoot, "current-version")).text();
const pi: typeof import("../install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js") = await import(resolve(installRoot, "releases", version.trim(), "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const fixture = await import(new URL("./fixtures/role-mcp/fake-tools.mjs", import.meta.url).href);

async function createSession() {
	const cwd = resolve(import.meta.dir, "..");
	const settingsManager = pi.SettingsManager.inMemory({}, { projectTrusted: false });
	const loader = new pi.DefaultResourceLoader({
		cwd,
		agentDir: resolve(import.meta.dir, ".."),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const modelRuntime = await pi.ModelRuntime.create({
		authPath: resolve(cwd, "absent-auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	return pi.createAgentSession({
		cwd,
		agentDir: resolve(import.meta.dir, ".."),
		resourceLoader: loader,
		settingsManager,
		modelRuntime,
		customTools: [fixture.allowedTool, fixture.deniedTool, fixture.relayTool],
		tools: ["mcp__fixture_allowed__probe", "fixture_relay"],
		sessionManager: pi.SessionManager.inMemory(cwd),
	});
}

function recordToolCall(session: AgentSession, id: string, name: string) {
	const model = session.model;
	assert.ok(model);
	session.agent.state.messages.push({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "toolCall", id, name, arguments: {} }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
}

const definitions = new Map(getEffectiveAgentDefinitions().map((definition) => [definition.name, definition]));

it.each([
	"implementation-engineer", "implementation-engineer-sol", "implementation-engineer-opus",
	"test-automation-engineer", "code-reviewer", "code-reviewer-sol", "code-reviewer-opus", "code-reviewer-sonnet",
])("%s disables MCP with the native flag", (role) => {
	expect(definitions.get(role)?.flags).toBe("--no-mcp");
	const denyEnv = definitions.get(role)?.denyEnv;
	expect(denyEnv).toContain("GITLAB_PERSONAL_ACCESS_TOKEN");
	const childEnv = buildParentEnvSnapshot({ GITLAB_PERSONAL_ACCESS_TOKEN: "fixture-gitlab-token", OPENAI_API_KEY: "fixture-model-key" }, resolveDenyEnvPatterns(denyEnv, {}));
	expect(childEnv.GITLAB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
	expect(childEnv.OPENAI_API_KEY).toBe("fixture-model-key");
});

test("recon remains eligible for its scoped MCP tools", () => {
	expect((definitions.get("code-explorer")?.flags ?? "").split(/\s+/)).not.toContain("--no-mcp");
});

test("MCP allowlist invokes the approved fake and blocks direct and nested denied dispatch", async () => {
	fixture.invocations.allowed = 0;
	fixture.invocations.denied = 0;
	fixture.invocations.relay = 0;
	const { session } = await createSession();
	try {
		const runner = session.extensionRunner;
		assert.ok(runner);
		const tools = new Map(session.agent.state.tools.map((tool) => [tool.name, tool]));
		expect(tools.has("mcp__fixture_allowed__probe")).toBe(true);
		expect(tools.has("mcp__fixture_denied__probe")).toBe(false);

		recordToolCall(session, "allow-call", "mcp__fixture_allowed__probe");
		const accepted = await runner.createToolContext("allow-call", undefined).executeTool("mcp__fixture_allowed__probe", {});
		expect(accepted.isError).toBe(false);
		expect(fixture.invocations.allowed).toBe(1);

		recordToolCall(session, "denied-call", "mcp__fixture_denied__probe");
		const directDenied = await runner.createToolContext("denied-call", undefined).executeTool("mcp__fixture_denied__probe", {});
		expect(directDenied.isError).toBe(true);
		expect(fixture.invocations.denied).toBe(0);

		recordToolCall(session, "relay-call", "fixture_relay");
		const nestedDenied = await runner.createToolContext("relay-call", undefined).executeTool("fixture_relay", {});
		expect(nestedDenied.isError).toBe(true);
		expect(fixture.invocations.relay).toBe(1);
		expect(fixture.invocations.denied).toBe(0);
	} finally {
		session.dispose();
	}
});
