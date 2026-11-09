import assert from "node:assert/strict";
import { test } from "bun:test";
import { getLocalAgentDefinitions } from "./fixtures/agent-definitions.ts";

const profiles = new Map(getLocalAgentDefinitions().map((profile) => [profile.name, profile]));

test("reviewer profiles retain canonical roles and distinct model families", () => {
	const reviewers = ["code-reviewer", "code-reviewer-sol", "code-reviewer-sonnet", "code-reviewer-opus"];
	for (const name of reviewers) {
		const profile = profiles.get(name);
		assert.ok(profile, `${name} profile is missing`);
		assert.equal(profile.flags, "--no-mcp");
		assert.ok(profile.denyEnv?.includes("GITLAB_PERSONAL_ACCESS_TOKEN"));
		assert.equal(profile.tools, profiles.get("code-reviewer")?.tools);
		assert.equal(profile.skills, profiles.get("code-reviewer")?.skills);
	}
	const family = (name: string) => profiles.get(name)?.model?.split("/")[0];
	for (const name of reviewers) assert.ok(family(name), `${name} has a model family`);
	assert.notEqual(family("code-reviewer"), family("code-reviewer-sonnet"));
	assert.notEqual(family("code-reviewer-sol"), family("code-reviewer-opus"));
});
