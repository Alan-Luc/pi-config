import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	readFileSync,
	rmSync,
	symlinkSync,
	statSync,
	unlinkSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { afterEach, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	registerReviewPreparation,
	prepareReview,
	addReviewMetadata,
	type ReviewPreparationResult,
	type TaskBoundary,
} from "../extensions/artifact-contracts/review-preparation.ts";
import { captureCandidateWithExec } from "../extensions/artifact-contracts/verification.ts";
import { registerGuardrails, REVIEW_ARTIFACT_ROOT } from "../extensions/guardrails/guardrails.ts";
import { validate } from "../extensions/artifact-contracts/validate.ts";

type ProcessResult = { stdout: string; stderr: string; code: number };
type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };

async function runProcess(argv: readonly string[], cwd: string): Promise<ProcessResult> {
	const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

async function git(cwd: string, ...argv: string[]): Promise<string> {
	const result = await runProcess(["git", ...argv], cwd);
	assert.equal(result.code, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

const repositories: string[] = [];
const artifactDirectories: string[] = [];

afterEach(() => {
	for (const path of repositories.splice(0)) rmSync(path, { recursive: true, force: true });
	for (const path of artifactDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function repository(): Promise<string> {
	const root = mkdtempSync(join("/tmp", "review-preparation-"));
	repositories.push(root);
	await git(root, "init", "--quiet");
	await git(root, "config", "user.email", "review@example.test");
	await git(root, "config", "user.name", "Review Test");
	writeFileSync(join(root, "baseline.txt"), "base\n");
	writeFileSync(join(root, "task.txt"), "task base\n");
	writeFileSync(join(root, "rename.txt"), "rename base\n");
	writeFileSync(join(root, "delete.txt"), "delete base\n");
	writeFileSync(join(root, "binary.txt"), Buffer.from([0, 1, 2, 255]));
	await git(root, "add", ".");
	await git(root, "commit", "--quiet", "-m", "base");
	return root;
}

function brief(scope = "Review the task-owned change."): string {
	return [
		"## Objective",
		"Review the task-owned change.",
		"",
		"## Context",
		"- Source of truth: the active plan and approved Slice B decisions",
		"- Verified facts: the preparation hook owns the generated review metadata",
		"- Read first: the bounded patch and exact review paths",
		"- Open questions: None.",
		"",
		"## Scope",
		scope,
		"",
		"## Constraints",
		"Do not edit files.",
		"",
		"## Done when",
		"The review is complete with evidence-backed findings.",
	].join("\n");
}

function toolCallHandler(root: string, failFirstCapture = false) {
	let toolCall: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown> | unknown) | undefined;
	let acceptCommand: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let failed = false;
	const exec = async (command: string, args: string[], options: ExecOptions = {}): Promise<ProcessResult & { killed: boolean }> => {
		if (failFirstCapture && !failed && command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
			failed = true;
			return { stdout: "", stderr: "forced capture failure", code: 1, killed: false };
		}
		const result = await runProcess([command, ...args], options.cwd ?? root);
		return { ...result, killed: false };
	};
	registerReviewPreparation({
		on: (name: string, handler: typeof toolCall) => {
			if (name === "tool_call") toolCall = handler;
			return () => undefined;
		},
		registerCommand: (_name: string, options: { handler: typeof acceptCommand }) => { acceptCommand = options.handler; },
		exec,
	} as unknown as ExtensionAPI);
	if (!toolCall || !acceptCommand) throw new Error("review preparation hooks were not registered");
	const context = { cwd: root, signal: undefined, ui: { notify: () => undefined } } as unknown as ExtensionContext;
	return { exec, call: (event: ToolCallEvent) => toolCall?.(event, context), accept: (args: string) => acceptCommand?.(args, context) };
}

function mutation(path = "task.txt", parentToolCallId?: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "write",
		toolCallId: `write-${path}`,
		...(parentToolCallId === undefined ? {} : { parentToolCallId }),
		input: { path, content: "the tool will write this" },
	};
}

function launch(input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolName: "subagent", toolCallId: "review", input };
}

function preparationMetadata(): ReviewPreparationResult {
	const candidate: ReviewPreparationResult["candidate"] = {
		id: `candidate_${"a".repeat(64)}`,
		repositoryRoot: "/tmp/project",
		head: null,
		tree: "tree",
		kind: "dirty",
	};
	return {
		candidate,
		patchArtifact: "/tmp/pi/review-preparation/example.patch",
		patchSha256: createHash("sha256").update("patch").digest("hex"),
		reviewPaths: ["/tmp/project/task.txt"],
	};
}

test("captures baseline records, later baseline edits, Bash-created changes, binary bytes, and literal pathspecs", async () => {
	const root = await repository();
	writeFileSync(join(root, "baseline.txt"), "baseline before task\n");
	const harness = toolCallHandler(root);
	await harness.call(mutation("boundary.txt"));

	writeFileSync(join(root, "baseline.txt"), "baseline edited again\n");
	writeFileSync(join(root, "task.txt"), "task changed\n");
	renameSync(join(root, "rename.txt"), join(root, "moved.txt"));
	unlinkSync(join(root, "delete.txt"));
	writeFileSync(join(root, "binary-new.bin"), Buffer.from([0, 255, 3, 128]));
	writeFileSync(join(root, "--literal path"), "pathspec edge\n");

	const input = { agent: "code-reviewer", task: brief() };
	await harness.call(launch(input));
	const task = String(input.task);
	assert.equal(validate("brief", task).ok, true);
	assert.match(task, /^Candidate: candidate_[0-9a-f]{64}$/m);
	assert.match(task, /^Patch SHA-256: [0-9a-f]{64}$/m);
	const paths = JSON.parse(task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	assert.equal(paths.some((path) => path.endsWith("/task.txt")), true);
	assert.equal(paths.some((path) => path.endsWith("/rename.txt")), true);
	assert.equal(paths.some((path) => path.endsWith("/moved.txt")), true);
	assert.equal(paths.some((path) => path.endsWith("/delete.txt")), true);
	assert.equal(paths.some((path) => path.endsWith("/binary-new.bin")), true);
	assert.equal(paths.some((path) => path.endsWith("/--literal path")), true);
	assert.equal(paths.some((path) => path.endsWith("/baseline.txt")), false);

	const artifact = task.match(/^Patch artifact: (.*)$/m)?.[1];
	if (!artifact) throw new Error("missing patch artifact");
	artifactDirectories.push(dirname(artifact));
	assert.equal(statSync(dirname(artifact)).mode & 0o777, 0o700);
	assert.equal(statSync(artifact).mode & 0o777, 0o600);
	const bytes = readFileSync(artifact);
	assert.match(bytes.toString(), /GIT binary patch/);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), task.match(/^Patch SHA-256: ([0-9a-f]{64})$/m)?.[1]);
});

test("ignores nested mutation calls and captures only root mutations", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation("nested.txt", "parent"));
	await harness.call(mutation("root.txt"));
	writeFileSync(join(root, "nested-task.txt"), "root task\n");
	const input = { agent: "code-reviewer", task: brief() };
	await harness.call(launch(input));
	assert.match(String(input.task), /^Patch artifact:/m);
});

