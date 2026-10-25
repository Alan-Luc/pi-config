import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { registerGuardrails, REVIEW_ARTIFACT_ROOT } from "../extensions/guardrails/guardrails.ts";
import { AGENT_OUTPUT } from "../extensions/artifact-contracts/schemas.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;
function createPi() {
	const handlers: Record<string, Handler> = {};
	registerGuardrails({ on: (name: string, handler: Handler) => { handlers[name] = handler; return () => undefined; } } as never, {});
	return handlers;
}
function call(handlers: Record<string, Handler>, command: string, cwd = "/tmp/project") {
	return handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "call", input: { command } }, { cwd });
}
async function artifact(): Promise<string> {
	await mkdir(REVIEW_ARTIFACT_ROOT, { recursive: true });
	const directory = await mkdtemp(join(REVIEW_ARTIFACT_ROOT, "guardrails-review-"));
	const path = join(directory, "review.patch");
	await writeFile(path, "diff\n");
	return path;
}

test("publication is disabled without trusted parent grant, target, candidate and scanner adapters", async () => {
	await expect(call(createPi(), "git push origin TASK-123-fix")).rejects.toThrow(/publication.*disabled/);
});

test.each(["git push origin main", "git push --force origin feature", "git -C /tmp/repository push -f origin release", "command git push origin TASK-123-fix", "exec git push origin TASK-123-fix", "command -p git push origin TASK-123-fix", "exec -- git push origin TASK-123-fix", "command -p -- git push origin TASK-123-fix", "exec -c git push origin TASK-123-fix", "exec -a fixture-name git push origin TASK-123-fix", "command command -p git push origin TASK-123-fix"])("denies publication without runtime authority: %s", async (command) => {
	await expect(call(createPi(), command)).rejects.toThrow("publication");
});

test.each([
	["git push", "explicit positional shape"], ["git push upstream main", "explicit positional shape"],
	["git push origin HEAD", "non-HEAD"], ["git push origin :main", "non-refspec"], ["git push origin +main", "non-refspec"],
	["git push origin ~", "shell expansion"], ["git push origin {main,release}", "shell expansion"],
	["git push --repo=/tmp/other origin main", "cannot override"], ["git push origin main another", "explicit positional shape"],
] as const)("rejects invalid push: %s", async (command, message) => {
	await expect(call(createPi(), command)).rejects.toThrow(message);
});

test("rejects Git environment retargeting and ambiguous syntax", async () => {
	await expect(call(createPi(), "GIT_DIR=/tmp/other git push origin main")).rejects.toThrow("retargeting");
	await expect(call(createPi(), "export GIT_DIR=/tmp/other; git push origin main")).rejects.toThrow("retargeting");
	await expect(call(createPi(), "git --bad foo worktree add .harness/worktrees/x")).rejects.toThrow("ambiguous direct Git mutation syntax");
});

test("permits only verification-owned temporary Git indexes", async () => {
	const handlers = createPi();
	const ctx = { cwd: "/tmp/project" };
	const indexPath = join(tmpdir(), "pi-verification-index-abc123", "index");
	const addCommand = `cd '/tmp/project' && GIT_INDEX_FILE='${indexPath}' git add -A`;
	const writeTreeCommand = `cd '/tmp/project' && GIT_INDEX_FILE='${indexPath}' git write-tree`;
	for (const command of [addCommand, writeTreeCommand]) {
		await expect(call(handlers, command)).rejects.toThrow("retargeting");
		await expect(handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "ordinary/1", parentToolCallId: "ordinary", input: { command } }, ctx)).rejects.toThrow("retargeting");
	}

	await handlers.tool_call({ type: "tool_call", toolName: "verification_evidence", toolCallId: "verify", input: { operation: "capture" } }, ctx);
	await handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "verify/1", parentToolCallId: "verify", input: { command: addCommand } }, ctx);
	await handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "verify/2", parentToolCallId: "verify", input: { command: writeTreeCommand } }, ctx);
	for (const maliciousCommand of [
		"GIT_DIR=/tmp/other git status",
		"GIT_INDEX_FILE+=/tmp/other git status",
		"env GIT_INDEX_FILE=/tmp/other/index git add -A",
		`${addCommand} && GIT_INDEX_FILE='${indexPath}' git write-tree`,
		"cd '/tmp/project' && GIT_INDEX_FILE='/tmp/other/index' git add -A",
		`cd '/tmp/project' && GIT_INDEX_FILE='${indexPath}' git add --all`,
	]) {
		await expect(handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "verify/malicious", parentToolCallId: "verify", input: { command: maliciousCommand } }, ctx)).rejects.toThrow("retargeting");
	}

	handlers.tool_result({ type: "tool_result", toolName: "verification_evidence", toolCallId: "verify", input: { operation: "capture" }, content: [], isError: false }, ctx);
	await expect(handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "verify/4", parentToolCallId: "verify", input: { command: addCommand } }, ctx)).rejects.toThrow("retargeting");
});

