import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { afterEach, it, test } from "bun:test";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	BACKGROUND_TASK_REQUEST_CHANNEL,
	BACKGROUND_TASK_RESPONSE_CHANNEL,
	BACKGROUND_TASK_RESPONSE_SCHEMA,
	BACKGROUND_TASK_TERMINAL_CHANNEL,
	BACKGROUND_TASK_TERMINAL_SCHEMA,
	type BackgroundTaskSnapshot,
} from "../extensions/artifact-contracts/background-tasks.ts";
import {
	MAX_EXPOSED_OUTPUT_BYTES,
	canonicalCommand,
	captureCandidate,
	executeVerification,
	executeVerificationEvidence,
	registerVerificationEvidence,
	type VerificationToolContext,
} from "../extensions/artifact-contracts/verification.ts";
import {
	beginVerificationAttempt,
	clearVerificationEvidence,
	createCandidateIdentity,
	invalidateVerificationEvidence,
	recordVerificationEvidence,
	verificationClaimErrors,
} from "../extensions/artifact-contracts/verification-store.ts";

const root = mkdtempSync(join(tmpdir(), "verification-evidence-contract-"));
let sequence = 0;
const candidate = createCandidateIdentity({
	repositoryRoot: "/repo",
	head: "a".repeat(40),
	tree: "b".repeat(40),
	kind: "dirty",
});

function record(
	command = "'bun' 'test'",
	exitCode = 0,
	valid = true,
	cwd = ".",
	candidateIdentity = candidate,
	attempt?: ReturnType<typeof beginVerificationAttempt>,
) {
	const output = `full output ${sequence}`;
	const logPath = join(root, `${sequence++}.log`);
	writeFileSync(logPath, output, { mode: 0o600 });
	chmodSync(logPath, 0o600);
	return recordVerificationEvidence({
		command,
		argv: ["bun", "test"],
		cwd,
		candidate: candidateIdentity,
		exitCode,
		logPath,
		logSha256: createHash("sha256").update(output).digest("hex"),
		valid,
		invalidReason: valid ? undefined : "candidate changed during verification",
	}, attempt);
}

afterEach(() => clearVerificationEvidence());
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("candidate and evidence IDs are deterministic content hashes", () => {
	assert.match(candidate.id, /^candidate_[0-9a-f]{64}$/);
	assert.equal(
		candidate.id,
		createCandidateIdentity({ repositoryRoot: "/repo", head: "a".repeat(40), tree: "b".repeat(40), kind: "dirty" }).id,
	);
	const evidence = record();
	assert.match(evidence.id, /^verify_[0-9a-f]{64}$/);
	assert.equal("invalidReason" in evidence, false);
	assert.deepEqual(verificationClaimErrors({ evidenceId: evidence.id, command: evidence.command, exitCode: 0 }), []);
});

test("claims require exact command and exit matches", () => {
	const evidence = record();
	assert.match(verificationClaimErrors({ evidenceId: evidence.id, command: "'bun' 'test' 'tests/'", exitCode: 0 })[0], /command does not match evidence/);
	assert.match(verificationClaimErrors({ evidenceId: evidence.id, command: evidence.command, exitCode: 1 })[0], /reported exit 1, evidence recorded 0/);
	assert.match(verificationClaimErrors({ evidenceId: `verify_${"f".repeat(64)}`, command: evidence.command, exitCode: 0 })[0], /not found/);
});

test("only the latest record for one repository, command, and cwd is reportable", () => {
	const older = record();
	const latest = record();
	assert.match(verificationClaimErrors({ evidenceId: older.id, command: older.command, exitCode: 0 })[0], /obsolete/);
	assert.deepEqual(verificationClaimErrors({ evidenceId: latest.id, command: latest.command, exitCode: 0 }), []);
	beginVerificationAttempt(candidate.repositoryRoot, latest.command, latest.cwd);
	assert.match(verificationClaimErrors({ evidenceId: latest.id, command: latest.command, exitCode: 0 })[0], /obsolete/);
});

test("identical checks in linked worktrees remain independently reportable", () => {
	const command = "'bun' 'test'";
	const primary = record(command);
	const linkedCandidate = createCandidateIdentity({
		repositoryRoot: "/repo-linked",
		head: candidate.head,
		tree: candidate.tree,
		kind: candidate.kind,
	});
	const linkedAttempt = beginVerificationAttempt(linkedCandidate.repositoryRoot, command, ".");
	assert.deepEqual(verificationClaimErrors({ evidenceId: primary.id, command, exitCode: 0 }), []);
	const linked = record(command, 0, true, ".", linkedCandidate, linkedAttempt);
	assert.deepEqual(verificationClaimErrors({ evidenceId: primary.id, command, exitCode: 0 }), []);
	assert.deepEqual(verificationClaimErrors({ evidenceId: linked.id, command, exitCode: 0 }), []);

	beginVerificationAttempt(candidate.repositoryRoot, command, ".");
	assert.match(verificationClaimErrors({ evidenceId: primary.id, command, exitCode: 0 })[0], /obsolete/);
	assert.deepEqual(verificationClaimErrors({ evidenceId: linked.id, command, exitCode: 0 }), []);
});

test("failed attempts remain scoped to the exact command and cwd", () => {
	const command = "'bun' 'test'";
	const firstCwd = record(command, 0, true, "packages/a");
	beginVerificationAttempt(candidate.repositoryRoot, command, firstCwd.cwd);
	const secondCwd = record(command, 0, true, "packages/b");
	assert.match(verificationClaimErrors({ evidenceId: firstCwd.id, command, exitCode: 0 })[0], /obsolete/);
	assert.deepEqual(verificationClaimErrors({ evidenceId: secondCwd.id, command, exitCode: 0 }), []);
});

