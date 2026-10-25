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
const GENERATED_METADATA_PREFIXES = ["Candidate:", "Patch SHA-256:", "Patch artifact:", "Review paths:", "Excluded pre-dirty paths:", "Review target:", "Staged path mapping:", "Plan source:", "Plan artifact:", "Plan SHA-256:", "Plan source identity:", "Plan references:"] as const;
const PLAN_SOURCE_PATH = /^\.harness\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
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
	kind?: never;
	candidate: CandidateIdentity;
	patchArtifact: string;
	patchSha256: string;
	reviewPaths: readonly string[];
	excludedPreDirtyPaths: readonly string[];
	reviewTarget?: "staged";
	stagedPathMapping?: readonly Readonly<{ reviewPath: string; originalPath: string; blob: string; sha256: string }>[];
}>;

export type PlanReferenceInput = Readonly<{ kind: "requirement" | "decision"; heading: string } | { kind: "source"; path: string }>;
export type PreparedPlanReference = Readonly<{ kind: PlanReferenceInput["kind"]; path: string; artifact: string; sha256: string }>;
export type PlanReviewPreparationResult = Readonly<{
	kind: "plan";
	candidate: CandidateIdentity;
	planSource: string;
	planArtifact: string;
	planSha256: string;
	planReferences: readonly PreparedPlanReference[];
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

function requestedReviewTarget(task: string): "staged" | "plan" | undefined {
	const matches = [...task.matchAll(/^ {0,3}Review target:[ \t]*(.*)$/gm)];
	if (matches.length > 1) throw new Error("review preparation accepts exactly one Review target line");
	const value = matches[0]?.[1].trim();
	if (value !== undefined && value !== "staged" && value !== "plan") throw new Error(`review preparation received unknown Review target: ${value || "<empty>"}`);
	return value;
}

function requestedPlanSource(task: string): string {
	const matches = [...task.matchAll(/^ {0,3}Plan source:[ \t]*(.*)$/gm)];
	if (matches.length !== 1 || !PLAN_SOURCE_PATH.test(matches[0]?.[1] ?? "")) {
		throw new Error("plan review requires exactly one canonical Plan source path under .harness/plans");
	}
	return matches[0][1];
}

function isPlanReferenceInput(value: unknown): value is PlanReferenceInput {
	return isRecord(value)
		&& ((value.kind === "source" && typeof value.path === "string" && Object.keys(value).every((key) => ["kind", "path"].includes(key)))
			|| ((value.kind === "requirement" || value.kind === "decision") && typeof value.heading === "string" && Object.keys(value).every((key) => ["kind", "heading"].includes(key))));
}

function requestedPlanReferences(task: string): PlanReferenceInput[] {
	const matches = [...task.matchAll(/^ {0,3}Plan references:[ \t]*(.*)$/gm)];
	if (matches.length !== 1) throw new Error("plan review requires exactly one Plan references JSON line");
	let parsed: unknown;
	try { parsed = JSON.parse(matches[0][1]); } catch { throw new Error("plan review received malformed Plan references JSON"); }
	if (!Array.isArray(parsed) || !parsed.every(isPlanReferenceInput)) {
		throw new Error("plan review references must name requirement/decision headings or source paths");
	}
	const references = parsed;
	if (!["requirement", "decision", "source"].every((kind) => references.some((reference) => reference.kind === kind))) {
		throw new Error("plan review requires explicit requirement, decision, and source references");
	}
	return references;
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

function openExistingPatch(path: string, label: string): number {
	try {
		return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ELOOP") throw new Error(`review preparation ${label} cannot be a symbolic link: ${path}`);
		throw error;
	}
}

function writePatch(path: string, bytes: Buffer, label = "patch"): void {
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

	const descriptor = openExistingPatch(path, label);
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error(`review preparation ${label} must be a regular file: ${path}`);
		if (!readFileSync(descriptor).equals(bytes)) throw new Error(`review preparation ${label} already exists with different bytes: ${path}`);
		fchmodSync(descriptor, 0o600);
	} finally {
		closeSync(descriptor);
	}
}

async function treeBlobs(
	exec: CandidateExec,
	root: string,
	tree: string,
	paths: readonly string[],
	signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
	if (paths.length === 0) return new Map();
	const output = await executeGit(exec, root, ["ls-tree", "-r", "-z", "--full-tree", tree, "--", ...paths.map(literalPathspec)], signal);
	const requestedPaths = new Set(paths);
	const blobs = new Map<string, string>();
	for (const record of output.split("\0")) {
		if (!record) continue;
		const separator = record.indexOf("\t");
		if (separator < 0) throw new Error("review preparation received malformed Git tree entry");
		const metadata = record.slice(0, separator).split(" ");
		const path = record.slice(separator + 1);
		const object = metadata[2];
		if (!object || !/^[0-9a-f]{40,64}$/.test(object)) {
			throw new Error("review preparation received malformed Git tree entry");
		}
		if (!requestedPaths.has(path)) continue;
		if (metadata[1] !== "blob") throw new Error(`review preparation cannot prepare staged non-blob context: ${path}`);
		blobs.set(path, object);
	}
	return blobs;
}

function gitBlobObjectId(blob: string, bytes: Buffer): string {
	const algorithm = blob.length === 64 ? "sha256" : "sha1";
	return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

async function stagedReviewPaths(
	exec: CandidateExec,
	candidate: CandidateIdentity,
	records: readonly DiffRecord[],
	signal: AbortSignal | undefined,
): Promise<{ paths: string[]; mapping: Array<{ reviewPath: string; originalPath: string; blob: string; sha256: string }> }> {
	if (candidate.head === null || candidate.source !== "staged") throw new Error("staged review requires a committed staged candidate");
	const root = candidate.repositoryRoot;
	const stagedPaths = records.flatMap(({ newPath }) => newPath === undefined ? [] : [newPath]);
	const deletedPaths = records.flatMap(({ oldPath, newPath }) => newPath === undefined && oldPath !== undefined ? [oldPath] : []);
	const stagedBlobs = await treeBlobs(exec, root, candidate.tree, stagedPaths, signal);
	const headBlobs = await treeBlobs(exec, root, `${candidate.head}^{tree}`, deletedPaths, signal);
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
		writePatch(copy, bytes, "staged context");
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

function generatedMetadata(result: ReviewPreparationResult | PlanReviewPreparationResult): string[] {
	if (result.kind === "plan") return [
		"Review target: plan",
		`Plan source: ${result.planSource}`,
		`Plan artifact: ${result.planArtifact}`,
		`Plan SHA-256: ${result.planSha256}`,
		`Plan source identity: ${JSON.stringify({ id: result.candidate.id, repositoryRoot: result.candidate.repositoryRoot, head: result.candidate.head, tree: result.candidate.tree })}`,
		`Plan references: ${JSON.stringify(result.planReferences)}`,
	];
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

function readPlanSource(repositoryRoot: string, sourcePath: string): Buffer {
	if (sourcePath.includes("\0") || isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes("..")) {
		throw new Error(`plan review rejects unsafe source path: ${sourcePath}`);
	}
	const absolute = resolve(repositoryRoot, sourcePath);
	if (!isWithin(repositoryRoot, absolute)) throw new Error(`plan review source escapes the repository: ${sourcePath}`);
	let cursor = repositoryRoot;
	for (const component of relative(repositoryRoot, absolute).split(/[\\/]/)) {
		cursor = join(cursor, component);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error(`plan review source cannot be a symbolic link: ${sourcePath}`);
	}
	const descriptor = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error(`plan review source must be a regular file: ${sourcePath}`);
		return readFileSync(descriptor);
	} finally { closeSync(descriptor); }
}

export async function preparePlanReview(
	exec: CandidateExec,
	boundary: TaskBoundary,
	sessionDirectory: string,
	planSource: string,
	references: readonly PlanReferenceInput[],
	signal?: AbortSignal,
): Promise<PlanReviewPreparationResult> {
	if (!PLAN_SOURCE_PATH.test(planSource)) throw new Error("plan review requires a canonical plan source path under .harness/plans");
	if (!["requirement", "decision", "source"].every((kind) => references.some((reference) => reference.kind === kind))) {
		throw new Error("plan review requires explicit requirement, decision, and source references");
	}
	const current = await captureCandidateWithExec(exec, sessionDirectory, signal, boundary.candidate.repositoryRoot);
	const repositoryRoot = current.repositoryRoot;
	const planBytes = readPlanSource(repositoryRoot, planSource);
	const planText = planBytes.toString("utf8");
	for (const reference of references) {
		if (reference.kind !== "source" && !planText.split("\n").includes(`## ${reference.heading}`)) {
			throw new Error(`plan review reference heading does not exist: ${reference.heading}`);
		}
	}
	const planSha256 = createHash("sha256").update(planBytes).digest("hex");
	const directory = join(REVIEW_DIRECTORY, `${current.id}-plan-${planSha256}`);
	ensureReviewDirectories();
	ensureDirectory(directory, "plan review artifact directory");
	const planArtifact = join(directory, `${planSha256}.plan`);
	writePatch(planArtifact, planBytes, "plan artifact");
	const planReferences: PreparedPlanReference[] = [];
	for (const reference of references) {
		const path = reference.kind === "source" ? reference.path : reference.heading;
		let bytes: Buffer;
		if (reference.kind === "source") bytes = readPlanSource(repositoryRoot, reference.path);
		else {
			const start = planText.indexOf(`## ${reference.heading}`);
			const next = planText.indexOf("\n## ", start + 1);
			bytes = Buffer.from(`${planText.slice(start, next < 0 ? undefined : next)}\n`, "utf8");
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const artifact = join(directory, `${sha256}.source`);
		writePatch(artifact, bytes, "plan review source");
		planReferences.push({ kind: reference.kind, path, artifact, sha256 });
	}
	const after = await captureCandidateWithExec(exec, sessionDirectory, signal, repositoryRoot);
	if (after.id !== current.id) throw new Error("plan review source identity changed during preparation");
	return { kind: "plan", candidate: current, planSource, planArtifact, planSha256, planReferences };
}

export async function validatePlanReviewMetadata(task: string, exec: CandidateExec, sessionDirectory: string, signal?: AbortSignal): Promise<void> {
	const one = (label: string): string => {
		const matches = [...task.matchAll(new RegExp(`^${label}:[ \\t]*(.*)$`, "gim"))];
		if (matches.length !== 1) throw new Error(`plan review requires exactly one ${label} metadata line`);
		return matches[0][1].trim();
	};
	if (one("Review target") !== "plan") throw new Error("plan review metadata has the wrong review target");
	if (/^ {0,3}(?:Review range|Candidate|Patch SHA-256|Patch artifact|Review paths|Excluded pre-dirty paths|Staged path mapping):/im.test(task)) {
		throw new Error("plan review rejects mixed PLAN and patch metadata");
	}
	const planSource = one("Plan source");
	if (!PLAN_SOURCE_PATH.test(planSource)) throw new Error("plan review metadata has a noncanonical plan source");
	const planArtifact = one("Plan artifact");
	const planSha256 = one("Plan SHA-256");
	const identity: unknown = JSON.parse(one("Plan source identity"));
	const references: unknown = JSON.parse(one("Plan references"));
	if (!isRecord(identity) || typeof identity.id !== "string" || !/^candidate_[0-9a-f]{64}$/.test(identity.id) || typeof identity.repositoryRoot !== "string" || !isAbsolute(identity.repositoryRoot)
		|| typeof identity.tree !== "string" || !/^[0-9a-f]{40,64}$/.test(identity.tree) || !(identity.head === null || (typeof identity.head === "string" && /^[0-9a-f]{40,64}$/.test(identity.head)))
		|| Object.keys(identity).some((key) => !["id", "repositoryRoot", "head", "tree"].includes(key))) {
		throw new Error("plan review source identity metadata is malformed");
	}
	if (!Array.isArray(references) || references.length < 3 || !references.every((entry): entry is PreparedPlanReference => isRecord(entry)
		&& (entry.kind === "requirement" || entry.kind === "decision" || entry.kind === "source")
		&& typeof entry.path === "string" && typeof entry.artifact === "string" && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256)
		&& Object.keys(entry).every((key) => ["kind", "path", "artifact", "sha256"].includes(key)))) {
		throw new Error("plan review reference metadata is malformed");
	}
	if (!["requirement", "decision", "source"].every((kind) => references.some((entry) => entry.kind === kind))) {
		throw new Error("plan review metadata is missing an explicit requirement, decision, or source reference");
	}
	const current = await captureCandidateWithExec(exec, sessionDirectory, signal);
	if (current.repositoryRoot !== identity.repositoryRoot || current.id !== identity.id || current.tree !== identity.tree || current.head !== identity.head) {
		throw new Error("plan review source identity drifted after preparation");
	}
	const readArtifact = (path: string, label: string): Buffer => {
		if (!isAbsolute(path) || !isWithin(REVIEW_ARTIFACT_ROOT, resolve(path))) throw new Error(`plan review ${label} is outside the private artifact root`);
		const rootStat = lstatSync(REVIEW_ARTIFACT_ROOT);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("plan review artifact root is not a private directory");
		let parent = REVIEW_ARTIFACT_ROOT;
		const parts = relative(REVIEW_ARTIFACT_ROOT, path).split(/[\\/]/);
		for (const part of parts.slice(0, -1)) {
			parent = join(parent, part);
			const stat = lstatSync(parent);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`plan review ${label} has unsafe directory traversal`);
		}
		const descriptor = openExistingPatch(path, label);
		try {
			if (!fstatSync(descriptor).isFile()) throw new Error(`plan review ${label} must be a regular file: ${path}`);
			return readFileSync(descriptor);
		} finally { closeSync(descriptor); }
	};
	const planBytes = readArtifact(planArtifact, "plan artifact");
	if (createHash("sha256").update(planBytes).digest("hex") !== planSha256) throw new Error("plan review artifact hash does not match generated Plan SHA-256");
	if (!readPlanSource(identity.repositoryRoot, planSource).equals(planBytes)) throw new Error("plan review source drifted after preparation");
	for (const entry of references) {
		const bytes = readArtifact(entry.artifact, "reference artifact");
		if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`plan review reference artifact hash mismatch: ${entry.path}`);
		let original: Buffer;
		if (entry.kind === "source") original = readPlanSource(identity.repositoryRoot, entry.path);
		else {
			const text = planBytes.toString("utf8");
			const start = text.indexOf(`## ${entry.path}`);
			if (start < 0) throw new Error(`plan review reference heading no longer exists: ${entry.path}`);
			const next = text.indexOf("\n## ", start + 1);
			original = Buffer.from(`${text.slice(start, next < 0 ? undefined : next)}\n`, "utf8");
		}
		if (!original.equals(bytes)) throw new Error(`plan review reference source drifted after preparation: ${entry.path}`);
	}
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
			...originalPaths.map((path) => literalPathspec(relative(current.repositoryRoot, path))),
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

export function addReviewMetadata(task: string, result: ReviewPreparationResult | PlanReviewPreparationResult): string {
	return replaceScopeMetadata(task, generatedMetadata(result));
}

export function registerReviewPreparation(pi: ExtensionAPI): void {
	const exec: CandidateExec = (command, args, options) => pi.exec(command, args, options);
	let boundary: TaskBoundary | undefined;
	let capturePromise: Promise<TaskBoundary> | undefined;
	const preparationPromises = new Map<string, Promise<ReviewPreparationResult | PlanReviewPreparationResult>>();

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
		reviewTarget: "staged" | "plan" | undefined,
		task: string,
	): Promise<ReviewPreparationResult | PlanReviewPreparationResult> => {
		if (reviewTarget === "plan" && reviewRange !== undefined) throw new Error("plan review rejects mixed Review target and Review range");
		const key = JSON.stringify([reviewTarget, reviewRange, task]);
		const existing = preparationPromises.get(key);
		if (existing) return existing;
		const preparation = (async () => {
			const activeBoundary = await ensureBoundary(ctx);
			if (reviewTarget === "plan") return preparePlanReview(exec, activeBoundary, ctx.cwd, requestedPlanSource(task), requestedPlanReferences(task), ctx.signal);
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
			const result = await prepare(ctx, range, target, launch.task);
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