test.each(["git -C /tmp/repository commit --no-verify -m message", "git commit -nq -m message"])("rejects no-verify: %s", async (command) => {
	await expect(call(createPi(), command)).rejects.toThrow("no-verify");
});

test("allows and rejects physical worktree containment", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-guardrails-worktree-"));
	await mkdir(join(root, ".harness", "worktrees"), { recursive: true });
	await call(createPi(), "git worktree add .harness/worktrees/feature", root);
	await expect(call(createPi(), "git worktree add /tmp/outside", root)).rejects.toThrow("outside the allowed");
	await expect(call(createPi(), "git worktree add .harness/worktrees", root)).rejects.toThrow("non-empty child");
	await expect(call(createPi(), "git worktree add ../.harness/worktrees/outside", root)).rejects.toThrow("outside the allowed");
});

test("rejects worktree symlink escapes and cd-based ambiguity", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-guardrails-worktree-symlink-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-guardrails-outside-"));
	await mkdir(join(root, ".harness"), { recursive: true });
	await symlink(outside, join(root, ".harness", "worktrees"));
	await expect(call(createPi(), "git worktree add .harness/worktrees/feature", root)).rejects.toThrow("outside the allowed");
	await expect(call(createPi(), "cd /tmp && git worktree add .harness/worktrees/feature", root)).rejects.toThrow("after cd");
});

test("requires bounded existing review artifacts for single and child launches", async () => {
	const path = await artifact();
	const metadata = `Candidate: candidate_${"a".repeat(64)}\nPatch SHA-256: ${createHash("sha256").update("diff\n").digest("hex")}\nExcluded pre-dirty paths: []`;
	const task = `${metadata}\nPatch artifact: ${path}\nReview paths: ${JSON.stringify(["/tmp/project/src/example.ts"])}`;
	const handlers = createPi();
	await handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "review", input: { agent: "code-reviewer", task } }, { cwd: "/tmp/project" });
	await handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "review", input: { children: [{ agent: "code-reviewer", task }] } }, { cwd: "/tmp/project" });

	const unbounded = () => handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task: "" } }, { cwd: "/tmp/project" });
	for (const expected of [REVIEW_ARTIFACT_ROOT, "Patch artifact:", "Review paths:", "Excluded pre-dirty paths:"]) {
		await expect(unbounded()).rejects.toThrow(expected);
	}

	const missing = join(REVIEW_ARTIFACT_ROOT, "missing.patch");
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task: `${metadata}\nPatch artifact: ${missing}\nReview paths: /tmp/project/src/example.ts` } }, { cwd: "/tmp/project" })).rejects.toThrow("does not exist");
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task: `${metadata}\nPatch artifact: ${path}` } }, { cwd: "/tmp/project" })).rejects.toThrow("Review paths");
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task: task.replace(/^Excluded pre-dirty paths:.*\n/m, "") } }, { cwd: "/tmp/project" })).rejects.toThrow("Excluded pre-dirty paths");
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task: `${metadata}\nPatch artifact: ${dirname(path)}\nReview paths: /tmp/project/src/example.ts` } }, { cwd: "/tmp/project" })).rejects.toThrow("regular file");

	const outside = join(await mkdtemp(join(tmpdir(), "pi-review-outside-")), "review.patch");
	await writeFile(outside, "diff\n");
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { children: [{ agent: "code-reviewer", task: `${metadata}\nPatch artifact: ${outside}\nReview paths: /tmp/project/src/example.ts` }] } }, { cwd: "/tmp/project" })).rejects.toThrow("lexically contained");
});

