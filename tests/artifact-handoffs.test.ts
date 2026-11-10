import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, it, test } from "bun:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { correctionMessage, failureReport, registerHandoffHooks, replyInstructions, replySchema, verifiedByErrors } from "../extensions/artifact-contracts/handoffs.ts";
import {
	BACKGROUND_TASK_REQUEST_CHANNEL,
	BACKGROUND_TASK_RESPONSE_CHANNEL,
	BACKGROUND_TASK_RESPONSE_SCHEMA,
} from "../extensions/artifact-contracts/background-tasks.ts";
import { renderTemplate } from "../extensions/artifact-contracts/render.ts";
import { currentAssignment, sameAssignment } from "../extensions/artifact-contracts/assignment.ts";
import { renderResultSubmission } from "../extensions/artifact-contracts/result-submission.ts";
import { validate } from "../extensions/artifact-contracts/validate.ts";
import * as publicationClearance from "../extensions/artifact-contracts/publication-clearance.ts";
import {
	beginVerificationAttempt,
	createCandidateIdentity,
	getVerificationEvidence,
	recordVerificationEvidence,
	verificationEvidenceErrors,
} from "../extensions/artifact-contracts/verification-store.ts";
import { captureCandidateWithExec, type CandidateExec } from "../extensions/artifact-contracts/verification.ts";
import { FINALIZE_RESULT_REQUEST, FINALIZE_RESULT_RESPONSE, FINALIZED_RESULT_ENTRY, LAUNCH_BINDING_ENV, DELEGATION_RESULT_REQUEST, DELEGATION_RESULT_RESPONSE, registerPublicationClearance, registerResultFinalizer } from "../extensions/artifact-contracts/publication-clearance.ts";
import { VERIFICATION_STATUS_REQUEST, VERIFICATION_STATUS_RESPONSE, DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE } from "../extensions/lib/work-status.ts";
import { createStagedSnapshot } from "../extensions/artifact-contracts/staged-verification.ts";

const child = { PI_SUBAGENT_AGENT: "code-explorer" };
const worker = { PI_SUBAGENT_AGENT: "other" };

function nativeSession() {
	return SessionManager.inMemory("/tmp/artifact-handoff-native");
}

function appendUser(session: SessionManager, text: string): string {
	return session.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

it.each([
	"implementation-engineer",
	"test-automation-engineer", "live-verifier", "code-explorer", "mr-babysitter",
	"code-reviewer", "code-reviewer-sol", "code-reviewer-sonnet", "code-reviewer-opus",
])("%s explicitly exposes the schema-bound submission tool", async (role) => {
	const source = await Bun.file(new URL(`../agents/${role}.md`, import.meta.url)).text();
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(frontmatter, "a real checked-in role profile must be read");
	const tools = frontmatter.match(/^tools:[ \t]*(.*)$/m)?.[1].split(",").map((name) => name.trim());
	assert.ok(tools?.includes("submit_agent_result"), "registered result submission must remain active under the role's explicit loadout");
});

test("assignment snapshots use persisted entry identity and survive compaction ancestry", () => {
	const session = nativeSession();
	const requestId = appendUser(session, "identical assignment");
	const original = currentAssignment(session);
	assert.equal(original?.requestEntryId, requestId);
	const compactId = session.appendCompaction("Compacted context", requestId, 12);
	const compacted = currentAssignment(session);
	assert.equal(compacted?.requestEntryId, requestId);
	assert.ok(sameAssignment(original!, compacted!));
	assert.ok(compacted?.branchEntryIds.includes(compactId));
});

test("branch navigation invalidates evidence on the newly selected native branch", () => {
	const session = nativeSession();
	const requestId = appendUser(session, "branch request");
	session.appendCustomEntry("old-branch-marker");
	const registered = hooks(worker);
	const context = { sessionManager: session };
	registered.agent_start({} as never, context);
	const run = evidence("'bun' 'test'");
	const oldLeafId = session.getLeafId();
	session.branch(requestId);
	const newLeafId = session.appendCustomEntry("alternate-branch-marker");
	registered.session_tree({ oldLeafId, newLeafId } as never, context);
	assert.match(verifiedByErrors(workerReply(run.verifiedBy ?? "")).join("\n"), /was not found in this session/);
});

test("abandoning an unobserved acknowledgement clears the same-prefix submission and receipt", async () => {
	const session = nativeSession();
	const requestId = appendUser(session, "branch request");
	const registered = hooks(worker, undefined, true);
	const context = { sessionManager: session };
	registered.agent_start({} as never, context);
	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await registered.message_end(event("missing structured result"), context), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean };
		assert.equal(correction.continue, true);
	}
	const proof = evidence("'bun' 'test'");
	const tool = registered.tools.get("submit_agent_result") as unknown as SubmitTool;
	await tool.execute("submit-branch", {
		status: "done", objective: "Branch result", currentState: "Submitted before navigation.",
		decisions: [], proofIds: [proof.id], observationIds: [], notRun: [], nextSteps: [], doNot: [],
	}, undefined, undefined, context);
	const oldLeafId = session.appendCustomEntry("submission-ack");
	session.branch(requestId);
	const newLeafId = session.getLeafId();
	registered.session_tree({ oldLeafId, newLeafId } as never, context);
	assert.match(verifiedByErrors(workerReply(proof.verifiedBy ?? "")).join("\n"), /was not found in this session/);
	assert.equal(await registered.message_end(event("ignored model prose"), context), undefined);
	const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
	assert.equal(correction.continue, true);
	assert.match(correction.entries[0].content, /structured result missing/);
});

test("reports a markdown heading inside a submitted field against that field", async () => {
	const session = nativeSession();
	appendUser(session, "heading assignment");
	const registered = hooks(worker, undefined, true);
	const context = { sessionManager: session };
	registered.agent_start({} as never, context);
	const proof = evidence("'bun' 'test' 'heading'");
	const tool = registered.tools.get("submit_agent_result") as unknown as SubmitTool;
	await assert.rejects(
		tool.execute("submit-heading", {
			status: "done", objective: "Assignment", currentState: "# next phase",
			decisions: [], proofIds: [proof.id], observationIds: [], notRun: [], nextSteps: [], doNot: [],
		}, undefined, undefined, context),
		/currentState: expected non-empty single-line prose/,
	);
});

test("new sessions and runtime replacement reset assignment-bound state", async () => {
	const firstSession = nativeSession();
	appendUser(firstSession, "first assignment");
	const registered = hooks(worker, undefined, true);
	const firstContext = { sessionManager: firstSession };
	registered.agent_start({} as never, firstContext);
	const firstProof = evidence("'bun' 'test' 'first-session'");
	const tool = registered.tools.get("submit_agent_result") as unknown as SubmitTool;
	const fields = (proofId: string) => ({
		status: "done", objective: "Assignment", currentState: "Persisted locally.",
		decisions: [], proofIds: [proofId], observationIds: [], notRun: [], nextSteps: [], doNot: [],
	});
	await tool.execute("submit-first", fields(firstProof.id), undefined, undefined, firstContext);

	const nextSession = nativeSession();
	const nextContext = { sessionManager: nextSession };
	registered.session_start({ reason: "new" } as never, nextContext);
	assert.match(verifiedByErrors(workerReply(firstProof.verifiedBy ?? "")).join("\n"), /was not found in this session/);

	appendUser(nextSession, "replacement assignment");
	registered.agent_start({} as never, nextContext);
	const replacementProof = evidence("'bun' 'test' 'replacement-session'");
	await tool.execute("submit-replacement", fields(replacementProof.id), undefined, undefined, nextContext);
	registered.session_start({ reason: "reload" } as never, nextContext);
	assert.match(verifiedByErrors(workerReply(replacementProof.verifiedBy ?? "")).join("\n"), /was not found in this session/);
	assert.equal(await registered.message_end(event("ignored model prose"), nextContext), undefined);
});

test("same-request retry, compaction, and repair preserve structured state", async () => {
	const session = nativeSession();
	const requestId = appendUser(session, "same assignment");
	const registered = hooks(worker, undefined, true);
	const context = { sessionManager: session };
	registered.agent_start({} as never, context);
	const firstProof = evidence("'bun' 'test' 'before-repair'");
	const tool = registered.tools.get("submit_agent_result") as unknown as SubmitTool;
	const fields = (proofId: string) => ({
		status: "done", objective: "Assignment", currentState: "Persisted locally.",
		decisions: [], proofIds: [proofId], observationIds: [], notRun: [], nextSteps: [], doNot: [],
	});
	await tool.execute("submit-initial", fields(firstProof.id), undefined, undefined, context);
	registered.agent_start({} as never, context);
	session.appendCompaction("Preserved same-request context", requestId, 1);
	registered.agent_start({} as never, context);
	const firstFinal = await registered.message_end(event("ignored model prose"), context) as { message: { content: Array<{ text: string }> } };
	assert.ok(firstFinal.message.content[0].text.includes(firstProof.id));

	registered.tool_call({ toolName: "bash", toolCallId: "repair-write", input: {} } as never);
	registered.tool_result({ toolName: "bash", toolCallId: "repair-write", content: [], isError: false } as never);
	assert.equal(await registered.message_end(event("stale proof needs repair"), context), undefined);
	assert.match((registered.turn_end({} as never) as { entries: Array<{ content: string }> }).entries[0].content, /stale: bash tool activity/);
	const repairedProof = evidence("'bun' 'test' 'after-repair'");
	await tool.execute("submit-repaired", fields(repairedProof.id), undefined, undefined, context);
	const repairedFinal = await registered.message_end(event("ignored model prose"), context) as { message: { content: Array<{ text: string }> } };
	assert.ok(repairedFinal.message.content[0].text.includes(repairedProof.id));
});