test("serializes concurrent first captures and preparations, repeats deterministically, and never infers acceptance", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await Promise.all([harness.call(mutation("boundary-a.txt")), harness.call(mutation("boundary-b.txt"))]);
	writeFileSync(join(root, "task.txt"), "first task\n");
	const left = { agent: "code-reviewer", task: brief() };
	const right = { agent: "code-reviewer", task: brief() };
	await Promise.all([harness.call(launch(left)), harness.call(launch(right))]);
	const leftArtifact = left.task.match(/^Patch artifact: (.*)$/m)?.[1];
	const rightArtifact = right.task.match(/^Patch artifact: (.*)$/m)?.[1];
	assert.equal(leftArtifact, rightArtifact);
	assert.equal(left.task.match(/^Patch SHA-256: (.*)$/m)?.[1], right.task.match(/^Patch SHA-256: (.*)$/m)?.[1]);
	if (!leftArtifact) throw new Error("missing concurrent artifact");
	artifactDirectories.push(dirname(leftArtifact));
	const originalBytes = readFileSync(leftArtifact);

	const repeat = { agent: "code-reviewer", task: brief() };
	await harness.call(launch(repeat));
	assert.equal(readFileSync(leftArtifact).equals(originalBytes), true);

	writeFileSync(join(root, "second-task.txt"), "second task\n");
	const noInferredAcceptance = { agent: "code-reviewer", task: brief() };
	await harness.call(launch(noInferredAcceptance));
	assert.match(String(noInferredAcceptance.task).match(/^Review paths: (.*)$/m)?.[1] ?? "", /task\.txt/);
	assert.match(String(noInferredAcceptance.task).match(/^Review paths: (.*)$/m)?.[1] ?? "", /second-task\.txt/);
});

