import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";
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

function record(command = "'bun' 'test'", exitCode = 0, valid = true, cwd = ".") {
	const output = `full output ${sequence}`;
	const logPath = join(root, `${sequence++}.log`);
	writeFileSync(logPath, output, { mode: 0o600 });
	chmodSync(logPath, 0o600);
	return recordVerificationEvidence({
		command,
		argv: ["bun", "test"],
		cwd,
		candidate,
		exitCode,
		logPath,
		logSha256: createHash("sha256").update(output).digest("hex"),
		valid,
		invalidReason: valid ? undefined : "candidate changed during verification",
	});
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

test("only the latest record for one command and cwd is reportable", () => {
	const older = record();
	const latest = record();
	assert.match(verificationClaimErrors({ evidenceId: older.id, command: older.command, exitCode: 0 })[0], /obsolete/);
	assert.deepEqual(verificationClaimErrors({ evidenceId: latest.id, command: latest.command, exitCode: 0 }), []);
	beginVerificationAttempt(latest.command, latest.cwd);
	assert.match(verificationClaimErrors({ evidenceId: latest.id, command: latest.command, exitCode: 0 })[0], /obsolete/);
});

test("failed attempts remain scoped to the exact command and cwd", () => {
	const command = "'bun' 'test'";
	const firstCwd = record(command, 0, true, "packages/a");
	beginVerificationAttempt(command, firstCwd.cwd);
	const secondCwd = record(command, 0, true, "packages/b");
	assert.match(verificationClaimErrors({ evidenceId: firstCwd.id, command, exitCode: 0 })[0], /obsolete/);
	assert.deepEqual(verificationClaimErrors({ evidenceId: secondCwd.id, command, exitCode: 0 }), []);
});

test("tool completion before recording invalidates an overlapping verification attempt", () => {
	const command = "'bun' 'test' 'overlap'";
	const attempt = beginVerificationAttempt(command, ".");
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
type FakeBashOptions = { omitExitFor?: (command: string) => boolean };

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
			const result = await runProcess(["bash", "-c", input.command], directory);
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

test("verification runners keep Bash callable but hide it from the model", () => {
	let runnerTool: { prepareLoadout?: () => { hiddenDeclarations?: readonly string[] } } | undefined;
	registerVerificationEvidence(
		{ registerTool: (tool: never) => { runnerTool = tool; } } as never,
		{ PI_SUBAGENT_AGENT: "verification-runner" },
	);
	assert.deepEqual(runnerTool?.prepareLoadout?.().hiddenDeclarations, ["bash"]);

	let implementationTool: { prepareLoadout?: unknown } | undefined;
	registerVerificationEvidence(
		{ registerTool: (tool: never) => { implementationTool = tool; } } as never,
		{ PI_SUBAGENT_AGENT: "backend-engineer" },
	);
	assert.equal(implementationTool?.prepareLoadout, undefined);
});