test("identical-text follow-ups and abandoned branches are different assignments", () => {
	const session = nativeSession();
	const firstRequest = appendUser(session, "same text");
	const oldBranchEntry = session.appendCustomEntry("branch-marker");
	const first = currentAssignment(session);
	session.branch(firstRequest);
	session.appendCustomEntry("alternate-branch");
	const alternate = currentAssignment(session);
	assert.equal(alternate?.requestEntryId, firstRequest);
	assert.equal(sameAssignment(first!, alternate!), false);
	assert.notEqual(oldBranchEntry, alternate?.branchEntryIds.at(-1));
	appendUser(session, "same text");
	const followUp = currentAssignment(session);
	assert.notEqual(followUp?.requestEntryId, firstRequest);
	assert.equal(sameAssignment(alternate!, followUp!), false);
});
const valid = "## Status\ndone\n\n## Answer\nFound it.\n\n## Relevant paths\n`src/a.ts:1`\n\n## Uncertainty\nNone.";

type Handler = (event: never, context?: unknown) => unknown;
type StatusResponse = (requestId: unknown) => Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	return value as Record<string, unknown>;
}

type HookRegistry = Record<string, Handler> & { tools: Map<string, unknown> };

function hooks(env: Record<string, string | undefined>, statusResponse?: StatusResponse, structuredToolActive = false, workStatusOverrides: Record<string, unknown> = {}): HookRegistry {
	const session = nativeSession();
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, env);
	const registered = {} as HookRegistry;
	Object.defineProperty(registered, "tools", { value: new Map<string, unknown>() });
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const events = {
		on(channel: string, listener: (value: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set<(value: unknown) => void>();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
	};
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = record(value);
		if (request.operation === "work-status") {
			const payload = record(request.payload);
			assert.equal(typeof payload.sessionId, "string");
			const frame = statusResponse?.(request.request_id) ?? statusFrame(request.request_id, []);
			const result = frame.ok === true ? record(frame.result) : undefined;
			events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, result === undefined
				? { ...frame, operation: "work-status" }
				: workStatusFrame(request.request_id, payload.sessionId, result, workStatusOverrides));
			return;
		}
		assert.equal(request.operation, "status");
		assert.deepEqual(request.payload, {});
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, statusResponse?.(request.request_id) ?? {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
			request_id: request.request_id,
			operation: "status",
			ok: true,
			result: { tasks: [] },
		});
	});
	let lastContext: unknown;
	registerHandoffHooks({
		on: (name: string, handler: Handler) => {
			registered[name] = (event, context) => {
				if (context !== undefined) lastContext = context;
				if (context === undefined && (name === "tool_call" || name === "message_end")) {
					context = lastContext === undefined ? { sessionManager: session } : lastContext;
				}
				return handler(event, context);
			};
			return () => undefined;
		},
		registerTool: (tool: { name: string }) => registered.tools.set(tool.name, tool),
		getActiveTools: () => structuredToolActive ? ["submit_agent_result"] : [],
		events,
	} as never);
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, previous);
	return registered;
}

function message(text: string, stopReason = "stop", toolCall = false): never {
	return {
		role: "assistant",
		content: toolCall ? [{ type: "toolCall", id: "1", name: "read", arguments: "{}" }] : [{ type: "text", text }],
		stopReason,
	} as never;
}

function event(text: string, stopReason = "stop", toolCall = false): never {
	return { message: message(text, stopReason, toolCall) } as never;
}

type TaskStatus = "running" | "completed" | "failed" | "killed";

function backgroundTask(id: string, status: TaskStatus, name = id): Record<string, unknown> {
	return {
		id,
		name,
		command: "bun test",
		status,
		outputPath: `.pi/tasks/${id}.output`,
		cwd: "/repo",
		startTime: 1,
		...(status === "running" ? {} : { endTime: 2, exitCode: status === "completed" ? 0 : 1 }),
		bytesWritten: 0,
		isAgent: false,
		notified: status !== "running",
		notifyOnCompletion: true,
		triggerOnCompletion: true,
	};
}

function statusFrame(requestId: unknown, tasks: readonly unknown[]): Record<string, unknown> {
	return {
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
		request_id: requestId,
		operation: "status",
		ok: true,
		result: { tasks },
	};
}

function workStatusFrame(requestId: unknown, sessionId: unknown, result: Record<string, unknown> = { tasks: [] }, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: requestId, operation: "work-status", ok: true,
		result: {
			schema_version: "pi-background-tasks.work-status.v1", version: 1,
			sessionId, generation: "generation-1", revision: "a".repeat(64),
			activeAdmissions: 0, shuttingDown: false, taskAdmissionsClosed: false,
			terminalPublicationClosed: false, historyComplete: true, incompletenessReasons: [],
			...result,
			tasks: Array.isArray(result.tasks) ? result.tasks.map((value: unknown) => {
				const task = record(value);
				const running = task.status === "running";
				return { task, terminalPublicationState: running ? "pending" : "delivered",
					terminalPublished: !running, terminalPublishInFlight: false, terminalEmitInFlight: false,
					notificationInFlight: false, notificationState: task.notifyOnCompletion === false ? "not-requested" : running ? "pending" : "delivered" };
			}) : result.tasks,
			...overrides,
		},
	};
}

function eventBus() {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	return {
		on(channel: string, listener: (value: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
		emit(channel: string, value: unknown) { for (const listener of listeners.get(channel) ?? []) listener(value); },
	};
}

async function nativeExec(file: string, args: string[], options: Parameters<CandidateExec>[2]) {
	const childProcess = Bun.spawn([file, ...args], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited,
	]);
	return { code: code ?? -1, stdout, stderr, killed: false };
}

function attachFinalizerStatus(events: ReturnType<typeof eventBus>) {
	let verificationStarting = 0;
	for (const [requestChannel, responseChannel, owner] of [
		[VERIFICATION_STATUS_REQUEST, VERIFICATION_STATUS_RESPONSE, "verification"],
		[DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE, "delegation"],
	] as const) {
		events.on(requestChannel, (value) => {
			const request = record(value);
			events.emit(responseChannel, {
				version: 1, requestId: request.requestId, sessionId: request.sessionId, generation: `${owner}-generation`,
				...(owner === "verification" ? { starting: verificationStarting, uncollectedTaskIds: [] } : { revision: 1, runningChildIds: [], pendingResultIds: [] }),
			});
		});
	}
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = record(value);
		if (request.operation !== "work-status") return;
		const payload = record(request.payload);
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, workStatusFrame(request.request_id, payload.sessionId));
	});
	return (starting: number) => { verificationStarting = starting; };
}

it("finalizes a persisted successful worker result against its launch assignment", async () => {
	const directory = mkdtempSync(join(tmpdir(), "artifact-finalizer-"));
	const previousBinding = process.env[LAUNCH_BINDING_ENV];
	let session: SessionManager | undefined;
	try {
		session = SessionManager.create(directory, join(directory, "sessions"));
		const sessionFile = session.getSessionFile();
		assert.ok(sessionFile);
		appendUser(session, "fresh child assignment");
		const canonicalSessionFile = realpathSync(sessionFile);
		const assignment = currentAssignment(session);
		assert.ok(assignment);
		const candidate = await captureCandidateWithExec(nativeExec, process.cwd());
		const output = "finalizer proof output";
		const logPath = join(directory, "proof.log");
		writeFileSync(logPath, output, { mode: 0o600 });
		const proof = recordVerificationEvidence({
			command: "'bun' 'test' 'finalizer-proof'", argv: ["bun", "test", "finalizer-proof"], cwd: ".", candidate,
			exitCode: 0, logPath, logSha256: createHash("sha256").update(output).digest("hex"), valid: true,
		});
		const fields = {
			status: "done", objective: "Finalize fresh result", currentState: "The persisted worker completed.",
			decisions: [], proofIds: [proof.id], observationIds: [], notRun: [], nextSteps: [], doNot: [],
		};
		const rendered = renderResultSubmission("worker", fields);
		assert.deepEqual(rendered.errors, []);
		const finalAssistantEntryId = session.appendMessage({
			role: "assistant", content: [{ type: "text", text: rendered.text }], stopReason: "stop", timestamp: Date.now(),
		} as never);
		const finalAssignment = currentAssignment(session);
		assert.ok(finalAssignment);
		const submission = { version: 1 as const, schemaId: "worker" as const, assignment, fields };
		const binding = {
			parentSessionId: "parent-session", parentLeafIdAtLaunch: "parent-leaf", launchToolCallId: "launch-call",
			childId: "child-1", incarnationId: "incarnation-1", canonicalSessionFile, entryFloor: 1,
		};
		process.env[LAUNCH_BINDING_ENV] = JSON.stringify(binding);
		const events = eventBus();
		const setVerificationStarting = attachFinalizerStatus(events);
		const entries: Array<{ type: string; data: unknown }> = [];
		const handlers = new Map<string, (event: never, context?: never) => unknown>();
		const pi = {
			events,
			on(name: string, handler: (event: never, context?: never) => unknown) { handlers.set(name, handler); },
			appendEntry(type: string, data: unknown) { entries.push({ type, data }); session!.appendCustomEntry(type, data); },
			exec: nativeExec,
		};
		registerResultFinalizer(pi as never, () => ({ assignment, submission, activeVerificationCalls: 0 }));
		const context = { cwd: process.cwd(), sessionManager: session };
		handlers.get("session_start")?.({} as never, context as never);
		let response: Record<string, unknown> | undefined;
		events.on(FINALIZE_RESULT_RESPONSE, (value) => { response = record(value); });
		events.emit(FINALIZE_RESULT_REQUEST, {
			version: 1, requestId: "finalize-1", childSessionId: session.getSessionId(), incarnationId: binding.incarnationId,
			expectedLeafId: finalAssistantEntryId, context,
		});
		assert.ok(response, "the root must synchronously provide the correlated finalization capability");
		const result = await (response.finalize as () => Promise<Record<string, unknown>>)();
		assert.equal(result.state, "finalized", JSON.stringify(result));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].type, FINALIZED_RESULT_ENTRY);
		const envelope = record(entries[0].data);
		assert.equal(envelope.finalAssistantEntryId, finalAssistantEntryId);
		assert.deepEqual(envelope.assignment, finalAssignment, "the envelope binds the final assistant's actual ancestry");
		assert.deepEqual(envelope.proofs, [proof]);
		assert.ok(readFileSync(sessionFile, "utf8").includes(FINALIZED_RESULT_ENTRY));

		const requestFinalize = async (incarnationId: string, expectedLeafId: string) => {
			response = undefined;
			events.emit(FINALIZE_RESULT_REQUEST, {
				version: 1, requestId: `retry-${incarnationId}`, childSessionId: session!.getSessionId(), incarnationId,
				expectedLeafId, context,
			});
			assert.ok(response);
			return (response.finalize as () => Promise<Record<string, unknown>>)();
		};
		const afterSuccess = session.getLeafId();
		assert.equal((await requestFinalize("wrong-incarnation", afterSuccess!)).state, "unavailable", "a different launch incarnation cannot reuse the capability");
		assert.equal((await requestFinalize(binding.incarnationId, "not-the-current-leaf")).state, "unavailable", "a different leaf cannot finalize the assignment");
		assert.equal(entries.length, 1, "rejected finalization must not append an entry");

		process.env[LAUNCH_BINDING_ENV] = JSON.stringify({ ...binding, entryFloor: 100 });
		const inherited = await requestFinalize(binding.incarnationId, afterSuccess!);
		assert.equal(inherited.state, "unavailable", "an inherited request before the launch floor cannot be finalized");
		assert.match(String(inherited.reason), /inherited request/);
		process.env[LAUNCH_BINDING_ENV] = JSON.stringify(binding);

		setVerificationStarting(1);
		const pending = await requestFinalize(binding.incarnationId, afterSuccess!);
		assert.equal(pending.state, "unavailable", "registering verification work must prevent finalization");
		assert.match(String(pending.reason), /verification.*pending/i);
		assert.equal(entries.length, 1);
		setVerificationStarting(0);

		writeFileSync(logPath, "tampered after successful finalization");
		const tamperedLog = await requestFinalize(binding.incarnationId, afterSuccess!);
		assert.equal(tamperedLog.state, "unavailable", "a changed proof log cannot support another finalization");
		assert.match(String(tamperedLog.reason), /log hash|log.*changed/i);
		assert.equal(entries.length, 1);
	} finally {
		if (previousBinding === undefined) delete process.env[LAUNCH_BINDING_ENV];
		else process.env[LAUNCH_BINDING_ENV] = previousBinding;
		rmSync(directory, { recursive: true, force: true });
	}
});

