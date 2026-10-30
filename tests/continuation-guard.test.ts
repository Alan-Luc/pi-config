import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { registerContinuationGuard } from "../extensions/tech-lead/continuation.ts";
import { isRecord } from "../extensions/lib/shared.ts";
import { TASK_SNAPSHOT_REQUEST, TASK_SNAPSHOT_RESPONSE } from "../extensions/lib/task-snapshot.ts";
import { parseWorkStatusRequest, VERIFICATION_STATUS_REQUEST, VERIFICATION_STATUS_RESPONSE, DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE } from "../extensions/lib/work-status.ts";
import { BACKGROUND_TASK_REQUEST_CHANNEL, BACKGROUND_TASK_RESPONSE_CHANNEL, BACKGROUND_TASK_RESPONSE_SCHEMA } from "../extensions/artifact-contracts/background-tasks.ts";

const suppressions = ["paused", "blocked", "waiting", "approval-required", "unknown", "missing-disposition", "stale-revision", "model-only-basis", "missing-approval", "dependency-blocked", "foreign-owner", "foreign-session", "scope-project", "scope-shared", "scope-memory", "verification-absent", "verification-starting", "verification-uncollected", "delegation-absent", "child-running", "child-unconsumed", "background-running", "background-notification", "state-changed", "operator-stop", "child-runtime"] as const;
type NativeScenario = "ready" | typeof suppressions[number];