test("tool completion before recording invalidates an overlapping verification attempt", () => {
	const command = "'bun' 'test' 'overlap'";
	const attempt = beginVerificationAttempt(candidate.repositoryRoot, command, ".");
	invalidateVerificationEvidence("bash tool activity completed after verification");
	const output = `full output ${sequence}`;
	const logPath = join(root, `${sequence++}.log`);
	writeFileSync(logPath, output, { mode: 0o600 });
	chmodSync(logPath, 0o600);
	const evidence = recordVerificationEvidence({
		command,
		argv: ["bun", "test", "overlap"],
		cwd: ".",
		candidate,
		exitCode: 0,
		logPath,
		logSha256: createHash("sha256").update(output).digest("hex"),
		valid: true,
	}, attempt);
	assert.equal(evidence.valid, false);
	assert.match(evidence.invalidReason ?? "", /tool activity overlapped verification/);
	assert.match(verificationClaimErrors({ evidenceId: evidence.id, command, exitCode: 0 }).join("\n"), /stale: bash tool activity completed/);
});

test("invalid, missing, and tampered evidence fails closed", () => {
	const invalid = record("'bun' 'test' 'invalid'", 0, false);
	assert.match(verificationClaimErrors({ evidenceId: invalid.id, command: invalid.command, exitCode: 0 })[0], /candidate changed during verification/);

	const missing = record("'bun' 'test' 'missing'");
	unlinkSync(missing.logPath);
	assert.match(verificationClaimErrors({ evidenceId: missing.id, command: missing.command, exitCode: 0 })[0], /log is missing/);

	const tampered = record("'bun' 'test' 'tampered'");
	writeFileSync(tampered.logPath, "changed");
	assert.match(verificationClaimErrors({ evidenceId: tampered.id, command: tampered.command, exitCode: 0 })[0], /log hash does not match/);

	const stale = record("'bun' 'test' 'stale'");
	invalidateVerificationEvidence("source edit after verification");
	assert.match(verificationClaimErrors({ evidenceId: stale.id, command: stale.command, exitCode: 0 })[0], /stale: source edit/);
});

type ProcessResult = { exitCode: number; output: string };
type FakeBashOptions = {
	omitExitFor?: (command: string) => boolean;
	resultFor?: (command: string) => ProcessResult | undefined;
};

async function runProcess(argv: readonly string[], cwd: string): Promise<ProcessResult> {
	const process = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { exitCode, output: stdout + stderr };
}

async function git(cwd: string, ...argv: string[]): Promise<string> {
	const result = await runProcess(["git", ...argv], cwd);
	assert.equal(result.exitCode, 0, result.output);
	return result.output.trim();
}

async function repository(): Promise<string> {
	const directory = mkdtempSync(join(tmpdir(), "verification-runtime-"));
	await git(directory, "init", "--quiet");
	await git(directory, "config", "user.email", "verification@example.test");
	await git(directory, "config", "user.name", "Verification Test");
	writeFileSync(join(directory, "tracked.txt"), "base\n");
	await git(directory, "add", "tracked.txt");
	await git(directory, "commit", "--quiet", "-m", "base");
	return directory;
}

function makeContext(directory: string, options: FakeBashOptions = {}): VerificationToolContext {
	let nestedCall = 0;
	return {
		cwd: directory,
		executeTool: async (name, args) => {
			assert.equal(name, "bash");
			if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("invalid fake bash input");
			const input = args as { command?: unknown; timeout?: unknown };
			if (typeof input.command !== "string" || typeof input.timeout !== "number") throw new Error("invalid fake bash input");
			const result = options.resultFor?.(input.command) ?? await runProcess(["bash", "-c", input.command], directory);
			const structuredContent: Record<string, string | number | boolean> = {
				output: result.output,
				truncated: false,
				exit_code: result.exitCode,
				wall_time_seconds: 0,
			};
			if (options.omitExitFor?.(input.command)) delete structuredContent.exit_code;
			return {
				toolCall: { type: "toolCall", id: `fake-${++nestedCall}`, name: "bash", arguments: input },
				result: { content: [{ type: "text", text: result.output }], details: undefined, structuredContent },
				isError: result.exitCode !== 0,
			};
		},
	};
}

async function repositorySnapshot(directory: string): Promise<string[]> {
	return [
		await git(directory, "rev-parse", "HEAD"),
		await git(directory, "branch", "--show-current"),
		await git(directory, "status", "--porcelain", "--untracked-files=all"),
		await git(directory, "stash", "list"),
	];
}

const runtimeRepositories: string[] = [];
async function newRepository(): Promise<string> {
	const directory = await repository();
	runtimeRepositories.push(directory);
	return directory;
}

type FakeBackgroundService = EventBus & {
	counts: Record<"run" | "status" | "logs", number>;
	task: BackgroundTaskSnapshot;
	complete(status?: "completed" | "failed" | "killed", exitCode?: number | null): void;
};