test("rejects failed capture and no-diff review without mutating non-reviewer briefs", async () => {
	const root = await repository();
	const failed = toolCallHandler(root, true);
	await assert.rejects(failed.call(mutation()), /Git command failed|working tree/);
	await failed.call(mutation());

	const noDiffRoot = await repository();
	const noDiff = toolCallHandler(noDiffRoot);
	await noDiff.call(mutation());
	await assert.rejects(noDiff.call(launch({ agent: "code-reviewer", task: brief() })), /no task-owned diff/);

	writeFileSync(join(noDiffRoot, "new-task.txt"), "changed\n");
	const implementation = { agent: "implementation-engineer", task: brief("keep unchanged") };
	await noDiff.call(launch(implementation));
	assert.equal(implementation.task, brief("keep unchanged"));
	const reviewer = { agent: "code-reviewer", task: brief() };
	const child = { agent: "implementation-engineer", task: brief("child unchanged") };
	await noDiff.call(launch({ children: [reviewer, child] }));
	assert.match(String(reviewer.task), /^Patch artifact:/m);
	assert.equal(child.task, brief("child unchanged"));
});

test("resets only after HEAD changes or exact explicit acceptance", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation());
	writeFileSync(join(root, "task.txt"), "committed task\n");
	await git(root, "add", "task.txt");
	await git(root, "commit", "--quiet", "-m", "task boundary");
	await harness.call(mutation("second-task.txt"));
	writeFileSync(join(root, "second-task.txt"), "after head\n");
	const afterHead = { agent: "code-reviewer", task: brief() };
	await harness.call(launch(afterHead));
	const afterHeadPaths = JSON.parse(afterHead.task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	const canonicalRoot = realpathSync(root);
	assert.equal(afterHeadPaths.includes(join(canonicalRoot, "task.txt")), false);
	assert.equal(afterHeadPaths.includes(join(canonicalRoot, "second-task.txt")), true);

	const acceptedRoot = await repository();
	const accepted = toolCallHandler(acceptedRoot);
	await accepted.call(mutation());
	const current = await captureCandidateWithExec(accepted.exec, acceptedRoot);
	await assert.rejects(accepted.accept("candidate_" + "0".repeat(64)), /does not match/);
	await accepted.accept(current.id);
	await accepted.call(mutation("second-task.txt"));
	writeFileSync(join(acceptedRoot, "second-task.txt"), "after acceptance\n");
	const afterAccept = { agent: "code-reviewer", task: brief() };
	await accepted.call(launch(afterAccept));
	const afterAcceptPaths = JSON.parse(afterAccept.task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	const canonicalAcceptedRoot = realpathSync(acceptedRoot);
	assert.equal(afterAcceptPaths.includes(join(canonicalAcceptedRoot, "task.txt")), false);
	assert.equal(afterAcceptPaths.includes(join(canonicalAcceptedRoot, "second-task.txt")), true);
});