async function runNativeScenario(scenario: NativeScenario) {
	const install = process.env.PI_MANAGED_INSTALL_ROOT;
	assert.ok(install);
	const version = readFileSync(join(install, "current-version"), "utf8").trim();
	const modules = join(install, "releases", version, "node_modules");
	const pi: typeof import("@earendil-works/pi-coding-agent") = await import(join(modules, "@earendil-works/pi-coding-agent/dist/index.js"));
	const ai: typeof import("@earendil-works/pi-ai") = await import(join(modules, "@earendil-works/pi-ai/dist/index.js"));
	const compat: typeof import("@earendil-works/pi-ai/compat") = await import(join(modules, "@earendil-works/pi-ai/dist/compat.js"));
	const root = mkdtempSync(join(tmpdir(), "native-continuation-"));
	let sessionId = "";
	let requestEntryId = "";
	let revision = "revision-1";
	let requests = 0;
	let backgroundQueries = 0;
	let abortedSettlement = false;
	const boundaries: Array<{ canContinue: boolean; outcome: string; continuing: boolean; pending: number; aborted: boolean }> = [];
	let networkRequests = 0;
	const priorFetch = globalThis.fetch;
	globalThis.fetch = async () => { networkRequests += 1; throw new Error("Unexpected external network in native continuation fixture"); };
	let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
	try {
		const settings = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: false });
		const loader = new pi.DefaultResourceLoader({
			cwd: root, agentDir: root, settingsManager: settings,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(api) => {
				if (scenario === "operator-stop") api.on("agent_before_settle", (_event, ctx) => { ctx.abort(); });
				registerContinuationGuard(api, scenario === "child-runtime" ? { PI_SUBAGENT_AGENT: "fixture-child", PI_SUBAGENT_PARENT_SESSION: "fixture-parent" } : {});
				api.on("agent_before_settle", (event, ctx) => { boundaries.push({ canContinue: event.context.canContinue, outcome: event.outcome, continuing: event.continue, pending: event.context.pendingMessages.length, aborted: ctx.signal?.aborted ?? false }); });
				api.on("session_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); });
				api.on("agent_settled", (event) => { abortedSettlement = event.aborted; });
				api.on("context", (_event, ctx) => {
					if (requestEntryId) return;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "user") requestEntryId = entry.id;
					}
				});
				// These controlled dependency observations are not producer integration proof.
				api.events.on(TASK_SNAPSHOT_REQUEST, (raw: unknown) => {
					const request = parseWorkStatusRequest(raw);
					if (!request || request.sessionId !== sessionId) return;
					const disposition = scenario === "paused" || scenario === "blocked" || scenario === "waiting" || scenario === "approval-required" || scenario === "unknown" ? scenario : "ready";
					const basis = scenario === "missing-approval"
						? { kind: "plan", inputEntryId: requestEntryId, requestEntryId, plan: ".harness/plans/2026-10-24-fixture.md", decisionAnchor: "approved-build", approvalEntryId: "not-an-observed-human" }
						: { kind: "request", inputEntryId: requestEntryId, requestEntryId: scenario === "model-only-basis" ? "model-written-approval" : requestEntryId };
					api.events.emit(TASK_SNAPSHOT_RESPONSE, { ...request, sessionId: scenario === "foreign-session" ? "another-session" : request.sessionId, generation: "tasks", scope: scenario.startsWith("scope-") ? scenario.slice(6) : "session-file", storeId: "isolated-store", revision,
						tasks: [{ id: "1", status: "in_progress", blockedBy: scenario === "dependency-blocked" ? ["missing-dependency"] : [], ...(scenario === "foreign-owner" ? { owner: "another-owner" } : {}) }],
						continuation: scenario === "missing-disposition" ? null : { taskId: "1", disposition, revision: scenario === "stale-revision" ? "old-revision" : revision, basis } });
				});
				for (const [requestChannel, responseChannel, fields] of [
					[VERIFICATION_STATUS_REQUEST, VERIFICATION_STATUS_RESPONSE, { starting: scenario === "verification-starting" ? 1 : 0, uncollectedTaskIds: scenario === "verification-uncollected" ? ["uncollected-check"] : [] }],
					[DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE, { revision: 1, runningChildIds: scenario === "child-running" ? ["running-child"] : [], pendingResultIds: scenario === "child-unconsumed" ? ["pending-child"] : [] }],
				] as const) api.events.on(requestChannel, (raw: unknown) => {
					if ((scenario === "verification-absent" && requestChannel === VERIFICATION_STATUS_REQUEST) || (scenario === "delegation-absent" && requestChannel === DELEGATION_STATUS_REQUEST)) return;
					const request = parseWorkStatusRequest(raw);
					if (request?.sessionId === sessionId) api.events.emit(responseChannel, { ...request, generation: responseChannel, ...fields });
				});
				api.events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (raw: unknown) => {
					if (!isRecord(raw) || raw.operation !== "status") return;
					backgroundQueries += 1;
					const tasks = scenario === "background-running" || scenario === "background-notification"
						? [{ id: "owned-background", name: "Fixture task", command: "node fixture.mjs", status: scenario === "background-running" ? "running" : "completed", cwd: root, outputPath: join(root, "owned-output"), startTime: 1, bytesWritten: 0, isAgent: false, notified: false, notifyOnCompletion: true, triggerOnCompletion: true }]
						: [];
					api.events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, { schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: raw.request_id, operation: "status", ok: true, result: { tasks } });
					if (scenario === "state-changed") revision = "revision-after-observation";
				});
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await pi.ModelRuntime.create({ authPath: join(root, "absent-auth.json"), modelsPath: null, refreshOnCreate: false });
		await runtime.setRuntimeApiKey("anthropic", "fixture-only");
		const model = compat.getModel("anthropic", "claude-sonnet-4-5");
		assert.ok(model);
		({ session } = await pi.createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, modelRuntime: runtime, model, thinkingLevel: "off", tools: [], sessionManager: pi.SessionManager.create(root, join(root, "sessions")) }));
		session.agent.streamFunction = (selected) => {
			requests += 1;
			assert.ok(requests <= 4, "automatic continuation must not loop past its human cap");
			if (requests === 2) revision = "revision-2";
			const stream = ai.createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, content: [{ type: "text", text: "Status answer; unfinished work remains." }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
			return stream;
		};
		await session.bindExtensions({ mode: "print" });
		await session.prompt("Continue the already-authorized bounded request after answering status.", { source: "rpc" });
		assert.ok(sessionId && requestEntryId, "native session and appended user identity controls must execute");
		if (scenario !== "ready") {
			assert.equal(requests, 1, `${scenario} must not request an automatic provider turn`);
			if (scenario === "background-running" || scenario === "background-notification") assert.ok(session.messages.some((message) => message.role === "custom" && typeof message.content === "string" && message.content.includes("background work or its notification is pending")), "a valid busy status, not a malformed fixture, must suppress continuation");
			if (scenario === "operator-stop") assert.equal(abortedSettlement, true, "the native SDK must confirm an actual operator-aborted settlement, not merely a no-nudge fixture");
			assert.equal(networkRequests, 0);
			return;
		}
		assert.equal(requests, 2, `one eligible stop must request exactly one next native provider turn; ${JSON.stringify({ boundaries, backgroundQueries, messages: session.messages.filter((message) => message.role === "custom") })}`);
		assert.ok(backgroundQueries > 0, "the existing background status interface must be observed");
		assert.ok(session.messages.some((message) => message.role === "custom" && message.customType === "workflow-continuation-status" && typeof message.content === "string" && /unfinished/i.test(message.content)), "the later capped stop must stay visibly unfinished");
		await session.prompt("Extension result notification", { source: "extension" });
		assert.equal(requests, 3, "a notification cannot replenish the prior human allowance");
		await session.prompt("Pause this work.", { source: "rpc" });
		assert.equal(requests, 4, "new human input without typed reconciliation must stale the old ready basis");
		assert.equal(networkRequests, 0);
	} finally {
		session?.dispose();
		globalThis.fetch = priorFetch;
		rmSync(root, { recursive: true, force: true });
	}
}

test("parent continuation uses one native human allowance despite metadata churn and extension notifications", () => runNativeScenario("ready"));
test.each(suppressions)("native continuation suppresses %s", (scenario) => runNativeScenario(scenario));