function backgroundService(directory: string, options: {
	status?: "running" | "completed" | "failed" | "killed";
	exitCode?: number | null;
	omitExitCode?: boolean;
	output?: string;
	outputPath?: string;
	logsPath?: string;
	logsText?: string;
	emitTerminalOnRun?: boolean;
} = {}): FakeBackgroundService {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const counts = { run: 0, status: 0, logs: 0 };
	const output = Buffer.from(options.output ?? "verification output\n");
	const runtimeDirectory = mkdtempSync(join(realpathSync(tmpdir()), "pi-background-tasks-test-"));
	runtimeRepositories.push(runtimeDirectory);
	const outputPath = options.outputPath ?? join(runtimeDirectory, "task-1.output");
	const absoluteOutputPath = isAbsolute(outputPath) ? outputPath : join(directory, outputPath);
	let command = "";
	let task: BackgroundTaskSnapshot = {
		id: "task-1",
		name: "Verification",
		command,
		status: options.status ?? "completed",
		outputPath,
		cwd: directory,
		startTime: 1,
		...(options.status === "running" ? {} : { endTime: 2 }),
		...(options.omitExitCode ? {} : { exitCode: options.exitCode ?? 0 }),
		bytesWritten: output.byteLength,
		isAgent: false,
		notified: options.status !== "running",
		notifyOnCompletion: true,
		triggerOnCompletion: true,
	};
	const service = {
		on(channel: string, listener: (value: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
		counts,
		get task() { return task; },
		complete(status: "completed" | "failed" | "killed" = "completed", exitCode: number | null = 0) {
			task = {
				...task,
				status,
				endTime: 2,
				...(options.omitExitCode ? {} : { exitCode }),
				notified: true,
			};
			service.emit(BACKGROUND_TASK_TERMINAL_CHANNEL, {
				schema_version: BACKGROUND_TASK_TERMINAL_SCHEMA,
				task,
			});
		},
	} as FakeBackgroundService;
	service.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		if (typeof value !== "object" || value === null) throw new Error("malformed request");
		const request = value as { request_id?: unknown; operation?: unknown; payload?: Record<string, unknown> };
		if (typeof request.request_id !== "string" || typeof request.operation !== "string") throw new Error("malformed request");
		if (request.operation === "run") {
			counts.run += 1;
			if (!options.outputPath) {
				writeFileSync(absoluteOutputPath, output);
				writeFileSync(join(runtimeDirectory, "task-1.json"), "{}\n");
			}
			command = String(request.payload?.command ?? "");
			task = { ...task, command };
			service.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
				schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
				request_id: request.request_id,
				operation: "run",
				ok: true,
				result: task,
			});
			if (task.status !== "running" && options.emitTerminalOnRun !== false) service.complete(task.status, task.exitCode ?? null);
			return;
		}
		if (request.operation === "status") {
			counts.status += 1;
			service.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
				schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
				request_id: request.request_id,
				operation: "status",
				ok: true,
				result: { tasks: [task] },
			});
			return;
		}
		if (request.operation === "logs") {
			counts.logs += 1;
			const boundedText = output.subarray(0, MAX_EXPOSED_OUTPUT_BYTES).toString("utf8");
			const truncated = output.byteLength > MAX_EXPOSED_OUTPUT_BYTES;
			const text = truncated
				? `${boundedText}\n\n[Showing head ${MAX_EXPOSED_OUTPUT_BYTES} bytes of ${output.byteLength} bytes; ${output.byteLength - MAX_EXPOSED_OUTPUT_BYTES} bytes omitted. Full output: ${outputPath}]`
				: `${boundedText}\n\n[Full output: ${outputPath}]`;
			service.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, {
				schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
				request_id: request.request_id,
				operation: "logs",
				ok: true,
				result: {
					task,
					path: options.logsPath ?? outputPath,
					bytesRead: Math.min(output.byteLength, MAX_EXPOSED_OUTPUT_BYTES),
					truncated,
					tail: false,
					text: options.logsText ?? text,
				},
			});
		}
	});
	return service;
}

process.on("exit", () => {
	for (const directory of runtimeRepositories) rmSync(directory, { recursive: true, force: true });
});

test("captures clean, staged, unstaged, untracked, deleted, and renamed candidates", { timeout: 30_000 }, async () => {
	const cases: Array<{ name: string; mutate: (directory: string) => Promise<void> }> = [
		{
			name: "staged",
			mutate: async (directory) => {
				writeFileSync(join(directory, "tracked.txt"), "staged\n");
				await git(directory, "add", "tracked.txt");
			},
		},
		{
			name: "unstaged",
			mutate: async (directory) => writeFileSync(join(directory, "tracked.txt"), "unstaged\n"),
		},
		{
			name: "untracked",
			mutate: async (directory) => writeFileSync(join(directory, "untracked.txt"), "new\n"),
		},
		{
			name: "deleted",
			mutate: async (directory) => unlinkSync(join(directory, "tracked.txt")),
		},
		{
			name: "renamed",
			mutate: async (directory) => renameSync(join(directory, "tracked.txt"), join(directory, "renamed.txt")),
		},
	];

	for (const scenario of cases) {
		const directory = await newRepository();
		const context = makeContext(directory);
		const clean = await captureCandidate(context);
		assert.equal(clean.kind, "clean", scenario.name);
		await scenario.mutate(directory);
		const dirty = await captureCandidate(context);
		assert.equal(dirty.kind, "dirty", scenario.name);
		assert.notEqual(dirty.id, clean.id, scenario.name);
	}
});

test("staged capture uses the real index and preserves unstaged and untracked inputs", async () => {
	const directory = await newRepository();
	writeFileSync(join(directory, "tracked.txt"), "staged source\n");
	await git(directory, "add", "tracked.txt");
	const indexTree = await git(directory, "write-tree");
	writeFileSync(join(directory, "tracked.txt"), "unstaged repair\n");
	writeFileSync(join(directory, "untracked.txt"), "not staged\n");
	const before = await repositorySnapshot(directory);
	const index = readFileSync(join(directory, ".git", "index"));
	const request = { operation: "capture" as const, source: "staged" as const };
	const response = await executeVerificationEvidence("staged-capture", request, undefined, makeContext(directory));
	const result = response.details;
	if (result.operation !== "capture") throw new Error("expected a candidate capture");
	assert.equal(result.candidate.tree, indexTree, "unstaged repair must not become the staged source");
	assert.ok("source" in result.candidate);
	assert.equal(result.candidate.source, "staged");
	assert.equal(await git(directory, "show", `${result.candidate.tree}:tracked.txt`), "staged source");
	assert.deepEqual(readFileSync(join(directory, ".git", "index")), index);
	assert.equal(readFileSync(join(directory, "tracked.txt"), "utf8"), "unstaged repair\n");
	assert.equal(readFileSync(join(directory, "untracked.txt"), "utf8"), "not staged\n");
	assert.deepEqual(await repositorySnapshot(directory), before);
});

