import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../lib/shared.ts";
import { AGENT_OUTPUT } from "./schemas.ts";
import type { CandidateExec } from "./verification.ts";

export const REVIEW_ARTIFACT_ROOT = resolve(tmpdir(), "pi");

type RecordValue = Record<string, unknown>;
type StagedReviewMapping = { reviewPath: string; originalPath: string; blob: string; sha256: string };
function isStagedReviewMapping(value: unknown): value is StagedReviewMapping {
	return isRecord(value)
		&& typeof value.reviewPath === "string"
		&& typeof value.originalPath === "string"
		&& typeof value.blob === "string"
		&& /^[0-9a-f]{40,64}$/.test(value.blob)
		&& typeof value.sha256 === "string"
		&& /^[0-9a-f]{64}$/.test(value.sha256);
}

function hasCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isContained(parent: string, candidate: string): boolean {
	const nested = relative(parent, candidate);
	return Boolean(nested) && nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function hasParentTraversal(value: string): boolean {
	return value.split(sep === "\\" ? /[\\/]/ : "/").includes("..");
}

async function requireNoSymlinkTraversal(candidate: string, boundary: string, label: string): Promise<void> {
	for (let current = candidate; ; current = dirname(current)) {
		if (current !== boundary && !isContained(boundary, current)) {
			throw new Error(`${label} escapes its allowed boundary: ${candidate}`);
		}
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} cannot traverse a symbolic link: ${current}`);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
		if (current === boundary) return;
	}
}

async function requireReviewArtifact(value: string): Promise<Buffer> {
	if (hasParentTraversal(value)) throw new Error(`Patch artifact cannot contain parent traversal: ${value}`);
	const candidate = resolve(value);
	if (!isAbsolute(value) || !isContained(REVIEW_ARTIFACT_ROOT, candidate)) {
		throw new Error(`Patch artifact must be an absolute path lexically contained under ${REVIEW_ARTIFACT_ROOT}: ${value || "<empty>"}`);
	}
	let stat;
	try {
		stat = await lstat(candidate);
	} catch (error) {
		if (hasCode(error, "ENOENT")) throw new Error(`Patch artifact does not exist: ${candidate}`);
		throw new Error(`Could not inspect Patch artifact ${candidate}: ${errorMessage(error)}`);
	}
	if (stat.isSymbolicLink()) throw new Error(`Patch artifact cannot be a symbolic link: ${candidate}`);
	if (!stat.isFile()) throw new Error(`Patch artifact must be a regular file: ${candidate}`);
	await requireNoSymlinkTraversal(dirname(candidate), REVIEW_ARTIFACT_ROOT, "Patch artifact");
	try {
		return await readFile(candidate);
	} catch (error) {
		throw new Error(`Could not read Patch artifact ${candidate}: ${errorMessage(error)}`);
	}
}

async function validateBoundedReview(input: unknown, ctx: ExtensionContext, exec: CandidateExec): Promise<void> {
	const launches: RecordValue[] = [];
	if (!isRecord(input)) return;
	if (Array.isArray(input.children) && input.children.length > 0) {
		for (const child of input.children) if (isRecord(child)) launches.push(child);
	} else {
		launches.push(input);
	}
	for (const launch of launches) {
		if (typeof launch.agent !== "string" || AGENT_OUTPUT[launch.agent] !== "review") continue;
		const task = typeof launch.task === "string" ? launch.task : "";
		const reviewTargetMatches = [...task.matchAll(/^Review target:[ \t]*(.*)$/gim)];
		const reviewTarget = reviewTargetMatches[0]?.[1].trim();
		if (reviewTarget === "plan") {
			const { validatePlanReviewMetadata } = await import("./review-preparation.ts");
			await validatePlanReviewMetadata(task, exec, ctx.cwd, ctx.signal);
			continue;
		}
		if (/^ {0,3}Plan (?:source|artifact|SHA-256|source identity|references):/im.test(task)) throw new Error("Blocked plan review metadata without Review target: plan");
		const artifactMatch = task.match(/^Patch artifact:[ \t]*(.*)$/im);
		const reviewPathsMatch = task.match(/^Review paths:[ \t]*(.*)$/im);
		const excludedPreDirtyPathsMatch = task.match(/^Excluded pre-dirty paths:[ \t]*(.*)$/im);
		const candidateMatch = task.match(/^Candidate:[ \t]*(candidate_[0-9a-f]{64})$/im);
		const patchHashMatch = task.match(/^Patch SHA-256:[ \t]*([0-9a-f]{64})$/im);
		const stagedMappingMatch = task.match(/^Staged path mapping:[ \t]*(.*)$/im);
		const reviewPathsText = reviewPathsMatch?.[1].trim() ?? "";
		let reviewPaths: string[] = [];
		if (reviewPathsText.startsWith("[")) {
			try {
				const parsed: unknown = JSON.parse(reviewPathsText);
				if (Array.isArray(parsed) && parsed.every((path): path is string => typeof path === "string")) reviewPaths = parsed;
			} catch {
				reviewPaths = [];
			}
		} else {
			reviewPaths = reviewPathsText.split(/[ \t]+/).filter(Boolean);
		}
		let excludedPreDirtyPaths: string[] | undefined;
		try {
			const parsed: unknown = JSON.parse(excludedPreDirtyPathsMatch?.[1].trim() ?? "");
			if (Array.isArray(parsed) && parsed.every((path): path is string => typeof path === "string")) excludedPreDirtyPaths = parsed;
		} catch {
			excludedPreDirtyPaths = undefined;
		}
		if (reviewTargetMatches.length > 1 || (reviewTarget !== undefined && reviewTarget !== "staged")) {
			throw new Error("Blocked code-reviewer task with an unknown or duplicate Review target");
		}
		if (reviewTarget === "staged" && /^ {0,3}Review range:/im.test(task)) {
			throw new Error("Blocked staged review mixed with Review range");
		}
		let stagedMapping: StagedReviewMapping[] | undefined;
		if (reviewTarget === "staged") {
			try {
				const parsed: unknown = JSON.parse(stagedMappingMatch?.[1] ?? "");
				if (Array.isArray(parsed) && parsed.every(isStagedReviewMapping)) stagedMapping = parsed;
			} catch {
				stagedMapping = undefined;
			}
			if (!stagedMapping || stagedMapping.length === 0 || JSON.stringify(stagedMapping.map(({ reviewPath }) => reviewPath)) !== JSON.stringify(reviewPaths)) {
				throw new Error("Blocked staged review with missing or mismatched staged path mapping");
			}
		}
		if (
			!artifactMatch
			|| reviewPaths.length === 0
			|| reviewPaths.some((path) => !isAbsolute(path))
			|| excludedPreDirtyPaths === undefined
			|| excludedPreDirtyPaths.some((path) => !isAbsolute(path))
			|| !candidateMatch
			|| !patchHashMatch
		) {
			throw new Error(`Blocked unbounded code-reviewer task; use generated review metadata:\nCandidate: candidate_<id>\nPatch SHA-256: <sha256>\nPatch artifact: ${resolve(REVIEW_ARTIFACT_ROOT, "<name>.patch")}\nReview paths: <exact absolute paths>\nExcluded pre-dirty paths: <exact absolute paths excluded from the patch>`);
		}
		const artifactBytes = await requireReviewArtifact(artifactMatch[1].trim());
		const actualPatchSha256 = createHash("sha256").update(artifactBytes).digest("hex");
		if (actualPatchSha256 !== patchHashMatch[1]) {
			throw new Error(`Patch artifact SHA-256 does not match generated Patch SHA-256: expected ${patchHashMatch[1]}, got ${actualPatchSha256}`);
		}
		for (const entry of stagedMapping ?? []) {
			if (!isAbsolute(entry.reviewPath) || !isContained(REVIEW_ARTIFACT_ROOT, resolve(entry.reviewPath))) {
				throw new Error("Blocked staged review context outside the private review artifact root");
			}
			if (hasParentTraversal(entry.reviewPath)) throw new Error("Blocked staged review context with parent traversal");
			await requireNoSymlinkTraversal(dirname(entry.reviewPath), REVIEW_ARTIFACT_ROOT, "Staged review context");
			let bytes: Buffer;
			try {
				const metadata = await lstat(entry.reviewPath);
				if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular file");
				bytes = await readFile(entry.reviewPath);
			} catch (error) {
				throw new Error(`Could not read staged review context ${entry.reviewPath}: ${errorMessage(error)}`);
			}
			if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
				throw new Error(`Staged review context hash does not match generated mapping: ${entry.reviewPath}`);
			}
		}
	}
}


export function registerReviewEnforcement(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "subagent") await validateBoundedReview(event.input, ctx, pi.exec);
	});
}
