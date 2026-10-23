import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.each(["live-verification", "build-live-verification", "correctness-review", "structural-review", "deslop"])(
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
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();
			const result = loader.getSkills();
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
