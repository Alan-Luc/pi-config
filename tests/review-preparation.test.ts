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
import { AGENT_OUTPUT } from "../extensions/artifact-contracts/schemas.ts";

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

function toolCallHandler(root: string, failFirstCapture = false, afterExec?: (command: string, args: string[]) => Promise<void>) {
	let toolCall: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown> | unknown) | undefined;
	let acceptCommand: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let failed = false;
	const exec = async (command: string, args: string[], options: ExecOptions = {}): Promise<ProcessResult & { killed: boolean }> => {
		if (failFirstCapture && !failed && command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
			failed = true;
			return { stdout: "", stderr: "forced capture failure", code: 1, killed: false };
		}
		const result = await runProcess([command, ...args], options.cwd ?? root);
		if (afterExec) await afterExec(command, args);
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
		excludedPreDirtyPaths: ["/tmp/project/baseline.txt"],
	};
}

test.each(["code-reviewer", "code-reviewer-sonnet", "code-reviewer-sol", "code-reviewer-opus", "code-reviewer-haiku"] as const)("prepares registered reviewer profile %s", async (agent) => {
	assert.equal(AGENT_OUTPUT[agent], "review");
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation());
	writeFileSync(join(root, "task.txt"), "changed\n");
	const reviewer = { agent, task: brief("Review range: HEAD") };
	await harness.call(launch(reviewer));
	assert.match(reviewer.task, /^Candidate: candidate_[0-9a-f]{64}$/m);
	assert.match(reviewer.task, /^Patch SHA-256: [0-9a-f]{64}$/m);
	assert.match(reviewer.task, /^Patch artifact: \/.*\.patch$/m);
	assert.match(reviewer.task, /^Review paths: \[.*task\.txt.*\]$/m);
	const artifact = reviewer.task.match(/^Patch artifact: (.*)$/m)?.[1];
	if (!artifact) throw new Error("missing generated patch artifact");
	artifactDirectories.push(dirname(artifact));
});

test("prepares six registered reviewers with identical range metadata and task text", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation());
	writeFileSync(join(root, "task.txt"), "changed\n");
	const children = ["code-reviewer", "code-reviewer-sonnet", "code-reviewer-sol", "code-reviewer-opus", "code-reviewer", "code-reviewer-opus"]
		.map((agent) => ({ agent, task: brief("Review range: HEAD") }));
	await harness.call(launch({ children }));
	for (const child of children) assert.match(child.task, /^Patch artifact:/m);
	assert.equal(new Set(children.map(({ task }) => task)).size, 1);
	const artifact = children[0]?.task.match(/^Patch artifact: (.*)$/m)?.[1];
	if (!artifact) throw new Error("missing generated patch artifact");
	artifactDirectories.push(dirname(artifact));
});

