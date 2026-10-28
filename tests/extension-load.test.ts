import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("Pi default discovery loads and parent-mode guard denies legacy publication", async () => {
	const { DefaultResourceLoader, SettingsManager } = await loadPiApi();
	const cwd = await mkdtemp(join(tmpdir(), "pi-extension-load-"));
	try {
		expect(isSubagentChildEnvironment(process.env)).toBe(false);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: resolve(import.meta.dir, ".."),
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		const extensions = new Map(result.extensions.map((extension) => [extension.path, extension]));
		const guardrails = extensions.get(resolve(import.meta.dir, "../extensions/guardrails/index.ts"));
		const shortcuts = extensions.get(resolve(import.meta.dir, "../extensions/shortcuts.ts"));
		const workLog = extensions.get(resolve(import.meta.dir, "../extensions/work-log/index.ts"));
		const notifyUser = extensions.get(resolve(import.meta.dir, "../extensions/notify-user.ts"));

		expect(guardrails?.handlers.has("tool_call")).toBe(true);
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git("init", "--quiet", "-b", "alan/fixture");
		git("config", "user.email", "fixture@example.test");
		git("config", "user.name", "Fixture");
		await writeFile(join(cwd, "tracked.txt"), "fixture\\n");
		git("add", "tracked.txt");
		git("commit", "--quiet", "-m", "fixture");
		git("remote", "add", "origin", "git@github.com:Alan-Luc/fixture.git");
		const callbacks = guardrails?.handlers.get("tool_call");
		expect(callbacks).toBeDefined();
		expect(callbacks?.length).toBeGreaterThan(0);
		await expect(Promise.all((callbacks ?? []).map((callback) => callback({ type: "tool_call", toolName: "bash", toolCallId: "loaded-push", input: { command: "git push origin alan/fixture" } }, { cwd })))).rejects.toThrow();
		expect(shortcuts?.shortcuts.has("alt+p")).toBe(true);
		expect(workLog?.tools.has("work_log")).toBe(true);
		expect(notifyUser?.tools.has("notify_user")).toBe(true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
