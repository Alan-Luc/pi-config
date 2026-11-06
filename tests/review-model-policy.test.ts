import assert from "node:assert/strict";
import { it } from "bun:test";
import { getEffectiveAgentDefinitions } from "../git/github.com/Alan-Luc/pi-subagents/src/agents/definitions.ts";
import { getSubagentAgentOverrideError } from "../git/github.com/Alan-Luc/pi-subagents/src/launch/policy.ts";
import { resolveResumeLaunchMetadataForInvocation } from "../git/github.com/Alan-Luc/pi-subagents/src/runtime/resume-service.ts";

const root = new URL("../", import.meta.url).pathname;
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const profiles = getEffectiveAgentDefinitions(root);
if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previous;

const lockedNames = [
	"implementation-engineer", "implementation-engineer-sol", "implementation-engineer-opus",
	"code-reviewer", "code-reviewer-sonnet", "code-reviewer-sol", "code-reviewer-opus",
];
const families = new Map([
	["openai-codex/gpt-6-luna", "OpenAI GPT"],
	["openai-codex/gpt-6.1-sol", "OpenAI GPT"],
	["anthropic/claude-sonnet-5-5", "Anthropic Claude"],
	["anthropic/claude-opus-5-5", "Anthropic Claude"],
]);
function profile(name: string) {
	const definition = profiles.find((item) => item.name === name);
	assert.ok(definition, `missing profile ${name}`);
	return definition;
}
function family(name: string) {
	const model = profile(name).model;
	const value = model && families.get(model);
	assert.ok(value, `unclassified model ${model} for ${name}`);
	return value;
}

it.each(lockedNames)("%s rejects model and effort substitutions", (name) => {
	const definition = profile(name);
	assert.equal(definition.allowModelOverride, false);
	assert.equal(getSubagentAgentOverrideError({ agent: name }, definition), null);
	assert.equal(getSubagentAgentOverrideError({ agent: name, model: definition.model }, definition)?.details.error, "model_override_not_allowed");
	assert.equal(getSubagentAgentOverrideError({ agent: name, thinking: "low" }, definition)?.details.error, "thinking_override_not_allowed");
	const persisted = { name, model: definition.model, thinking: definition.thinking, allowModelOverride: definition.allowModelOverride };
	assert.throws(() => resolveResumeLaunchMetadataForInvocation(persisted, "anthropic/claude-sonnet-5-5"), /Model override is not allowed/);
	assert.throws(() => resolveResumeLaunchMetadataForInvocation(persisted, undefined, "low"), /Thinking override.*not allowed/);
});

it.each([
	{ first: "code-reviewer", second: "code-reviewer-sonnet", context: "ordinary pair" },
	{ first: "code-reviewer-sol", second: "code-reviewer-opus", context: "difficult pair" },
	{ first: "implementation-engineer", second: "code-reviewer-sonnet", context: "Luna builder single-seat trial" },
	{ first: "implementation-engineer-sol", second: "code-reviewer-sonnet", context: "Sol builder single-seat trial" },
	{ first: "implementation-engineer-opus", second: "code-reviewer", context: "Opus builder single-seat trial" },
])("$context uses distinct configured families", ({ first, second }) => {
	assert.notEqual(family(first), family(second));
});

it("keeps routine Focused review on the builder family without claiming independence", () => {
	assert.equal(family("implementation-engineer"), family("code-reviewer"));
});
