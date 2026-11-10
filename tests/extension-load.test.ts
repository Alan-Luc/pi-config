import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSubagentChildEnvironment } from "../extensions/lib/shared.ts";

const standaloneCommit = "9d0549e55e3f0b8835b925c589e73e97678b7dd9";

async function loadPiApi() {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	if (!installRoot) throw new Error("PI_MANAGED_INSTALL_ROOT is required to run the Pi loader smoke test");
	const version = (await readFile(join(installRoot, "current-version"), "utf8")).trim();
	return import(join(installRoot, "releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
}

test("settings pin the standalone guard package", async () => {
	const settings = JSON.parse(await readFile(new URL("../settings.json", import.meta.url), "utf8"));
	expect(settings.packages).toContain(`git:github.com/Alan-Luc/pi-guardrails@${standaloneCommit}`);
});

test("Pi discovery loads one standalone guard and preserves artifact tools", async () => {
	if (isSubagentChildEnvironment(process.env)) {
		const fixtureEnv = { ...process.env };
		for (const key of ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"]) delete fixtureEnv[key];
		execFileSync(process.execPath, ["test", import.meta.path], { cwd: resolve(import.meta.dir, ".."), env: fixtureEnv, timeout: 30_000 });
		return;
	}
	const { DefaultResourceLoader, SessionManager, SettingsManager } = await loadPiApi();
	const packageRoot = resolve(process.env.PI_GUARDRAILS_TEST_ROOT ?? join(import.meta.dir, "../git/github.com/Alan-Luc/pi-guardrails"));
	expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim()).toBe(standaloneCommit);
	const cwd = await mkdtemp(join(tmpdir(), "pi-extension-load-"));
	const publicationConfigPath = process.env.PI_PUBLICATION_CONFIG_PATH;
	delete process.env.PI_PUBLICATION_CONFIG_PATH;
	try {
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		settings.setPackages([packageRoot]);
		const loader = new DefaultResourceLoader({
			cwd, agentDir: resolve(import.meta.dir, ".."), settingsManager: settings,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		const guards = result.extensions.filter((extension) => extension.path.endsWith("/extensions/guardrails/index.ts"));
		expect(guards.map((extension) => extension.path)).toEqual([join(packageRoot, "extensions/guardrails/index.ts")]);
		const extensions = new Map(result.extensions.map((extension) => [extension.path, extension]));
		const guardrails = guards[0];
		expect(guardrails?.commands.has("publication-config")).toBe(true);
		const callbacks = guardrails?.handlers.get("tool_call");
		expect(callbacks?.length).toBeGreaterThan(0);
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git("init", "--quiet", "-b", "alan/fixture");
		git("config", "user.email", "fixture@example.test");
		git("config", "user.name", "Fixture");
		await writeFile(join(cwd, "tracked.txt"), "fixture\n");
		git("add", "tracked.txt");
		git("commit", "--quiet", "-m", "fixture");
		git("remote", "add", "origin", "git@github.com:Alan-Luc/fixture.git");
		const before = git("show-ref");
		const context = { cwd, sessionManager: SessionManager.inMemory(cwd) };
		for (const host of ["github.com", "gitlab.com"]) {
			git("remote", "set-url", "origin", `git@${host}:Alan-Luc/fixture.git`);
			for (const toolName of ["bash", "bg_run"]) {
				await expect(Promise.all((callbacks ?? []).map((callback) => callback({ type: "tool_call", toolName, toolCallId: "loaded-push", input: { command: "git push origin alan/fixture" } }, context)))).rejects.toThrow("grant_invalid");
			}
		}
		expect(git("show-ref")).toBe(before);
		expect(extensions.get(resolve(import.meta.dir, "../extensions/shortcuts.ts"))?.shortcuts.has("alt+p")).toBe(true);
		expect(extensions.get(resolve(import.meta.dir, "../extensions/work-log/index.ts"))?.tools.has("work_log")).toBe(true);
		expect(extensions.get(resolve(import.meta.dir, "../extensions/notify-user.ts"))?.tools.has("notify_user")).toBe(true);
		const artifacts = extensions.get(resolve(import.meta.dir, "../extensions/artifact-contracts/index.ts"));
		expect(artifacts?.tools.has("verification_evidence")).toBe(true);
		expect(artifacts?.tools.has("publication_clearance")).toBe(true);
	} finally {
		if (publicationConfigPath === undefined) delete process.env.PI_PUBLICATION_CONFIG_PATH;
		else process.env.PI_PUBLICATION_CONFIG_PATH = publicationConfigPath;
		await rm(cwd, { recursive: true, force: true });
	}
});
