import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { it, test } from "bun:test";

const repository = resolve(import.meta.dir, "..");
const script = join(repository, "agents/config/initialize-mcp.py");
const template = readFileSync(join(repository, "agents/mr-babysitter.md"), "utf8");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "mcp-config-"));
	mkdirSync(join(root, "agents/config"), { recursive: true });
	copyFileSync(script, join(root, "agents/config/initialize-mcp.py"));
	copyFileSync(join(repository, "agents/config/mcp-servers.template.json"), join(root, "agents/config/mcp-servers.template.json"));
	writeFileSync(join(root, "settings.json"), "{}\n");
	writeFileSync(join(root, "auth.json"), "fixture-auth-must-not-change\n");
	writeFileSync(join(root, "mcp.json"), JSON.stringify({ unrelated: true, mcpServers: { existing: { url: "https://fixture.invalid/mcp" } } }));
	writeFileSync(join(root, "agents/mr-babysitter.md"), template.replace("model: openai-codex/gpt-6-luna", "model: fixture/preserved-model").replace("deny-tools: mcp,", "deny-tools: fixture_blocked,mcp,"));
	chmodSync(root, 0o750);
	return root;
}

function manifest(root: string, tools: unknown) {
	writeFileSync(join(root, "agents/config/gitlab-read-tools.json"), JSON.stringify({ server: "gitlab", approvedReadOnlyTools: tools }));
}

function initialize(root: string) {
	return spawnSync("python3", [join(root, "agents/config/initialize-mcp.py"), root], { encoding: "utf8", timeout: 10_000, env: { ...process.env, GITLAB_PERSONAL_ACCESS_TOKEN: "fixture-secret-not-for-output" } });
}

test("setup preserves existing model, tool denials, directory access and auth while merging selected servers", () => {
	const root = fixture();
	try {
		manifest(root, ["mcp__gitlab__fixture_read"]);
		const result = initialize(root);
		assert.equal(result.status, 0, result.stderr);
		const profile = readFileSync(join(root, "agents/mr-babysitter.md"), "utf8");
		assert.match(profile, /^model: fixture\/preserved-model$/m);
		assert.match(profile, /^deny-tools: .*fixture_blocked/m);
		assert.match(profile, /^tools: .*mcp__gitlab__fixture_read/m);
		assert.equal(statSync(root).mode & 0o777, 0o750);
		assert.equal(readFileSync(join(root, "auth.json"), "utf8"), "fixture-auth-must-not-change\n");
		assert.ok(!result.stdout.includes("fixture-secret-not-for-output"));
		assert.deepEqual(JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")), {
			unrelated: true,
			mcpServers: {
				existing: { url: "https://fixture.invalid/mcp" },
				codesearch: { url: "https://codesearch-internal.inf.replicant.ai/mcp", enabled: true },
				gitlab: { url: "https://gitlab-mcp-internal.inf.replicant.ai/mcp", headers: { Authorization: "Bearer ${GITLAB_PERSONAL_ACCESS_TOKEN}" } },
			},
		});
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("revoking the approved read list disables MCP and restores GitLab credential denial", () => {
	const root = fixture();
	try {
		manifest(root, ["mcp__gitlab__fixture_read"]);
		assert.equal(initialize(root).status, 0);
		manifest(root, []);
		const result = initialize(root);
		assert.equal(result.status, 0, result.stderr);
		const profile = readFileSync(join(root, "agents/mr-babysitter.md"), "utf8");
		assert.match(profile, /^flags: --no-mcp$/m);
		assert.match(profile, /^deny-env: .*GITLAB_PERSONAL_ACCESS_TOKEN/m);
		assert.doesNotMatch(profile, /^tools: .*mcp__gitlab__/m);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([
	["wildcard", ["mcp__gitlab__*"]],
	["unqualified", ["fixture_read"]],
	["non-string", [42]],
])("rejects a %s grant before changing configuration", (_name, tools) => {
	const root = fixture();
	try {
		manifest(root, tools);
		const before = readFileSync(join(root, "mcp.json"), "utf8");
		assert.notEqual(initialize(root).status, 0);
		assert.equal(readFileSync(join(root, "mcp.json"), "utf8"), before);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
