import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { registerReviewEnforcement, REVIEW_ARTIFACT_ROOT } from "../extensions/artifact-contracts/review-enforcement.ts";
import { AGENT_OUTPUT } from "../extensions/artifact-contracts/schemas.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;
function createPi() {
	const handlers: Record<string, Handler> = {};
	registerReviewEnforcement({ on: (name: string, handler: Handler) => { handlers[name] = handler; return () => undefined; } } as never);
	return handlers;
}
async function artifact(): Promise<string> {
	await mkdir(REVIEW_ARTIFACT_ROOT, { recursive: true });
	const directory = await mkdtemp(join(REVIEW_ARTIFACT_ROOT, "guardrails-review-"));
	const path = join(directory, "review.patch");
	await writeFile(path, "diff\n");
	return path;
}

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

test.each(["code-reviewer", "code-reviewer-sonnet", "code-reviewer-sol"] as const)("enforces bounded metadata for registered reviewer profile %s", async (agent) => {
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
