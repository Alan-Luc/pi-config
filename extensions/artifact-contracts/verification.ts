import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	EventBus,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	onBackgroundTaskTerminal,
	requestBackgroundTask,
	type BackgroundTaskLogsResult,
	type BackgroundTaskSnapshot,
} from "./background-tasks.ts";
import {
	beginVerificationAttempt,
	createCandidateIdentity,
	invalidateVerificationEvidence,
	recordVerificationEvidence,
	type CandidateIdentity,
	type VerificationEvidence,
} from "./verification-store.ts";

import { createStagedSnapshot, type StagedSnapshot } from "./staged-verification.ts";
import { parseWorkStatusRequest, VERIFICATION_STATUS_REQUEST, VERIFICATION_STATUS_RESPONSE } from "../lib/work-status.ts";
import { rejectGitMutations } from "./verification-git.ts";

const VERIFICATION_PROTOCOL_VERSION = 2;
const MAX_TIMEOUT_SECONDS = 600;
const CANDIDATE_TIMEOUT_SECONDS = 30;
export const MAX_EXPOSED_OUTPUT_BYTES = 4096;
const VERIFICATION_LOG_DIRECTORY = join(tmpdir(), "pi", "verification");

export const VERIFICATION_EVIDENCE_PARAMETERS = {
	// Provider/schema renderers need top-level field types as well as the strict operation variants.
	type: "object",
	properties: {
		operation: { type: "string", enum: ["capture", "run", "start", "collect", "start_batch", "collect_batch"] },
		repositoryRoot: { type: "string", minLength: 1 },
		source: { type: "string", const: "staged" },
		runtimeInputs: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
		argv: { type: "array", items: { type: "string" }, minItems: 1 },
		cwd: { type: "string", minLength: 1 },
		timeout: { type: "number", exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS },
		taskId: { type: "string", minLength: 1 },
		checks: {
			type: "array", minItems: 1,
			items: {
				type: "object",
				properties: {
					repositoryRoot: { type: "string", minLength: 1 }, source: { const: "staged" },
					runtimeInputs: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
					argv: { type: "array", items: { type: "string" }, minItems: 1 },
					cwd: { type: "string", minLength: 1 }, timeout: { type: "number", exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS },
				},
				required: ["argv", "cwd", "timeout"], additionalProperties: false,
				dependencies: { runtimeInputs: ["source"] },
			},
		},
		taskIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, uniqueItems: true },
	},

	dependencies: { runtimeInputs: ["source"] },
	oneOf: [
		{
			type: "object",
			properties: {
				operation: { const: "capture" },
				repositoryRoot: { type: "string", minLength: 1 },
				source: { const: "staged" },
			},
			required: ["operation"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "run" },
				repositoryRoot: { type: "string", minLength: 1 },
				source: { const: "staged" },
				runtimeInputs: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
				argv: { type: "array", items: { type: "string" }, minItems: 1 },
				cwd: { type: "string", minLength: 1 },
				timeout: { type: "number", exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS },
			},
			required: ["operation", "argv", "cwd", "timeout"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "start" },
				repositoryRoot: { type: "string", minLength: 1 },
				source: { const: "staged" },
				runtimeInputs: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
				argv: { type: "array", items: { type: "string" }, minItems: 1 },
				cwd: { type: "string", minLength: 1 },
				timeout: { type: "number", exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS },
			},
			required: ["operation", "argv", "cwd", "timeout"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "collect" },
				taskId: { type: "string", minLength: 1 },
			},
			required: ["operation", "taskId"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "start_batch" },
				checks: {
					type: "array", minItems: 1,
					items: {
						type: "object",
						properties: {
							repositoryRoot: { type: "string", minLength: 1 }, source: { const: "staged" },
							runtimeInputs: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
							argv: { type: "array", items: { type: "string" }, minItems: 1 },
							cwd: { type: "string", minLength: 1 }, timeout: { type: "number", exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS },
						},
						required: ["argv", "cwd", "timeout"], additionalProperties: false,
						dependencies: { runtimeInputs: ["source"] },
					},
				},
			},
			required: ["operation", "checks"], additionalProperties: false,
		},
		{
			type: "object",
			properties: { operation: { const: "collect_batch" }, taskIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, uniqueItems: true } },
			required: ["operation", "taskIds"], additionalProperties: false,
		},
	],
} as const;
type VerificationCheckSource =
	| { source?: never; runtimeInputs?: never }
	| { source: "staged"; runtimeInputs?: string[] };

export type VerificationBatchCheck = { repositoryRoot?: string; argv: string[]; cwd: string; timeout: number } & VerificationCheckSource;

export type VerificationEvidenceInput =
	| { operation: "capture"; repositoryRoot?: string; source?: "staged" }
	| ({ operation: "run"; repositoryRoot?: string; argv: string[]; cwd: string; timeout: number } & VerificationCheckSource)
	| ({ operation: "start"; repositoryRoot?: string; argv: string[]; cwd: string; timeout: number } & VerificationCheckSource)
	| { operation: "collect"; taskId: string }
	| { operation: "start_batch"; checks: VerificationBatchCheck[] }
	| { operation: "collect_batch"; taskIds: string[] };

const candidateOutputSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		repositoryRoot: { type: "string" },
		head: { type: ["string", "null"] },
		tree: { type: "string" },
		kind: { type: "string", enum: ["clean", "dirty"] },
		source: { const: "staged" },
		runtimeInputs: {
			type: "array",
			items: {
				type: "object",
				properties: { path: { type: "string" }, sha256: { type: "string" } },
				required: ["path", "sha256"],
				additionalProperties: false,
			},
		},
	},
	required: ["id", "repositoryRoot", "head", "tree", "kind"],
	additionalProperties: false,
} as const;
const backgroundTaskOutputSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		command: { type: "string" },
		status: { type: "string", enum: ["running", "completed", "failed", "killed"] },
		outputPath: { type: "string" },
		cwd: { type: "string" },
		startTime: { type: "number" },
		endTime: { type: "number" },
		exitCode: { type: ["integer", "null"] },
		signal: { type: ["string", "null"] },
		bytesWritten: { type: "number" },
		isAgent: { type: "boolean" },
		error: { type: "string" },
		notified: { type: "boolean" },
		notifyOnCompletion: { type: "boolean" },
		triggerOnCompletion: { type: "boolean" },
		timeoutSeconds: { type: "number" },
	},
	required: [
		"id", "command", "status", "outputPath", "cwd", "startTime", "bytesWritten", "isAgent",
		"notified", "notifyOnCompletion", "triggerOnCompletion",
	],
	additionalProperties: false,
} as const;
const evidenceOutputSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		command: { type: "string" },
		argv: { type: "array", items: { type: "string" } },
		cwd: { type: "string" },
		candidate: candidateOutputSchema,
		exitCode: { type: "integer" },
		logPath: { type: "string" },
		logSha256: { type: "string" },
		valid: { type: "boolean" },
		invalidReason: { type: "string" },
		verifiedBy: { type: "string" },
	},
	required: ["id", "command", "argv", "cwd", "candidate", "exitCode", "logPath", "logSha256", "valid"],
	additionalProperties: false,
} as const;
export const VERIFICATION_EVIDENCE_OUTPUT_SCHEMA = {
	oneOf: [
		{
			type: "object",
			properties: { operation: { const: "capture" }, protocolVersion: { type: "integer", const: VERIFICATION_PROTOCOL_VERSION }, candidate: candidateOutputSchema },
			required: ["operation", "protocolVersion", "candidate"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { operation: { const: "run" }, protocolVersion: { type: "integer", const: VERIFICATION_PROTOCOL_VERSION }, evidence: evidenceOutputSchema, output: { type: "string" } },
			required: ["operation", "protocolVersion", "evidence", "output"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "start" },
				protocolVersion: { type: "integer", const: VERIFICATION_PROTOCOL_VERSION },
				taskId: { type: "string" },
				task: backgroundTaskOutputSchema,
				candidate: candidateOutputSchema,
				command: { type: "string" },
				argv: { type: "array", items: { type: "string" } },
				cwd: { type: "string" },
			},
			required: ["operation", "protocolVersion", "taskId", "task", "candidate", "command", "argv", "cwd"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "collect" }, protocolVersion: { type: "integer", const: VERIFICATION_PROTOCOL_VERSION },
				state: { const: "collected" }, evidence: evidenceOutputSchema, output: { type: "string" },
			},
			required: ["operation", "protocolVersion", "state", "evidence", "output"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "collect" }, protocolVersion: { type: "integer", const: VERIFICATION_PROTOCOL_VERSION },
				state: { const: "pending" }, taskId: { type: "string" }, nextAction: { const: "wait-for-terminal-notification" },
			},
			required: ["operation", "protocolVersion", "state", "taskId", "nextAction"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "start_batch" }, protocolVersion: { type: "integer", const: VERIFICATION_PROTOCOL_VERSION },
				outcomes: { type: "array", items: { oneOf: [
					{ type: "object", properties: { index: { type: "integer" }, result: { type: "object", properties: {
						operation: { const: "start" }, protocolVersion: { type: "integer" }, taskId: { type: "string" }, task: backgroundTaskOutputSchema,
						candidate: candidateOutputSchema, command: { type: "string" }, argv: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
					}, required: ["operation", "protocolVersion", "taskId", "task", "candidate", "command", "argv", "cwd"], additionalProperties: false } }, required: ["index", "result"], additionalProperties: false },
					{ type: "object", properties: { index: { type: "integer" }, error: { type: "string" } }, required: ["index", "error"], additionalProperties: false },
				] } },
			}, required: ["operation", "protocolVersion", "outcomes"], additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "collect_batch" }, protocolVersion: { type: "integer", const: VERIFICATION_PROTOCOL_VERSION },
				outcomes: { type: "array", items: { oneOf: [
					{ type: "object", properties: { index: { type: "integer" }, result: { oneOf: [
						{ type: "object", properties: { operation: { const: "collect" }, protocolVersion: { type: "integer" }, state: { const: "collected" }, evidence: evidenceOutputSchema, output: { type: "string" } }, required: ["operation", "protocolVersion", "state", "evidence", "output"], additionalProperties: false },
						{ type: "object", properties: { operation: { const: "collect" }, protocolVersion: { type: "integer" }, state: { const: "pending" }, taskId: { type: "string" }, nextAction: { const: "wait-for-terminal-notification" } }, required: ["operation", "protocolVersion", "state", "taskId", "nextAction"], additionalProperties: false },
					] } }, required: ["index", "result"], additionalProperties: false },
					{ type: "object", properties: { index: { type: "integer" }, error: { type: "string" } }, required: ["index", "error"], additionalProperties: false },
				] } },
			}, required: ["operation", "protocolVersion", "outcomes"], additionalProperties: false,
		},
	],
} as const;

export type VerificationToolContext = Pick<ExtensionToolContext, "cwd" | "executeTool"> & { exec?: CandidateExec };

export type CandidateCaptureResult = Readonly<{
	operation: "capture";
	protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
	candidate: CandidateIdentity;
}>;

export type VerificationRunResult = Readonly<{
	operation: "run";
	protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
	evidence: VerificationEvidence;
	output: string;
}>;

export type VerificationStartResult = Readonly<{
	operation: "start";
	protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
	taskId: string;
	task: BackgroundTaskSnapshot;
	candidate: CandidateIdentity;
	command: string;
	argv: readonly string[];
	cwd: string;
}>;

export type VerificationCollectedResult = Readonly<{
	operation: "collect";
	protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
	state: "collected";
	evidence: VerificationEvidence;
	output: string;
}>;

export type VerificationCollectResult = VerificationCollectedResult | Readonly<{
	operation: "collect";
	protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
	state: "pending";
	taskId: string;
	nextAction: "wait-for-terminal-notification";
}>;

export type VerificationBatchOutcome<T> = Readonly<{ index: number; result: T }> | Readonly<{ index: number; error: string }>;

export type VerificationStartBatchResult = Readonly<{
	operation: "start_batch";
	protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
	outcomes: readonly VerificationBatchOutcome<VerificationStartResult>[];
}>;

export type VerificationCollectBatchResult = Readonly<{
	operation: "collect_batch";
	protocolVersion: typeof VERIFICATION_PROTOCOL_VERSION;
	outcomes: readonly VerificationBatchOutcome<VerificationCollectResult>[];
}>;

export type VerificationEvidenceResult = CandidateCaptureResult | VerificationRunResult | VerificationStartResult | VerificationCollectResult | VerificationStartBatchResult | VerificationCollectBatchResult;

type BashOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
type Repository = Readonly<{
	root: string;
	indexPath: string;
	commonDirectory: string;
}>;
type BashResult = Readonly<{ exitCode: number; output: string }>;
type VerificationAttempt = ReturnType<typeof beginVerificationAttempt>;
type StartedVerificationTask = {
	candidate: CandidateIdentity;
	attempt: VerificationAttempt;
	command: string;
	argv: readonly string[];
	cwd: string;
	repositoryRoot: string;
	outputDirectory: string;
	task: BackgroundTaskSnapshot;
	terminal?: BackgroundTaskSnapshot;
	result?: VerificationCollectedResult;
	collectionFailed?: true;
	stagedSnapshot?: StagedSnapshot;
};
type PendingVerificationStart = { terminalTasks: Map<string, BackgroundTaskSnapshot> };
type VerificationEventState = {
	startedTasks: Map<string, StartedVerificationTask>;
	pendingStarts: Set<PendingVerificationStart>;
};

const verificationEventStates = new WeakMap<EventBus, VerificationEventState>();

function verificationEventState(events: EventBus): VerificationEventState {
	const existing = verificationEventStates.get(events);
	if (existing) return existing;
	const state: VerificationEventState = { startedTasks: new Map(), pendingStarts: new Set() };
	verificationEventStates.set(events, state);
	onBackgroundTaskTerminal(events, (task) => {
		const started = state.startedTasks.get(task.id);
		if (started) {
			started.terminal = task;
			return;
		}
		for (const pending of state.pendingStarts) pending.terminalTasks.set(task.id, task);
	});
	return state;
}