test.each(["code-reviewer", "code-reviewer-sonnet", "code-reviewer-sol", "code-reviewer-opus", "code-reviewer-haiku"] as const)("enforces bounded metadata for registered reviewer profile %s", async (agent) => {
	expect(AGENT_OUTPUT[agent]).toBe("review");
	const path = await artifact();
	const metadata = `Candidate: candidate_${"a".repeat(64)}\nPatch SHA-256: ${createHash("sha256").update("diff\n").digest("hex")}\nExcluded pre-dirty paths: []`;
	const task = `${metadata}\nPatch artifact: ${path}\nReview paths: /tmp/project/src/example.ts`;
	const handlers = createPi();
	await handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "review", input: { agent, task } }, { cwd: "/tmp/project" });
	await handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "review", input: { children: [{ agent, task }] } }, { cwd: "/tmp/project" });
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent, task: "" } }, { cwd: "/tmp/project" })).rejects.toThrow("generated review metadata");
	const stale = task.replace(/^Patch SHA-256: .*$/m, `Patch SHA-256: ${"b".repeat(64)}`);
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "stale", input: { children: [{ agent, task: stale }] } }, { cwd: "/tmp/project" })).rejects.toThrow("does not match generated");
	const outside = task.replace(path, "/outside/review.patch");
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "outside", input: { agent, task: outside } }, { cwd: "/tmp/project" })).rejects.toThrow("lexically contained");
});

test("rejects a generated hash that does not match the exact patch bytes", async () => {
	const path = await artifact();
	const task = `Candidate: candidate_${"a".repeat(64)}\nPatch SHA-256: ${"b".repeat(64)}\nPatch artifact: ${path}\nReview paths: ${JSON.stringify(["/tmp/project/src/example.ts"])}\nExcluded pre-dirty paths: []`;
	const handlers = createPi();
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task } }, { cwd: "/tmp/project" })).rejects.toThrow("does not match generated");
});

test("rejects symlink and traversal review artifacts", async () => {
	const path = await artifact();
	const metadata = `Candidate: candidate_${"a".repeat(64)}\nPatch SHA-256: ${"b".repeat(64)}\nExcluded pre-dirty paths: []`;
	const alias = join(dirname(path), "alias.patch");
	await symlink(path, alias);
	const handlers = createPi();
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task: `${metadata}\nPatch artifact: ${alias}\nReview paths: /tmp/project/src/example.ts` } }, { cwd: "/tmp/project" })).rejects.toThrow("symbolic link");
	await expect(handlers.tool_call({ type: "tool_call", toolName: "subagent", toolCallId: "bad", input: { agent: "code-reviewer", task: `${metadata}\nPatch artifact: ${dirname(path)}/alias/../review.patch\nReview paths: /tmp/project/src/example.ts` } }, { cwd: "/tmp/project" })).rejects.toThrow("parent traversal");
});

test("suppresses unchanged infrastructure retries with an explicit Pi override", async () => {
	const handlers = createPi();
	const command = "bun test tests/example.test.ts";
	handlers.tool_result({ type: "tool_result", toolName: "bash", toolCallId: "call", input: { command }, content: [{ type: "text", text: "ECONNREFUSED localhost:55432" }], isError: true }, { cwd: "/tmp/project" });
	await expect(call(handlers, command)).rejects.toThrow("unchanged DB/infrastructure failure");
	await call(handlers, `PI_ALLOW_INFRA_RETRY=1 ${command}`);
	handlers.tool_result({ type: "tool_result", toolName: "bash", toolCallId: "call", input: { command }, content: [{ type: "text", text: "passed" }], isError: false }, { cwd: "/tmp/project" });
	await call(handlers, command);
});

function createPiWithEnv(env: Record<string, string | undefined>) {
	const handlers: Record<string, Handler> = {};
	registerGuardrails({ on: (name: string, handler: Handler) => { handlers[name] = handler; return () => undefined; } } as never, env);
	return handlers;
}

test("children cannot commit or push; parents can commit but publication stays disabled", async () => {
	const key = "PI_SUBAGENT_AGENT";
	const child = createPiWithEnv({ [key]: "1" });
	for (const command of ["git commit -m x", "git push origin main", "git -C repo commit", "ls && git push origin main", "git --no-pager commit -m x", "git -C", "env git commit -m x", "env -S 'git push origin TASK-123-fix'"]) {
		await expect(call(child, command)).rejects.toThrow("Subagents cannot commit or push");
	}
	await call(child, "git status");
	await call(child, "git diff");
	const main = createPiWithEnv({});
	await call(main, "git commit -m x");
	await expect(call(main, "git push origin main")).rejects.toThrow("publication gate disabled");
});