test("rejects a symlinked review root before creating outside descendants", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation());
	const boundaryCandidate = await captureCandidateWithExec(harness.exec, root);
	writeFileSync(join(root, "task.txt"), "changed\n");
	const outside = mkdtempSync(join("/tmp", "review-root-outside-"));
	const backup = mkdtempSync(join("/tmp", "review-root-backup-"));
	rmSync(backup, { recursive: true, force: true });
	let hadRoot = false;
	try {
		try {
			lstatSync(REVIEW_ARTIFACT_ROOT);
			hadRoot = true;
		} catch (error: unknown) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") throw error;
		}
		if (hadRoot) renameSync(REVIEW_ARTIFACT_ROOT, backup);
		symlinkSync(outside, REVIEW_ARTIFACT_ROOT);
		await assert.rejects(
			prepareReview(harness.exec, { candidate: boundaryCandidate, baselinePaths: new Set() }, root),
			/symbolic link/,
		);
		assert.deepEqual(readdirSync(outside), []);
	} finally {
		unlinkSync(REVIEW_ARTIFACT_ROOT);
		if (hadRoot) renameSync(backup, REVIEW_ARTIFACT_ROOT);
		rmSync(backup, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("reuses candidate identity and rejects a pre-existing patch symlink", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation());
	const candidate = await captureCandidateWithExec(harness.exec, root);
	const boundary: TaskBoundary = { candidate, baselinePaths: new Set() };
	writeFileSync(join(root, "task.txt"), "changed\n");
	const first = await prepareReview(harness.exec, boundary, root);
	artifactDirectories.push(dirname(first.patchArtifact));
	const outside = mkdtempSync(join("/tmp", "review-patch-outside-"));
	repositories.push(outside);
	unlinkSync(first.patchArtifact);
	symlinkSync(join(outside, "outside.patch"), first.patchArtifact);
	await assert.rejects(prepareReview(harness.exec, boundary, root), /symbolic link/);
	assert.equal(lstatSync(first.patchArtifact).isSymbolicLink(), true);
});

test("removes shadow metadata across the brief before inserting one Scope block", () => {
	const result = preparationMetadata();
	const shadowed = brief("existing scope")
		.replace("## Objective\n", "## Objective\n   Patch artifact: stale.patch\n")
		.replace("## Context\n", "## Context\n  Patch SHA-256: stale\n")
		.replace("## Constraints\n", "## Constraints\n Candidate: candidate_stale\n")
		.replace("## Done when\n", "## Done when\n Review paths: [\"/tmp/stale\"]\n");
	const generated = addReviewMetadata(shadowed, result);
	assert.equal(validate("brief", generated).ok, true);
	for (const prefix of ["Candidate:", "Patch SHA-256:", "Patch artifact:", "Review paths:"]) {
		assert.equal(generated.split("\n").filter((line) => line.replace(/^ {0,3}/, "").startsWith(prefix)).length, 1, prefix);
	}
	assert.match(generated, /^Patch artifact: \/tmp\/pi\/review-preparation\/example\.patch$/m);
});

test("composes review-preparation mutation before guardrails validation for single and child launches", async () => {
	const root = await repository();
	const preparation = toolCallHandler(root);
	let guardrail: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown> | unknown) | undefined;
	registerGuardrails({
		on: (name: string, handler: typeof guardrail) => {
			if (name === "tool_call") guardrail = handler;
			return () => undefined;
		},
	} as unknown as ExtensionAPI, {});
	if (!guardrail) throw new Error("guardrail hook was not registered");
	await preparation.call(mutation());
	writeFileSync(join(root, "task.txt"), "changed\n");
	const single = launch({ agent: "code-reviewer", task: brief() });
	await preparation.call(single);
	await guardrail(single, { cwd: root } as ExtensionContext);
	const childReviewer = { agent: "code-reviewer", task: brief() };
	const childWorker = { agent: "implementation-engineer", task: brief() };
	const children = launch({ children: [childReviewer, childWorker] });
	await preparation.call(children);
	await guardrail(children, { cwd: root } as ExtensionContext);
	const artifact = String(single.input && typeof single.input === "object" && "task" in single.input ? (single.input as { task: string }).task.match(/^Patch artifact: (.*)$/m)?.[1] : "");
	if (!artifact) throw new Error("missing composed patch artifact");
	artifactDirectories.push(dirname(artifact));
	assert.equal(childWorker.task, brief());
});
