import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";

type Recipe = { command: string[]; cwd: string };
type VerificationConfig = { recipes: Recipe[] };

const root = join(import.meta.dir, "..");
const config = JSON.parse(readFileSync(join(root, "verification.json"), "utf8")) as VerificationConfig;
const ownedTests = readdirSync(join(root, "tests"))
	.filter((name) => /\.test\.(?:ts|mjs)$/.test(name))
	.sort()
	.map((name) => `tests/${name}`);

test("verification recipes use direct safe argv from the repository root", () => {
	assert.deepEqual(Object.keys(config), ["recipes"]);
	assert.equal(config.recipes.length, 2);
	for (const recipe of config.recipes) {
		assert.deepEqual(Object.keys(recipe).sort(), ["command", "cwd"]);
		assert.equal(recipe.cwd, ".");
		assert.ok(Array.isArray(recipe.command) && recipe.command.length > 0);
		assert.ok(recipe.command.every((argument) => typeof argument === "string" && argument.length > 0 && !argument.includes("\0")));
		assert.doesNotMatch(recipe.command.join(" "), /(?:^|\s)(?:ba|z|da)?sh\s+-[a-z]*c\b|\|\||&&|[|;]/);
	}
});

test("the integration recipe lists every owned test exactly once", () => {
	const integration = config.recipes.find((recipe) => recipe.command[0] === "bun");
	assert.ok(integration);
	assert.deepEqual(integration.command.slice(0, 2), ["bun", "test"]);
	assert.deepEqual(integration.command.slice(2), ownedTests);
	assert.equal(new Set(integration.command.slice(2)).size, ownedTests.length);
	assert.ok(integration.command.includes("tests/extension-load.test.ts"));
	assert.ok(integration.command.every((argument) => !argument.includes("*")));
});

test("git diff whitespace validation is a separate direct recipe", () => {
	const diffCheck = config.recipes.find((recipe) => recipe.command[0] === "git");
	assert.deepEqual(diffCheck, { command: ["git", "diff", "--check"], cwd: "." });
});
