import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHumanInputTracker, type HumanInputIdentity } from "../extensions/lib/human-input.ts";

test("native input events bind distinct persisted human requests, not extension messages or startup", async () => {
	const install = process.env.PI_MANAGED_INSTALL_ROOT;
	assert.ok(install);
	const version = readFileSync(join(install, "current-version"), "utf8").trim();
	const modules = join(install, "releases", version, "node_modules");
	const pi: typeof import("@earendil-works/pi-coding-agent") = await import(join(modules, "@earendil-works/pi-coding-agent/dist/index.js"));
	const ai: typeof import("@earendil-works/pi-ai") = await import(join(modules, "@earendil-works/pi-ai/dist/index.js"));
	const compat: typeof import("@earendil-works/pi-ai/compat") = await import(join(modules, "@earendil-works/pi-ai/dist/compat.js"));
	const root = mkdtempSync(join(tmpdir(), "native-human-input-"));
	const sources: string[] = [];
	const observations: Array<{ phase: string; identity: HumanInputIdentity | undefined; users: string[] }> = [];
	let tracker: ReturnType<typeof registerHumanInputTracker> | undefined;
	let lastContext: ExtensionContext | undefined;
	const settings = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: false });
	const loader = new pi.DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager: settings,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(api) => {
			tracker = registerHumanInputTracker(api);
			api.on("input", (event) => { sources.push(event.source); });
			const observe = (phase: string, ctx: ExtensionContext) => {
				lastContext = ctx;
				const users = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "user" ? [entry.id] : []);
				observations.push({ phase, identity: tracker?.current(ctx), users });
			};
			api.on("before_agent_start", (_event, ctx) => observe("before", ctx));
			api.on("context", (_event, ctx) => observe("context", ctx));
		}],
	});
	let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
	let networkRequests = 0;
	const priorFetch = globalThis.fetch;
	globalThis.fetch = async () => { networkRequests += 1; throw new Error("Unexpected network request in local native fixture"); };
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.ok(tracker, "inline extension must actually load before this is a lifecycle check");
		const runtime = await pi.ModelRuntime.create({ authPath: join(root, "absent-auth.json"), modelsPath: null, refreshOnCreate: false });
		await runtime.setRuntimeApiKey("anthropic", "local-fixture-only");
		const model = compat.getModel("anthropic", "claude-sonnet-4-5");
		assert.ok(model, "the pinned SDK fixture model must exist");
		({ session } = await pi.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, modelRuntime: runtime, model, thinkingLevel: "off", tools: [], sessionManager: pi.SessionManager.create(root, join(root, "sessions")) }));
		session.agent.streamFunction = (model) => {
			const stream = ai.createAssistantMessageEventStream();
			const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, content: [{ type: "text" as const, text: "Local fixture response" }], stopReason: "stop" as const, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		};
		await session.bindExtensions({ mode: "print" });
		await session.prompt("Identical human request", { source: "rpc" });
		assert.deepEqual(sources, ["rpc"], "native input source must be observed");
		const before = observations.find((item) => item.phase === "before");
		const first = observations.find((item) => item.phase === "context");
		assert.ok(before && first && first.users.length === 1, "native user persistence must precede context");
		assert.equal(before.identity, undefined, "startup must not invent a persisted originating request");
		assert.equal(first.identity?.entryId, first.users[0], "the adapter must bind the actual persisted human request");
		assert.equal(first.identity?.sessionId, session.sessionManager.getSessionId());
		const sessionFile = session.sessionFile;
		assert.ok(sessionFile);
		assert.ok(readFileSync(sessionFile, "utf8").split("\n").some((line) => line.includes(`"id":${JSON.stringify(first.users[0])}`) && line.includes('"role":"user"')), "the bound native user entry must reach the owned session file");
		await session.prompt("Injected notification", { source: "extension" });
		assert.ok(lastContext);
		assert.equal(tracker.current(lastContext)?.entryId, first.users[0], "extension user messages create no human epoch");
		await session.prompt("Identical human request", { source: "rpc" });
		const second = tracker.current(lastContext);
		assert.ok(second);
		assert.notEqual(second.entryId, first.users[0], "identical actual requests have distinct native identities");
		const leaf = session.sessionManager.getLeafId();
		assert.ok(leaf);
		session.sessionManager.appendCompaction("Local fixture compaction", leaf, 0, undefined, true);
		assert.equal(tracker.current(lastContext)?.entryId, second.entryId, "compaction keeps the raw branch request identity");
		assert.equal(tracker.isHumanEntry(lastContext, first.users[0]), true);
		assert.equal(networkRequests, 0);
	} finally {
		session?.dispose();
		globalThis.fetch = priorFetch;
		rmSync(root, { recursive: true, force: true });
	}
});
