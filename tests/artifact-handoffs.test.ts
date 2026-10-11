import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "bun:test";
import { correctionMessage, failureReport, registerHandoffHooks, replyInstructions, replySchema } from "../extensions/artifact-contracts/handoffs.ts";
import { renderTemplate } from "../extensions/artifact-contracts/render.ts";
import {
	createCandidateIdentity,
	recordVerificationEvidence,
} from "../extensions/artifact-contracts/verification-store.ts";

const child = { PI_SUBAGENT_AGENT: "code-explorer" };
const valid = "## Status\ndone\n\n## Answer\nFound it.\n\n## Relevant paths\n`src/a.ts:1`\n\n## Uncertainty\nNone.";

type Handler = (event: never) => unknown;
function hooks(env: Record<string, string | undefined>): Record<string, Handler> {
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, env);
	const registered: Record<string, Handler> = {};
	registerHandoffHooks({ on: (name: string, handler: Handler) => { registered[name] = handler; return () => undefined; } } as never);
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, previous);
	return registered;
}

function message(text: string, stopReason = "stop", toolCall = false): never {
	return {
		role: "assistant",
		content: toolCall ? [{ type: "toolCall", id: "1", name: "read", arguments: "{}" }] : [{ type: "text", text }],
		stopReason,
	} as never;
}

function event(text: string, stopReason = "stop", toolCall = false): never {
	return { message: message(text, stopReason, toolCall) } as never;
}

test("selects schemas and does nothing outside children or for null schemas", () => {
	assert.equal(replySchema({}), null);
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "code-explorer" }), "explorer");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "requirements-clarifier" }), "requirements");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "code-reviewer" }), "review");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "code-reviewer-light" }), "reviewLight");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "verification-runner" }), "worker");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "other" }), "worker");
	assert.deepEqual(hooks({}), {});
});

test("appends the template without dropping the prior prompt", () => {
	const registered = hooks(child);
	const start = { systemPromptOptions: { appendSystemPrompt: "Prior instructions" } } as never;
	registered.before_agent_start(start);
	assert.match((start as { systemPromptOptions: { appendSystemPrompt: string } }).systemPromptOptions.appendSystemPrompt, /^Prior instructions\n\n/);
	assert.match((start as { systemPromptOptions: { appendSystemPrompt: string } }).systemPromptOptions.appendSystemPrompt, /Template:/);
	assert.equal(replyInstructions("explorer").includes(renderTemplate("explorer")), true);

	const unset = { systemPromptOptions: {} as { appendSystemPrompt?: string } };
	registered.before_agent_start(unset as never);
	assert.equal(unset.systemPromptOptions.appendSystemPrompt, replyInstructions("explorer"));
});