test("staged provenance distinguishes otherwise identical candidate inputs", () => {
	const fields = { repositoryRoot: "/repo", head: "a".repeat(40), tree: "b".repeat(40), kind: "dirty" as const };
	const staged = { ...fields, source: "staged" as const };
	assert.notEqual(createCandidateIdentity(staged).id, createCandidateIdentity(fields).id);
});

test("candidate capture preserves HEAD, branch, real index, status, stash, and files", async () => {
	const directory = await newRepository();
	const index = readFileSync(join(directory, ".git", "index"));
	const before = await repositorySnapshot(directory);
	const candidate = await captureCandidate(makeContext(directory));
	assert.equal(candidate.kind, "clean");
	assert.deepEqual(readFileSync(join(directory, ".git", "index")), index);
	assert.deepEqual(await repositorySnapshot(directory), before);
	assert.equal(readFileSync(join(directory, "tracked.txt"), "utf8"), "base\n");
});

test("candidate capture tolerates embedded repository warnings", async () => {
	const directory = await newRepository();
	const embedded = join(directory, "embedded");
	mkdirSync(embedded);
	await git(embedded, "init", "--quiet");
	await git(embedded, "config", "user.email", "verification@example.test");
	await git(embedded, "config", "user.name", "Verification Test");
	writeFileSync(join(embedded, "tracked.txt"), "embedded\n");
	await git(embedded, "add", "tracked.txt");
	await git(embedded, "commit", "--quiet", "-m", "embedded");

	const candidate = await captureCandidate(makeContext(directory));
	assert.equal(candidate.kind, "dirty");
});

test("candidate capture reports staging and malformed tree diagnostics", async () => {
	const directory = await newRepository();
	const failedAdd = makeContext(directory, {
		resultFor: (command) => command.includes("git add -A")
			? { exitCode: 1, output: "embedded staging failed" }
			: undefined,
	});
	await assert.rejects(captureCandidate(failedAdd), /temporary Git index staging failed with exit 1: embedded staging failed/);

	const malformedTree = makeContext(directory, {
		resultFor: (command) => command.includes("git write-tree")
			? { exitCode: 0, output: `${"x".repeat(MAX_EXPOSED_OUTPUT_BYTES + 100)}tree diagnostic` }
			: undefined,
	});
	await assert.rejects(
		captureCandidate(malformedTree),
		(error: Error) => error.message.includes("invalid Git tree output")
			&& error.message.includes("tree diagnostic")
			&& error.message.length < MAX_EXPOSED_OUTPUT_BYTES + 200,
	);
});

test("capture and run target linked sibling worktrees only", { timeout: 30_000 }, async () => {
	const directory = await newRepository();
	const worktreeContainer = mkdtempSync(join(tmpdir(), "verification-linked-worktree-"));
	runtimeRepositories.push(worktreeContainer);
	const worktree = join(worktreeContainer, "candidate");
	await git(directory, "worktree", "add", "--quiet", "-b", "isolated-candidate", worktree);
	writeFileSync(join(worktree, "candidate.txt"), "isolated\n");
	const context = makeContext(directory);

	const captured = await executeVerificationEvidence(
		"linked-capture",
		{ operation: "capture", repositoryRoot: worktree },
		undefined,
		context,
	);
	assert.equal(captured.details.operation, "capture");
	if (captured.details.operation !== "capture") throw new Error("expected capture result");
	assert.equal(captured.details.candidate.repositoryRoot, await git(worktree, "rev-parse", "--show-toplevel"));
	assert.equal(captured.details.candidate.kind, "dirty");

	const run = await executeVerification(
		"linked-run",
		{ operation: "run", repositoryRoot: worktree, argv: ["git", "rev-parse", "--show-toplevel"], cwd: ".", timeout: 10 },
		context,
	);
	assert.equal(run.output.trim(), captured.details.candidate.repositoryRoot);
	assert.equal(run.evidence.candidate.repositoryRoot, captured.details.candidate.repositoryRoot);

	await assert.rejects(
		executeVerification("relative-root", { operation: "run", repositoryRoot: "../candidate", argv: ["true"], cwd: ".", timeout: 10 }, context),
		/repositoryRoot must be absolute/,
	);
	mkdirSync(join(worktree, "subdirectory"));
	await assert.rejects(
		executeVerification("subdirectory-root", { operation: "run", repositoryRoot: join(worktree, "subdirectory"), argv: ["true"], cwd: ".", timeout: 10 }, context),
		/repositoryRoot must be the worktree top level/,
	);
	const unrelated = await newRepository();
	await assert.rejects(
		executeVerification("unrelated-root", { operation: "run", repositoryRoot: unrelated, argv: ["true"], cwd: ".", timeout: 10 }, context),
		/linked worktree of the session repository/,
	);
});

test("non-Git and unborn repositories fail descriptively", async () => {
	const nonGit = mkdtempSync(join(tmpdir(), "verification-non-git-"));
	runtimeRepositories.push(nonGit);
	await assert.rejects(captureCandidate(makeContext(nonGit)), /Git working tree|repository discovery/);

	const unborn = mkdtempSync(join(tmpdir(), "verification-unborn-"));
	runtimeRepositories.push(unborn);
	await git(unborn, "init", "--quiet");
	await assert.rejects(captureCandidate(makeContext(unborn)), /unborn HEAD|no commit/);
});

