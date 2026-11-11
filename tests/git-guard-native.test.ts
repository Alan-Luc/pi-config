import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";

test("native Pi enforces the local Git guard through Bash", { timeout: 60_000 }, async () => {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	assert.ok(installRoot, "PI_MANAGED_INSTALL_ROOT must select the managed SDK");
	const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
	const modules = join(installRoot, "releases", version, "node_modules");
	const pi: typeof import("@earendil-works/pi-coding-agent") = await import(join(modules, "@earendil-works/pi-coding-agent/dist/index.js"));
	const ai: typeof import("@earendil-works/pi-ai") = await import(join(modules, "@earendil-works/pi-ai/dist/index.js"));
	const compat: typeof import("@earendil-works/pi-ai/compat") = await import(join(modules, "@earendil-works/pi-ai/dist/compat.js"));
	const root = mkdtempSync(join(tmpdir(), "git-guard-native-"));
	const repo = join(root, "repo");
	const privateAgentDir = join(root, "agent");
	const bin = join(root, "bin");
	const counter = join(root, "test-command-count");
	mkdirSync(repo);
	mkdirSync(privateAgentDir);
	mkdirSync(bin);
	const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const childMarkers = ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"];
	const previousMarkers = new Map(childMarkers.map((key) => [key, process.env[key]]));
	const previousPath = process.env.PATH;
	const previousUserConfig = process.env.PI_CODING_AGENT_DIR;
	let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
	try {
		for (const key of childMarkers) process.env[key] = "native-fixture-child";
		process.env.PI_CODING_AGENT_DIR = privateAgentDir;
		process.env.PATH = `${bin}:/usr/bin:/bin`;
		writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf x >> '${counter}'\nprintf 'ECONNREFUSED localhost:55432\\n' >&2\nexit 1\n`, { mode: 0o755 });
		git(["init", "-b", "main"]);
		git(["config", "user.name", "Native Guard Fixture"]);
		git(["config", "user.email", "native-guard@example.invalid"]);
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(["add", "tracked.txt"]);
		git(["commit", "-m", "base"]);
		const remote = join(root, "origin.git");
		git(["init", "--bare", remote], root);
		git(["remote", "add", "origin", remote]);
		git(["push", "origin", "main"]);
		writeFileSync(join(repo, "pending.txt"), "pending\n");
		git(["add", "pending.txt"]);
		const initialHead = git(["rev-parse", "HEAD"]);
		const initialRemoteHead = git(["--git-dir", remote, "rev-parse", "refs/heads/main"], root);
		const initialStatus = git(["status", "--porcelain"]);

		const settings = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: false });
		let plannedCommand = "";
		let callId = 0;
		const loader = new pi.DefaultResourceLoader({
			cwd: repo,
			agentDir: privateAgentDir,
			settingsManager: settings,
			additionalExtensionPaths: [resolve(import.meta.dir, "../extensions/git-guard/index.ts"), resolve(import.meta.dir, "../extensions/artifact-contracts/index.ts")],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const extensions = new Map(loaded.extensions.map((extension) => [extension.path, extension]));
		const guard = extensions.get(resolve(import.meta.dir, "../extensions/git-guard/index.ts"));
		const artifacts = extensions.get(resolve(import.meta.dir, "../extensions/artifact-contracts/index.ts"));
		assert.ok(guard, "the explicitly selected local Git guard must load");
		assert.ok(artifacts?.tools.has("verification_evidence"), "native discovery must retain verification_evidence");
		assert.ok(artifacts?.tools.has("submit_agent_result"), "native discovery must retain submit_agent_result");
		assert.ok(!artifacts?.tools.has("publication_clearance"), "native discovery must not restore the removed publication tool");

		const runtime = await pi.ModelRuntime.create({ authPath: join(root, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
		const model = compat.getModel("anthropic", "claude-sonnet-4-5");
		assert.ok(model, "the selected SDK must provide the synthetic fixture model");
		({ session } = await pi.createAgentSession({
			cwd: repo,
			agentDir: privateAgentDir,
			resourceLoader: loader,
			settingsManager: settings,
			modelRuntime: runtime,
			model,
			thinkingLevel: "off",
			tools: ["bash"],
			sessionManager: pi.SessionManager.create(repo, join(root, "sessions")),
		}));
		session.agent.streamFunction = (selectedModel) => {
			const stream = ai.createAssistantMessageEventStream();
			if (plannedCommand) {
				callId += 1;
				stream.push({ type: "done", reason: "toolUse", message: {
					role: "assistant", api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
					content: [{ type: "toolCall", id: `native-guard-${callId}`, name: "bash", arguments: { command: plannedCommand } }],
					stopReason: "toolUse", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				} });
				plannedCommand = "";
			} else {
				stream.push({ type: "done", reason: "stop", message: {
					role: "assistant", api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
					content: [{ type: "text", text: "Local fixture complete." }], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				} });
			}
			return stream;
		};
		await session.bindExtensions({ mode: "print" });
		const runCommand = async (command: string) => {
			plannedCommand = command;
			const before = session!.messages.length;
			await session!.prompt(`Run exactly this local verification command: ${command}`, { source: "rpc" });
			const result = session!.messages.slice(before).find((message) => message.role === "toolResult");
			assert.ok(result, `native Bash must persist a tool result for ${command}`);
			assert.equal(result.toolName, "bash");
			return { output: result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), isError: result.isError };
		};

		for (const command of ["git commit -m denied", "git push origin main"]) {
			const result = await runCommand(command);
			assert.equal(result.isError, true, `child ${command} must be denied`);
			assert.match(result.output, /Subagents cannot commit or push/);
			assert.equal(git(["rev-parse", "HEAD"]), initialHead);
			assert.equal(git(["--git-dir", remote, "rev-parse", "refs/heads/main"], root), initialRemoteHead);
			assert.equal(git(["status", "--porcelain"]), initialStatus);
		}

		const dbCommand = "bun test tests/native-fixture.test.ts";
		const failed = await runCommand(dbCommand);
		assert.equal(failed.isError, true);
		assert.match(failed.output, /ECONNREFUSED localhost:55432/);
		assert.equal(readFileSync(counter, "utf8"), "x", "the initial database failure must come from executed fixture Bash");
		const retry = await runCommand(dbCommand);
		assert.equal(retry.isError, true);
		assert.match(retry.output, /Blocked repeat bash command/);
		assert.equal(readFileSync(counter, "utf8"), "x", "the blocked exact retry must not run the fixture command");
		const overridden = await runCommand(`PI_ALLOW_INFRA_RETRY=1 ${dbCommand}`);
		assert.equal(overridden.isError, true, "the override must execute the still-failing fixture command");
		assert.match(overridden.output, /ECONNREFUSED localhost:55432/);
		assert.equal(readFileSync(counter, "utf8"), "xx", "the explicit override must execute Bash exactly once");
		const read = await runCommand("pwd");
		assert.equal(read.isError, false);
		assert.equal(read.output.trim(), realpathSync(repo));
		assert.equal(callId, 6, "each prompt must make one actual native Bash tool call");
		assert.ok(session.sessionFile);
		const persisted = readFileSync(session.sessionFile, "utf8");
		assert.equal(persisted.split("\n").filter((line) => line.includes('"role":"toolResult"')).length, 6);
		assert.ok(persisted.includes("Subagents cannot commit or push"));
		assert.ok(persisted.includes("Blocked repeat bash command"));
		console.log(JSON.stringify({ sdkVersion: version, nativeBashCalls: callId, childMutationsBlocked: 2, databaseCommandExecutions: readFileSync(counter, "utf8").length, persistedToolResults: 6, refsUnchanged: git(["rev-parse", "HEAD"]) === initialHead && git(["--git-dir", remote, "rev-parse", "refs/heads/main"], root) === initialRemoteHead }));
	} finally {
		session?.dispose();
		for (const [key, value] of previousMarkers) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousUserConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousUserConfig;
		rmSync(root, { recursive: true, force: true });
	}
});