async function runGit(directory: string, ...args: string[]): Promise<string> {
	const childProcess = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited,
	]);
	assert.equal(code, 0, stderr);
	return stdout.trim();
}

const PUBLICATION_CLEARANCE_QUERY = "pi-guardrails:publication-clearance:query:v1";
const PUBLICATION_CLEARANCE_RECORD = "pi-guardrails:publication-clearance:record:v1";
const PUBLICATION_CLEARANCE_DIAGNOSE = "pi-guardrails:publication-clearance:diagnose:v1";
const PUBLICATION_CLEARANCE_DIAGNOSIS = "pi-guardrails:publication-clearance:diagnosis:v1";

it("seals current postcommit evidence, permits reads, and revokes on failure, source change, or restart", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "artifact-seal-")));
	const logDirectory = mkdtempSync(join(tmpdir(), "artifact-seal-logs-"));
	try {
		await runGit(directory, "init", "--quiet", "-b", "fixture");
		await runGit(directory, "remote", "add", "origin", "https://example.test/owner/repo.git");
		await runGit(directory, "config", "user.email", "seal@example.test");
		await runGit(directory, "config", "user.name", "Seal test");
		writeFileSync(join(directory, "source.txt"), "committed source\n");
		writeFileSync(join(directory, ".gitignore"), "/runtime-input.json\n/notes.md\n");
		await runGit(directory, "add", "source.txt", ".gitignore");
		await runGit(directory, "commit", "--quiet", "-m", "base");
		const inputPath = join(directory, "runtime-input.json");
		const inputBytes = "pinned runtime input\n";
		writeFileSync(inputPath, inputBytes);
		const runtimeSnapshot = await createStagedSnapshot(nativeExec, directory, ".", ["runtime-input.json"]);
		const runtimeInput = runtimeSnapshot.runtimeInputs[0];
		runtimeSnapshot.cleanup();
		assert.ok(runtimeInput, "the repository-relative ignored input must produce a manifest pin");
		const candidate = await captureCandidateWithExec(nativeExec, directory);
		const evidenceCandidate = createCandidateIdentity({
			repositoryRoot: candidate.repositoryRoot, head: candidate.head, tree: candidate.tree, kind: candidate.kind, source: "staged",
			runtimeInputs: [runtimeInput],
		});
		const output = "successful current proof";
		const logPath = join(logDirectory, "proof.log");
		writeFileSync(logPath, output, { mode: 0o600 });
		const proofInput = {
			command: "'bun' 'test' 'seal'", argv: ["bun", "test", "seal"], cwd: ".", candidate: evidenceCandidate,
			exitCode: 0, logPath, logSha256: createHash("sha256").update(output).digest("hex"), valid: true,
		};
		const session = nativeSession();
		appendUser(session, "authorize local seal fixture");
		const context = { cwd: directory, sessionManager: session };
		const events = eventBus();
		const backgroundGeneration = "generation-1";
		let backgroundRevision = "a".repeat(64);
		let backgroundOverrides: Record<string, unknown> = {};
		let verificationOverrides: Record<string, unknown> = {};
		let delegationOverrides: Record<string, unknown> = {};
		let backgroundReplies = 1;
		events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
			const request = record(value);
			if (request.operation === "work-status") for (let reply = 0; reply < backgroundReplies; reply++) {
				events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, workStatusFrame(request.request_id, record(request.payload).sessionId, { tasks: [] }, { generation: backgroundGeneration, revision: backgroundRevision, ...backgroundOverrides }));
			}
		});
		for (const [requestChannel, responseChannel, owner] of [
			[VERIFICATION_STATUS_REQUEST, VERIFICATION_STATUS_RESPONSE, "verification"],
			[DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE, "delegation"],
		] as const) {
			events.on(requestChannel, (value) => {
				const request = record(value);
				events.emit(responseChannel, {
					version: 1, requestId: request.requestId, sessionId: request.sessionId, generation: `${owner}-generation`,
					...(owner === "verification" ? { starting: 0, uncollectedTaskIds: [], ...verificationOverrides } : { revision: 1, runningChildIds: [], pendingResultIds: [], ...delegationOverrides }),
				});
			});
		}
		const registered = new Map<string, (event: never, ctx: never) => unknown>();
		let availableTools = ["verification_evidence", "publication_clearance"];
		type ClearanceTool = { execute: (id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown> };
		let clearanceTool: ClearanceTool | undefined;
		const pi = {
			events, exec: nativeExec,
			getAllTools() { return availableTools.map((name) => ({ name })); },
			on(name: string, handler: (event: never, ctx: never) => unknown) { registered.set(name, handler); },
			registerTool(tool: unknown) { clearanceTool = tool as ClearanceTool; },
		};
		const childMarkers = ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"];
		const savedMarkers = childMarkers.map((key) => [key, process.env[key]] as const);
		for (const key of childMarkers) delete process.env[key];
		registerPublicationClearance(pi as never);
		for (const [key, value] of savedMarkers) if (value !== undefined) process.env[key] = value;
		registered.get("session_start")?.({} as never, context as never);
		assert.ok(clearanceTool);
		registered.get("tool_call")?.({ toolName: "verification_evidence", toolCallId: "background-start", input: { operation: "start" } } as never, context as never);
		const backgroundCommand = "'bun' 'test' 'background-before-inspection'";
		const backgroundAttempt = beginVerificationAttempt(directory, backgroundCommand, ".");
		registered.get("tool_result")?.({ toolName: "verification_evidence", toolCallId: "background-start", details: { protocolVersion: 2, operation: "start", taskId: "background-proof" } } as never, context as never);
		registered.get("tool_call")?.({ toolName: "bash", toolCallId: "background-inspection", input: { command: "git status --porcelain=v1" } } as never, context as never);
		await runGit(directory, "status", "--porcelain=v1");
		registered.get("tool_result")?.({ toolName: "bash", toolCallId: "background-inspection" } as never, context as never);
		registered.get("tool_call")?.({ toolName: "verification_evidence", toolCallId: "background-collect", input: { operation: "collect", taskId: "background-proof" } } as never, context as never);
		const backgroundProof = recordVerificationEvidence({ ...proofInput, command: backgroundCommand }, backgroundAttempt);
		registered.get("tool_result")?.({ toolName: "verification_evidence", toolCallId: "background-collect", details: { protocolVersion: 2, operation: "collect", state: "collected", evidence: backgroundProof } } as never, context as never);
		assert.equal(backgroundProof.valid, true, "unrelated parent tool activity must not invalidate a background receipt");
		assert.deepEqual(verificationEvidenceErrors(backgroundProof.id), []);
		await assert.rejects(clearanceTool.execute("old-background-proof", { tier: "Direct", evidenceIds: [backgroundProof.id], lanes: [], adjudication: "A reportable receipt is not necessarily fresh publication proof." }, undefined, undefined, context), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /fresh|activity/);
			assert.match(error.message, /background-inspection/, "freshness recovery must identify the actual invalidating tool call");
			return true;
		});
		registered.get("tool_call")?.({ toolName: "verification_evidence", toolCallId: "primary-proof", input: { operation: "run" } } as never, context as never);
		const proof = recordVerificationEvidence(proofInput);
		registered.get("tool_result")?.({ toolName: "verification_evidence", toolCallId: "primary-proof", details: { protocolVersion: 2, operation: "run", evidence: proof } } as never, context as never);
		await clearanceTool.execute("seal", { tier: "Direct", evidenceIds: [proof.id], lanes: [], adjudication: "Local acceptance fixture." }, undefined, undefined, context);
		const queryRecord = (overrides: Record<string, unknown> = {}) => {
			const records: Record<string, unknown>[] = [];
			const off = events.on(PUBLICATION_CLEARANCE_RECORD, (value) => records.push(record(value)));
			events.emit(PUBLICATION_CLEARANCE_QUERY, {
				version: 1, requestId: "query-v1", sessionId: session.getSessionId(), repositoryRoot: candidate.repositoryRoot,
				candidateSha: candidate.head, pushUrl: "https://example.test/owner/repo.git", branch: "fixture", ...overrides,
			});
			off();
			return records;
		};
		const query = () => queryRecord()[0];
		const diagnosis = (overrides: Record<string, unknown> = {}) => {
			const replies: Record<string, unknown>[] = [];
			const off = events.on(PUBLICATION_CLEARANCE_DIAGNOSIS, (value) => replies.push(record(value)));
			events.emit(PUBLICATION_CLEARANCE_DIAGNOSE, {
				version: 1, requestId: "diagnosis-v1", sessionId: session.getSessionId(), repositoryRoot: candidate.repositoryRoot,
				candidateSha: candidate.head, pushUrl: "https://example.test/owner/repo.git", branch: "fixture", ...overrides,
			});
			off();
			return replies;
		};
		const firstRecord = queryRecord();
		assert.equal(firstRecord.length, 1, "the real seal answers synchronously");
		const firstSeal = record(firstRecord[0]);
		assert.deepEqual(firstSeal.evidenceIds instanceof Array, true);
		assert.ok(Number.isFinite(firstSeal.clearedAt));
		assert.deepEqual(queryRecord()[0], firstSeal, "same-seal record and timestamp stay stable");
		assert.deepEqual(diagnosis(), [], "a valid current seal needs no diagnostic response");
		assert.equal(diagnosis({ branch: "another-branch" })[0]?.state, "binding_mismatch", "a wrong branch needs a binding diagnosis rather than silence");
		const mismatch = diagnosis({ candidateSha: "f".repeat(40) })[0];
		assert.equal(mismatch?.state, "binding_mismatch");
		assert.deepEqual(Object.keys(mismatch ?? {}).sort(), ["branch", "candidateSha", "nextStep", "pushUrl", "reason", "repositoryRoot", "requestId", "sessionId", "state", "version"].sort());
		assert.match(String(mismatch?.nextStep), /exact sealed sessionId.*single effective origin push URL.*do not rerun checks/i);
		assert.equal(queryRecord().length, 1, "diagnosis must not alter or issue authorization records");
		writeFileSync(logPath, "tampered proof log");
		const stale = diagnosis()[0];
		assert.equal(stale?.state, "stale_seal");
		assert.match(String(stale?.reason), /proof receipt.*proof log/i);
		assert.match(String(stale?.nextStep), /verification_evidence\(\{operation:"capture"\}\).*argv.*cwd.*timeout.*taskId.*evidenceIds.*lanes.*adjudication.*another session/s);
		assert.match(String(stale?.nextStep), /capture creates no evidenceId.*operation:"start".*operation:"collect".*successful evidenceId.*publication_clearance.*correctness-primary.*live-success/s);
		assert.match(String(stale?.nextStep), /Focused.*correctness-primary.*live-success.*Full.*correctness-counterpart.*live-attack/s);
		assert.equal(queryRecord().length, 0, "proof-log bytes are revalidated synchronously");
		writeFileSync(logPath, output);
		await runGit(directory, "read-tree", "--empty");
		assert.equal(queryRecord().length, 0, "index drift denies otherwise unchanged source");
		await runGit(directory, "read-tree", "HEAD");
		assert.deepEqual(queryRecord({ requestId: "final-query" })[0], { ...firstSeal, requestId: "final-query" }, "the gate can requery the same seal with a fresh request ID");
		registered.get("tool_call")?.({ toolName: "verification_evidence", toolCallId: "active-check", input: { operation: "capture" } } as never, context as never);
		assert.equal(queryRecord().length, 0, "active verification calls deny synchronous clearance");
		registered.get("tool_result")?.({ toolName: "verification_evidence", toolCallId: "active-check" } as never, context as never);
		await runGit(directory, "remote", "set-url", "--push", "origin", "https://example.test/changed/repo.git");
		assert.equal(queryRecord().length, 0, "effective target drift denies the original query");
		await runGit(directory, "remote", "set-url", "--push", "origin", "https://example.test/owner/repo.git");
		await runGit(directory, "remote", "set-url", "--add", "--push", "origin", "https://example.test/other/repo.git");
		assert.equal(queryRecord().length, 0, "multiple effective push targets deny clearance");
		await runGit(directory, "config", "--unset-all", "remote.origin.pushurl");
		for (const overrides of [
			{ activeAdmissions: 1 },
			{ historyComplete: false, incompletenessReasons: ["history_pruned"] },
			{ generation: "replacement-background-owner" },
			{ version: 2 },
		]) {
			backgroundOverrides = overrides;
			assert.equal(queryRecord().length, 0, `background currentness denies ${JSON.stringify(overrides)}`);
		}
		backgroundOverrides = {};
		for (const replies of [0, 2]) {
			backgroundReplies = replies;
			assert.equal(queryRecord().length, 0, "missing or competing background owners deny clearance");
		}
		backgroundReplies = 1;
		for (const overrides of [{ starting: 1 }, { uncollectedTaskIds: ["uncollected"] }, { generation: "replacement-verification-owner" }]) {
			verificationOverrides = overrides;
			assert.equal(queryRecord().length, 0, `verification currentness denies ${JSON.stringify(overrides)}`);
		}
		verificationOverrides = {};
		for (const overrides of [{ runningChildIds: ["running"] }, { pendingResultIds: ["pending"] }, { revision: 2 }, { generation: "replacement-delegation-owner" }]) {
			delegationOverrides = overrides;
			assert.equal(queryRecord().length, 0, `delegation currentness denies ${JSON.stringify(overrides)}`);
		}
		delegationOverrides = {};
		backgroundRevision = "b".repeat(64);
		assert.equal(queryRecord().length, 0, "changed background service revision revokes the seal");
		backgroundRevision = "a".repeat(64);
		assert.deepEqual(queryRecord()[0], firstSeal, "restoring identical service state retains the seal");
		assert.equal(queryRecord({ candidateSha: "f".repeat(40) }).length, 0, "wrong candidate binding receives no record");
		assert.equal(queryRecord({ sessionId: "another-session" }).length, 0, "foreign sessions receive no record");
		assert.equal(queryRecord({ repositoryRoot: logDirectory }).length, 0, "foreign roots receive no record");
		assert.equal(queryRecord({ branch: "another-branch" }).length, 0, "foreign branches receive no record");
		assert.equal(queryRecord({ requestId: "" }).length, 0, "empty request identifiers receive no record");
		assert.equal(queryRecord({ version: 2 }).length, 0, "unknown versions receive no record");
		assert.equal(queryRecord({ pushUrl: "" }).length, 0, "empty targets receive no record");
		assert.equal(queryRecord({ pushUrl: "https://example.test/other/repo.git" }).length, 0, "wrong exact targets receive no record");
		assert.equal(queryRecord({ extra: true }).length, 0, "malformed closed query receives no record");
		registered.get("tool_call")?.({ toolName: "bash", toolCallId: "inspection", input: { command: "git status --porcelain=v1" } } as never, context as never);
		await runGit(directory, "status", "--porcelain=v1");
		registered.get("tool_result")?.({ toolName: "bash", toolCallId: "inspection" } as never, context as never);
		assert.deepEqual(verificationEvidenceErrors(proof.id), [], "publication must not change ordinary parent receipt freshness");
		assert.ok(await query(), "read-only Git inspection must not revoke the seal");
		writeFileSync(inputPath, "changed runtime input\n");
		const changedPin = diagnosis()[0];
		assert.equal(changedPin?.state, "stale_seal");
		assert.match(String(changedPin?.reason), /runtime input pin changed/i);
		assert.equal(await query(), undefined, "a pinned ignored input mutation must make the seal unavailable");
		assert.equal(queryRecord().length, 0, "synchronous currentness rechecks ignored input pins");
		writeFileSync(inputPath, inputBytes);
		assert.ok(await query(), "restoring the exact pinned input preserves the seal identity");

		recordVerificationEvidence({
			command: proof.command, argv: proof.argv, cwd: proof.cwd, candidate: evidenceCandidate, exitCode: 1, logPath,
			logSha256: createHash("sha256").update(output).digest("hex"), valid: true,
		});
		assert.equal(await query(), undefined, "a superseding failed check must revoke the seal");
		assert.equal(queryRecord().length, 0, "synchronous currentness rejects superseded successful evidence");

		const repairedOutput = "fresh post-failure proof";
		const repairedLog = join(logDirectory, "repaired-proof.log");
		writeFileSync(repairedLog, repairedOutput, { mode: 0o600 });
		registered.get("tool_call")?.({ toolName: "verification_evidence", toolCallId: "repaired-proof", input: { operation: "run" } } as never, context as never);
		const repairedProof = recordVerificationEvidence({
			command: "'bun' 'test' 'seal-repaired'", argv: ["bun", "test", "seal-repaired"], cwd: ".", candidate: evidenceCandidate,
			exitCode: 0, logPath: repairedLog, logSha256: createHash("sha256").update(repairedOutput).digest("hex"), valid: true,
		});
		registered.get("tool_result")?.({ toolName: "verification_evidence", toolCallId: "repaired-proof", details: { protocolVersion: 2, operation: "run", evidence: repairedProof } } as never, context as never);
		await clearanceTool.execute("reseal", { tier: "Direct", evidenceIds: [repairedProof.id], lanes: [], adjudication: "Local acceptance fixture." }, undefined, undefined, context);
		assert.ok(await query(), "fresh successful evidence must permit a replacement seal");
		const replacementRecord = record(queryRecord()[0]);
		assert.notDeepEqual(replacementRecord.evidenceIds, firstSeal.evidenceIds, "a replacement seal gets distinct opaque evidence references");
		assert.notEqual(replacementRecord.clearedAt, undefined, "a replacement seal has its own stable clearing time");
		const slots = ["correctness-primary", "correctness-counterpart", "live-success", "live-attack"] as const;
		await assert.rejects(clearanceTool.execute("focused-policy", { tier: "Focused", evidenceIds: [repairedProof.id], lanes: [], adjudication: "Focused requires primary review and live success." }, undefined, undefined, context), /required: correctness-primary, live-success;/);
		const selections = slots.map((slot, index) => ({ slot, childId: `child-${index}`, incarnationId: `invocation-${index}` }));
		const parentLeaf = session.getLeafId();
		assert.ok(parentLeaf);
		registered.get("tool_call")?.({ toolName: "subagent", toolCallId: "lane-launch" } as never, context as never);
		registered.get("tool_result")?.({ toolName: "subagent", toolCallId: "lane-launch", isError: false, details: { children: selections.map(({ childId }) => ({ id: childId })) } } as never, context as never);
		let resultGeneration = "result-owner-generation";
		const resolved = selections.map((selection, index) => {
			const review = selection.slot.startsWith("correctness");
			const fields = review
				? { status: "done", verdict: "APPROVE", scope: "Frozen fixture source", critical: [], important: [], niceToHave: [], outOfScope: [] }
				: { status: "done", objective: "Independent fixture proof", currentState: "Verified frozen fixture source", decisions: [], proofIds: [repairedProof.id], observationIds: [], notRun: [], nextSteps: [], doNot: [] };
			const envelope = { version: 1, launchBinding: { parentSessionId: session.getSessionId(), parentLeafIdAtLaunch: parentLeaf, launchToolCallId: "lane-launch", childId: selection.childId,
				incarnationId: selection.incarnationId, canonicalSessionFile: `/fixture/child-${index}.jsonl`, entryFloor: 1 }, rootGeneration: `child-generation-${index}`,
				assignment: { sessionId: `child-session-${index}`, requestEntryId: `request-${index}`, branchEntryIds: [`request-${index}`, `assistant-${index}`] }, finalAssistantEntryId: `assistant-${index}`,
				resultSchemaId: review ? "review" : "worker", validatedFields: fields, renderedSha256: "a".repeat(64), candidate,
				inputPins: review ? [] : [runtimeInput], proofs: review ? [] : [repairedProof] };
			const ref = { state: "finalized", entryId: `finalization-${index}`, envelopeSha256: createHash("sha256").update(JSON.stringify(envelope)).digest("hex"),
				childSessionId: envelope.assignment.sessionId, rootGeneration: envelope.rootGeneration, incarnationId: selection.incarnationId };
			return { selection, envelope, ref };
		});
		let laneReply: (reply: Record<string, unknown>) => unknown[] = (reply) => [reply];
		events.on(DELEGATION_RESULT_REQUEST, (value) => {
			const request = record(value);
			const result = resolved.find(({ selection }) => selection.childId === request.childId);
			if (result) for (const reply of laneReply({ ...request, generation: resultGeneration, revision: 1, state: "completed", status: "completed", launchBinding: result.envelope.launchBinding, envelope: result.envelope, ref: result.ref })) {
				events.emit(DELEGATION_RESULT_RESPONSE, reply);
			}
		});
		for (const scenario of [
			{ name: "missing provider", replies: () => [], expected: /no delegation result response.*Recovery:.*extension/s },
			{ name: "duplicate providers", replies: (reply: Record<string, unknown>) => [reply, reply], expected: /2 delegation result responses.*Recovery:.*extension/s },
			{ name: "running", replies: (reply: Record<string, unknown>) => [{ ...reply, state: "running" }], expected: /state="running".*Recovery:.*Wait/s },
			{ name: "missing", replies: (reply: Record<string, unknown>) => [{ ...reply, state: "missing" }], expected: /state="missing".*Recovery:.*Publication lane/s },
			{ name: "unavailable", replies: (reply: Record<string, unknown>) => [{ ...reply, state: "unavailable", reason: "No current finalized result for this invocation." }], expected: /state="unavailable".*No current finalized result.*Recovery:.*finalized/s },
			{ name: "wrong child", replies: (reply: Record<string, unknown>) => [{ ...reply, childId: "other-child" }], expected: /childId mismatch.*Recovery:.*extension/s },
			{ name: "wrong incarnation", replies: (reply: Record<string, unknown>) => [{ ...reply, incarnationId: "old-invocation" }], expected: /incarnationId mismatch.*Recovery:.*extension/s },
			{ name: "invalid revision", replies: (reply: Record<string, unknown>) => [{ ...reply, revision: -1 }], expected: /revision.*Recovery:.*extension/s },
			{ name: "failed status", replies: (reply: Record<string, unknown>) => [{ ...reply, status: "failed" }], expected: /status="failed".*Recovery:.*worker/s },
			{ name: "extra fields", replies: (reply: Record<string, unknown>) => [{ ...reply, unexpected: true }], expected: /completed response fields.*Recovery:.*extension/s },
		]) {
			laneReply = scenario.replies;
			await assert.rejects(clearanceTool.execute(`diagnose-${scenario.name}`, { tier: "Full", evidenceIds: [repairedProof.id], lanes: selections, adjudication: "Diagnose a rejected lane without replacing passing proof." }, undefined, undefined, context), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /correctness-primary.*child-0.*invocation-0/s, scenario.name);
				assert.match(error.message, scenario.expected, scenario.name);
				return true;
			});
			assert.equal(queryRecord().length, 0, `${scenario.name} must not authorize publication`);
			assert.deepEqual(verificationEvidenceErrors(repairedProof.id), [], `${scenario.name} must preserve unchanged verification`);
		}
		const recoverable = diagnosis()[0];
		assert.equal(recoverable?.state, "missing_seal");
		assert.ok(String(recoverable?.nextStep).includes(repairedProof.id), "missing seal recovery must reuse known fresh proof rather than rerun passing checks");
		laneReply = (reply) => [reply];
		await assert.rejects(clearanceTool.execute("missing-full-counterpart", { tier: "Full", evidenceIds: [repairedProof.id], lanes: [selections[0], selections[2], selections[3]], adjudication: "Full still requires the counterpart review." }, undefined, undefined, context), /required: correctness-primary, correctness-counterpart, live-success, live-attack; missing: correctness-counterpart/);
		await assert.rejects(clearanceTool.execute("missing-lane", { tier: "Full", evidenceIds: [repairedProof.id], lanes: selections.slice(0, 3), adjudication: "Missing attack lane." }, undefined, undefined, context), /complete distinct selected lanes/);
		await clearanceTool.execute("joined-lanes", { tier: "Full", evidenceIds: [repairedProof.id], lanes: selections, adjudication: "All four owner-bound fixture lanes approved." }, undefined, undefined, context);
		assert.ok(await query(), "complete authoritative lane results must join the parent seal");
		assert.equal(queryRecord().length, 1, "authoritative fixture lane validation also answers the synchronous contract");
		const focusedSeal = record(await clearanceTool.execute("focused-policy", { tier: "Focused", evidenceIds: [repairedProof.id], lanes: [selections[0], selections[2]], adjudication: "Approved Focused policy requires primary review and live success." }, undefined, undefined, context));
		assert.equal(record(focusedSeal.details).laneCount, 2);
		assert.ok(await query(), "Focused clearance accepts primary and live-success lanes without a counterpart");
		registered.get("tool_call")?.({ toolName: "write", toolCallId: "parent-notes", input: { path: join(directory, "notes.md"), content: "Review disposition recorded.\n" } } as never, context as never);
		writeFileSync(join(directory, "notes.md"), "Review disposition recorded.\n");
		registered.get("tool_result")?.({ toolName: "write", toolCallId: "parent-notes" } as never, context as never);
		assert.deepEqual(verificationEvidenceErrors(repairedProof.id), []);
		assert.ok(await query(), "ignored parent notes must preserve finalized child results with unchanged source and input pins");
		resultGeneration = "restarted-result-owner";
		assert.equal(await query(), undefined, "a replaced result-owner generation cannot authorize an existing seal");
		assert.equal(queryRecord().length, 0, "synchronous currentness rejects changed lane ownership");
		registered.get("tool_call")?.({ toolName: "verification_evidence", toolCallId: "source-control-proof", input: { operation: "run" } } as never, context as never);
		registered.get("tool_result")?.({ toolName: "verification_evidence", toolCallId: "source-control-proof", details: { protocolVersion: 2, operation: "run", evidence: repairedProof } } as never, context as never);
		await clearanceTool.execute("source-control", { tier: "Direct", evidenceIds: [repairedProof.id], lanes: [], adjudication: "Isolate the source mutation control." }, undefined, undefined, context);
		assert.ok(await query());
		writeFileSync(join(directory, "source.txt"), "mutated after seal\n");
		assert.equal(await query(), undefined, "a source mutation must make the frozen candidate unavailable");
		assert.equal(queryRecord().length, 0, "synchronous currentness recaptures source bytes");

		registered.get("session_start")?.({} as never, context as never);
		assert.equal(await query(), undefined, "session restart must discard process-local publication authority");
		assert.equal(queryRecord().length, 0, "synchronous records cannot survive session restart");
		availableTools = ["publication_clearance"];
		const missingSeal = diagnosis()[0];
		assert.equal(missingSeal?.state, "missing_seal", "diagnosis identifies an absent session-local seal");
		assert.match(String(missingSeal?.nextStep), /verification_evidence is not registered.*operator/i);
		assert.doesNotMatch(String(missingSeal?.nextStep), /operation:"start"/);
		assert.ok(getVerificationEvidence(repairedProof.id), "session restart must not erase ordinary receipt history");
		await assert.rejects(clearanceTool.execute("replay-prior-proof", { tier: "Direct", evidenceIds: [repairedProof.id], lanes: [], adjudication: "A restarted owner needs fresh publication proof." }, undefined, undefined, context), /fresh|activity/);
		appendUser(session, "a new parent assignment");
		registered.get("agent_start")?.({} as never, context as never);
		assert.ok(getVerificationEvidence(repairedProof.id), "a new parent assignment must not erase ordinary receipts");
	} finally {
		rmSync(directory, { recursive: true, force: true });
		rmSync(logDirectory, { recursive: true, force: true });
	}
}, 30_000);