test("cwd and argv validation rejects unsafe execution forms", async () => {
	const directory = await newRepository();
	const outside = mkdtempSync(join(tmpdir(), "verification-outside-"));
	runtimeRepositories.push(outside);
	symlinkSync(outside, join(directory, "outside-link"));
	symlinkSync(".", join(directory, "inside-link"));
	const context = makeContext(directory);
	const run = (cwd: string) => executeVerification("unsafe", { operation: "run", argv: ["true"], cwd, timeout: 10 }, context);
	await assert.rejects(run("/tmp"), /repository-relative/);
	await assert.rejects(run("../outside"), /traverse/);
	await assert.rejects(run("outside-link"), /symlink/);
	await assert.rejects(run("inside-link"), /symlink/);

	assert.throws(() => canonicalCommand([]), /non-empty argv/);
	assert.throws(() => canonicalCommand(["printf", ""]), /empty argv/);
	assert.throws(() => canonicalCommand(["printf", "bad\0value"]), /NUL/);
	assert.throws(() => canonicalCommand(["bash", "-c", "true"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["/bin/sh", "-lc", "true"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["fish", "--command=true"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["fish", "-C", "false; exit 0"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["fish", "--init-command=false; exit 0"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["env", "-S", "sh -c true"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["/usr/bin/env", "--split-string=sh -c true"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["command", "env", "-S", "sh -c 'false; exit 0'"]), /shell command wrappers/);
	assert.throws(() => canonicalCommand(["printf", "ok\0"]), /NUL/);
	await assert.rejects(run("bad\0cwd"), /NUL/);
	await assert.rejects(executeVerification("timeout", { operation: "run", argv: ["true"], cwd: ".", timeout: 601 }, context), /timeout/);

	const special = await executeVerification(
		"special-argv",
		{ operation: "run", argv: ["printf", "%s", "line\n`tick`\\end"], cwd: ".", timeout: 10 },
		context,
	);
	assert.equal(special.output, "line\n`tick`\\end");
	assert.doesNotMatch(special.evidence.command, /[\n`]/);

});

test("failed commands and missing structured exits fail closed", async () => {
	const directory = await newRepository();
	const context = makeContext(directory);
	const failed = await executeVerification("failed", { operation: "run", argv: ["false"], cwd: ".", timeout: 10 }, context);
	assert.equal(failed.evidence.exitCode, 1);
	assert.deepEqual(verificationClaimErrors({ evidenceId: failed.evidence.id, command: failed.evidence.command, exitCode: 1 }), []);
	const toolResult = await executeVerificationEvidence("failed-tool", { operation: "run", argv: ["false"], cwd: ".", timeout: 10 }, undefined, context);
	assert.equal(toolResult.isError, true);

	const missingParams = { operation: "run" as const, argv: ["printf", "missing-structured"], cwd: ".", timeout: 10 };
	const prior = await executeVerification("prior", missingParams, context);
	assert.deepEqual(verificationClaimErrors({ evidenceId: prior.evidence.id, command: prior.evidence.command, exitCode: 0 }), []);
	const missingExit = makeContext(directory, { omitExitFor: (command) => command.includes("missing-structured") });
	await assert.rejects(executeVerification("missing", missingParams, missingExit), /structured exit_code/);
	assert.match(
		verificationClaimErrors({ evidenceId: prior.evidence.id, command: prior.evidence.command, exitCode: 0 })[0],
		/obsolete/,
	);
});

test("source mutation invalidates otherwise successful evidence and prior commands", async () => {
	const directory = await newRepository();
	const prior = record("'bun' 'test' 'prior-stable'");
	const result = await executeVerification("mutator", { operation: "run", argv: ["touch", "created.txt"], cwd: ".", timeout: 10 }, makeContext(directory));
	assert.equal(result.evidence.exitCode, 0);
	assert.equal(result.evidence.valid, false);
	assert.equal(result.evidence.invalidReason, "candidate changed during verification");
	assert.match(verificationClaimErrors({ evidenceId: result.evidence.id, command: result.evidence.command, exitCode: 0 }).join("\n"), /candidate changed/);
	assert.match(verificationClaimErrors({ evidenceId: prior.id, command: prior.command, exitCode: 0 }).join("\n"), /stale: candidate changed during verification/);
});

test("ref-only HEAD mutation invalidates otherwise successful evidence", async () => {
	const directory = await newRepository();
	const result = await executeVerification(
		"ref-mutator",
		{ operation: "run", argv: ["git", "commit", "--allow-empty", "--quiet", "-m", "move HEAD"], cwd: ".", timeout: 10 },
		makeContext(directory),
	);
	assert.equal(result.evidence.exitCode, 0);
	assert.equal(result.evidence.valid, false);
	assert.equal(result.evidence.invalidReason, "candidate changed during verification");
});

test("candidate mutation stales prior evidence before a log-write failure", async () => {
	const directory = await newRepository();
	const prior = record("'bun' 'test' 'before-log-failure'");
	await assert.rejects(
		executeVerification(
			"log-failure",
			{ operation: "run", argv: ["touch", "created-before-log-failure.txt"], cwd: ".", timeout: 10 },
			makeContext(directory),
			undefined,
			() => { throw new Error("forced verification log write failure"); },
		),
		/forced verification log write failure/,
	);
	assert.match(verificationClaimErrors({ evidenceId: prior.id, command: prior.command, exitCode: 0 }).join("\n"), /stale: candidate changed during verification/);
});

test("logs are mode 0600 and hashed while exposed output stays bounded", async () => {
	const directory = await newRepository();
	const fullOutput = "x".repeat(MAX_EXPOSED_OUTPUT_BYTES + 1000);
	const result = await executeVerification("large-output", { operation: "run", argv: ["printf", "%s", fullOutput], cwd: ".", timeout: 10 }, makeContext(directory));
	assert.equal(result.output.length, MAX_EXPOSED_OUTPUT_BYTES);
	const log = readFileSync(result.evidence.logPath);
	assert.equal(log.length, fullOutput.length);
	assert.equal(statSync(result.evidence.logPath).mode & 0o777, 0o600);
	assert.equal(createHash("sha256").update(log).digest("hex"), result.evidence.logSha256);
});

test("concurrent tool calls keep their candidate evidence and logs separate", async () => {
	const directory = await newRepository();
	const context = makeContext(directory);
	const [left, right] = await Promise.all([
		executeVerification("tool-call-left", { operation: "run", argv: ["printf", "left"], cwd: ".", timeout: 10 }, context),
		executeVerification("tool-call-right", { operation: "run", argv: ["printf", "right"], cwd: ".", timeout: 10 }, context),
	]);
	assert.equal(left.output, "left");
	assert.equal(right.output, "right");
	assert.notEqual(left.evidence.id, right.evidence.id);
	assert.notEqual(left.evidence.logPath, right.evidence.logPath);
});

test("capture operation returns a structured candidate", async () => {
	const directory = await newRepository();
	const result = await executeVerificationEvidence("capture", { operation: "capture" }, undefined, makeContext(directory));
	assert.equal(result.isError, undefined);
	assert.equal(result.details.operation, "capture");
	assert.equal(result.structuredContent?.operation, "capture");
});

test("background start and early terminal collect preserve the verification contract", { timeout: 30_000 }, async () => {
	const directory = await newRepository();
	const fullOutput = "x".repeat(MAX_EXPOSED_OUTPUT_BYTES + 100);
	const service = backgroundService(directory, { output: fullOutput });
	const context = makeContext(directory);
	const started = await executeVerificationEvidence(
		"start-success",
		{ operation: "start", argv: ["printf", "%s", "verification"], cwd: ".", timeout: 10 },
		undefined,
		context,
		service,
	);
	assert.equal(started.details.operation, "start");
	if (started.details.operation !== "start") throw new Error("expected start result");
	assert.equal(started.details.taskId, "task-1");
	assert.equal(started.details.candidate.kind, "clean");
	assert.equal(await git(directory, "status", "--porcelain", "--untracked-files=all"), "");
	assert.match(started.details.task.command, /cd .* && 'printf' '%s' 'verification'/);
	const collected = await executeVerificationEvidence(
		"collect-success",
		{ operation: "collect", taskId: started.details.taskId },
		undefined,
		context,
		service,
	);
	assert.equal(collected.isError, false);
	if (collected.details.operation !== "collect") throw new Error("expected collect result");
	assert.equal(collected.details.evidence.argv[0], "printf");
	assert.equal(collected.details.evidence.cwd, ".");
	assert.equal(collected.details.output.length, MAX_EXPOSED_OUTPUT_BYTES);
	assert.deepEqual(readFileSync(collected.details.evidence.logPath), Buffer.from(fullOutput));
	assert.equal(service.counts.status, 0);
	assert.equal(service.counts.logs, 1);
	await assert.rejects(
		executeVerificationEvidence("collect-duplicate", { operation: "collect", taskId: started.details.taskId }, undefined, context, service),
		/already collected/,
	);
});

it.each(["linked worktree", "session subdirectory"])("legacy background output belongs to the service directory: %s", async (scenario) => {
	const directory = await newRepository();
	const sessionDirectory = join(directory, "session");
	mkdirSync(sessionDirectory);
	let repositoryRoot = directory;
	if (scenario === "linked worktree") {
		const container = mkdtempSync(join(tmpdir(), "verification-background-linked-"));
		runtimeRepositories.push(container);
		repositoryRoot = join(container, "candidate");
		await git(directory, "worktree", "add", "--quiet", "--detach", repositoryRoot);
	}
	const outputPath = ".pi/tasks/session/task-1.output";
	mkdirSync(dirname(join(sessionDirectory, outputPath)), { recursive: true });
	writeFileSync(join(sessionDirectory, outputPath), "verification output\n");
	const service = backgroundService(sessionDirectory, { outputPath });
	const context = makeContext(sessionDirectory);
	const started = await executeVerificationEvidence("legacy-start", {
		operation: "start", repositoryRoot, argv: ["true"], cwd: ".", timeout: 10,
	}, undefined, context, service);
	if (started.details.operation !== "start") throw new Error("expected start result");
	const collected = await executeVerificationEvidence("legacy-collect", {
		operation: "collect", taskId: started.details.taskId,
	}, undefined, context, service);
	if (collected.details.operation !== "collect") throw new Error("expected collect result");
	assert.equal(collected.isError, false);
	assert.equal(collected.details.evidence.candidate.repositoryRoot, realpathSync(repositoryRoot));
	assert.equal(collected.details.output, "verification output\n");
});

it.each([
	{ name: "unstaged source", path: "tracked.txt", stage: false },
	{ name: "staged source", path: "tracked.txt", stage: true },
	{ name: "untracked source", path: "new.txt", stage: false },
	{ name: "Pi configuration", path: ".pi/settings.json", stage: false },
	{ name: "source inside a legacy tasks directory", path: ".pi/tasks/source.ts", stage: false },
])("external runtime output does not hide $name mutations", async ({ path, stage }) => {
	const directory = await newRepository();
	const service = backgroundService(directory);
	const context = makeContext(directory);
	const started = await executeVerificationEvidence("mutation-start", {
		operation: "start", argv: ["true"], cwd: ".", timeout: 10,
	}, undefined, context, service);
	if (started.details.operation !== "start") throw new Error("expected start result");
	mkdirSync(dirname(join(directory, path)), { recursive: true });
	writeFileSync(join(directory, path), "changed\n");
	if (stage) await git(directory, "add", path);
	const collected = await executeVerificationEvidence("mutation-collect", {
		operation: "collect", taskId: started.details.taskId,
	}, undefined, context, service);
	if (collected.details.operation !== "collect") throw new Error("expected collect result");
	assert.equal(collected.details.evidence.exitCode, 0);
	assert.equal(collected.details.evidence.valid, false);
	assert.equal(collected.details.evidence.invalidReason, "candidate changed during verification");
});

it.each(["arbitrary temporary directory", "wrong task filename", "symlinked runtime directory", "traversal"])("external runtime output rejects %s", async (scenario) => {
	const directory = await newRepository();
	const runtimeDirectory = mkdtempSync(join(realpathSync(tmpdir()), scenario === "arbitrary temporary directory" ? "other-runtime-" : "pi-background-tasks-test-"));
	runtimeRepositories.push(runtimeDirectory);
	writeFileSync(join(runtimeDirectory, "task-1.output"), "verification output\n");
	let outputPath = join(runtimeDirectory, "task-1.output");
	if (scenario === "wrong task filename") {
		outputPath = join(runtimeDirectory, "another-task.output");
		writeFileSync(outputPath, "verification output\n");
	} else if (scenario === "symlinked runtime directory") {
		const link = `${runtimeDirectory}-link`;
		symlinkSync(runtimeDirectory, link);
		runtimeRepositories.push(link);
		outputPath = join(link, "task-1.output");
	} else if (scenario === "traversal") {
		outputPath = `${runtimeDirectory}/../${basename(runtimeDirectory)}/task-1.output`;
	}
	const service = backgroundService(directory, { outputPath });
	const context = makeContext(directory);
	const started = await executeVerificationEvidence("unsafe-runtime-start", {
		operation: "start", argv: ["true"], cwd: ".", timeout: 10,
	}, undefined, context, service);
	if (started.details.operation !== "start") throw new Error("expected start result");
	await assert.rejects(executeVerificationEvidence("unsafe-runtime-collect", {
		operation: "collect", taskId: started.details.taskId,
	}, undefined, context, service), /output path|symbolic link|task filename/);
});

test("background collect accepts empty bounded-log text for silent commands", { timeout: 30_000 }, async () => {
	const directory = await newRepository();
	const service = backgroundService(directory, { output: "", logsText: "" });
	const context = makeContext(directory);
	const started = await executeVerificationEvidence(
		"start-silent",
		{ operation: "start", argv: ["true"], cwd: ".", timeout: 10 },
		undefined,
		context,
		service,
	);
	if (started.details.operation !== "start") throw new Error("expected start result");
	const collected = await executeVerificationEvidence(
		"collect-silent",
		{ operation: "collect", taskId: started.details.taskId },
		undefined,
		context,
		service,
	);
	assert.equal(collected.isError, false);
	if (collected.details.operation !== "collect") throw new Error("expected collect result");
	assert.equal(collected.details.output, "");
	assert.equal(readFileSync(collected.details.evidence.logPath).byteLength, 0);
});

test("background collect performs one status query and rejects a running task", { timeout: 30_000 }, async () => {
	const directory = await newRepository();
	const service = backgroundService(directory, { status: "running", emitTerminalOnRun: false });
	const context = makeContext(directory);
	const started = await executeVerificationEvidence(
		"start-running",
		{ operation: "start", argv: ["true"], cwd: ".", timeout: 10 },
		undefined,
		context,
		service,
	);
	if (started.details.operation !== "start") throw new Error("expected start result");
	await assert.rejects(
		executeVerificationEvidence("collect-running", { operation: "collect", taskId: started.details.taskId }, undefined, context, service),
		/still running/,
	);
	assert.equal(service.counts.status, 1);
	service.complete();
	const collected = await executeVerificationEvidence(
		"collect-after-terminal",
		{ operation: "collect", taskId: started.details.taskId },
		undefined,
		context,
		service,
	);
	assert.equal(collected.isError, false);
	assert.equal(service.counts.status, 1);
});

test("background collect reports nonzero exits and candidate mutation", { timeout: 30_000 }, async () => {
	const failedDirectory = await newRepository();
	const failedService = backgroundService(failedDirectory, { exitCode: 7 });
	const failedContext = makeContext(failedDirectory);
	const failedStart = await executeVerificationEvidence(
		"start-nonzero",
		{ operation: "start", argv: ["false"], cwd: ".", timeout: 10 },
		undefined,
		failedContext,
		failedService,
	);
	if (failedStart.details.operation !== "start") throw new Error("expected start result");
	const failedCollect = await executeVerificationEvidence(
		"collect-nonzero",
		{ operation: "collect", taskId: failedStart.details.taskId },
		undefined,
		failedContext,
		failedService,
	);
	assert.equal(failedCollect.isError, true);
	if (failedCollect.details.operation !== "collect") throw new Error("expected collect result");
	assert.equal(failedCollect.details.evidence.exitCode, 7);
	assert.equal(failedCollect.details.evidence.valid, true);

	const mutatedDirectory = await newRepository();
	const mutatedService = backgroundService(mutatedDirectory);
	const mutatedContext = makeContext(mutatedDirectory);
	const mutatedStart = await executeVerificationEvidence(
		"start-mutated",
		{ operation: "start", argv: ["true"], cwd: ".", timeout: 10 },
		undefined,
		mutatedContext,
		mutatedService,
	);
	if (mutatedStart.details.operation !== "start") throw new Error("expected start result");
	writeFileSync(join(mutatedDirectory, "tracked.txt"), "changed after start\n");
	const mutatedCollect = await executeVerificationEvidence(
		"collect-mutated",
		{ operation: "collect", taskId: mutatedStart.details.taskId },
		undefined,
		mutatedContext,
		mutatedService,
	);
	assert.equal(mutatedCollect.isError, true);
	if (mutatedCollect.details.operation !== "collect") throw new Error("expected collect result");
	assert.equal(mutatedCollect.details.evidence.valid, false);
	assert.equal(mutatedCollect.details.evidence.invalidReason, "candidate changed during verification");
});

test.each(["failed", "killed"] as const)("%s tasks without an exit code are invalid", { timeout: 30_000 }, async (status) => {
	const directory = await newRepository();
	const service = backgroundService(directory, { status, omitExitCode: true });
	const context = makeContext(directory);
	const started = await executeVerificationEvidence(
		`start-${status}`,
		{ operation: "start", argv: ["true"], cwd: ".", timeout: 10 },
		undefined,
		context,
		service,
	);
	if (started.details.operation !== "start") throw new Error("expected start result");
	const collected = await executeVerificationEvidence(
		`collect-${status}`,
		{ operation: "collect", taskId: started.details.taskId },
		undefined,
		context,
		service,
	);
	assert.equal(collected.isError, true);
	if (collected.details.operation !== "collect") throw new Error("expected collect result");
	assert.equal(collected.details.evidence.exitCode, -1);
	assert.match(collected.details.evidence.invalidReason ?? "", /did not report a numeric exit code/);
});

test("background output paths fail closed for missing and symlinked files", { timeout: 30_000 }, async () => {
	const missingDirectory = await newRepository();
	const missingService = backgroundService(missingDirectory, { outputPath: ".pi/tasks/session/missing.output" });
	const missingContext = makeContext(missingDirectory);
	const missingStart = await executeVerificationEvidence(
		"start-missing-output",
		{ operation: "start", argv: ["true"], cwd: ".", timeout: 10 },
		undefined,
		missingContext,
		missingService,
	);
	if (missingStart.details.operation !== "start") throw new Error("expected start result");
	await assert.rejects(
		executeVerificationEvidence("collect-missing-output", { operation: "collect", taskId: missingStart.details.taskId }, undefined, missingContext, missingService),
		/could not read background task output path/,
	);

	const symlinkDirectory = await newRepository();
	const tasksDirectory = join(symlinkDirectory, ".pi", "tasks", "session");
	mkdirSync(tasksDirectory, { recursive: true });
	const outside = join(symlinkDirectory, "outside.output");
	writeFileSync(outside, "outside\n");
	const symlinkOutput = join(tasksDirectory, "symlink.output");
	symlinkSync(outside, symlinkOutput);
	const symlinkService = backgroundService(symlinkDirectory, { outputPath: ".pi/tasks/session/symlink.output" });
	const symlinkContext = makeContext(symlinkDirectory);
	const symlinkStart = await executeVerificationEvidence(
		"start-symlink-output",
		{ operation: "start", argv: ["true"], cwd: ".", timeout: 10 },
		undefined,
		symlinkContext,
		symlinkService,
	);
	if (symlinkStart.details.operation !== "start") throw new Error("expected start result");
	await assert.rejects(
		executeVerificationEvidence("collect-symlink-output", { operation: "collect", taskId: symlinkStart.details.taskId }, undefined, symlinkContext, symlinkService),
		/symbolic link/,
	);
});

test("start preserves validation and fails when the EventBus is unavailable", async () => {
	const directory = await newRepository();
	const context = makeContext(directory);
	const unavailable = {
		on: () => () => undefined,
		emit: () => { throw new Error("service unavailable"); },
	} as EventBus;
	await assert.rejects(
		executeVerificationEvidence("start-unavailable", { operation: "start", argv: ["true"], cwd: ".", timeout: 10 }, undefined, context, unavailable),
		/service unavailable/,
	);
	await assert.rejects(
		executeVerificationEvidence("start-timeout", { operation: "start", argv: ["true"], cwd: ".", timeout: 601 }, undefined, context, unavailable),
		/timeout/,
	);
	await assert.rejects(
		executeVerificationEvidence("start-shell", { operation: "start", argv: ["sh", "-c", "true"], cwd: ".", timeout: 10 }, undefined, context, unavailable),
		/shell command wrappers/,
	);
	await assert.rejects(
		executeVerificationEvidence("collect-unknown", { operation: "collect", taskId: "unknown" }, undefined, context, unavailable),
		/unknown/,
	);
});

test("malformed terminal frames are rejected by the shared EventBus listener", async () => {
	const directory = await newRepository();
	const service = backgroundService(directory);
	registerVerificationEvidence({ events: service, registerTool: () => undefined } as never);
	assert.throws(() => service.emit(BACKGROUND_TASK_TERMINAL_CHANNEL, {
		schema_version: BACKGROUND_TASK_TERMINAL_SCHEMA,
		task: { id: "task-1", status: "completed", extra: true },
	}), /unknown key|background task/);
});

test("verification evidence uses one background-first shared tool contract", () => {
	let tool: { prepareLoadout?: unknown; promptGuidelines?: string[] } | undefined;
	registerVerificationEvidence({ registerTool: (registered: never) => { tool = registered; } } as never);
	assert.equal(tool?.prepareLoadout, undefined);
	const guidance = tool?.promptGuidelines?.join("\n") ?? "";
	assert.match(guidance, /Default to start/);
	assert.match(guidance, /automatic terminal notification without polling/);
	assert.match(guidance, /expected lack of parallel work is not sufficient/);
});