test("valid, tool-call, and aborted replies are untouched", () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	assert.equal(registered.message_end(event(valid)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(registered.message_end(event("bad", "stop", true)), undefined);
	assert.equal(registered.message_end(event("bad", "aborted")), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("re-prompts twice, then replaces the reply with a fenced failure report", () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.equal(registered.message_end(event("bad")), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
		assert.equal(correction.continue, true);
		assert.match(correction.entries[0].content, /Validation errors:/);
	}
	const original = "bad with ``` inside";
	const replacement = registered.message_end(event(original)) as { message: { content: Array<{ text: string }> } };
	assert.match(replacement.message.content[0].text, /## Status\nfailed/);
	assert.match(replacement.message.content[0].text, /````\nbad with ``` inside\n````/);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("agent_start resets retry state", () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	registered.message_end(event("bad"));
	registered.turn_end({} as never);
	registered.agent_start({} as never);
	registered.message_end(event("bad"));
	const correction = registered.turn_end({} as never) as { continue: boolean };
	assert.equal(correction.continue, true);
});

test("pure report helpers include all errors", () => {
	assert.match(correctionMessage(["one", "two"], "worker"), /- one\n- two/);
	assert.match(failureReport(["one"], "reply"), /## Original reply\n```\nreply\n```/);
});

const worker = { PI_SUBAGENT_AGENT: "other" };
const workerReply = (item: string) =>
	`## Status\ndone\n\n## Objective\nX\n\n## Current state\nY\n\n## Key decisions\nNone.\n\n## Verified by\n${item}\n\n## Next steps\nNone.\n\n## Do not\nNone.`;
const evidenceRoot = mkdtempSync(join(tmpdir(), "artifact-handoff-evidence-"));
let evidenceSequence = 0;
const candidate = createCandidateIdentity({ repositoryRoot: "/repo", head: "a".repeat(40), tree: "b".repeat(40), kind: "dirty" });
function evidence(command: string, exitCode = 0) {
	const output = `output ${evidenceSequence}`;
	const logPath = join(evidenceRoot, `${evidenceSequence++}.log`);
	writeFileSync(logPath, output, { mode: 0o600 });
	chmodSync(logPath, 0o600);
	return recordVerificationEvidence({
		command,
		argv: ["bun", "test"],
		cwd: ".",
		candidate,
		exitCode,
		logPath,
		logSha256: createHash("sha256").update(output).digest("hex"),
		valid: true,
	});
}
afterAll(() => rmSync(evidenceRoot, { recursive: true, force: true }));

test("Verified by must match current evidence exactly", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test' 'tests/'");
	assert.equal(registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(registered.message_end(event(workerReply("- Not run: no time"))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);

	registered.message_end(event(workerReply(`- \`'pnpm' 'typecheck'\` → exit 0 [evidence: ${run.id}]`)));
	let correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /command does not match evidence/);

	registered.message_end(event(workerReply(`- \`${run.command}\` → exit 1 [evidence: ${run.id}]`)));
	correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /reported exit 1, evidence recorded 0/);
});

test("indented Verified by claims still require current evidence", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`   - \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`)
		.replace("\n## Verified by\n", "\n   ## Verified by\n");
	registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("fenced Verified by headings cannot hide the real evidence section", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`- \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`)
		.replace("## Key decisions\nNone.", "## Key decisions\n```md\n## Verified by\n- Not run: example\n```");
	registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("CRLF Verified by claims still require current evidence", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`- \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`).replaceAll("\n", "\r\n");
	registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("verification evidence resets at agent_start", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test'");
	registered.agent_start({} as never);
	registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
	assert.notEqual(registered.turn_end({} as never), undefined);
});

test("write-capable tool activity after a check invalidates its evidence", () => {
	for (const toolName of ["bash", "edit", "write"]) {
		const registered = hooks(worker);
		registered.agent_start({} as never);
		const run = evidence(`'bun' 'test' '${toolName}'`);
		registered.tool_call({ toolName, toolCallId: toolName, input: {} } as never);
		registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
		const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
		assert.match(correction.entries[0].content, new RegExp(`stale: ${toolName} tool activity`));
	}
});

test("overlapping write-capable tools invalidate evidence when they finish", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	registered.tool_call({ toolName: "bash", toolCallId: "overlap", input: {} } as never);
	const run = evidence("'bun' 'test' 'overlap'");
	registered.tool_result({ toolName: "bash", toolCallId: "overlap", input: {}, content: [], isError: false } as never);
	registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /stale: bash tool activity completed/);
});

test("non-worker schemas ignore Verified by", () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	assert.equal(registered.message_end(event(valid + "\n\n## Verified by\n- `nope` → exit 0")), undefined);
});

test("raw or masked Bash claims are rejected without evidence", () => {
	for (const item of ["- `bun test tests/` → exit 0", "- `bun test tests/ || true` → exit 0", "- `bun test tests/ | tail -5` → exit 0"]) {
		const registered = hooks(worker);
		registered.agent_start({} as never);
		registered.message_end(event(workerReply(item)));
		const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
		assert.match(correction.entries[0].content, /expected item matching/);
	}
});