test("publication proof rejects a reportable nonzero result instead of trusting valid", () => {
	const check: unknown = (publicationClearance as Readonly<Record<string, unknown>>).publicationEvidenceErrors;
	assert.equal(typeof check, "function", "publication must validate successful proof at its owner");
	if (typeof check !== "function") throw new Error("publication evidence validator unavailable");
	const run = evidence("'false'", 1);
	assert.equal(run.valid, true);
	assert.match(check([run.id], run.candidate).join("; "), /nonzero|exit 1/);
});

test("publication proof rejects evidence from another candidate", () => {
	const check: unknown = (publicationClearance as Readonly<Record<string, unknown>>).publicationEvidenceErrors;
	assert.equal(typeof check, "function", "publication must validate candidate binding at its owner");
	if (typeof check !== "function") throw new Error("publication evidence validator unavailable");
	const run = evidence("'true'");
	const other = createCandidateIdentity({ repositoryRoot: "/other", head: "a".repeat(40), tree: "b".repeat(40), kind: "clean" });
	assert.match(check([run.id], other).join("; "), /candidate/);
});

test("selects schemas and does nothing outside children or for null schemas", () => {
	assert.equal(replySchema({}), null);
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "code-explorer" }), "explorer");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "code-reviewer" }), "review");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "implementation-engineer" }), "worker");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "live-verifier" }), "worker");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "other" }), "worker");
	assert.deepEqual(hooks({}), {});
});

