import { createHash } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { REVIEW_ARTIFACT_ROOT } from "../guardrails/guardrails.ts";
import { isRecord } from "../lib/shared.ts";
import {
	captureCandidateWithExec,
	type CandidateExec,
} from "./verification.ts";
import type { CandidateIdentity } from "./verification-store.ts";
import { AGENT_OUTPUT } from "./schemas.ts";
import { validate } from "./validate.ts";

const CANDIDATE_TIMEOUT_SECONDS = 30;
const REVIEW_DIRECTORY = join(REVIEW_ARTIFACT_ROOT, "review-preparation");
const ROOT_MUTATION_TOOLS = new Set(["bash", "edit", "write"]);
const DELEGATED_MUTATION_AGENTS = new Set(["implementation-engineer", "test-automation-engineer"]);
const GENERATED_METADATA_PREFIXES = ["Candidate:", "Patch SHA-256:", "Patch artifact:", "Review paths:", "Excluded pre-dirty paths:", "Review target:", "Staged path mapping:"] as const;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type DiffRecord = Readonly<{
	status: string;
	oldPath?: string;
	newPath?: string;
}>;

export type TaskBoundary = Readonly<{
	candidate: CandidateIdentity;
}>;

type ExecResult = Readonly<{
	stdout: string;
	stderr: string;
	code: number;
}>;

export type ReviewPreparationResult = Readonly<{
	candidate: CandidateIdentity;
	patchArtifact: string;
	patchSha256: string;
	reviewPaths: readonly string[];
	excludedPreDirtyPaths: readonly string[];
	reviewTarget?: "staged";
	stagedPathMapping?: readonly Readonly<{ reviewPath: string; originalPath: string; blob: string; sha256: string }>[];
}>;

function isWithin(root: string, candidate: string): boolean {
	const nested = relative(root, candidate);
	return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function commandError(argv: readonly string[], result: ExecResult): Error {
	const detail = result.stderr.trim() || result.stdout.trim();
	return new Error(`review preparation Git command failed with exit ${result.code}: ${argv.join(" ")}${detail ? `: ${detail}` : ""}`);
}

async function executeGit(
	exec: CandidateExec,
	cwd: string,
	argv: readonly string[],
	signal: AbortSignal | undefined,
): Promise<string> {
	let result: ExecResult;
	try {
		result = await exec("git", [...argv], { cwd, signal, timeout: CANDIDATE_TIMEOUT_SECONDS * 1000 });
	} catch (error) {
		throw new Error(`review preparation could not execute Git: ${String(error)}`);
	}
	if (result.code !== 0) throw commandError(["git", ...argv], result);
	return result.stdout;
}

export function parseNameStatus(output: string): DiffRecord[] {
	const fields = output.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const records: DiffRecord[] = [];
	for (let index = 0; index < fields.length;) {
		const status = fields[index++];
		if (status === undefined || status.length === 0) throw new Error("review preparation received malformed Git name-status output");
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = fields[index++];
			const newPath = fields[index++];
			if (oldPath === undefined || newPath === undefined) throw new Error("review preparation received an incomplete Git rename record");
			records.push({ status, oldPath, newPath });
			continue;
		}
		const path = fields[index++];
		if (path === undefined) throw new Error("review preparation received an incomplete Git name-status record");
		records.push({
			status,
			...(status.startsWith("D") ? { oldPath: path } : { newPath: path }),
		});
	}
	return records;
}

function recordPaths(record: DiffRecord): string[] {
	return [record.oldPath, record.newPath].filter((path): path is string => path !== undefined);
}

type ParsedReviewRange = Readonly<{ left: string; operator?: ".." | "..."; right?: string }>;

function parseReviewRange(value: string): ParsedReviewRange | undefined {
	const operator = value.includes("...") ? "..." : value.includes("..") ? ".." : undefined;
	if (operator === undefined) return REVISION.test(value) ? { left: value } : undefined;
	const separator = value.indexOf(operator);
	const left = value.slice(0, separator);
	const right = value.slice(separator + operator.length);
	if (!REVISION.test(left) || !REVISION.test(right) || left.includes("..") || right.includes("..")) return undefined;
	return { left, operator, right };
}

