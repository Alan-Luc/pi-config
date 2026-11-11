import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSubagentChildEnvironment } from "../extensions/lib/shared.ts";

async function loadPiApi() {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	if (!installRoot) throw new Error("PI_MANAGED_INSTALL_ROOT is required to run the Pi loader smoke test");
	const version = (await readFile(join(installRoot, "current-version"), "utf8")).trim();
	return import(join(installRoot, "releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
}

test("Pi discovery loads one local Git guard and preserves artifact tools", async () => {
	if (isSubagentChildEnvironment(process.env)) {
		const fixtureEnv = { ...process.env };
		for (const key of ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"]) delete fixtureEnv[key];
		execFileSync(process.execPath, ["test", import.meta.path], { cwd: resolve(import.meta.dir, ".."), env: fixtureEnv, timeout: 30_000 });
		return;
	}
	const { DefaultResourceLoader, SettingsManager } = await loadPiApi();
	const cwd = await mkdtemp(join(tmpdir(), "pi-extension-load-"));
	try {
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		const loader = new DefaultResourceLoader({
			cwd, agentDir: resolve(import.meta.dir, ".."), settingsManager: settings,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		const guards = result.extensions.filter((extension) => extension.path.endsWith("/extensions/git-guard/index.ts"));
		expect(guards.map((extension) => extension.path)).toEqual([resolve(import.meta.dir, "../extensions/git-guard/index.ts")]);
		expect(guards[0]?.handlers.get("tool_call")?.length).toBe(3);
		const extensions = new Map(result.extensions.map((extension) => [extension.path, extension]));
		expect(extensions.get(resolve(import.meta.dir, "../extensions/shortcuts.ts"))?.shortcuts.has("alt+p")).toBe(true);
		expect(extensions.get(resolve(import.meta.dir, "../extensions/work-log/index.ts"))?.tools.has("work_log")).toBe(true);
		expect(extensions.get(resolve(import.meta.dir, "../extensions/notify-user.ts"))?.tools.has("notify_user")).toBe(true);
		const artifacts = extensions.get(resolve(import.meta.dir, "../extensions/artifact-contracts/index.ts"));
		expect(artifacts?.tools.has("verification_evidence")).toBe(true);
		expect(artifacts?.tools.has("submit_agent_result")).toBe(false);
		expect(artifacts?.tools.has("publication_clearance")).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