it.each(["code-reviewer", "code-reviewer-sonnet", "code-reviewer-sol", "code-reviewer-opus"])("selects the same review contract for counterpart %s", (agent) => {
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: agent }), "review");
});

test("appends the template without dropping the prior prompt", () => {
	const registered = hooks(child, undefined, true);
	const start = { systemPromptOptions: { appendSystemPrompt: "Prior instructions" } } as never;
	registered.before_agent_start(start);
	assert.match((start as { systemPromptOptions: { appendSystemPrompt: string } }).systemPromptOptions.appendSystemPrompt, /^Prior instructions\n\n/);
	assert.match((start as { systemPromptOptions: { appendSystemPrompt: string } }).systemPromptOptions.appendSystemPrompt, /Template:/);
	assert.equal(replyInstructions("explorer").includes(renderTemplate("explorer")), true);
	assert.match(replyInstructions("explorer"), /submit_agent_result/);
	assert.match(replyInstructions("explorer"), /recorded, not delivered/i);

	const unset = { systemPromptOptions: {} as { appendSystemPrompt?: string } };
	registered.before_agent_start(unset as never);
	assert.equal(unset.systemPromptOptions.appendSystemPrompt, replyInstructions("explorer"));
});

it.each(["caller_ping", "subagent_done"])("%s rejects an admission before a task exists instead of falling back to legacy emptiness", async (toolName) => {
	const registered = hooks(worker, (requestId) => statusFrame(requestId, []), false, { activeAdmissions: 1 });
	const result = await registered.tool_call({ toolName, toolCallId: "registering", input: {} } as never) as { block?: boolean; reason?: string } | undefined;
	assert.equal(result?.block, true);
	assert.match(result.reason ?? "", /background.*admission/i);
});

