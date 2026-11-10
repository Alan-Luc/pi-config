import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
	SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import artifactContracts from "../extensions/artifact-contracts/index.ts";
import {
	BACKGROUND_TASK_REQUEST_CHANNEL, BACKGROUND_TASK_RESPONSE_CHANNEL, BACKGROUND_TASK_RESPONSE_SCHEMA,
} from "../extensions/artifact-contracts/background-tasks.ts";
import { currentAssignment } from "../extensions/artifact-contracts/assignment.ts";
import { renderResultSubmission } from "../extensions/artifact-contracts/result-submission.ts";
import {
	DELEGATION_RESULT_REQUEST, DELEGATION_RESULT_RESPONSE, FINALIZE_RESULT_REQUEST, FINALIZE_RESULT_RESPONSE,
	FINALIZED_RESULT_ENTRY, LAUNCH_BINDING_ENV, PUBLICATION_CLEARANCE_QUERY, PUBLICATION_CLEARANCE_RECORD,
} from "../extensions/artifact-contracts/publication-clearance.ts";
import { DELEGATION_STATUS_REQUEST, DELEGATION_STATUS_RESPONSE } from "../extensions/lib/work-status.ts";

const PACKAGE_ROOT = resolve(process.env.PI_GUARDRAILS_TEST_ROOT ?? join(import.meta.dir, "../git/github.com/Alan-Luc/pi-guardrails"));
const PACKAGE_COMMIT = "9d0549e55e3f0b8835b925c589e73e97678b7dd9";
const SDK_ROOT = resolve(process.env.PI_MIGRATION_SDK_ROOT ?? join(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent"));
const BRANCH = "alan/ENG-native-migration";
const PUSH_URL = "https://gitlab.example.test/group/project.git";
const PROJECT_API = "https://gitlab.example.test/api/v4/projects/group%2Fproject";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type NativeSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolCall(session: NativeSession, id: string, name: string): void {
	session.agent.state.messages.push({
		role: "assistant", api: "openai-completions", provider: "openai", model: "guardrails-migration-test",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now(),
	});
}

async function runNativeChild(args: {
	workspace: string; repo: string; agentDir: string; packageRoot: string; parentSessionId: string;
	parentLeafId: string; launchToolCallId: string; slot: string; agent: string; name: string;
	task: string; childId: string; incarnationId: string;
}): Promise<Record<string, unknown>> {
	const markerKeys = ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE", LAUNCH_BINDING_ENV];
	const previous = new Map(markerKeys.map((key) => [key, process.env[key]]));
	const sessionDir = join(args.workspace, "sessions", args.childId);
	let child: NativeSession | undefined;
	try {
		process.env.PI_SUBAGENT_AGENT = args.agent;
		process.env.PI_SUBAGENT_PARENT_SESSION = args.parentSessionId;
		process.env.PI_SUBAGENT_NAME = args.name;
		process.env.PI_SUBAGENT_SESSION = args.childId;
		process.env.PI_SUBAGENT_SURFACE = "native-acceptance-fixture";
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		settings.setPackages([args.packageRoot]);
		const loader = new DefaultResourceLoader({
			cwd: args.repo, agentDir: args.agentDir, settingsManager: settings,
			extensionFactories: [artifactContracts, (pi) => {
				pi.events.on(DELEGATION_STATUS_REQUEST, (value) => {
					if (isRecord(value)) pi.events.emit(DELEGATION_STATUS_RESPONSE, { version: 1, requestId: value.requestId, sessionId: value.sessionId, generation: "native-child-delegation", revision: 1, runningChildIds: [], pendingResultIds: [] });
				});
				pi.events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
					if (!isRecord(value) || value.operation !== "work-status" || !isRecord(value.payload)) return;
					pi.events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, { schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: value.request_id, operation: "work-status", ok: true, result: { schema_version: "pi-background-tasks.work-status.v1", version: 1, sessionId: value.payload.sessionId, generation: "native-child-background", revision: "b".repeat(64), activeAdmissions: 0, shuttingDown: false, taskAdmissionsClosed: false, terminalPublicationClosed: false, historyComplete: true, incompletenessReasons: [], tasks: [] } });
				});
				pi.registerTool({ name: "migration_dispatch", label: "Native child dispatch", description: "Dispatch a native Pi tool in this child session.", parameters: Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }), async execute(id, params, _signal, _update, context) {
					const outcome = await context.executeTool(params.tool, params.args);
					return { content: outcome.result.content, details: outcome.result.structuredContent ?? outcome.result.details, isError: outcome.isError };
				} });
				pi.registerTool({ name: "finalize_native_child", label: "Finalize native child", description: "Request the native result finalizer and return its persisted result.", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, context) {
					const binding = JSON.parse(process.env[LAUNCH_BINDING_ENV] ?? "null");
					const replies: unknown[] = [];
					const off = pi.events.on(FINALIZE_RESULT_RESPONSE, (reply) => replies.push(reply));
					const request = { version: 1, requestId: randomUUID(), childSessionId: context.sessionManager.getSessionId(), incarnationId: args.incarnationId, expectedLeafId: context.sessionManager.getLeafId(), context };
					try { pi.events.emit(FINALIZE_RESULT_REQUEST, request); } finally { off(); }
					if (replies.length !== 1 || !isRecord(replies[0]) || typeof replies[0].finalize !== "function") throw new Error("native finalization capability did not respond");
					const ref = await (replies[0].finalize as () => Promise<unknown>)();
					const sessionFile = context.sessionManager.getSessionFile();
					if (!sessionFile) throw new Error("child session has no persisted file");
					const persisted = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
					const finalizedEntry = persisted.find((entry) => isRecord(entry) && entry.customType === FINALIZED_RESULT_ENTRY);
					if (!isRecord(finalizedEntry) || !isRecord(finalizedEntry.data)) {
						console.log("native finalizer response", JSON.stringify(ref), persisted.filter(isRecord).map((entry) => ({ type: entry.type, customType: entry.customType })));
						throw new Error("native finalized entry was not persisted");
					}
					return { content: [{ type: "text", text: "Native child result finalized." }], details: { ref, envelope: finalizedEntry.data, launchBinding: binding } };
				} });
			}], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: join(args.workspace, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
		const manager = SessionManager.create(args.repo, sessionDir);
		const requestEntryId = manager.appendMessage({ role: "user", content: [{ type: "text", text: args.task }], timestamp: Date.now() });
		const created = await createAgentSession({ cwd: args.repo, agentDir: args.agentDir, resourceLoader: loader, settingsManager: settings, modelRuntime, sessionManager: manager, tools: ["bash", "verification_evidence", "submit_agent_result", "migration_dispatch", "finalize_native_child"] });
		child = created.session;
		await child.bindExtensions({});
		const runner = child.extensionRunner;
		if (!runner) throw new Error("native child extension runner unavailable");
		const dispatch = runner.getToolDefinition("migration_dispatch");
		if (!dispatch) throw new Error("native child dispatch tool unavailable");
		const execute = async (id: string, tool: string, args: Record<string, unknown>) => {
			toolCall(child!, id, dispatch.name);
			return dispatch.execute(id, { tool, args }, undefined, undefined, runner.createToolContext(id, undefined));
		};
		const review = args.agent.startsWith("code-reviewer");
		let proofIds: string[] = [];
		if (!review) {
			const proof = await execute(`proof-${args.childId}`, "verification_evidence", { operation: "run", argv: ["true"], cwd: ".", timeout: 30 });
			if (proof.isError || !isRecord(proof.details) || !isRecord(proof.details.evidence) || typeof proof.details.evidence.id !== "string") throw new Error(`native child verification did not return structured evidence: ${JSON.stringify({ isError: proof.isError, details: proof.details, content: proof.content })}`);
			proofIds = [proof.details.evidence.id];
		}
		const schemaId = review ? "review" : "worker";
		const fields: Record<string, unknown> = review
			? { status: "done", verdict: "APPROVE", scope: "Frozen native acceptance candidate", critical: [], important: [], niceToHave: [], outOfScope: [] }
			: { status: "done", objective: `Independent proof for ${args.name}`, currentState: "Verified the frozen candidate with native evidence.", decisions: [], proofIds, observationIds: [], notRun: [], nextSteps: [], doNot: [] };
		const submitted = await execute(`submit-${args.childId}`, "submit_agent_result", fields);
		if (submitted.isError) throw new Error("native result submission failed: " + submitted.content.map((block) => block.type === "text" ? block.text : "").join(" "));
		const rendered = renderResultSubmission(schemaId, fields);
		if (rendered.errors.length > 0) throw new Error(`native result rendering rejected submission: ${rendered.errors.join("; ")}`);
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: rendered.text }], stopReason: "stop", timestamp: Date.now() } as never);
		const assignment = currentAssignment(manager);
		const sessionFile = manager.getSessionFile();
		if (!assignment || !sessionFile) throw new Error("native child assignment or session file missing");
		const lines = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const entryFloor = lines.findIndex((entry) => isRecord(entry) && entry.id === requestEntryId);
		if (entryFloor < 0) throw new Error("child request entry missing from persisted session");
		const binding = { parentSessionId: args.parentSessionId, parentLeafIdAtLaunch: args.parentLeafId, launchToolCallId: args.launchToolCallId, childId: args.childId, incarnationId: args.incarnationId, canonicalSessionFile: await realpath(sessionFile), entryFloor };
		process.env[LAUNCH_BINDING_ENV] = JSON.stringify(binding);
		const id = `finalize-${args.childId}`;
		const outcome = await execute(id, "finalize_native_child", {});
		if (outcome.isError || !isRecord(outcome.details)) throw new Error("native child finalizer failed: " + outcome.content.map((block) => block.type === "text" ? block.text : "").join(" "));
		return outcome.details;
	} finally {
		child?.dispose();
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("native Pi joins the pinned guard with real artifact clearance and finalized Full lanes", { timeout: 90_000 }, async () => {
	const packageFiles = ["package.json", "extensions/guardrails/index.ts", "extensions/guardrails/guardrails.ts", "extensions/guardrails/clearance.ts", "extensions/guardrails/publication.ts", "extensions/guardrails/publication-runtime.ts", "extensions/guardrails/refusal.ts", "extensions/guardrails/directory-policy.ts", "extensions/guardrails/directory-runtime.ts", "extensions/guardrails/personal-identity.ts", "extensions/lib/shared.ts"];
	const sdkFiles = ["package.json", "dist/core/sdk.js", "dist/extensions/codemode/index.js", "dist/extensions/codemode/tool.js", "dist/extensions/codemode/execute.js", "dist/extensions/codemode/execute.lazy.js", "dist/extensions/codemode/worker.js"];
	const inputManifest = async (root: string, files: string[]) => Promise.all(files.map(async (file) => [file, hash(await readFile(join(root, file)))]));
	expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim()).toBe(PACKAGE_COMMIT);
	const configRoot = resolve(import.meta.dir, "..");
	const configFiles: string[] = [];
	for (const directory of ["extensions/artifact-contracts", "extensions/lib"]) {
		for (const file of await readdir(join(configRoot, directory))) if (file.endsWith(".ts")) configFiles.push(`${directory}/${file}`);
	}
	const inputsBefore = { package: await inputManifest(PACKAGE_ROOT, packageFiles), sdk: await inputManifest(SDK_ROOT, sdkFiles),
		config: await inputManifest(configRoot, configFiles), probe: hash(await readFile(import.meta.filename)) };
	const evidenceRoot = await mkdtemp(join(tmpdir(), "joined-guardrails-evidence-"));
	const workspace = await mkdtemp(join(tmpdir(), "guardrails-migration-native-"));
	const repo = join(workspace, "repo");
	const agentDir = join(workspace, "agent");
	const shimDir = join(workspace, "bin");
	const scannerPath = join(workspace, "scanner");
	const scannerConfigPath = join(workspace, "scanner-config.json");
	const scannerLog = join(workspace, "scanner-input.log");
	const pushLog = join(workspace, "push.log");
	const grantPath = join(workspace, "publication-grant.json");
	const previousEnv = new Map(["PATH", "PI_PUBLICATION_CONFIG_PATH", "FIXTURE_TOKEN", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"].map((key) => [key, process.env[key]]));
	const previousFetch = globalThis.fetch;
	const providerRequests: string[] = [];
	const queries: Record<string, unknown>[] = [];
	const records: Record<string, unknown>[] = [];
	const laneResults = new Map<string, Record<string, unknown>>();
	let laneGeneration = "native-fixture-result-owner";
	let revokeAfterQuery: number | undefined;
	let revocationApplied = false;
	let session: NativeSession | undefined;
	try {
		for (const key of ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"]) delete process.env[key];
		await Promise.all([mkdir(repo), mkdir(agentDir), mkdir(shimDir)]);
		const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const git = (...args: string[]) => execFileSync(gitPath, args, { cwd: repo, encoding: "utf8" }).trim();
		git("init", "--quiet", "-b", BRANCH);
		git("config", "user.email", "migration-test@example.test");
		git("config", "user.name", "Native Migration Test");
		await writeFile(join(repo, "tracked.txt"), "base\n");
		git("add", "tracked.txt");
		git("commit", "--quiet", "-m", "base");
		const baseSha = git("rev-parse", "HEAD");
		await writeFile(join(repo, "tracked.txt"), "approved change\n");
		git("add", "tracked.txt");
		git("commit", "--quiet", "-m", "approved change");
		const candidateSha = git("rev-parse", "HEAD");
		const refsBefore = git("show-ref");
		const canonicalRepo = await realpath(repo);
		git("remote", "add", "origin", PUSH_URL);
		await writeFile(join(shimDir, "git"), `#!/bin/sh\nif [ "$1" = ls-remote ]; then [ "$2" = --refs ] && [ "$3" = '${PUSH_URL}' ] || exit 71; printf '%s\\t%s\\n' '${baseSha}' 'refs/heads/${BRANCH}'; exit 0; fi\nif [ "$1" = push ]; then printf '%s\\n' "$*" >> '${pushLog}'; exit 0; fi\nexec '${gitPath}' "$@"\n`, { mode: 0o700 });
		const scannerConfig = JSON.stringify({ rules: ["fixture-secret-marker"] }) + "\n";
		await writeFile(scannerConfigPath, scannerConfig);
		const scannerProgram = `#!/usr/bin/env node\nconst fs=require('node:fs');let input='';if(process.argv.slice(2).join(' ')==='version --short'){console.log('fixture-scanner-1');process.exit(0)}process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(scannerLog)},input+'\\n---blob---\\n');if(process.argv.slice(2).join(' ')!=='scan --json')process.exit(71);console.log(input.includes('FIXTURE_SECRET_MARKER')?'[{}]':'[]')});\n`;
		await writeFile(scannerPath, scannerProgram, { mode: 0o700 });
		const configSha256 = hash(scannerConfig);
		const scanner = {
			executable: scannerPath, argv: ["scan", "--json"], versionArgv: ["version", "--short"], version: "fixture-scanner-1",
			configPath: scannerConfigPath, configSha256,
			scannerId: hash(JSON.stringify({ executable: hash(scannerProgram), argv: ["scan", "--json"], versionArgv: ["version", "--short"], version: "fixture-scanner-1", protocol: "stdin-blob-json-findings-array-v1", configPath: scannerConfigPath, configSha256 })),
		};
		await writeFile(grantPath, JSON.stringify({ version: 2, enabled: true, maxCommits: 8, targets: [{ provider: "gitlab", host: "https://gitlab.example.test", project: "group/project", pushUrl: PUSH_URL, branchPattern: "alan/ENG-*", tokenEnv: "FIXTURE_TOKEN" }], scanner }));
		process.env.PI_PUBLICATION_CONFIG_PATH = grantPath;
		process.env.FIXTURE_TOKEN = "synthetic-fixture-token";
		process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			providerRequests.push(`${init?.method ?? "GET"} ${url}`);
			if (revokeAfterQuery !== undefined && queries.length >= revokeAfterQuery && !revocationApplied) {
				laneGeneration = "revoked-native-fixture-result-owner";
				revocationApplied = true;
			}
			if (url === PROJECT_API) return new Response(JSON.stringify({ id: 17, path_with_namespace: "group/project", web_url: "https://gitlab.example.test/group/project" }));
			if (url === `https://gitlab.example.test/api/v4/projects/17/repository/branches/${encodeURIComponent(BRANCH)}`) return new Response(JSON.stringify({ protected: false, commit: { id: baseSha } }));
			throw new Error(`Unexpected synthetic provider request: ${url}`);
		};

		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		settings.setPackages([PACKAGE_ROOT]);
		const loader = new DefaultResourceLoader({
			cwd: repo, agentDir, settingsManager: settings,
			extensionFactories: [artifactContracts, createCodemodeExtension({ mode: "on" }), (pi) => {
				pi.events.on(DELEGATION_STATUS_REQUEST, (value) => {
					if (isRecord(value)) pi.events.emit(DELEGATION_STATUS_RESPONSE, { version: 1, requestId: value.requestId, sessionId: value.sessionId, generation: "native-fixture-delegation", revision: 1, runningChildIds: [], pendingResultIds: [] });
				});
				pi.events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
					if (!isRecord(value) || value.operation !== "work-status" || !isRecord(value.payload)) return;
					pi.events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, { schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: value.request_id, operation: "work-status", ok: true, result: { schema_version: "pi-background-tasks.work-status.v1", version: 1, sessionId: value.payload.sessionId, generation: "native-fixture-background", revision: "a".repeat(64), activeAdmissions: 0, shuttingDown: false, taskAdmissionsClosed: false, terminalPublicationClosed: false, historyComplete: true, incompletenessReasons: [], tasks: [] } });
				});
				pi.events.on(PUBLICATION_CLEARANCE_QUERY, (value) => { if (isRecord(value)) queries.push(value); });
				pi.events.on(PUBLICATION_CLEARANCE_RECORD, (value) => { if (isRecord(value)) records.push(value); });
				pi.events.on(DELEGATION_RESULT_REQUEST, (value) => {
					if (!isRecord(value) || typeof value.childId !== "string") return;
					const saved = laneResults.get(value.childId);
					if (!saved || saved.incarnationId !== value.incarnationId || !isRecord(saved.envelope) || !isRecord(saved.launchBinding) || !isRecord(saved.ref)) return;
					pi.events.emit(DELEGATION_RESULT_RESPONSE, { version: 1, requestId: value.requestId, sessionId: value.sessionId, childId: value.childId, incarnationId: value.incarnationId, generation: laneGeneration, revision: 1, state: "completed", status: "completed", launchBinding: saved.launchBinding, envelope: saved.envelope, ref: saved.ref });
				});
				pi.registerTool({ name: "subagent", label: "Native child sessions", description: "Launch isolated native child sessions for this acceptance.", parameters: Type.Object({ children: Type.Array(Type.Object({ slot: Type.String(), agent: Type.String(), name: Type.String(), task: Type.String() })) }), async execute(id, params, _signal, _update, context) {
					const parentSessionId = context.sessionManager.getSessionId();
					const parentLeafId = context.sessionManager.getLeafId();
					if (!parentLeafId) throw new Error("parent launch leaf unavailable");
					const children = [];
					for (const child of params.children) {
						const childId = `native-${child.slot}-${randomUUID()}`;
						const incarnationId = randomUUID();
						const saved = await runNativeChild({ workspace, repo, agentDir, packageRoot: PACKAGE_ROOT, parentSessionId, parentLeafId, launchToolCallId: id, ...child, childId, incarnationId });
						laneResults.set(childId, { ...saved, childId, incarnationId, slot: child.slot });
						children.push({ id: childId, incarnationId, slot: child.slot });
					}
					return { content: [{ type: "text", text: `Finalized ${children.length} native child results.` }], details: { children } };
				} });
				pi.registerTool({ name: "migration_dispatch", label: "Migration test dispatch", description: "Dispatch a native Pi tool for this acceptance.", parameters: Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }), async execute(_id, params, _signal, _update, context) {
					const outcome = await context.executeTool(params.tool, params.args);
					return { content: outcome.result.content, details: outcome.result.structuredContent ?? outcome.result.details, isError: outcome.isError };
				} });
			}],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions.map((extension) => extension.path).filter((path) => !path.startsWith("<inline:"))).toEqual([resolve(PACKAGE_ROOT, "extensions/guardrails/index.ts")]);
		const modelRuntime = await ModelRuntime.create({ authPath: join(workspace, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
		const created = await createAgentSession({ cwd: repo, agentDir, resourceLoader: loader, settingsManager: settings, modelRuntime, sessionManager: SessionManager.inMemory(repo), tools: ["read", "bash", "verification_evidence", "publication_clearance", "migration_dispatch", "subagent", "codemode"] });
		session = created.session;
		await session.bindExtensions({});
		session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Run the isolated native migration acceptance." }], timestamp: Date.now() });
		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (!runner) throw new Error("native extension runner unavailable");
		const dispatch = runner.getToolDefinition("migration_dispatch");
		if (!dispatch) throw new Error("native dispatch tool unavailable");
		const call = async (id: string, tool: string, args: Record<string, unknown>) => {
			toolCall(session!, id, dispatch.name);
			return dispatch.execute(id, { tool, args }, undefined, undefined, runner.createToolContext(id, undefined));
		};

		delete process.env.PI_PUBLICATION_CONFIG_PATH;
		const disabled = await call("default-off-push", "bash", { command: `git push origin ${BRANCH}` });
		expect(disabled.isError).toBe(true);
		expect(disabled.content.map((block) => block.type === "text" ? block.text : "").join(" ")).toMatch(/grant|publication/i);
		expect(await readFile(pushLog, "utf8").catch(() => "")).toBe("");
		expect(git("show-ref")).toBe(refsBefore);
		process.env.PI_PUBLICATION_CONFIG_PATH = grantPath;
		const refused = await call("unsealed-push", "bash", { command: `git push origin ${BRANCH}` });
		expect(refused.isError).toBe(true);
		expect(refused.content.map((block) => block.type === "text" ? block.text : "").join(" ")).toMatch(/clearance|grant/i);
		expect(await readFile(pushLog, "utf8").catch(() => "")).toBe("");
		expect(git("show-ref")).toBe(refsBefore);

		const verification = await call("real-proof", "verification_evidence", { operation: "run", argv: ["true"], cwd: ".", timeout: 30 });
		expect(verification.isError).not.toBe(true);
		const verificationDetails = isRecord(verification.details) ? verification.details : undefined;
		const verificationEvidence = verificationDetails && isRecord(verificationDetails.evidence) ? verificationDetails.evidence : undefined;
		const directEvidenceId = typeof verificationEvidence?.id === "string" ? verificationEvidence.id : undefined;
		expect(directEvidenceId).toBeDefined();
		if (!directEvidenceId) throw new Error("native verification tool returned no structured evidence ID");
		const sealed = await call("real-seal", "publication_clearance", { tier: "Direct", evidenceIds: [directEvidenceId], lanes: [], adjudication: "Native Direct smoke coverage before Full child finalization." });
		if (sealed.isError) throw new Error(sealed.content.map((block) => block.type === "text" ? block.text : "").join(" "));
		const allowed = await call("sealed-push", "bash", { command: `git push -u origin ${BRANCH}` });
		expect(allowed.isError).not.toBe(true);
		expect(await readFile(pushLog, "utf8")).toBe(`push -u origin ${BRANCH}\n`);
		const directMatching = queries.filter((query) => query.repositoryRoot === canonicalRepo && query.candidateSha === candidateSha && query.pushUrl === PUSH_URL && query.branch === BRANCH);
		expect(directMatching.length).toBeGreaterThanOrEqual(2);
		expect(directMatching.every((query) => query.sessionId === session!.sessionManager.getSessionId())).toBe(true);
		expect(records).toHaveLength(2);
		expect(records[0]?.evidenceIds).toEqual(records[1]?.evidenceIds);
		expect(records[0]?.clearedAt).toBe(records[1]?.clearedAt);
		expect(records[0]?.requestId).not.toBe(records[1]?.requestId);
		expect(Array.isArray(records[0]?.evidenceIds) && records[0].evidenceIds.every((id) => typeof id === "string" && id.startsWith("seal:"))).toBe(true);
		expect(providerRequests).toContain(`GET ${PROJECT_API}`);
		expect(providerRequests).toContain(`GET https://gitlab.example.test/api/v4/projects/17/repository/branches/${encodeURIComponent(BRANCH)}`);
		expect(await readFile(scannerLog, "utf8")).toContain("approved change");

		const brief = (objective: string, reviewRange?: string) => [
			"## Objective", objective,
			"## Context", "- Source of truth: isolated native guardrails migration acceptance", "- Verified facts: pinned guard loaded and Direct smoke passed", "- Read first: native artifact-contracts producer and frozen candidate", "- Open questions: None.",
			"## Scope", "Review or verify only the frozen fixture candidate.", ...(reviewRange ? [`Review range: ${reviewRange}`] : []),
			"## Constraints", "Use the native Pi tools and the local scripted provider. Do not contact external services.",
			"## Done when", "Submit the assigned structured result through the native result tool.",
		].join("\n");
		const slots = [
			{ slot: "correctness-primary", agent: "code-reviewer", name: "correctness-primary", task: brief("Independently review the frozen candidate for correctness.", `${baseSha}..${candidateSha}`) },
			{ slot: "correctness-counterpart", agent: "code-reviewer-sonnet", name: "correctness-counterpart", task: brief("Independently review the frozen candidate as a counterpart.", `${baseSha}..${candidateSha}`) },
			{ slot: "live-success", agent: "live-verifier", name: "live-success", task: brief("Run independent native verification for the frozen candidate.") },
			{ slot: "live-attack", agent: "live-verifier", name: "live-attack", task: brief("Run independent native verification for the frozen candidate.") },
		];
		const launched = await call("full-lanes-launch", "subagent", { children: slots });
		if (launched.isError || !isRecord(launched.details) || !Array.isArray(launched.details.children)) throw new Error("native child launch failed: " + launched.content.map((block) => block.type === "text" ? block.text : "").join(" "));
		const children = launched.details.children.filter(isRecord);
		expect(children).toHaveLength(4);
		expect(laneResults.size).toBe(4);
		const lanes = children.map((child) => {
			if (typeof child.id !== "string" || typeof child.incarnationId !== "string" || typeof child.slot !== "string") throw new Error("native child launch returned incomplete identity");
			const saved = laneResults.get(child.id);
			if (!saved || !isRecord(saved.ref) || !isRecord(saved.envelope) || !isRecord(saved.launchBinding)) throw new Error("native child did not return a finalized persisted record");
			expect(saved.ref.state).toBe("finalized");
			expect(saved.envelope.launchBinding).toEqual(saved.launchBinding);
			return { slot: child.slot, childId: child.id, incarnationId: child.incarnationId };
		});
		expect(lanes.map((lane) => lane.slot).sort()).toEqual(["correctness-counterpart", "correctness-primary", "live-attack", "live-success"]);

		const freshProof = await call("fresh-parent-proof", "verification_evidence", { operation: "run", argv: ["true"], cwd: ".", timeout: 30 });
		if (freshProof.isError || !isRecord(freshProof.details) || !isRecord(freshProof.details.evidence) || typeof freshProof.details.evidence.id !== "string") throw new Error("fresh parent verification evidence unavailable");
		const fullEvidenceId = freshProof.details.evidence.id;
		const fullSeal = await call("full-native-seal", "publication_clearance", { tier: "Full", evidenceIds: [fullEvidenceId], lanes, adjudication: "Four distinct native child sessions finalized independent lanes; parent evidence was captured after child completion." });
		if (fullSeal.isError) throw new Error("native Full clearance failed: " + fullSeal.content.map((block) => block.type === "text" ? block.text : "").join(" "));
		const fullPush = await call("full-sealed-push", "bash", { command: `git push origin ${BRANCH}` });
		expect(fullPush.isError).not.toBe(true);
		expect((await readFile(pushLog, "utf8")).split("\n").filter(Boolean)).toEqual([`push -u origin ${BRANCH}`, `push origin ${BRANCH}`]);
		expect(records).toHaveLength(4);
		expect(records[2]?.evidenceIds).toEqual(records[3]?.evidenceIds);
		expect(records[2]?.clearedAt).toBe(records[3]?.clearedAt);
		expect(records[2]?.requestId).not.toBe(records[3]?.requestId);

		const attempts = (await readFile(pushLog, "utf8")).split("\n").filter(Boolean);
		revokeAfterQuery = queries.length + 1;
		const revoked = await call("revoked-full-seal-push", "bash", { command: `git push origin ${BRANCH}` });
		expect(revoked.isError).toBe(true);
		expect(revocationApplied).toBe(true);
		expect(records).toHaveLength(5);
		expect((await readFile(pushLog, "utf8")).split("\n").filter(Boolean)).toEqual(attempts);
		expect(git("show-ref")).toBe(refsBefore);

		const codemode = runner.getToolDefinition("codemode");
		expect(codemode).toBeDefined();
		if (!codemode) throw new Error("native codemode tool unavailable");
		const codemodeId = "migration-codemode-revocation";
		toolCall(session, codemodeId, "codemode");
		const codemodeResult = await codemode.execute(codemodeId, {
			code: `const results = await Promise.allSettled([tools.read({ path: ${JSON.stringify(join(repo, "tracked.txt"))} }), tools.bash({ command: ${JSON.stringify(`git push origin ${BRANCH}`)} })]); return results.map((item) => item.status === "fulfilled" ? { status: item.status, value: item.value } : { status: item.status, reason: String(item.reason) });`,
		}, undefined, undefined, runner.createToolContext(codemodeId, undefined));
		const codemodeOutput = codemodeResult.content.map((block) => block.type === "text" ? block.text : "").join(" ");
		expect(codemodeResult.isError).not.toBe(true);
		expect(codemodeOutput).toContain("approved change");
		expect(codemodeOutput).toContain("fulfilled");
		expect(codemodeOutput).toContain("rejected");
		expect(codemodeOutput).toMatch(/clearance|worktree_dirty/i);
		expect((await readFile(pushLog, "utf8")).split("\n").filter(Boolean)).toEqual(attempts);
		expect(git("show-ref")).toBe(refsBefore);
	} finally {
		await writeFile(join(evidenceRoot, "report.json"), JSON.stringify({
			packageRoot: PACKAGE_ROOT, packageCommit: PACKAGE_COMMIT, sdkRoot: SDK_ROOT,
			inputsBefore, queries, records, providerRequests,
			laneResults: [...laneResults.entries()],
			transport: await readFile(pushLog, "utf8").catch(() => ""),
			scanner: await readFile(scannerLog, "utf8").catch(() => ""),
		}, null, 2));
		console.log("Joined migration report:", join(evidenceRoot, "report.json"));
		session?.dispose();
		globalThis.fetch = previousFetch;
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(workspace, { recursive: true, force: true });
		expect(await inputManifest(PACKAGE_ROOT, packageFiles)).toEqual(inputsBefore.package);
		expect(await inputManifest(SDK_ROOT, sdkFiles)).toEqual(inputsBefore.sdk);
		expect(await inputManifest(configRoot, configFiles)).toEqual(inputsBefore.config);
		expect(hash(await readFile(import.meta.filename))).toBe(inputsBefore.probe);
	}
});
