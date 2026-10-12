import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	beginVerificationAttempt,
	createCandidateIdentity,
	invalidateVerificationEvidence,
	recordVerificationEvidence,
	type CandidateIdentity,
	type VerificationEvidence,
} from "./verification-store.ts";

const MAX_TIMEOUT_SECONDS = 600;
const CANDIDATE_TIMEOUT_SECONDS = 30;
export const MAX_EXPOSED_OUTPUT_BYTES = 4096;
const VERIFICATION_LOG_DIRECTORY = join(tmpdir(), "pi", "verification");

export const VERIFICATION_EVIDENCE_PARAMETERS = {
	oneOf: [
		{
			type: "object",
			properties: {
				operation: { const: "capture" },
				repositoryRoot: { type: "string", minLength: 1 },
			},
			required: ["operation"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				operation: { const: "run" },
				repositoryRoot: { type: "string", minLength: 1 },
				argv: { type: "array", items: { type: "string" }, minItems: 1 },
				cwd: { type: "string", minLength: 1 },
				timeout: { type: "number", exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS },
			},
			required: ["operation", "argv", "cwd", "timeout"],
			additionalProperties: false,
		},
	],
} as const;
export type VerificationEvidenceInput =
	| { operation: "capture"; repositoryRoot?: string }
	| { operation: "run"; repositoryRoot?: string; argv: string[]; cwd: string; timeout: number };

const candidateOutputSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		repositoryRoot: { type: "string" },
		head: { type: ["string", "null"] },
		tree: { type: "string" },
		kind: { type: "string", enum: ["clean", "dirty"] },
	},
	required: ["id", "repositoryRoot", "head", "tree", "kind"],
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
	},
	required: ["id", "command", "argv", "cwd", "candidate", "exitCode", "logPath", "logSha256", "valid"],
	additionalProperties: false,
} as const;
export const VERIFICATION_EVIDENCE_OUTPUT_SCHEMA = {
	oneOf: [
		{
			type: "object",
			properties: { operation: { const: "capture" }, candidate: candidateOutputSchema },
			required: ["operation", "candidate"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { operation: { const: "run" }, evidence: evidenceOutputSchema, output: { type: "string" } },
			required: ["operation", "evidence", "output"],
			additionalProperties: false,
		},
	],
} as const;

export type VerificationToolContext = Pick<ExtensionToolContext, "cwd" | "executeTool">;

export type CandidateCaptureResult = Readonly<{
	operation: "capture";
	candidate: CandidateIdentity;
}>;

export type VerificationRunResult = Readonly<{
	operation: "run";
	evidence: VerificationEvidence;
	output: string;
}>;

export type VerificationEvidenceResult = CandidateCaptureResult | VerificationRunResult;

type BashOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
type Repository = Readonly<{
	root: string;
	indexPath: string;
	commonDirectory: string;
}>;
type BashResult = Readonly<{ exitCode: number; output: string }>;

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

async function executeGit(
	ctx: VerificationToolContext,
	root: string,
	gitArguments: readonly string[],
	signal: AbortSignal | undefined,
): Promise<BashResult> {
	const command = `cd ${shellQuote(root)} && git ${gitArguments.map(shellQuote).join(" ")}`;
	const result = await executeBash(ctx, command, CANDIDATE_TIMEOUT_SECONDS, signal);
	if (result.exitCode !== 0) {
		const output = result.output.trim();
		throw new Error(`verification_evidence git command failed with exit ${result.exitCode}${output ? `: ${output}` : ""}`);
	}
	return result;
}

async function discoverRepositoryAt(
	ctx: VerificationToolContext,
	directory: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Repository> {
	const prefix = directory === undefined ? "" : `cd ${shellQuote(directory)} && `;
	const rootResult = await executeBash(ctx, `${prefix}git rev-parse --show-toplevel`, CANDIDATE_TIMEOUT_SECONDS, signal);
	if (rootResult.exitCode !== 0) {
		throw new Error("verification_evidence requires a Git working tree; repository discovery failed");
	}
	let root: string;
	try {
		root = realpathSync(singleLineOutput(rootResult.output, "the repository root"));
	} catch (error) {
		throw new Error(`verification_evidence could not resolve the repository root: ${String(error)}`);
	}
	const workTree = singleLineOutput((await executeGit(ctx, root, ["rev-parse", "--is-inside-work-tree"], signal)).output, "Git work-tree status");
	if (workTree !== "true") throw new Error("verification_evidence requires a Git working tree");
	const indexPathValue = singleLineOutput((await executeGit(ctx, root, ["rev-parse", "--git-path", "index"], signal)).output, "the Git index path");
	const commonDirectoryValue = singleLineOutput((await executeGit(ctx, root, ["rev-parse", "--git-common-dir"], signal)).output, "the Git common directory");
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

async function discoverRepository(
	ctx: VerificationToolContext,
	signal: AbortSignal | undefined,
	repositoryRoot?: string,
): Promise<Repository> {
	const sessionRepository = await discoverRepositoryAt(ctx, undefined, signal);
	if (repositoryRoot === undefined) return sessionRepository;
	const requestedRoot = canonicalRepositoryRoot(repositoryRoot);
	const requestedRepository = requestedRoot === sessionRepository.root
		? sessionRepository
		: await discoverRepositoryAt(ctx, requestedRoot, signal);
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

async function snapshotCandidate(
	ctx: VerificationToolContext,
	repository: Repository,
	signal: AbortSignal | undefined,
): Promise<CandidateIdentity> {
	let headResult: BashResult;
	try {
		headResult = await executeGit(ctx, repository.root, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
	} catch (error) {
		const message = String(error);
		if (!message.includes("git command failed with exit")) throw error;
		throw new Error(`verification_evidence cannot capture an unborn HEAD; repository has no commit: ${message}`);
	}
	const head = singleLineOutput(headResult.output, "HEAD");
	const headTree = singleLineOutput(
		(await executeGit(ctx, repository.root, ["rev-parse", `${head}^{tree}`], signal)).output,
		"the HEAD tree",
	);
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-verification-index-"));
	const temporaryIndex = join(temporaryDirectory, "index");
	try {
		if (existsSync(repository.indexPath)) copyFileSync(repository.indexPath, temporaryIndex);
		const addResult = await executeBash(
			ctx,
			`cd ${shellQuote(repository.root)} && GIT_INDEX_FILE=${shellQuote(temporaryIndex)} git add -A`,
			CANDIDATE_TIMEOUT_SECONDS,
			signal,
		);
		if (addResult.exitCode !== 0) {
			const output = boundedOutput(addResult.output).trim();
			throw new Error(`temporary Git index staging failed with exit ${addResult.exitCode}${output ? `: ${output}` : ""}`);
		}
		const treeResult = await executeBash(
			ctx,
			`cd ${shellQuote(repository.root)} && GIT_INDEX_FILE=${shellQuote(temporaryIndex)} git write-tree`,
			CANDIDATE_TIMEOUT_SECONDS,
			signal,
		);
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

function writeVerificationLog(toolCallId: string, output: string): { path: string; sha256: string } {
	mkdirSync(VERIFICATION_LOG_DIRECTORY, { recursive: true, mode: 0o700 });
	chmodSync(VERIFICATION_LOG_DIRECTORY, 0o700);
	const path = join(VERIFICATION_LOG_DIRECTORY, `verification-${hashText(toolCallId)}-${randomUUID()}.log`);
	const bytes = Buffer.from(output);
	writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
	chmodSync(path, 0o600);
	return { path, sha256: hashBytes(bytes) };
}

export async function captureCandidate(
	ctx: VerificationToolContext,
	signal?: AbortSignal,
	repositoryRoot?: string,
): Promise<CandidateIdentity> {
	const repository = await discoverRepository(ctx, signal, repositoryRoot);
	return snapshotCandidate(ctx, repository, signal);
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
	const repository = await discoverRepository(ctx, signal, params.repositoryRoot);
	const workingDirectory = repositoryCwd(repository.root, cwd);
	const attempt = beginVerificationAttempt(repository.root, command, workingDirectory.relative);
	const before = await snapshotCandidate(ctx, repository, signal);
	const commandResult = await executeBash(
		ctx,
		`cd ${shellQuote(workingDirectory.absolute)} && ${command}`,
		params.timeout,
		signal,
	);
	const after = await snapshotCandidate(ctx, repository, signal);
	const valid = before.id === after.id;
	if (!valid) invalidateVerificationEvidence("candidate changed during verification");
	const log = writeLog(toolCallId, commandResult.output);
	const evidence = recordVerificationEvidence({
		command,
		argv: params.argv,
		cwd: workingDirectory.relative,
		candidate: before,
		exitCode: commandResult.exitCode,
		logPath: log.path,
		logSha256: log.sha256,
		valid,
		invalidReason: valid ? undefined : "candidate changed during verification",
	}, attempt);
	return { operation: "run", evidence, output: boundedOutput(commandResult.output) };
}

function contentFor(result: VerificationEvidenceResult): string {
	return JSON.stringify(result);
}

export async function executeVerificationEvidence(
	toolCallId: string,
	params: VerificationEvidenceInput,
	signal: AbortSignal | undefined,
	ctx: VerificationToolContext,
): Promise<AgentToolResult<VerificationEvidenceResult>> {
	if (params.operation === "capture") {
		const result: CandidateCaptureResult = { operation: "capture", candidate: await captureCandidate(ctx, signal, params.repositoryRoot) };
		return { content: [{ type: "text", text: contentFor(result) }], details: result, structuredContent: result };
	}
	const result = await executeVerification(toolCallId, params, ctx, signal);
	return {
		content: [{ type: "text", text: contentFor(result) }],
		details: result,
		structuredContent: result,
		isError: result.evidence.exitCode !== 0 || !result.evidence.valid,
	};
}

export function registerVerificationEvidence(
	pi: ExtensionAPI,
	env: Readonly<Record<string, string | undefined>> = process.env,
): void {
	const hideNestedBash = env.PI_SUBAGENT_AGENT === "verification-runner";
	pi.registerTool({
		name: "verification_evidence",
		label: "Verification evidence",
		description: "Capture a Git candidate or run one exact argv check against an immutable candidate identity, optionally in a linked worktree.",
		promptSnippet: "Capture or run bounded verification evidence",
		promptGuidelines: [
			"Use capture before coordinating checks and run only one exact argument vector with a repository-relative cwd; repositoryRoot may select an absolute linked-worktree root.",
			"A failed command or changed candidate is evidence of failure; do not mask either result.",
		],
		parameters: VERIFICATION_EVIDENCE_PARAMETERS,
		outputSchema: VERIFICATION_EVIDENCE_OUTPUT_SCHEMA,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		...(hideNestedBash ? { prepareLoadout: () => ({ hiddenDeclarations: ["bash"] }) } : {}),
		execute: async (
			toolCallId: string,
			params: VerificationEvidenceInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<VerificationEvidenceResult> | undefined,
			ctx: ExtensionToolContext,
		) => executeVerificationEvidence(toolCallId, params, signal, ctx),
	});
}