it.each([
	{ historyComplete: false, incompletenessReasons: ["history_pruned"] },
	{ taskAdmissionsClosed: true, historyComplete: false, incompletenessReasons: ["task_admissions_closed"] },
])("final replies reject incomplete background history %j", async (overrides) => {
	const registered = hooks(child, undefined, false, overrides);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { continue?: boolean; entries?: Array<{ content: string }> } | undefined;
	assert.equal(correction?.continue, true);
	assert.match(correction.entries?.[0].content ?? "", /background.*(?:incomplete|closed)/i);
});

it.each([
	{ terminalPublicationState: "pending" },
	{ terminalPublicationState: "abandoned", terminalPublished: false },
	{ terminalPublished: "unknown" },
	{ terminalPublishInFlight: true },
	{ terminalEmitInFlight: "unknown" },
	{ notificationInFlight: true },
	{ notificationState: "pending" },
	{ notificationState: "unknown" },
])("closing waits for terminal reconciliation %j", async (overrides) => {
	const entry = { task: backgroundTask("unsettled", "completed"), terminalPublicationState: "delivered",
		terminalPublished: true, terminalPublishInFlight: false, terminalEmitInFlight: false,
		notificationInFlight: false, notificationState: "delivered", ...overrides };
	const registered = hooks(worker, undefined, false, { tasks: [entry] });
	const result = await registered.tool_call({ toolName: "caller_ping", toolCallId: "terminal-pending", input: {} } as never) as { block?: boolean; reason?: string } | undefined;
	assert.equal(result?.block, true);
	assert.match(result.reason ?? "", /terminal results not settled.*unsettled/);
});

it.each(["completed", "failed", "killed"] as const)("settled %s jobs remain truthfully reportable without requested notification", async (status) => {
	const registered = hooks(worker, (requestId) => statusFrame(requestId, [
		{ ...backgroundTask("settled", status), notifyOnCompletion: false, notified: false },
	]));
	assert.equal(await registered.tool_call({ toolName: "caller_ping", toolCallId: "settled", input: {} } as never), undefined);
});

test("closing without a background owner session fails closed", async () => {
	const registered = hooks(worker);
	const result = await registered.tool_call({ toolName: "caller_ping", toolCallId: "missing-owner", input: {} } as never, {}) as { block?: boolean; reason?: string } | undefined;
	assert.equal(result?.block, true);
	assert.match(result.reason ?? "", /session|owner/i);
});

test("valid replies query status once while invalid and non-final replies do not", async () => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		requests++;
		return statusFrame(requestId, []);
	});
	registered.agent_start({} as never);
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(requests, 1);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(await registered.message_end(event("bad", "stop", true)), undefined);
	assert.equal(await registered.message_end(event("bad", "aborted")), undefined);
	assert.equal(await registered.message_end(event("bad", "error")), undefined);
	assert.equal(requests, 1);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("does not register or query background status outside child environments", () => {
	let requests = 0;
	assert.deepEqual(hooks({}, () => {
		requests++;
		return statusFrame("unused", []);
	}), {});
	assert.equal(requests, 0);
});

it.each(["caller_ping", "subagent_done"])("reliability: exit tool %s cannot abandon running work", async (toolName) => {
	const registered = hooks(worker, (requestId) => statusFrame(requestId, [backgroundTask("owned-job", "running")]));
	registered.agent_start({} as never);
	const result = await registered.tool_call({ toolName, toolCallId: "premature-exit", input: {} } as never) as { block: boolean; reason: string } | undefined;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /owned-job/);
	assert.match(result?.reason ?? "", /collect|cancel/i);
});

it.each(["caller_ping", "subagent_done"])("reliability: %s waits for an in-flight verification call before its task exists", async (toolName) => {
	const registered = hooks(worker);
	await registered.tool_call({ toolName: "verification_evidence", toolCallId: "registering-call", input: { operation: "start", argv: ["true"], cwd: ".", timeout: 10 } } as never);
	const blocked = await registered.tool_call({ toolName, toolCallId: "racing-close", input: {} } as never) as { block: boolean; reason: string } | undefined;
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /verification tool calls still running/);
	registered.tool_result({ toolName: "verification_evidence", toolCallId: "registering-call", input: {}, content: [], isError: true } as never);
	assert.equal(await registered.tool_call({ toolName, toolCallId: "settled-close", input: {} } as never), undefined);
});

it.each(["caller_ping", "subagent_done"])("reliability: exit tool %s remains available after terminal ordinary work", async (toolName) => {
	const registered = hooks(worker, (requestId) => statusFrame(requestId, [backgroundTask("owned-job", "completed")]));
	registered.agent_start({} as never);
	assert.equal(await registered.tool_call({ toolName, toolCallId: "safe-exit", input: {} } as never), undefined);
});

test("reliability: exit tools fail closed when work ownership cannot be queried", async () => {
	const registered = hooks(worker, (requestId) => ({
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: requestId, operation: "status", ok: false, error: "owner unavailable",
	}));
	const result = await registered.tool_call({ toolName: "caller_ping", toolCallId: "unknown-owner", input: {} } as never) as { block: boolean; reason: string } | undefined;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /owner unavailable/);
});

test("running child jobs reject through the correction lifecycle", async () => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		requests++;
		return statusFrame(requestId, [backgroundTask("job-running", "running", "Build")]);
	});
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
	assert.equal(correction.continue, true);
	assert.match(correction.entries[0].content, /background tasks still running: job-running \(Build\)/);
	assert.equal(requests, 1);
});

test.each(["completed", "failed", "killed"] as const)("terminal child job status %s permits the reply", async (status) => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		requests++;
		return statusFrame(requestId, [backgroundTask(`job-${status}`, status)]);
	});
	registered.agent_start({} as never);
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(requests, 1);
});

test("a corrected reply succeeds after running work becomes terminal", async () => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		const tasks = requests++ === 0 ? [backgroundTask("job-1", "running")] : [backgroundTask("job-1", "completed")];
		return statusFrame(requestId, tasks);
	});
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	assert.notEqual(registered.turn_end({} as never), undefined);
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(requests, 2);
});

