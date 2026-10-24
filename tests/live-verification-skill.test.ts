import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("live verification owns bounded failure rechecks, negative-promise proof, and teardown evidence", async () => {
	const skill = await readFile(resolve(import.meta.dir, "../skills/live-verification/SKILL.md"), "utf8");
	for (const marker of [
		"After an unexpected action failure", "recheck instance/build/auth/readiness",
		"healthy process", "wedged application", "reset only owned disposable state",
		"preserve the failure", "Do not retry until green",
		"dry-run", "read-only", "cancellation", "no-publication",
		"compare relevant files, requests, processes or Git refs before and after",
		"Execute the documented startup, readiness, action, effect and cleanup procedure.",
		"artifacts remain readable after teardown",
		"Staged snapshots require Git support for `checkout-index --ignore-skip-worktree-bits`",
		"if unavailable, verification is blocked and must never fall back to live workspace files",
	]) assert.ok(skill.includes(marker), marker);
});

test.each(["live-verification", "build-live-verification", "thermonuclear-correctness-review", "thermonuclear-structural-review", "deslop", "task-recipe"])(
	"Pi default discovery advertises %s as a selectable user skill",
	async (skillName) => {
		const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
		assert.ok(installRoot, "PI_MANAGED_INSTALL_ROOT is required for the real Pi loader");
		const version = (await readFile(join(installRoot, "current-version"), "utf8")).trim();
		const { DefaultResourceLoader, SettingsManager, formatSkillsForPrompt } = await import(
			join(installRoot, "releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")
		);
		const cwd = await mkdtemp(join(tmpdir(), "pi-live-verification-skill-"));
		try {
			const agentDir = resolve(import.meta.dir, "..");
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
				noExtensions: true,
				noContextFiles: true,
				noPromptTemplates: skillName !== "task-recipe",
				noThemes: true,
			});
			await loader.reload();
			const result = loader.getSkills();
			if (skillName === "task-recipe") {
				assert.equal(result.skills.some((skill) => skill.name === "correctness-review" || skill.name === "structural-review"), false, "old lens aliases are absent");
				const { prompts, diagnostics } = loader.getPrompts();
				const renamed = prompts.filter((prompt) => prompt.name === "eviscerate-diff");
				assert.equal(renamed.length, 1, "discover exactly one composite command");
				const promptPath = join(agentDir, "prompts", "eviscerate-diff.md");
				assert.equal(renamed[0].filePath, promptPath);
				const liveRows = renamed[0].content.split("\n").filter((line) => /^\| `live-verification-(?:success|attack)` \|/.test(line));
				assert.deepEqual(liveRows.map((line) => line.split("|")[1].trim()), ["`live-verification-success`", "`live-verification-attack`"], "loaded pass requires separate positive and adversarial live workers");
				for (const row of liveRows) assert.ok(row.includes("`live-verifier`"), "both lanes reuse the existing verifier profile");
				assert.equal(prompts.some((prompt) => prompt.name === "code_review"), false, "old composite alias is absent");
				assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.path === promptPath), []);
			}
			const matches = result.skills.filter((skill) => skill.name === skillName);
			assert.equal(matches.length, 1, `discover exactly one ${skillName} skill without explicit skill paths`);
			const skill = matches[0];
			const path = join(agentDir, "skills", skillName, "SKILL.md");
			assert.equal(skill.filePath, path);
			assert.equal(skill.disableModelInvocation, false, "available for model selection, not explicit-only");
			assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.path === path), []);
			const prompt = formatSkillsForPrompt([skill]);
			assert.ok(prompt.includes(`<name>${skillName}</name>`));
			assert.ok(prompt.includes(`<location>${path}</location>`));
			assert.ok((await readFile(skill.filePath, "utf8")).trim(), "advertised instructions are readable");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