function requestedReviewTarget(task: string): "staged" | undefined {
	const matches = [...task.matchAll(/^ {0,3}Review target:[ \t]*(.*)$/gm)];
	if (matches.length > 1) throw new Error("review preparation accepts exactly one Review target line");
	const value = matches[0]?.[1].trim();
	if (value !== undefined && value !== "staged") throw new Error(`review preparation received unknown Review target: ${value || "<empty>"}`);
	return value;
}

function requestedReviewRange(task: string): string | undefined {
	const matches = [...task.matchAll(/^ {0,3}Review range:[ \t]*(\S+)[ \t]*$/gm)];
	if (matches.length > 1) throw new Error("review preparation accepts exactly one Review range line");
	const value = matches[0]?.[1];
	if (value !== undefined && parseReviewRange(value) === undefined) {
		throw new Error(`review preparation received invalid Review range: ${value}`);
	}
	return value;
}

async function resolveCommit(
	exec: CandidateExec,
	repositoryRoot: string,
	revision: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const commit = (await executeGit(exec, repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`], signal)).trim();
	if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`review preparation received invalid commit for Review range: ${revision}`);
	return commit;
}

async function reviewDiffArguments(
	exec: CandidateExec,
	boundary: TaskBoundary,
	current: CandidateIdentity,
	reviewRange: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ args: string[]; description: string }> {
	if (reviewRange === undefined) {
		return { args: [boundary.candidate.tree, current.tree], description: "task-owned diff" };
	}
	const parsed = parseReviewRange(reviewRange);
	if (!parsed) throw new Error(`review preparation received invalid Review range: ${reviewRange}`);
	const left = await resolveCommit(exec, current.repositoryRoot, parsed.left, signal);
	if (parsed.operator === undefined || parsed.right === undefined) {
		return { args: [`${left}^{tree}`, current.tree], description: `Review range: ${reviewRange}` };
	}
	const right = await resolveCommit(exec, current.repositoryRoot, parsed.right, signal);
	return { args: [`${left}${parsed.operator}${right}`], description: `Review range: ${reviewRange}` };
}

function literalPathspec(path: string): string {
	if (path.includes("\0")) throw new Error("review preparation rejects NUL bytes in Git paths");
	return `:(literal)${path}`;
}

function absolutePaths(root: string, paths: readonly string[]): string[] {
	return [...new Set(paths)].sort().map((path) => {
		const absolute = resolve(root, path);
		if (!isWithin(root, absolute)) throw new Error(`review preparation Git path escapes the repository: ${path}`);
		return absolute;
	});
}

function absoluteReviewPaths(root: string, records: readonly DiffRecord[]): string[] {
	return absolutePaths(root, records.flatMap(recordPaths));
}

function directoryDescriptor(directory: string, label: string): number {
	let descriptor: number;
	try {
		descriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ELOOP") throw new Error(`${label} cannot be a symbolic link: ${directory}`);
		throw error;
	}
	try {
		if (!fstatSync(descriptor).isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
		fchmodSync(descriptor, 0o700);
		return descriptor;
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

function ensureDirectory(directory: string, label: string): void {
	try {
		const existing = lstatSync(directory);
		if (existing.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${directory}`);
		if (!existing.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code !== "ENOENT") throw error;
		mkdirSync(directory, { mode: 0o700 });
	}
	const descriptor = directoryDescriptor(directory, label);
	closeSync(descriptor);
}

function ensureReviewDirectories(): void {
	ensureDirectory(REVIEW_ARTIFACT_ROOT, "review artifact root");
	ensureDirectory(REVIEW_DIRECTORY, "review preparation directory");
}

function writeAll(descriptor: number, bytes: Buffer): void {
	for (let offset = 0; offset < bytes.byteLength;) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
}

function openExistingPatch(path: string): number {
	try {
		return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ELOOP") throw new Error(`review preparation patch cannot be a symbolic link: ${path}`);
		throw error;
	}
}

function writePatch(path: string, bytes: Buffer): void {
	try {
		const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
		try {
			writeAll(descriptor, bytes);
			fchmodSync(descriptor, 0o600);
		} finally {
			closeSync(descriptor);
		}
		return;
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code !== "EEXIST") throw error;
	}

	const descriptor = openExistingPatch(path);
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error(`review preparation patch must be a regular file: ${path}`);
		if (!readFileSync(descriptor).equals(bytes)) throw new Error(`review preparation patch already exists with different bytes: ${path}`);
		fchmodSync(descriptor, 0o600);
	} finally {
		closeSync(descriptor);
	}
}