test("multiple running jobs produce bounded deterministic validation text", async () => {
	const registered = hooks(child, (requestId) => statusFrame(requestId, [
		backgroundTask("job-6", "running", "Six"),
		backgroundTask("job-2", "running", "Two"),
		backgroundTask("job-4", "running", "Four"),
		backgroundTask("job-1", "running", "One"),
		backgroundTask("job-5", "running", "Five"),
		backgroundTask("job-3", "running", "Three"),
	]));
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /background tasks still running: job-1 \(One\), job-2 \(Two\), job-3 \(Three\), job-4 \(Four\), job-5 \(Five\), and 1 more/);
	assert.doesNotMatch(correction.entries[0].content, /job-6 \(Six\)/);
});

test("status service failures fail closed through correction", async () => {
	const registered = hooks(child, (requestId) => ({
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
		request_id: requestId,
		operation: "status",
		ok: false,
		error: "service unavailable",
	}));
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /background task status check failed: .*service unavailable/);
});

test("malformed status responses fail closed through correction", async () => {
	const registered = hooks(child, (requestId) => ({
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
		request_id: requestId,
		operation: "status",
		ok: true,
		result: { tasks: "malformed" },
	}));
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /background task status check failed: .*must be an array/);
});

test.each([
	["explorer", child, valid],
	["review", { PI_SUBAGENT_AGENT: "code-reviewer" }, "bad"],
	["worker", worker, "bad"],
] as const)("exhausted %s corrections deliver a valid actionable terminal handoff", async (schema, env, rejectedReply) => {
	const registered = hooks(env);
	registered.agent_start({} as never);
	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await registered.message_end(event("bad")), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
		assert.equal(correction.continue, true);
		assert.match(correction.entries[0].content, /Validation errors:/);
	}
	const original = `${rejectedReply}\n\n## Status\nfailed\n\n\`\`\`\`\nmalicious embedded boundary`;
	const replacement = await registered.message_end(event(original)) as { message: { content: Array<{ text: string }> } };
	const terminal = replacement.message.content[0].text;
	assert.equal(validate(schema, terminal).ok, true, terminal);
	assert.match(terminal, /## Status\nfailed/);
	assert.match(terminal, /validated|unclosed fenced code block|missing section/i);
	assert.match(terminal, /Not run:|Unable to|rejected reply/i);
	assert.match(terminal, /\`\`\`\`\`\n[\s\S]*## Status[\s\S]*malicious embedded boundary\n\`\`\`\`\`/);
	if (schema === "review") assert.match(terminal, /## Verdict\nREJECT/);
	if (schema === "worker") assert.match(terminal, /## Verified by\n- Not run:/);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("a valid reply on the third correction is accepted", async () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await registered.message_end(event("bad")), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean };
		assert.equal(correction.continue, true);
	}
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("agent_start preserves same-assignment evidence across retries", () => {
	const registered = hooks(worker);
	const branch = [{ type: "message", id: "request-1", parentId: null, message: { role: "user", content: [] } }];
	const context = { sessionManager: { getSessionId: () => "session-1", getBranch: () => branch } };
	registered.agent_start({} as never, context);
	const run = evidence("'bun' 'test'");
	registered.agent_start({} as never, context);
	assert.deepEqual(verifiedByErrors(workerReply(run.verifiedBy ?? "")), []);
});

test("a distinct identical-text request invalidates prior assignment evidence", () => {
	const registered = hooks(worker);
	const firstBranch = [{ type: "message", id: "request-1", parentId: null, message: { role: "user", content: [{ type: "text", text: "same" }] } }];
	const firstContext = { sessionManager: { getSessionId: () => "session-1", getBranch: () => firstBranch } };
	registered.agent_start({} as never, firstContext);
	const run = evidence("'bun' 'test'");
	const nextBranch = [...firstBranch, { type: "message", id: "request-2", parentId: "request-1", message: { role: "user", content: [{ type: "text", text: "same" }] } }];
	const nextContext = { sessionManager: { getSessionId: () => "session-1", getBranch: () => nextBranch } };
	registered.agent_start({} as never, nextContext);
	assert.match(verifiedByErrors(workerReply(run.verifiedBy ?? "")).join("\n"), /was not found in this session/);
});

test("stale evidence recovery requires fresh proof instead of another formatting attempt", () => {
	const text = correctionMessage(["Verified by: evidence is stale: bash tool activity completed after verification"], "worker");
	assert.match(text, /cannot refresh stale evidence/);
	assert.match(text, /fresh verification/);
	assert.match(text, /Current state/);
	assert.match(text, /Not run/);
	assert.match(text, /evidence\.verifiedBy/);
	assert.match(failureReport(["stale"], "bad", "worker"), /after 3 correction attempts/);
});

test("pure report helpers include all errors", () => {
	assert.match(correctionMessage(["one", "two"], "worker"), /- one\n- two/);
	assert.match(failureReport(["one"], "reply", "explorer"), /Rejected reply \(untrusted\):\n```\nreply\n```/);
});

const workerReply = (item: string) =>
	`## Status\ndone\n\n## Objective\nX\n\n## Current state\nY\n\n## Key decisions\nNone.\n\n## Verified by\n${item}\n\n## Next steps\nNone.\n\n## Do not\nNone.`;
const evidenceRoot = mkdtempSync(join(tmpdir(), "artifact-handoff-evidence-"));
let evidenceSequence = 0;
const candidate = createCandidateIdentity({ repositoryRoot: "/repo", head: "a".repeat(40), tree: "b".repeat(40), kind: "dirty" });
function evidence(command: string, exitCode = 0) {
	const output = `output ${evidenceSequence}`;
	const logPath = join(evidenceRoot, `${evidenceSequence++}.log`);
	writeFileSync(logPath, output, { mode: 0o600 });
	chmodSync(logPath, 0o600);
	return recordVerificationEvidence({
		command,
		argv: ["bun", "test"],
		cwd: ".",
		candidate,
		exitCode,
		logPath,
		logSha256: createHash("sha256").update(output).digest("hex"),
		valid: true,
	});
}
afterAll(() => rmSync(evidenceRoot, { recursive: true, force: true }));

type SubmitTool = {
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, context: unknown) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: unknown;
	}>;
};

function submissionContext(requestId: string, branch: readonly unknown[] = [{
	type: "message", id: requestId, parentId: null, message: { role: "user", content: [{ type: "text", text: "same request" }] },
}]) {
	return { sessionManager: { getSessionId: () => "session-1", getBranch: () => branch } };
}

it("rejects semantic text that breaks the rendered review document contract", () => {
	const result = renderResultSubmission("review", {
		status: "done", verdict: "APPROVE", scope: "## Status",
		critical: [], important: [], niceToHave: [], outOfScope: [],
	});
	assert.ok(result.errors.length > 0, "a duplicate heading must not be accepted as semantic text");
	assert.equal(result.text, "");
});

it.each([false, true])("a length-limited structured final validates its submission (submitted=%s)", async (submitted) => {
	const registered = hooks(worker, undefined, true);
	const context = submissionContext("request-length");
	registered.agent_start({} as never, context);
	if (submitted) {
		const tool = registered.tools.get("submit_agent_result") as unknown as SubmitTool;
		await tool.execute("submit-length", {
			status: "done", objective: "Length-limited result", currentState: "Recorded semantic result.",
			decisions: [], proofIds: [], observationIds: [], notRun: ["No check required by this fixture."], nextSteps: [], doNot: [],
		}, undefined, undefined, context);
	}
	const replacement = await registered.message_end(event("Unvalidated truncated prose", "length"), context) as { message: { content: Array<{ text: string }> } } | undefined;
	if (submitted) {
		assert.ok(replacement, "a recorded submission must render even when final prose reaches its token limit");
		assert.equal(validate("worker", replacement.message.content[0].text).ok, true);
		assert.doesNotMatch(replacement.message.content[0].text, /Unvalidated truncated prose/);
	} else {
		assert.equal(replacement, undefined);
		assert.equal((registered.turn_end({} as never) as { continue?: boolean } | undefined)?.continue, true, "a missing submission must enter correction rather than bypass validation");
	}
});

it("records structured data and replaces prose with a revalidated deterministic final", async () => {
	const registered = hooks(worker, undefined, true);
	const context = submissionContext("request-1");
	registered.agent_start({} as never, context);
	const proof = evidence("'bun' 'test'", 0);
	const observation = evidence("'bun' 'test' 'negative-control'", 1);
	const tool = registered.tools.get("submit_agent_result") as unknown as SubmitTool;
	const result = await tool.execute("submit-1", {
		status: "failed",
		objective: "Report the failed check",
		currentState: "The expected negative was observed.",
		decisions: [],
		proofIds: [proof.id],
		observationIds: [observation.id],
		notRun: [],
		nextSteps: [],
		doNot: [],
	}, undefined, undefined, context);
	assert.match(result.content[0].text, /Recorded, not delivered/);
	const replacement = await registered.message_end(event("model-authored markdown is ignored"), context) as { message: { content: Array<{ text: string }> } };
	const report = replacement.message.content[0].text;
	assert.equal(validate("worker", report).ok, true, report);
	assert.ok(proof.verifiedBy);
	assert.ok(report.includes(proof.verifiedBy));
	const verifiedSection = report.split("## Verified by\n")[1]?.split("\n## Next steps")[0] ?? "";
	assert.doesNotMatch(verifiedSection, new RegExp(observation.id));
	assert.ok(report.includes(`Observation \`${observation.id}\`: current, exit 1`));
	assert.doesNotMatch(report, /model-authored markdown/);
});

it("replaces and persists the final report through the native extension runner and session manager", async () => {
	const directory = mkdtempSync(join(tmpdir(), "artifact-handoff-native-"));
	const previousRole = process.env.PI_SUBAGENT_AGENT;
	process.env.PI_SUBAGENT_AGENT = "implementation-engineer";
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			extensionFactories: [(pi) => {
				pi.events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
					const request = record(value);
					pi.events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, workStatusFrame(request.request_id, record(request.payload).sessionId));
				});
				registerHandoffHooks(pi);
			}],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
		const created = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			resourceLoader,
			settingsManager,
			modelRuntime,
			sessionManager: SessionManager.inMemory(directory),
			tools: ["read", "bash", "edit", "write", "submit_agent_result"],
		});
		session = created.session;
		const runner = session.extensionRunner;
		assert.ok(runner);
		assert.ok(runner.getActiveTools().includes("submit_agent_result"));
		const requestId = session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "native scripted request" }], timestamp: Date.now() });
		await runner.emit({ type: "agent_start", prompt: "native scripted request", messageType: "user" } as never);
		const passed = evidence("'bun' 'test'", 0);
		const definition = runner.getToolDefinition("submit_agent_result");
		assert.ok(definition);
		const result = await definition.execute("native-submit", {
			status: "done", objective: "Native replacement", currentState: "Persisted by the session manager.",
			decisions: [], proofIds: [passed.id], observationIds: [], notRun: [], nextSteps: [], doNot: [],
		}, undefined, undefined, runner.createToolContext("native-submit", undefined));
		assert.notEqual(result.isError, true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Recorded, not delivered/);
		session.sessionManager.appendMessage({
			role: "toolResult", toolCallId: "native-submit", toolName: "submit_agent_result", content: result.content,
			isError: result.isError, timestamp: Date.now(), details: result.details,
		} as never);
		await session.bindExtensions({});
		const finalMessage = message("ignored model prose");
		const replaced = await runner.emitMessageEnd({ type: "message_end", message: finalMessage } as never);
		assert.ok(replaced);
		const persistedId = session.sessionManager.appendMessage(replaced as never);
		const persisted = session.sessionManager.getEntry(persistedId);
		assert.equal(persisted?.type, "message");
		if (persisted?.type !== "message" || persisted.message.role !== "assistant") throw new Error("native final message was not persisted");
		const rendered = persisted.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		assert.equal(validate("worker", rendered).ok, true, rendered);
		assert.match(rendered, /Native replacement/);
		assert.doesNotMatch(rendered, /ignored model prose/);
		assert.ok(session.sessionManager.getBranch().some((entry) => entry.id === requestId));

		const abandonedProof = evidence("'bun' 'test' 'abandoned-branch'");
		const abandonedResult = await definition.execute("native-branch-submit", {
			status: "done", objective: "Abandoned native branch", currentState: "Must not survive navigation.",
			decisions: [], proofIds: [abandonedProof.id], observationIds: [], notRun: [], nextSteps: [], doNot: [],
		}, undefined, undefined, runner.createToolContext("native-branch-submit", undefined));
		session.sessionManager.appendMessage({
			role: "toolResult", toolCallId: "native-branch-submit", toolName: "submit_agent_result", content: abandonedResult.content,
			isError: abandonedResult.isError, timestamp: Date.now(), details: abandonedResult.details,
		} as never);
		const navigation = await session.navigateTree(persistedId, { summarize: false });
		assert.equal(navigation.cancelled, false);
		assert.match(verifiedByErrors(workerReply(abandonedProof.verifiedBy ?? "")).join("\n"), /was not found in this session/);
		assert.equal(await runner.emitMessageEnd({ type: "message_end", message: message("ignored after navigation") } as never), undefined);
	} finally {
		session?.dispose();
		if (previousRole === undefined) delete process.env.PI_SUBAGENT_AGENT;
		else process.env.PI_SUBAGENT_AGENT = previousRole;
		rmSync(directory, { recursive: true, force: true });
	}
});