export function pendingVerificationWork(events: EventBus): Readonly<{ starting: number; uncollectedTaskIds: readonly string[] }> {
	const state = verificationEventStates.get(events);
	if (!state) return { starting: 0, uncollectedTaskIds: [] };
	return {
		starting: state.pendingStarts.size,
		uncollectedTaskIds: [...state.startedTasks].filter(([, task]) => !task.result && !task.collectionFailed).map(([taskId]) => taskId),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashBytes(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashText(value: string): string {
	return hashBytes(Buffer.from(value));
}

function isWithin(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function shellQuote(value: string): string {
	if (value.includes("\0")) throw new Error("verification_evidence rejects NUL bytes");
	if (!/[`\\\x00-\x1f\x7f]/.test(value)) return `'${value.replaceAll("'", "'\\''")}'`;
	const escaped = value.replace(/[\\'`\x00-\x1f\x7f]/g, (character) => {
		if (character === "\\") return "\\\\";
		if (character === "'") return "\\'";
		if (character === "`") return "\\x60";
		return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
	return `$'${escaped}'`;
}

function isShellExecutable(value: string): boolean {
	const name = basename(value.replaceAll("\\", "/"));
	return new Set(["ash", "bash", "csh", "dash", "fish", "ksh", "sh", "tcsh", "zsh"]).has(name);
}

function isShellCommandFlag(shell: string, value: string): boolean {
	if (value === "--command" || value.startsWith("--command=") || /^-[^-]*c/.test(value)) return true;
	const name = basename(shell.replaceAll("\\", "/"));
	return name === "fish"
		&& (value === "--init-command" || value.startsWith("--init-command=") || /^-[^-]*C/.test(value));
}

function usesEnvSplitString(argv: readonly string[]): boolean {
	return argv.some((argument, index) =>
		basename(argument.replaceAll("\\", "/")) === "env" && argv.slice(index + 1).some((candidate) =>
			candidate === "--split-string" || candidate.startsWith("--split-string=") || /^-[^-]*S/.test(candidate)));
}

export function canonicalCommand(argv: readonly string[]): string {
	if (!Array.isArray(argv) || argv.length === 0) throw new Error("verification_evidence run requires a non-empty argv");
	for (const argument of argv) {
		if (typeof argument !== "string" || argument.length === 0) throw new Error("verification_evidence rejects empty argv arguments");
		if (argument.includes("\0")) throw new Error("verification_evidence rejects NUL bytes in argv");
	}
	if (usesEnvSplitString(argv) || argv.some((argument, index) =>
		isShellExecutable(argument) && argv.slice(index + 1).some((flag) => isShellCommandFlag(argument, flag)))) {
		throw new Error("verification_evidence rejects caller-supplied shell command wrappers");
	}
	return argv.map(shellQuote).join(" ");
}

function validateTimeout(timeout: number): void {
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`verification_evidence timeout must be greater than 0 and at most ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

function canonicalCwd(cwd: string): string {
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error("verification_evidence run requires a cwd");
	if (cwd.includes("\0")) throw new Error("verification_evidence rejects NUL bytes in cwd");
	if (isAbsolute(cwd) || win32.isAbsolute(cwd) || cwd.includes("\\")) {
		throw new Error("verification_evidence cwd must be repository-relative");
	}
	if (cwd.split("/").some((part) => part === "..")) {
		throw new Error("verification_evidence cwd may not traverse outside the repository");
	}
	return posix.normalize(cwd);
}

function singleLineOutput(output: string, description: string): string {
	const value = output.trim();
	if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
		throw new Error(`verification_evidence could not read ${description}`);
	}
	return value;
}

function structuredBashContent(outcome: BashOutcome): Record<string, unknown> {
	if (!isRecord(outcome.result.structuredContent)) {
		throw new Error("verification_evidence nested bash result is missing structured content and exit_code");
	}
	return outcome.result.structuredContent;
}

function fullBashOutput(content: Record<string, unknown>): string {
	const output = content.output;
	const truncated = content.truncated;
	if (typeof output !== "string" || typeof truncated !== "boolean") {
		throw new Error("verification_evidence nested bash result has invalid structured output");
	}
	if (!truncated) return output;
	const fullOutputPath = content.full_output_path;
	if (typeof fullOutputPath !== "string" || !isAbsolute(fullOutputPath)) {
		throw new Error("verification_evidence nested bash result is truncated without a full output path");
	}
	let resolvedPath: string;
	try {
		resolvedPath = realpathSync(fullOutputPath);
	} catch (error) {
		throw new Error(`verification_evidence could not read nested bash full output: ${String(error)}`);
	}
	const temporaryRoot = realpathSync(tmpdir());
	if (!isWithin(temporaryRoot, resolvedPath)) {
		throw new Error("verification_evidence nested bash full output is outside the temporary directory");
	}
	try {
		return readFileSync(resolvedPath, "utf8");
	} catch (error) {
		throw new Error(`verification_evidence could not read nested bash full output: ${String(error)}`);
	}
}

async function executeBash(
	ctx: VerificationToolContext,
	command: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<BashResult> {
	let outcome: BashOutcome;
	try {
		outcome = await ctx.executeTool("bash", { command, timeout }, { signal });
	} catch (error) {
		throw new Error(`verification_evidence could not execute nested bash: ${String(error)}`);
	}
	const content = structuredBashContent(outcome);
	const exitCode = content.exit_code;
	if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
		throw new Error("verification_evidence nested bash result is missing structured exit_code");
	}
	return { exitCode, output: fullBashOutput(content) };
}

type CandidateCommand = (
	cwd: string,
	argv: readonly string[],
	timeout: number,
	signal: AbortSignal | undefined,
) => Promise<BashResult>;

export type CandidateExec = Pick<ExtensionAPI, "exec">["exec"];

type CandidateStep = Readonly<{ cwd: string; argv: readonly string[]; timeout: number }>;
type CandidatePlan<T> = Generator<CandidateStep, T, BashResult>;

async function runCandidatePlan<T>(plan: CandidatePlan<T>, run: CandidateCommand, signal?: AbortSignal): Promise<T> {
	let step = plan.next();
	while (!step.done) {
		try {
			const { cwd, argv, timeout } = step.value;
			step = plan.next(await run(cwd, argv, timeout, signal));
		} catch (error) {
			step = plan.throw(error);
		}
	}
	return step.value;
}

function runCandidatePlanSync<T>(plan: CandidatePlan<T>, deadline: number): T {
	let step = plan.next();
	while (!step.done) {
		try {
			const { cwd, argv, timeout } = step.value;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("publication Git capture deadline exceeded");
			const result = spawnSync(argv[0], [...argv.slice(1)], {
				cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
				timeout: Math.min(timeout * 1000, remaining), killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
			});
			if (result.error || result.signal || result.status === null) throw new Error("publication Git capture failed or exceeded its bounds", { cause: result.error });
			step = plan.next({ exitCode: result.status, output: result.stdout + result.stderr });
		} catch (error) {
			step = plan.throw(error);
		}
	}
	if (Date.now() > deadline) throw new Error("publication Git capture deadline exceeded");
	return step.value;
}

function discoverRepository(run: CandidateCommand, directory: string, signal?: AbortSignal, repositoryRoot?: string): Promise<Repository> {
	return runCandidatePlan(discoverRepositoryPlan(directory, repositoryRoot), run, signal);
}

function snapshotCandidate(run: CandidateCommand, repository: Repository, signal?: AbortSignal, source?: "staged"): Promise<CandidateIdentity> {
	return runCandidatePlan(snapshotCandidatePlan(repository, source), run, signal);
}

export function captureCandidateSync(sessionDirectory: string, repositoryRoot?: string, source?: "staged", deadline = Date.now() + 30_000): CandidateIdentity {
	const repository = runCandidatePlanSync(discoverRepositoryPlan(sessionDirectory, repositoryRoot), deadline);
	return runCandidatePlanSync(snapshotCandidatePlan(repository, source), deadline);
}

function candidateCommand(ctx: VerificationToolContext): CandidateCommand {
	if (ctx.exec) return directCandidateCommand(ctx.exec);
	return async (cwd, argv, timeout, signal) => {
		const command = argv[0] === "env" && argv[1]?.startsWith("GIT_INDEX_FILE=")
			? `cd ${shellQuote(cwd)} && GIT_INDEX_FILE=${shellQuote(argv[1].slice("GIT_INDEX_FILE=".length))} ${argv.slice(2).join(" ")}`
			: `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(" ")}`;
		return executeBash(ctx, command, timeout, signal);
	};
}

function directCandidateCommand(exec: CandidateExec): CandidateCommand {
	return async (cwd, argv, timeout, signal) => {
		try {
			const result = await exec(argv[0], [...argv.slice(1)], { cwd, signal, timeout: timeout * 1000 });
			return { exitCode: result.code, output: result.stdout + result.stderr };
		} catch (error) {
			throw new Error(`verification_evidence could not execute candidate command: ${String(error)}`);
		}
	};
}

function* executeCandidateGit(
	root: string,
	gitArguments: readonly string[],
): CandidatePlan<BashResult> {
	const result = yield { cwd: root, argv: ["git", ...gitArguments], timeout: CANDIDATE_TIMEOUT_SECONDS };
	if (result.exitCode !== 0) {
		const output = result.output.trim();
		throw new Error(`verification_evidence git command failed with exit ${result.exitCode}${output ? `: ${output}` : ""}`);
	}
	return result;
}

function* discoverRepositoryAt(
	directory: string,
): CandidatePlan<Repository> {
	const rootResult = yield { cwd: directory, argv: ["git", "rev-parse", "--show-toplevel"], timeout: CANDIDATE_TIMEOUT_SECONDS };
	if (rootResult.exitCode !== 0) {
		throw new Error("verification_evidence requires a Git working tree; repository discovery failed");
	}
	let root: string;
	try {
		root = realpathSync(singleLineOutput(rootResult.output, "the repository root"));
	} catch (error) {
		throw new Error(`verification_evidence could not resolve the repository root: ${String(error)}`);
	}
	const workTree = singleLineOutput((yield* executeCandidateGit(root, ["rev-parse", "--is-inside-work-tree"])).output, "Git work-tree status");
	if (workTree !== "true") throw new Error("verification_evidence requires a Git working tree");
	const indexPathValue = singleLineOutput((yield* executeCandidateGit(root, ["rev-parse", "--git-path", "index"])).output, "the Git index path");
	const commonDirectoryValue = singleLineOutput((yield* executeCandidateGit(root, ["rev-parse", "--git-common-dir"])).output, "the Git common directory");
	let commonDirectory: string;
	try {
		commonDirectory = realpathSync(resolve(root, commonDirectoryValue));
	} catch (error) {
		throw new Error(`verification_evidence could not resolve the Git common directory: ${String(error)}`);
	}
	return { root, indexPath: resolve(root, indexPathValue), commonDirectory };
}

function canonicalRepositoryRoot(value: string): string {
	if (value.includes("\0")) throw new Error("verification_evidence rejects NUL bytes in repositoryRoot");
	if (!isAbsolute(value)) throw new Error("verification_evidence repositoryRoot must be absolute");
	let root: string;
	try {
		root = realpathSync(value);
		if (!statSync(root).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new Error(`verification_evidence repositoryRoot is not a directory: ${value} (${String(error)})`);
	}
	return root;
}

function* discoverRepositoryPlan(
	sessionDirectory: string,
	repositoryRoot?: string,
): CandidatePlan<Repository> {
	const sessionRepository = yield* discoverRepositoryAt(sessionDirectory);
	if (repositoryRoot === undefined) return sessionRepository;
	const requestedRoot = canonicalRepositoryRoot(repositoryRoot);
	const requestedRepository = requestedRoot === sessionRepository.root
		? sessionRepository
		: yield* discoverRepositoryAt(requestedRoot);
	if (requestedRepository.root !== requestedRoot) {
		throw new Error("verification_evidence repositoryRoot must be the worktree top level");
	}
	if (requestedRepository.commonDirectory !== sessionRepository.commonDirectory) {
		throw new Error("verification_evidence repositoryRoot must be a linked worktree of the session repository");
	}
	return requestedRepository;
}

function repositoryCwd(root: string, cwd: string): { absolute: string; relative: string } {
	const lexicalPath = resolve(root, cwd);
	let resolvedPath: string;
	try {
		resolvedPath = realpathSync(lexicalPath);
	} catch (error) {
		throw new Error(`verification_evidence cwd does not exist: ${cwd} (${String(error)})`);
	}
	if (resolvedPath !== lexicalPath || !isWithin(root, resolvedPath)) {
		throw new Error(`verification_evidence cwd may not traverse a symlink: ${cwd}`);
	}
	try {
		if (!statSync(resolvedPath).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new Error(`verification_evidence cwd is not a directory: ${cwd} (${String(error)})`);
	}
	return { absolute: resolvedPath, relative: cwd };
}

function* snapshotCandidatePlan(
	repository: Repository,
	source?: "staged",
): CandidatePlan<CandidateIdentity> {
	let headResult: BashResult;
	try {
		headResult = yield* executeCandidateGit(repository.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
	} catch (error) {
		const message = String(error);
		if (!message.includes("git command failed with exit")) throw error;
		throw new Error(`verification_evidence cannot capture an unborn HEAD; repository has no commit: ${message}`);
	}
	const head = singleLineOutput(headResult.output, "HEAD");
	const headTree = singleLineOutput(
		(yield* executeCandidateGit(repository.root, ["rev-parse", `${head}^{tree}`])).output,
		"the HEAD tree",
	);
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-verification-index-"));
	const temporaryIndex = join(temporaryDirectory, "index");
	try {
		if (existsSync(repository.indexPath)) copyFileSync(repository.indexPath, temporaryIndex);
		if (source === undefined) {
			const addResult = yield { cwd: repository.root, argv: ["env", `GIT_INDEX_FILE=${temporaryIndex}`, "git", "add", "-A"], timeout: CANDIDATE_TIMEOUT_SECONDS };
			if (addResult.exitCode !== 0) {
				const output = boundedOutput(addResult.output).trim();
				throw new Error(`temporary Git index staging failed with exit ${addResult.exitCode}${output ? `: ${output}` : ""}`);
			}
		}
		const treeResult = yield { cwd: repository.root, argv: ["env", `GIT_INDEX_FILE=${temporaryIndex}`, "git", "write-tree"], timeout: CANDIDATE_TIMEOUT_SECONDS };
		if (treeResult.exitCode !== 0) {
			const output = boundedOutput(treeResult.output).trim();
			throw new Error(`temporary Git tree serialization failed with exit ${treeResult.exitCode}${output ? `: ${output}` : ""}`);
		}
		const tree = treeResult.output.trim();
		if (!/^[0-9a-f]{40,64}$/.test(tree)) {
			const output = boundedOutput(treeResult.output).trim();
			throw new Error(`verification_evidence received invalid Git tree output${output ? `: ${output}` : ""}`);
		}
		return createCandidateIdentity({
			repositoryRoot: repository.root,
			head,
			tree,
			kind: tree === headTree ? "clean" : "dirty",
			...(source === undefined ? {} : { source }),
		});
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function boundedOutput(output: string): string {
	const bytes = Buffer.from(output);
	if (bytes.byteLength <= MAX_EXPOSED_OUTPUT_BYTES) return output;
	return bytes.subarray(bytes.byteLength - MAX_EXPOSED_OUTPUT_BYTES).toString("utf8");
}

function outputTail(output: string, maxBytes: number): string {
	const bytes = Buffer.from(output);
	let start = Math.max(0, bytes.byteLength - maxBytes);
	while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

function outputHead(output: string, maxBytes: number): string {
	const bytes = Buffer.from(output);
	let end = Math.min(bytes.byteLength, maxBytes);
	while (end > 0 && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function summarizedOutput(output: string, exitCode: number): string {
	if (exitCode === 0) {
		const lastLines = output.split("\n").slice(-7).join("\n");
		if (lastLines === output && Buffer.byteLength(output) <= 512) return output;
		const marker = "[... earlier output omitted ...]\n";
		return `${marker}${outputTail(lastLines, 512 - Buffer.byteLength(marker))}`;
	}
	if (Buffer.byteLength(output) <= MAX_EXPOSED_OUTPUT_BYTES) return output;
	const lines = output.split(/\r?\n/);
	const failureIndex = lines.findIndex((line) => /FAIL|Error|Traceback|panic|assert|non[- ]?zero exit|exit(?:ed)?(?: with)?(?: code| status)?[: =]+[1-9]\d*/i.test(line));
	if (failureIndex < 0) return outputTail(output, MAX_EXPOSED_OUTPUT_BYTES);
	const failureBlock = lines.slice(failureIndex).join("\n");
	const marker = "\n[... output omitted ...]\n";
	const excerptBytes = Math.floor((MAX_EXPOSED_OUTPUT_BYTES - Buffer.byteLength(marker)) / 2);
	return `${outputHead(failureBlock, excerptBytes)}${marker}${outputTail(output, excerptBytes)}`;
}

function writeVerificationLogBytes(toolCallId: string, bytes: Buffer): { path: string; sha256: string } {
	mkdirSync(VERIFICATION_LOG_DIRECTORY, { recursive: true, mode: 0o700 });
	chmodSync(VERIFICATION_LOG_DIRECTORY, 0o700);
	const path = join(VERIFICATION_LOG_DIRECTORY, `verification-${hashText(toolCallId)}-${randomUUID()}.log`);
	writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
	chmodSync(path, 0o600);
	return { path, sha256: hashBytes(bytes) };
}

function writeVerificationLog(toolCallId: string, output: string): { path: string; sha256: string } {
	return writeVerificationLogBytes(toolCallId, Buffer.from(output));
}

function secureBackgroundOutputPath(sessionDirectory: string, outputPath: string, taskId: string): string {
	if (outputPath.includes("\0")) throw new Error("verification_evidence background task output path contains NUL bytes");
	if (outputPath.split(/[\\/]/).some((segment) => segment === "..")) {
		throw new Error("verification_evidence background task output path may not traverse parent directories");
	}
	const resolved = resolve(sessionDirectory, outputPath);
	const temporaryRoot = realpathSync(tmpdir());
	const runtimeDirectory = dirname(resolved);
	const externalRuntime = isAbsolute(outputPath)
		&& dirname(runtimeDirectory) === temporaryRoot
		&& basename(runtimeDirectory).startsWith("pi-background-tasks-");
	if (externalRuntime && basename(resolved) !== `${taskId}.output`) {
		throw new Error("verification_evidence background task output path has a different task filename");
	}
	const tasksRoot = externalRuntime ? runtimeDirectory : join(sessionDirectory, ".pi", "tasks");
	if (resolved === tasksRoot || !isWithin(tasksRoot, resolved)) {
		throw new Error("verification_evidence background task output path must be under its private runtime or session .pi/tasks tree");
	}
	const root = externalRuntime ? temporaryRoot : sessionDirectory;
	const components = relative(root, resolved).split(/[\\/]/).filter(Boolean);
	let current = root;
	try {
		for (const [index, component] of components.entries()) {
			current = join(current, component);
			const metadata = lstatSync(current);
			if (metadata.isSymbolicLink()) {
				throw new Error("verification_evidence background task output path may not traverse a symbolic link");
			}
			if (index < components.length - 1 && !metadata.isDirectory()) {
				throw new Error("verification_evidence background task output path has a non-directory parent");
			}
		}
		return resolved;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("verification_evidence")) throw error;
		throw new Error(`verification_evidence could not read background task output path: ${String(error)}`);
	}
}

function readBackgroundOutput(
	sessionDirectory: string,
	task: BackgroundTaskSnapshot,
	logs: BackgroundTaskLogsResult,
): Buffer {
	if (logs.task.id !== task.id) throw new Error("verification_evidence background task logs returned a different task");
	const taskPath = secureBackgroundOutputPath(sessionDirectory, task.outputPath, task.id);
	const logPath = secureBackgroundOutputPath(sessionDirectory, logs.path, task.id);
	if (taskPath !== logPath) throw new Error("verification_evidence background task log path does not match task metadata");
	if (logs.bytesRead > MAX_EXPOSED_OUTPUT_BYTES) {
		throw new Error(`verification_evidence background task logs exceed ${MAX_EXPOSED_OUTPUT_BYTES} bytes`);
	}
	let descriptor: number | undefined;
	try {
		if (typeof constants.O_NOFOLLOW !== "number") throw new Error("verification_evidence no-follow output reads are unavailable");
		descriptor = openSync(taskPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile()) throw new Error("verification_evidence background task output path is not a regular file");
		if (metadata.size !== task.bytesWritten) {
			throw new Error("verification_evidence background task output length does not match task metadata");
		}
		const bytes = readFileSync(descriptor);
		if (bytes.byteLength !== task.bytesWritten) {
			throw new Error("verification_evidence background task output length does not match task metadata");
		}
		return bytes;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("verification_evidence")) throw error;
		throw new Error(`verification_evidence could not read background task output: ${String(error)}`);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

async function captureCandidateWithRunner(
	run: CandidateCommand,
	sessionDirectory: string,
	signal: AbortSignal | undefined,
	repositoryRoot?: string,
	source?: "staged",
): Promise<CandidateIdentity> {
	const repository = await discoverRepository(run, sessionDirectory, signal, repositoryRoot);
	return snapshotCandidate(run, repository, signal, source);
}

export async function captureCandidate(
	ctx: VerificationToolContext,
	signal?: AbortSignal,
	repositoryRoot?: string,
	source?: "staged",
): Promise<CandidateIdentity> {
	return captureCandidateWithRunner(candidateCommand(ctx), ctx.cwd, signal, repositoryRoot, source);
}

export async function captureCandidateWithExec(
	exec: CandidateExec,
	sessionDirectory: string,
	signal?: AbortSignal,
	repositoryRoot?: string,
	source?: "staged",
): Promise<CandidateIdentity> {
	return captureCandidateWithRunner(directCandidateCommand(exec), sessionDirectory, signal, repositoryRoot, source);
}

function stagedSnapshotExec(ctx: VerificationToolContext, signal?: AbortSignal): CandidateExec {
	return async (file, args, options) => {
		const cwd = options?.cwd ?? ctx.cwd;
		const timeout = options?.timeout ?? CANDIDATE_TIMEOUT_SECONDS * 1000;
		const commandSignal = options?.signal ?? signal;
		if (ctx.exec) return ctx.exec(file, args, { cwd, timeout, signal: commandSignal });
		const result = await executeBash(ctx, `cd ${shellQuote(cwd)} && ${[file, ...args].map(shellQuote).join(" ")}`, timeout / 1000, commandSignal);
		return { stdout: result.output, stderr: "", code: result.exitCode, killed: false };
	};
}

async function prepareStagedCheck(
	ctx: VerificationToolContext,
	params: VerificationCheckSource,
	before: CandidateIdentity,
	cwd: string,
	signal?: AbortSignal,
): Promise<StagedSnapshot | undefined> {
	if (params.source === undefined) return undefined;
	const snapshot = await createStagedSnapshot(stagedSnapshotExec(ctx, signal), before.repositoryRoot, cwd, params.runtimeInputs);
	try {
		await snapshot.validate();
		if (snapshot.head !== before.head || snapshot.tree !== before.tree) throw new Error("staged candidate changed during snapshot preparation");
		return snapshot;
	} catch (error) {
		snapshot.cleanup();
		throw error;
	}
}

function candidateWithRuntimeInputs(candidate: CandidateIdentity, snapshot?: StagedSnapshot): CandidateIdentity {
	return snapshot?.runtimeInputs.length
		? createCandidateIdentity({ ...candidate, runtimeInputs: snapshot.runtimeInputs })
		: candidate;
}

async function candidateInvalidReason(
	ctx: VerificationToolContext,
	candidate: CandidateIdentity,
	signal?: AbortSignal,
	snapshot?: StagedSnapshot,
): Promise<string | undefined> {
	if (snapshot) {
		try {
			await snapshot.validate();
			return undefined;
		} catch (error) {
			return `staged verification invalid: ${String(error)}`;
		}
	}
	const after = await captureCandidate(ctx, signal, candidate.repositoryRoot);
	return candidate.id === after.id ? undefined : "candidate changed during verification";
}

export async function executeVerification(
	toolCallId: string,
	params: Extract<VerificationEvidenceInput, { operation: "run" }>,
	ctx: VerificationToolContext,
	signal?: AbortSignal,
	writeLog: typeof writeVerificationLog = writeVerificationLog,
): Promise<VerificationRunResult> {
	const command = canonicalCommand(params.argv);
	validateTimeout(params.timeout);
	const cwd = canonicalCwd(params.cwd);
	const repository = await discoverRepository(candidateCommand(ctx), ctx.cwd, signal, params.repositoryRoot);
	const workingDirectory = repositoryCwd(repository.root, cwd);
	rejectGitMutations(params.argv, workingDirectory.absolute);
	const attempt = beginVerificationAttempt(repository.root, command, workingDirectory.relative);
	const runCandidateCommand = candidateCommand(ctx);
	const before = await snapshotCandidate(runCandidateCommand, repository, signal, params.source);
	const stagedSnapshot = await prepareStagedCheck(ctx, params, before, cwd, signal);
	try {
		const candidate = candidateWithRuntimeInputs(before, stagedSnapshot);
		const commandResult = await executeBash(
			ctx,
			`cd ${shellQuote(stagedSnapshot?.cwd ?? workingDirectory.absolute)} && ${command}`,
			params.timeout,
			signal,
		);
		const invalidReason = await candidateInvalidReason(ctx, candidate, signal, stagedSnapshot);
		const valid = invalidReason === undefined;
		if (invalidReason !== undefined) invalidateVerificationEvidence(invalidReason);
		const log = writeLog(toolCallId, commandResult.output);
		const evidence = recordVerificationEvidence({
			command,
			argv: params.argv,
			cwd: workingDirectory.relative,
			candidate,
			exitCode: commandResult.exitCode,
			logPath: log.path,
			logSha256: log.sha256,
			valid,
			invalidReason,
		}, attempt);
		return { operation: "run", protocolVersion: VERIFICATION_PROTOCOL_VERSION, evidence, output: summarizedOutput(commandResult.output, commandResult.exitCode) };
	} finally {
		stagedSnapshot?.cleanup();
	}
}

async function executeVerificationStart(
	params: Extract<VerificationEvidenceInput, { operation: "start" }>,
	ctx: VerificationToolContext,
	signal: AbortSignal | undefined,
	events: EventBus | undefined,
): Promise<VerificationStartResult> {
	const command = canonicalCommand(params.argv);
	validateTimeout(params.timeout);
	const cwd = canonicalCwd(params.cwd);
	const repository = await discoverRepository(candidateCommand(ctx), ctx.cwd, signal, params.repositoryRoot);
	const workingDirectory = repositoryCwd(repository.root, cwd);
	rejectGitMutations(params.argv, workingDirectory.absolute);
	if (!events) throw new Error("verification_evidence background task service is unavailable");
	const attempt = beginVerificationAttempt(repository.root, command, workingDirectory.relative);
	const before = await snapshotCandidate(candidateCommand(ctx), repository, signal, params.source);
	const stagedSnapshot = await prepareStagedCheck(ctx, params, before, cwd, signal);
	const candidate = candidateWithRuntimeInputs(before, stagedSnapshot);
	const eventState = verificationEventState(events);
	const pendingStart: PendingVerificationStart = { terminalTasks: new Map() };
	eventState.pendingStarts.add(pendingStart);
	let transferred = false;
	try {
		const task = await requestBackgroundTask(events, "run", {
			name: "Verification",
			command: `cd ${shellQuote(stagedSnapshot?.cwd ?? workingDirectory.absolute)} && ${command}`,
			isAgent: false,
			timeoutSeconds: params.timeout,
			notifyOnCompletion: true,
			triggerOnCompletion: true,
		});
		if (task.isAgent || !task.notifyOnCompletion || !task.triggerOnCompletion) {
			throw new Error("verification_evidence background task did not satisfy the verification run contract");
		}
		if (eventState.startedTasks.has(task.id)) throw new Error(`verification_evidence task ${task.id} was already started`);
		const started: StartedVerificationTask = {
			candidate,
			stagedSnapshot,
			attempt,
			command,
			argv: Object.freeze([...params.argv]),
			cwd: workingDirectory.relative,
			repositoryRoot: repository.root,
			outputDirectory: realpathSync(ctx.cwd),
			task,
			...(task.status === "running" ? { terminal: pendingStart.terminalTasks.get(task.id) } : { terminal: task }),
		};
		eventState.startedTasks.set(task.id, started);
		transferred = true;
		return {
			operation: "start",
			protocolVersion: VERIFICATION_PROTOCOL_VERSION,
			taskId: task.id,
			task,
			candidate,
			command,
			argv: started.argv,
			cwd: workingDirectory.relative,
		};
	} finally {
		eventState.pendingStarts.delete(pendingStart);
		if (!transferred) stagedSnapshot?.cleanup();
	}
}

async function executeVerificationCollect(
	toolCallId: string,
	params: Extract<VerificationEvidenceInput, { operation: "collect" }>,
	ctx: VerificationToolContext,
	signal: AbortSignal | undefined,
	events: EventBus | undefined,
): Promise<VerificationCollectResult> {
	if (!events) throw new Error("verification_evidence background task service is unavailable");
	const eventState = verificationEventState(events);
	const started = eventState.startedTasks.get(params.taskId);
	if (!started) throw new Error(`verification_evidence task ${params.taskId} is unknown in this loaded session. Conversation resume does not restore task ownership; return to its live owner or reconcile the original owned process before starting a fresh check.`);
	if (started.result) throw new Error(`verification_evidence task ${params.taskId} was already collected`);

	let terminal = started.terminal;
	if (!terminal) {
		const status = await requestBackgroundTask(events, "status", { taskId: params.taskId });
		terminal = status.tasks.find((task) => task.id === params.taskId);
		if (!terminal) throw new Error(`verification_evidence task ${params.taskId} was not found by the background task service`);
	}
	if (terminal.status === "running") {
		return {
			operation: "collect", protocolVersion: VERIFICATION_PROTOCOL_VERSION, state: "pending",
			taskId: params.taskId, nextAction: "wait-for-terminal-notification",
		};
	}

	try {
		const logs = await requestBackgroundTask(events, "logs", {
			taskId: params.taskId,
			maxBytes: MAX_EXPOSED_OUTPUT_BYTES,
			tail: false,
		});
		const outputBytes = readBackgroundOutput(started.outputDirectory, terminal, logs);
		const candidateError = await candidateInvalidReason(ctx, started.candidate, signal, started.stagedSnapshot);
		const candidateUnchanged = candidateError === undefined;
		if (candidateError !== undefined) invalidateVerificationEvidence(candidateError);
		const terminalExitCode = terminal.exitCode;
		const hasNumericExit = typeof terminalExitCode === "number" && Number.isInteger(terminalExitCode);
		const exitCode = hasNumericExit ? terminalExitCode : -1;
		const valid = candidateUnchanged && hasNumericExit;
		const invalidReason = candidateUnchanged
			? (hasNumericExit ? undefined : `background verification task ${terminal.status} did not report a numeric exit code`)
			: candidateError;
		const log = writeVerificationLogBytes(toolCallId, outputBytes);
		const evidence = recordVerificationEvidence({
			command: started.command,
			argv: started.argv,
			cwd: started.cwd,
			candidate: started.candidate,
			exitCode,
			logPath: log.path,
			logSha256: log.sha256,
			valid,
			invalidReason,
		}, started.attempt);
		const result: VerificationCollectedResult = {
			operation: "collect",
			protocolVersion: VERIFICATION_PROTOCOL_VERSION,
			state: "collected",
			evidence,
			output: summarizedOutput(outputBytes.toString("utf8"), exitCode),
		};
		started.terminal = terminal;
		started.result = result;
		return result;
	} catch (error) {
		started.terminal = terminal;
		started.collectionFailed = true;
		throw error;
	} finally {
		started.stagedSnapshot?.cleanup();
	}
}

function contentFor(result: VerificationEvidenceResult): string {
	return JSON.stringify(result);
}

async function executeVerificationStartBatch(
	params: Extract<VerificationEvidenceInput, { operation: "start_batch" }>,
	ctx: VerificationToolContext,
	signal: AbortSignal | undefined,
	events: EventBus | undefined,
): Promise<VerificationStartBatchResult> {
	const outcomes = await Promise.all(params.checks.map(async (check, index): Promise<VerificationBatchOutcome<VerificationStartResult>> => {
		try {
			return { index, result: await executeVerificationStart({ operation: "start", ...check }, ctx, signal, events) };
		} catch (error) {
			return { index, error: String(error) };
		}
	}));
	return { operation: "start_batch", protocolVersion: VERIFICATION_PROTOCOL_VERSION, outcomes };
}

async function executeVerificationCollectBatch(
	toolCallId: string,
	params: Extract<VerificationEvidenceInput, { operation: "collect_batch" }>,
	ctx: VerificationToolContext,
	signal: AbortSignal | undefined,
	events: EventBus | undefined,
): Promise<VerificationCollectBatchResult> {
	const outcomes = await Promise.all(params.taskIds.map(async (taskId, index): Promise<VerificationBatchOutcome<VerificationCollectResult>> => {
		try {
			return {
				index,
				result: await executeVerificationCollect(`${toolCallId}-${index}`, { operation: "collect", taskId }, ctx, signal, events),
			};
		} catch (error) {
			return { index, error: String(error) };
		}
	}));
	return { operation: "collect_batch", protocolVersion: VERIFICATION_PROTOCOL_VERSION, outcomes };
}

export async function executeVerificationEvidence(
	toolCallId: string,
	params: VerificationEvidenceInput,
	signal: AbortSignal | undefined,
	ctx: VerificationToolContext,
	events?: EventBus,
): Promise<AgentToolResult<VerificationEvidenceResult>> {
	if (params.operation === "capture") {
		const result: CandidateCaptureResult = { operation: "capture", protocolVersion: VERIFICATION_PROTOCOL_VERSION, candidate: await captureCandidate(ctx, signal, params.repositoryRoot, params.source) };
		return { content: [{ type: "text", text: contentFor(result) }], details: result, structuredContent: result };
	}
	if (params.operation === "start_batch") {
		const result = await executeVerificationStartBatch(params, ctx, signal, events);
		const isError = result.outcomes.some((outcome) => "error" in outcome);
		return { content: [{ type: "text", text: contentFor(result) }], details: result, structuredContent: result, ...(isError ? { isError: true } : {}) };
	}
	if (params.operation === "collect_batch") {
		const result = await executeVerificationCollectBatch(toolCallId, params, ctx, signal, events);
		const isError = result.outcomes.some((outcome) => "error" in outcome
			|| (outcome.result.state === "collected" && (outcome.result.evidence.exitCode !== 0 || !outcome.result.evidence.valid)));
		return { content: [{ type: "text", text: contentFor(result) }], details: result, structuredContent: result, isError };
	}
	if (params.operation === "start") {
		const result = await executeVerificationStart(params, ctx, signal, events);
		return { content: [{ type: "text", text: contentFor(result) }], details: result, structuredContent: result };
	}
	if (params.operation === "collect") {
		const result = await executeVerificationCollect(toolCallId, params, ctx, signal, events);
		return {
			content: [{ type: "text", text: contentFor(result) }],
			details: result,
			structuredContent: result,
			isError: result.state === "collected" && (result.evidence.exitCode !== 0 || !result.evidence.valid),
		};
	}
	const result = await executeVerification(toolCallId, params, ctx, signal);
	return {
		content: [{ type: "text", text: contentFor(result) }],
		details: result,
		structuredContent: result,
		isError: result.evidence.exitCode !== 0 || !result.evidence.valid,
	};
}

export function registerVerificationEvidence(pi: ExtensionAPI): void {
	if (pi.events) {
		const events = pi.events;
		const state = verificationEventState(events);
		let sessionId: string | undefined;
		let generation = randomUUID();
		pi.on("session_start", (_event, ctx) => {
			sessionId = ctx.sessionManager.getSessionId();
			generation = randomUUID();
		});
		pi.on("tool_result", async (event, ctx) => {
			if (event.toolName !== "verification_evidence" || !isRecord(event.input)
				|| !sessionId || ctx.sessionManager.getSessionId() !== sessionId) return;
			let surfaced: { taskId: string; result: unknown }[] = [];
			if (event.input.operation === "collect" && typeof event.input.taskId === "string") {
				surfaced = [{ taskId: event.input.taskId, result: event.details }];
			} else if (event.input.operation === "collect_batch" && Array.isArray(event.input.taskIds)
				&& isRecord(event.details) && event.details.operation === "collect_batch" && Array.isArray(event.details.outcomes)) {
				const taskIds = event.input.taskIds;
				surfaced = event.details.outcomes.flatMap((outcome) => {
					if (!isRecord(outcome) || typeof outcome.index !== "number" || !Number.isInteger(outcome.index)) return [];
					const taskId = taskIds[outcome.index];
					return typeof taskId === "string" ? [{ taskId, result: outcome.result }] : [];
				});
			}
			const taskIds = surfaced.filter(({ taskId, result }) => {
				const collected = state.startedTasks.get(taskId)?.result;
				return collected?.evidence.valid && collected === result;
			}).map(({ taskId }) => taskId);
			if (taskIds.length === 0) return;
			const ownerSessionId = sessionId;
			const ownerGeneration = generation;
			const capabilities = await requestBackgroundTask(events, "capabilities", {});
			if (!capabilities.completion_acknowledgement || sessionId !== ownerSessionId || generation !== ownerGeneration) return;
			await Promise.all(taskIds.map((taskId) => requestBackgroundTask(events, "acknowledge", { taskId, sessionId: ownerSessionId })));
		});
		events.on(VERIFICATION_STATUS_REQUEST, (value) => {
			const request = parseWorkStatusRequest(value);
			if (!request || !sessionId || request.sessionId !== sessionId) return;
			events.emit(VERIFICATION_STATUS_RESPONSE, {
				...request,
				generation,
				starting: state.pendingStarts.size,
				uncollectedTaskIds: [...state.startedTasks]
					.filter(([, task]) => !task.result && !task.collectionFailed)
					.map(([taskId]) => taskId).sort(),
			});
		});
		pi.on("session_shutdown", async () => {
			sessionId = undefined;
			const errors: Error[] = [];
			for (const [taskId, started] of state.startedTasks) {
				if (!started.stagedSnapshot) continue;
				try {
					let terminal = started.terminal;
					if (!terminal) {
						const status = await requestBackgroundTask(events, "status", { taskId });
						terminal = status.tasks.find((task) => task.id === taskId);
						if (!terminal) throw new Error("background task service did not return this task");
					}
					if (terminal.status === "running") {
						terminal = (await requestBackgroundTask(events, "kill", { taskId })).task;
						if (terminal.status === "running") throw new Error("background task remained running after kill");
					}
					started.stagedSnapshot.cleanup();
				} catch (error) {
					errors.push(new Error(`staged verification shutdown failed for task ${taskId}: ${String(error)}`, { cause: error }));
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
		});
	}
	pi.registerTool({
		name: "verification_evidence",
		label: "Verification evidence",
		description: "Capture a Git candidate or run one exact argv check synchronously. Use start or start_batch, then collect or collect_batch; batch outcomes keep each task, candidate, log, and failure separate. Output is capped at 4096 bytes; full output remains in the hashed log.",
		promptSnippet: "Capture, run, or start/collect bounded verification evidence",
		promptGuidelines: [
			"Capture before checks. Supply exact argv, repository-relative cwd, and timeout.",
			"For independent checks, use start_batch and collect_batch. Otherwise, use start and collect. Wait for automatic terminal notifications without polling.",
			"Use run only for explicit requests, unavailable background service, or a stated same-turn correctness or lifecycle requirement.",
			"For staged snapshots, set source: staged. Use runtimeInputs only with staged snapshots. For working-tree checks, omit both fields and hash ignored inputs before and after execution. Staged receipts pin manifests. Changes to HEAD, the index, source, or inputs invalidate staged receipts. If snapshot prerequisites are missing, block instead of using working files.",
			"Treat command failures and changed candidates as failures. Require protocolVersion: 2 in every result. If absent, reconcile active work before reloading.",
			"A pending collect has no evidence. Wait for terminal notification, then collect. Treat unknown task ownership as an error.",
			"While starts register, tasks run, or results remain uncollected, keep the helper open. If abandoning work, cancel owned tasks and collect terminal results.",
			"Copy evidence.verifiedBy verbatim into the handoff. Child Bash commands, edits, and writes invalidate child receipts. After final child checks, use read, grep, and find. Reuse finalized child results only while source and declared inputs remain unchanged. Ordinary parent receipts retain candidate-based freshness.",
		],
		parameters: VERIFICATION_EVIDENCE_PARAMETERS,
		outputSchema: VERIFICATION_EVIDENCE_OUTPUT_SCHEMA,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		execute: async (
			toolCallId: string,
			params: VerificationEvidenceInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<VerificationEvidenceResult> | undefined,
			ctx: ExtensionToolContext,
		) => executeVerificationEvidence(toolCallId, params, signal, {
			cwd: ctx.cwd,
			executeTool: ctx.executeTool.bind(ctx),
			exec: (file, args, options) => pi.exec(file, args, options),
		}, pi.events),
	});
}