async function treeBlobs(
	exec: CandidateExec,
	root: string,
	tree: string,
	signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
	const output = await executeGit(exec, root, ["ls-tree", "-r", "-z", "--full-tree", tree], signal);
	const blobs = new Map<string, string>();
	for (const record of output.split("\0")) {
		if (!record) continue;
		const separator = record.indexOf("\t");
		const metadata = record.slice(0, separator).split(" ");
		const path = record.slice(separator + 1);
		const object = metadata[2];
		if (separator < 0 || metadata[1] !== "blob" || !object || !/^[0-9a-f]{40,64}$/.test(object)) {
			throw new Error("review preparation received malformed Git tree entry");
		}
		blobs.set(path, object);
	}
	return blobs;
}

function gitBlobObjectId(blob: string, bytes: Buffer): string {
	const algorithm = blob.length === 64 ? "sha256" : "sha1";
	return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function writeStagedCopy(path: string, bytes: Buffer): void {
	try {
		const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
		try {
			writeAll(descriptor, bytes);
			fchmodSync(descriptor, 0o600);
		} finally {
			closeSync(descriptor);
		}
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code !== "EEXIST") throw error;
		const descriptor = openExistingPatch(path);
		try {
			if (!fstatSync(descriptor).isFile() || !readFileSync(descriptor).equals(bytes)) {
				throw new Error(`review preparation staged context already exists with different bytes: ${path}`);
			}
		} finally {
			closeSync(descriptor);
		}
	}
}