it("rejects unknown fields, oversized text, and foreign evidence IDs at structured submission", async () => {
	const registered = hooks(worker, undefined, true);
	const context = submissionContext("request-unknown");
	registered.agent_start({} as never, context);
	const tool = registered.tools.get("submit_agent_result") as unknown as SubmitTool;
	const fields = {
		status: "done", objective: "X", currentState: "Y", decisions: [], proofIds: [`verify_${"f".repeat(64)}`],
		observationIds: [], notRun: [], nextSteps: [], doNot: [],
	};
	await assert.rejects(() => tool.execute("submit-1", { ...fields, invented: "field" }, undefined, undefined, context), /unknown field: invented/);
	await assert.rejects(() => tool.execute("submit-2", { ...fields, currentState: "x".repeat(8001) }, undefined, undefined, context), /currentState: expected non-empty single-line prose/);
	await assert.rejects(() => tool.execute("submit-3", fields, undefined, undefined, context), /was not found in this child session/);
});

it.each(["'node' '-e' 'console.log(`ok`)'", "'printf' 'first\nsecond'"])("receipt-generated claims round-trip command %j", async (command) => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence(command);
	assert.ok(run.verifiedBy, "valid receipts supply a ready-to-copy handoff item");
	assert.equal(run.verifiedBy.split("\n").length, 1, "multiline commands cannot break the handoff list");
	assert.equal((run.verifiedBy.match(/`/g) ?? []).length, 2, "command backticks cannot break the Markdown span");
	const reply = workerReply(run.verifiedBy);
	assert.equal(validate("worker", reply).ok, true, reply);
	assert.deepEqual(verifiedByErrors(reply), []);
	assert.equal(await registered.message_end(event(reply)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
});

it.each(["command-json: {", "command-json: 42", "command-json: [\"wrong\"]"])("malformed encoded receipt command fails closed: %s", (command) => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test'");
	assert.match(verifiedByErrors(workerReply(`- \`${command}\` → exit 0 [evidence: ${run.id}]`)).join("\n"), /invalid encoded command/);
});

test("receipt-generated claims still reject later Bash activity", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test'");
	assert.ok(run.verifiedBy);
	registered.tool_call({ toolName: "bash", toolCallId: "inspect", input: {} } as never);
	registered.tool_result({ toolName: "bash", toolCallId: "inspect", content: [], isError: false } as never);
	assert.match(verifiedByErrors(workerReply(run.verifiedBy)).join("\n"), /stale: bash tool activity completed/);
});

test("Verified by must match current evidence exactly", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test' 'tests/'");
	assert.equal(await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(await registered.message_end(event(workerReply("- Not run: no time"))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);

	await registered.message_end(event(workerReply(`- \`'pnpm' 'typecheck'\` → exit 0 [evidence: ${run.id}]`)));
	let correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /command does not match evidence/);

	await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 1 [evidence: ${run.id}]`)));
	correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /reported exit 1, evidence recorded 0/);
});

test("exhausted command mismatches retain the blocker without accepting the original claim", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test' 'tests/'");
	const rejected = workerReply(`- \`'python3' '-c' 'illustrative shorthand'\` → exit 0 [evidence: ${run.id}]`);
	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await registered.message_end(event(rejected)), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
		assert.equal(correction.continue, true);
		assert.match(correction.entries[0].content, /reported command does not match evidence/);
	}
	const replacement = await registered.message_end(event(rejected)) as { message: { content: Array<{ text: string }> } };
	const terminal = replacement.message.content[0].text;
	assert.equal(validate("worker", terminal).ok, true, terminal);
	assert.deepEqual(verifiedByErrors(terminal), [], "fenced rejected claims are not current verification");
	assert.match(terminal, /reported command does not match evidence/);
	assert.match(terminal, /## Status\nfailed/);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("unavailable review coverage does not manufacture a product finding", () => {
	const terminal = failureReport(["missing section"], "bad", "review");
	assert.equal(validate("review", terminal).ok, true, terminal);
	assert.match(terminal, /## Verdict\nREJECT/);
	assert.match(terminal, /## Important \(P1\)\nNone\./);
	assert.match(terminal, /provide|corrected/i);
});

test("indented Verified by claims still require current evidence", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`   - \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`)
		.replace("\n## Verified by\n", "\n   ## Verified by\n");
	await registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("fenced Verified by headings cannot hide the real evidence section", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`- \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`)
		.replace("## Key decisions\nNone.", "## Key decisions\n```md\n## Verified by\n- Not run: example\n```");
	await registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("CRLF Verified by claims still require current evidence", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`- \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`).replaceAll("\n", "\r\n");
	await registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("verification evidence resets at agent_start", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test'");
	registered.agent_start({} as never);
	await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
	assert.notEqual(registered.turn_end({} as never), undefined);
});

test("write-capable tool activity after a check invalidates its evidence", async () => {
	for (const toolName of ["bash", "edit", "write"]) {
		const registered = hooks(worker);
		registered.agent_start({} as never);
		const run = evidence(`'bun' 'test' '${toolName}'`);
		registered.tool_call({ toolName, toolCallId: toolName, input: {} } as never);
		await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
		const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
		assert.match(correction.entries[0].content, new RegExp(`stale: ${toolName} tool activity`));
	}
});

test("overlapping write-capable tools invalidate evidence when they finish", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	registered.tool_call({ toolName: "bash", toolCallId: "overlap", input: {} } as never);
	const run = evidence("'bun' 'test' 'overlap'");
	registered.tool_result({ toolName: "bash", toolCallId: "overlap", input: {}, content: [], isError: false } as never);
	await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /stale: bash tool activity completed/);
});

test("non-worker schemas ignore Verified by", async () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	assert.equal(await registered.message_end(event(valid + "\n\n## Verified by\n- `nope` → exit 0")), undefined);
});

test("raw or masked Bash claims are rejected without evidence", async () => {
	for (const item of ["- `bun test tests/` → exit 0", "- `bun test tests/ || true` → exit 0", "- `bun test tests/ | tail -5` → exit 0"]) {
		const registered = hooks(worker);
		registered.agent_start({} as never);
		await registered.message_end(event(workerReply(item)));
		const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
		assert.match(correction.entries[0].content, /expected item matching/);
	}
});