test("captures later edits to pre-dirty paths, Bash-created changes, binary bytes, and literal pathspecs", async () => {
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
	assert.equal(paths.some((path) => path.endsWith("/baseline.txt")), true);
	const excludedPreDirtyPaths = JSON.parse(task.match(/^Excluded pre-dirty paths: (.*)$/m)?.[1] ?? "[]") as string[];
	assert.deepEqual(excludedPreDirtyPaths, []);

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

test.each(["implementation-engineer", "test-automation-engineer"])("captures the boundary before %s child edits when the lead never mutates", async (agent) => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(launch({ agent, task: brief() }));
	writeFileSync(join(root, "child-task.txt"), "changed by child\n");

	const reviewer = { agent: "code-reviewer", task: brief() };
	await harness.call(launch(reviewer));
	const paths = JSON.parse(reviewer.task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	assert.equal(paths.some((path) => path.endsWith("/child-task.txt")), true);
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

test("reviews explicit existing worktree and branch ranges without a task mutation", async () => {
	const worktreeRoot = await repository();
	writeFileSync(join(worktreeRoot, "task.txt"), "existing worktree change\n");
	const worktreeHarness = toolCallHandler(worktreeRoot);
	const worktreeReview = { agent: "code-reviewer", task: brief("Review range: HEAD") };
	await worktreeHarness.call(launch(worktreeReview));
	const worktreePaths = JSON.parse(worktreeReview.task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	assert.equal(worktreePaths.includes(join(realpathSync(worktreeRoot), "task.txt")), true);
	const worktreeArtifact = worktreeReview.task.match(/^Patch artifact: (.*)$/m)?.[1];
	if (!worktreeArtifact) throw new Error("missing worktree patch artifact");
	artifactDirectories.push(dirname(worktreeArtifact));
	assert.match(readFileSync(worktreeArtifact, "utf8"), /existing worktree change/);

	const branchRoot = await repository();
	await git(branchRoot, "branch", "-M", "main");
	await git(branchRoot, "checkout", "--quiet", "-b", "feature");
	writeFileSync(join(branchRoot, "task.txt"), "existing branch change\n");
	await git(branchRoot, "add", "task.txt");
	await git(branchRoot, "commit", "--quiet", "-m", "feature change");
	const branchHarness = toolCallHandler(branchRoot);
	const branchReview = { agent: "code-reviewer", task: brief("Review range: main...HEAD") };
	await branchHarness.call(launch(branchReview));
	const branchPaths = JSON.parse(branchReview.task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	assert.equal(branchPaths.includes(join(realpathSync(branchRoot), "task.txt")), true);
	const branchArtifact = branchReview.task.match(/^Patch artifact: (.*)$/m)?.[1];
	if (!branchArtifact) throw new Error("missing branch patch artifact");
	artifactDirectories.push(dirname(branchArtifact));
	assert.match(readFileSync(branchArtifact, "utf8"), /existing branch change/);
});

test("rejects invalid, duplicate, empty, and failed review preparation without mutating non-reviewer briefs", async () => {
	const root = await repository();
	const failed = toolCallHandler(root, true);
	await assert.rejects(failed.call(mutation()), /Git command failed|working tree/);
	await failed.call(mutation());

	const noDiffRoot = await repository();
	const noDiff = toolCallHandler(noDiffRoot);
	await noDiff.call(mutation());
	await assert.rejects(noDiff.call(launch({ agent: "code-reviewer", task: brief() })), /no task-owned diff.*Review range: HEAD/);
	await assert.rejects(noDiff.call(launch({ agent: "code-reviewer", task: brief("Review range: --stat") })), /invalid Review range/);
	await assert.rejects(noDiff.call(launch({ agent: "code-reviewer", task: brief("Review target: worktree") })), /unknown Review target/);
	await assert.rejects(noDiff.call(launch({ agent: "code-reviewer", task: brief("Review target:") })), /unknown Review target: <empty>/);
	await assert.rejects(noDiff.call(launch({ agent: "code-reviewer", task: brief("Review target: staged\nReview range: HEAD") })), /rejects mixed Review target and Review range/);
	await assert.rejects(
		noDiff.call(launch({ agent: "code-reviewer", task: brief("Review range: HEAD\nReview range: main...HEAD") })),
		/exactly one Review range line/,
	);
	await assert.rejects(noDiff.call(launch({ agent: "code-reviewer", task: brief("Review range: HEAD") })), /no changes for Review range: HEAD/);

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

test("resets after HEAD changes", async () => {
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
});

test("resets after exact explicit acceptance", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation());
	const current = await captureCandidateWithExec(harness.exec, root);
	await assert.rejects(harness.accept("candidate_" + "0".repeat(64)), /does not match/);
	await harness.accept(current.id);
	await harness.call(mutation("second-task.txt"));
	writeFileSync(join(root, "second-task.txt"), "after acceptance\n");
	const afterAccept = { agent: "code-reviewer", task: brief() };
	await harness.call(launch(afterAccept));
	const afterAcceptPaths = JSON.parse(afterAccept.task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	const canonicalRoot = realpathSync(root);
	assert.equal(afterAcceptPaths.includes(join(canonicalRoot, "task.txt")), false);
	assert.equal(afterAcceptPaths.includes(join(canonicalRoot, "second-task.txt")), true);
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
			prepareReview(harness.exec, { candidate: boundaryCandidate }, root),
			/symbolic link/,
		);
		assert.equal(readdirSync(outside).includes("review-preparation"), false);
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
	const boundary: TaskBoundary = { candidate };
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
	const shadowed = brief("existing scope\nExcluded pre-dirty paths: [\"/tmp/stale\"]")
		.replace("## Objective\n", "## Objective\n   Patch artifact: stale.patch\n")
		.replace("## Context\n", "## Context\n  Patch SHA-256: stale\n")
		.replace("## Constraints\n", "## Constraints\n Candidate: candidate_stale\n")
		.replace("## Done when\n", "## Done when\n Review paths: [\"/tmp/stale\"]\n");
	const generated = addReviewMetadata(shadowed, result);
	assert.equal(validate("brief", generated).ok, true);
	for (const prefix of ["Candidate:", "Patch SHA-256:", "Patch artifact:", "Review paths:", "Excluded pre-dirty paths:"]) {
		assert.equal(generated.split("\n").filter((line) => line.replace(/^ {0,3}/, "").startsWith(prefix)).length, 1, prefix);
	}
	assert.match(generated, /^Patch artifact: \/tmp\/pi\/review-preparation\/example\.patch$/m);
	assert.match(generated, /^Excluded pre-dirty paths: \["\/tmp\/project\/baseline\.txt"\]$/m);
});

test("prepares staged-only review inputs without exposing partially staged working-tree content", async () => {
	const root = await repository();
	writeFileSync(join(root, "task.txt"), "staged source\n");
	await git(root, "add", "task.txt");
	writeFileSync(join(root, "task.txt"), "unstaged console.log('unique-review-leak')\n");
	writeFileSync(join(root, "untracked-secret.txt"), "untracked unique-review-leak\n");
	const harness = toolCallHandler(root);
	const reviewer = { agent: "code-reviewer", task: brief("Review target: staged") };

	await harness.call(launch(reviewer));

	assert.match(reviewer.task, /^Review target: staged$/m);
	assert.match(reviewer.task, /^Candidate: candidate_[0-9a-f]{64}$/m);
	const paths = JSON.parse(reviewer.task.match(/^Review paths: (.*)$/m)?.[1] ?? "[]") as string[];
	assert.equal(paths.length, 1);
	assert.equal(paths.every((path) => !path.startsWith(realpathSync(root))), true);
	const mapping = JSON.parse(reviewer.task.match(/^Staged path mapping: (.*)$/m)?.[1] ?? "[]") as Array<{ reviewPath: string; originalPath: string; blob: string; sha256: string }>;
	assert.deepEqual(mapping.map(({ originalPath }) => originalPath), ["task.txt"]);
	assert.equal(mapping[0]?.reviewPath, paths[0]);
	assert.equal(paths.some((path) => path.endsWith("untracked-secret.txt")), false);
	const artifact = reviewer.task.match(/^Patch artifact: (.*)$/m)?.[1];
	if (!artifact) throw new Error("missing staged patch artifact");
	artifactDirectories.push(dirname(artifact));
	const patch = readFileSync(artifact, "utf8");
	assert.match(patch, /staged source/);
	assert.doesNotMatch(patch, /unique-review-leak|console\.log/);
	assert.match(readFileSync(paths[0] ?? "", "utf8"), /staged source/);
	assert.doesNotMatch(readFileSync(paths[0] ?? "", "utf8"), /unique-review-leak|console\.log/);
	let guardrail: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown> | unknown) | undefined;
	registerGuardrails({
		on: (name: string, handler: typeof guardrail) => { if (name === "tool_call") guardrail = handler; return () => undefined; },
	} as unknown as ExtensionAPI, {});
	if (!guardrail) throw new Error("guardrail hook was not registered");
	await guardrail(launch({ agent: "code-reviewer", task: reviewer.task }), { cwd: root } as ExtensionContext);
	writeFileSync(paths[0] ?? "", "tampered context\n");
	await assert.rejects(guardrail(launch({ agent: "code-reviewer", task: reviewer.task }), { cwd: root } as ExtensionContext), /context hash does not match/);
});

test("staged review covers additions, renames, and deletions while excluding untracked edits", async () => {
	const root = await repository();
	await git(root, "mv", "rename.txt", "renamed.txt");
	await git(root, "rm", "delete.txt");
	writeFileSync(join(root, "added.txt"), "staged addition\n");
	await git(root, "add", "added.txt");
	writeFileSync(join(root, "rename.txt"), "unstaged recreation leak\n");
	writeFileSync(join(root, "added.txt"), "unstaged console.log('unique-review-leak')\n");
	writeFileSync(join(root, "untracked-only.txt"), "untracked unique-review-leak\n");
	const beforeIndex = readFileSync(join(root, ".git", "index"));
	const beforeStatus = await git(root, "status", "--porcelain");
	const harness = toolCallHandler(root);
	const reviewer = { agent: "code-reviewer", task: brief("Review target: staged") };
	await harness.call(launch(reviewer));
	const artifact = reviewer.task.match(/^Patch artifact: (.*)$/m)?.[1];
	if (!artifact) throw new Error("missing staged patch artifact");
	artifactDirectories.push(dirname(artifact));
	const patch = readFileSync(artifact, "utf8");
	assert.match(patch, /staged addition/);
	assert.match(patch, /rename.txt/);
	assert.match(patch, /renamed.txt/);
	assert.match(patch, /delete.txt/);
	assert.doesNotMatch(patch, /unique-review-leak|unstaged recreation leak/);
	const mappingText = reviewer.task.match(/^Staged path mapping: (.*)$/m)?.[1];
	if (!mappingText) throw new Error("missing staged path mapping");
	const mapping = JSON.parse(mappingText) as Array<{ originalPath: string }>;
	assert.deepEqual(mapping.map(({ originalPath }) => originalPath).sort(), ["added.txt", "delete.txt", "renamed.txt"]);
	assert.deepEqual(readFileSync(join(root, ".git", "index")), beforeIndex);
	assert.equal(await git(root, "status", "--porcelain"), beforeStatus);
});

test("prepares the next staged slice after a task-internal commit advances HEAD", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	await harness.call(mutation());
	const originalBoundary = await captureCandidateWithExec(harness.exec, root);
	writeFileSync(join(root, "first-slice.txt"), "already committed slice\n");
	await git(root, "add", "first-slice.txt");
	await git(root, "commit", "--quiet", "-m", "first slice");
	writeFileSync(join(root, "next-slice.txt"), "new staged slice\n");
	await git(root, "add", "next-slice.txt");

	const result = await prepareReview(harness.exec, { candidate: originalBoundary }, root, undefined, undefined, "staged");

	artifactDirectories.push(dirname(result.patchArtifact));
	const patch = readFileSync(result.patchArtifact, "utf8");
	assert.match(patch, /new staged slice/);
	assert.doesNotMatch(patch, /already committed slice/);
});

test("does not return staged context with bytes altered by text stdout decoding", async () => {
	const root = await repository();
	const harness = toolCallHandler(root);
	const boundary = await captureCandidateWithExec(harness.exec, root);
	const originalBytes = Buffer.from([0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0xff, 0x00]);
	writeFileSync(join(root, "binary-change.bin"), originalBytes);
	await git(root, "add", "binary-change.bin");

	const stagedCandidate = await captureCandidateWithExec(harness.exec, root, undefined, root, "staged");
	artifactDirectories.push(join(REVIEW_ARTIFACT_ROOT, "review-preparation", `${stagedCandidate.id}-context`));
	await assert.rejects(
		prepareReview(harness.exec, { candidate: boundary }, root, undefined, undefined, "staged"),
		/cannot preserve staged blob bytes through text output/,
	);
});

test("rejects index drift while staged artifacts are being prepared", async () => {
	const root = await repository();
	writeFileSync(join(root, "task.txt"), "staged source\n");
	await git(root, "add", "task.txt");
	let changedIndex = false;
	const harness = toolCallHandler(root, false, async (command, args) => {
		if (!changedIndex && command === "git" && args[0] === "cat-file") {
			changedIndex = true;
			writeFileSync(join(root, "late-staged.txt"), "index changed during review\n");
			await git(root, "add", "late-staged.txt");
		}
	});
	const candidate = await captureCandidateWithExec(harness.exec, root, undefined, root, "staged");
	const reviewer = { agent: "code-reviewer", task: brief("Review target: staged") };
	await assert.rejects(harness.call(launch(reviewer)), /HEAD or index changed during preparation/);
	const preparationDirectory = join(REVIEW_ARTIFACT_ROOT, "review-preparation");
	for (const name of readdirSync(preparationDirectory)) {
		if (name.startsWith(candidate.id)) rmSync(join(preparationDirectory, name), { recursive: true, force: true });
	}
});

test("rejects HEAD drift while staged artifacts are being prepared", async () => {
	const root = await repository();
	writeFileSync(join(root, "task.txt"), "staged source\n");
	await git(root, "add", "task.txt");
	let changedHead = false;
	const harness = toolCallHandler(root, false, async (command, args) => {
		if (!changedHead && command === "git" && args[0] === "cat-file") {
			changedHead = true;
			await git(root, "commit", "--quiet", "--allow-empty", "-m", "head drift");
		}
	});
	const candidate = await captureCandidateWithExec(harness.exec, root, undefined, root, "staged");
	const reviewer = { agent: "code-reviewer", task: brief("Review target: staged") };
	await assert.rejects(harness.call(launch(reviewer)), /HEAD or index changed during preparation/);
	const preparationDirectory = join(REVIEW_ARTIFACT_ROOT, "review-preparation");
	for (const name of readdirSync(preparationDirectory)) {
		if (name.startsWith(candidate.id)) rmSync(join(preparationDirectory, name), { recursive: true, force: true });
	}
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