async function stagedReviewPaths(
	exec: CandidateExec,
	candidate: CandidateIdentity,
	records: readonly DiffRecord[],
	signal: AbortSignal | undefined,
): Promise<{ paths: string[]; mapping: Array<{ reviewPath: string; originalPath: string; blob: string; sha256: string }> }> {
	if (candidate.head === null || candidate.source !== "staged") throw new Error("staged review requires a committed staged candidate");
	const root = candidate.repositoryRoot;
	const stagedBlobs = await treeBlobs(exec, root, candidate.tree, signal);
	const headBlobs = await treeBlobs(exec, root, `${candidate.head}^{tree}`, signal);
	const files = new Map<string, { originalPath: string; blob: string }>();
	for (const record of records) {
		if (record.newPath !== undefined) {
			const blob = stagedBlobs.get(record.newPath);
			if (blob) files.set(record.newPath, { originalPath: record.newPath, blob });
		}
		if (record.newPath === undefined && record.oldPath !== undefined) {
			const blob = headBlobs.get(record.oldPath);
			if (blob) files.set(record.oldPath, { originalPath: record.oldPath, blob });
		}
	}
	if (files.size === 0) throw new Error("staged review has no staged file contexts to prepare");
	const directory = join(REVIEW_DIRECTORY, `${candidate.id}-context`);
	ensureDirectory(directory, "staged review context directory");
	const mapping: Array<{ reviewPath: string; originalPath: string; blob: string; sha256: string }> = [];
	for (const { originalPath, blob } of files.values()) {
		const bytes = Buffer.from(await executeGit(exec, root, ["cat-file", "blob", blob], signal));
		if (gitBlobObjectId(blob, bytes) !== blob) {
			throw new Error(`review preparation cannot preserve staged blob bytes through text output: ${originalPath}`);
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const copy = join(directory, `${sha256}.source`);
		writeStagedCopy(copy, bytes);
		mapping.push({ reviewPath: copy, originalPath, blob, sha256 });
	}
	return { paths: mapping.map(({ reviewPath }) => reviewPath), mapping };
}

function replaceScopeMetadata(text: string, metadata: readonly string[]): string {
	const lines = text.split("\n");
	const scopeStart = lines.findIndex((line) => line.replace(/^ {0,3}/, "") === "## Scope");
	if (scopeStart < 0) return text;
	const sanitized = lines.filter((line) => {
		const normalized = line.replace(/^ {0,3}/, "");
		return !GENERATED_METADATA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
	});
	const sanitizedScopeStart = sanitized.findIndex((line) => line.replace(/^ {0,3}/, "") === "## Scope");
	let sanitizedScopeEnd = sanitized.length;
	for (let index = sanitizedScopeStart + 1; index < sanitized.length; index++) {
		if (sanitized[index].replace(/^ {0,3}/, "").startsWith("## ")) {
			sanitizedScopeEnd = index;
			break;
		}
	}
	const body = sanitized.slice(sanitizedScopeStart + 1, sanitizedScopeEnd);
	while (body.at(-1) === "") body.pop();
	const nextBody = [...body, "", ...metadata];
	const next = [...sanitized.slice(0, sanitizedScopeStart + 1), ...nextBody, ...sanitized.slice(sanitizedScopeEnd)];
	return next.join("\n");
}

function subagentLaunches(input: unknown): Array<Record<string, unknown>> {
	if (!isRecord(input)) return [];
	if (Array.isArray(input.children) && input.children.length > 0) {
		return input.children.filter((child): child is Record<string, unknown> => isRecord(child));
	}
	return [input];
}

function generatedMetadata(result: ReviewPreparationResult): string[] {
	return [
		...(result.reviewTarget === undefined ? [] : [`Review target: ${result.reviewTarget}`]),
		...(result.stagedPathMapping === undefined ? [] : [`Staged path mapping: ${JSON.stringify(result.stagedPathMapping)}`]),
		`Candidate: ${result.candidate.id}`,
		`Patch SHA-256: ${result.patchSha256}`,
		`Patch artifact: ${result.patchArtifact}`,
		`Review paths: ${JSON.stringify(result.reviewPaths)}`,
		`Excluded pre-dirty paths: ${JSON.stringify(result.excludedPreDirtyPaths)}`,
	];
}

export async function prepareReview(
	exec: CandidateExec,
	boundary: TaskBoundary,
	sessionDirectory: string,
	signal?: AbortSignal,
	reviewRange?: string,
	reviewTarget?: "staged",
): Promise<ReviewPreparationResult> {
	if (reviewTarget !== undefined && reviewRange !== undefined) {
		throw new Error("review preparation rejects mixed Review target and Review range");
	}
	const current = await captureCandidateWithExec(
		exec,
		sessionDirectory,
		signal,
		boundary.candidate.repositoryRoot,
		reviewTarget,
	);
	const diff = reviewTarget === "staged"
		? { args: [`${current.head}^{tree}`, current.tree], description: "staged candidate" }
		: await reviewDiffArguments(exec, boundary, current, reviewRange, signal);
	const records = parseNameStatus(await executeGit(
		exec,
		current.repositoryRoot,
		["diff", "--name-status", "-z", "--find-renames", ...diff.args, "--"],
		signal,
	));
	if (records.length === 0) {
		if (reviewRange === undefined) {
			throw new Error("review preparation found no task-owned diff to review; add Review range: HEAD for existing worktree changes or Review range: main...HEAD for an existing branch");
		}
		throw new Error(`review preparation found no changes for ${diff.description}`);
	}
	const originalPaths = absoluteReviewPaths(current.repositoryRoot, records);
	if (reviewTarget === "staged") ensureReviewDirectories();
	const staged = reviewTarget === "staged"
		? await stagedReviewPaths(exec, current, records, signal)
		: undefined;
	const paths = staged?.paths ?? originalPaths;
	const patch = await executeGit(
		exec,
		current.repositoryRoot,
		[
			"diff",
			"--binary",
			"--full-index",
			"--no-ext-diff",
			"--find-renames",
			...diff.args,
			"--",
			...(staged === undefined ? paths : originalPaths)
				.map((path) => literalPathspec(relative(current.repositoryRoot, path))),
		],
		signal,
	);
	const patchBytes = Buffer.from(patch);
	if (patchBytes.byteLength === 0) throw new Error(`review preparation found no patch bytes for ${diff.description}`);
	const patchSha256 = createHash("sha256").update(patchBytes).digest("hex");
	ensureReviewDirectories();
	const patchArtifact = join(REVIEW_DIRECTORY, `${current.id}-${patchSha256}.patch`);
	writePatch(patchArtifact, patchBytes);
	if (staged) {
		const after = await captureCandidateWithExec(exec, sessionDirectory, signal, current.repositoryRoot, "staged");
		if (after.id !== current.id) throw new Error("staged review HEAD or index changed during preparation");
	}
	return {
		candidate: current,
		patchArtifact,
		patchSha256,
		reviewPaths: paths,
		excludedPreDirtyPaths: [],
		...(staged === undefined ? {} : { reviewTarget: "staged" as const, stagedPathMapping: staged.mapping }),
	};
}

export function addReviewMetadata(task: string, result: ReviewPreparationResult): string {
	return replaceScopeMetadata(task, generatedMetadata(result));
}

export function registerReviewPreparation(pi: ExtensionAPI): void {
	const exec: CandidateExec = (command, args, options) => pi.exec(command, args, options);
	let boundary: TaskBoundary | undefined;
	let capturePromise: Promise<TaskBoundary> | undefined;
	const preparationPromises = new Map<string, Promise<ReviewPreparationResult>>();

	const captureBoundary = (ctx: { cwd: string; signal?: AbortSignal }): Promise<TaskBoundary> => {
		if (capturePromise) return capturePromise;
		capturePromise = (async () => {
			const candidate = await captureCandidateWithExec(exec, ctx.cwd, ctx.signal);
			if (candidate.head === null) throw new Error("review preparation requires a committed HEAD");
			return { candidate };
		})().then((next) => {
			boundary = next;
			return next;
		}).finally(() => {
			capturePromise = undefined;
		});
		return capturePromise;
	};

	const currentHead = async (ctx: { signal?: AbortSignal }, repositoryRoot: string): Promise<string> => {
		const output = await executeGit(exec, repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], ctx.signal);
		return output.trim();
	};

	const ensureBoundary = async (ctx: { cwd: string; signal?: AbortSignal }): Promise<TaskBoundary> => {
		if (capturePromise) return capturePromise;
		if (!boundary) return captureBoundary(ctx);
		const head = await currentHead(ctx, boundary.candidate.repositoryRoot);
		if (head !== boundary.candidate.head) return captureBoundary(ctx);
		return boundary;
	};

	const prepare = async (
		ctx: { cwd: string; signal?: AbortSignal },
		reviewRange: string | undefined,
		reviewTarget?: "staged",
	): Promise<ReviewPreparationResult> => {
		const key = JSON.stringify([reviewTarget, reviewRange]);
		const existing = preparationPromises.get(key);
		if (existing) return existing;
		const preparation = (async () => {
			const activeBoundary = await ensureBoundary(ctx);
			return prepareReview(exec, activeBoundary, ctx.cwd, ctx.signal, reviewRange, reviewTarget);
		})().finally(() => {
			if (preparationPromises.get(key) === preparation) preparationPromises.delete(key);
		});
		preparationPromises.set(key, preparation);
		return preparation;
	};

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const launches = event.toolName === "subagent" ? subagentLaunches(event.input) : [];
		if (event.parentToolCallId === undefined && (
			ROOT_MUTATION_TOOLS.has(event.toolName)
			|| launches.some((launch) => typeof launch.agent === "string" && DELEGATED_MUTATION_AGENTS.has(launch.agent))
		)) {
			await ensureBoundary(ctx);
		}
		const reviewerLaunches = launches.filter((launch) => typeof launch.agent === "string" && AGENT_OUTPUT[launch.agent] === "review");
		if (reviewerLaunches.length === 0) return;
		for (const launch of reviewerLaunches) {
			if (typeof launch.task !== "string") continue;
			const target = requestedReviewTarget(launch.task);
			const range = requestedReviewRange(launch.task);
			if (target !== undefined && range !== undefined) throw new Error("review preparation rejects mixed Review target and Review range");
			const result = await prepare(ctx, range, target);
			const nextTask = addReviewMetadata(launch.task, result);
			const validation = validate("brief", nextTask);
			if (!validation.ok) return { block: true, reason: `Generated code-reviewer brief is invalid:\n${validation.errors.join("\n")}` };
			launch.task = nextTask;
		}
	});

	pi.registerCommand("accept-candidate", {
		description: "Accept the current review-preparation candidate boundary",
		handler: async (args, ctx) => {
			const candidateId = args.trim();
			if (!/^candidate_[0-9a-f]{64}$/.test(candidateId)) throw new Error("accept-candidate requires an exact candidate ID");
			if (capturePromise) await capturePromise;
			if (!boundary) throw new Error("accept-candidate has no captured candidate boundary");
			const current = await captureCandidateWithExec(exec, ctx.cwd, ctx.signal, boundary.candidate.repositoryRoot);
			if (current.id !== candidateId) throw new Error(`accept-candidate does not match the current candidate ${current.id}`);
			boundary = undefined;
			ctx.ui.notify(`Accepted candidate ${candidateId}; the next root mutation starts a new boundary.`, "info");
		},
	});
}
