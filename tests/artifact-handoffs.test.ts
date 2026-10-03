import assert from "node:assert/strict";
import { test } from "bun:test";
import { correctionMessage, failureReport, registerHandoffHooks, replyInstructions, replySchema, verifiedByErrors } from "../extensions/artifact-contracts/handoffs.ts";
import { renderTemplate } from "../extensions/artifact-contracts/render.ts";

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
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "other" }), "worker");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "handoff-writer" }), null);
	assert.deepEqual(hooks({}), {});
	assert.deepEqual(hooks({ PI_SUBAGENT_AGENT: "handoff-writer" }), {});
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
const ran = (registered: Record<string, Handler>, command: string, exit_code: number) =>
	registered.tool_result({ toolName: "bash", input: { command }, isError: exit_code !== 0, structuredContent: { exit_code } } as never);

test("Verified by must match bash commands actually run", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	ran(registered, "cd /x && bun test tests/ 2>&1", 0);
	assert.equal(registered.message_end(event(workerReply("- `bun test tests/` → exit 0"))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(registered.message_end(event(workerReply("- Not run: no time"))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);

	registered.message_end(event(workerReply("- `pnpm typecheck` → exit 0")));
	let correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /"pnpm typecheck" was not run in this session/);

	registered.message_end(event(workerReply("- `bun test tests/` → exit 1")));
	correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /"bun test tests\/" exited 0, not 1/);
});

test("recorded bash runs reset at agent_start", () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	ran(registered, "bun test", 0);
	registered.agent_start({} as never);
	registered.message_end(event(workerReply("- `bun test` → exit 0")));
	assert.notEqual(registered.turn_end({} as never), undefined);
});

test("non-worker schemas ignore Verified by", () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	assert.equal(registered.message_end(event(valid + "\n\n## Verified by\n- `nope` → exit 0")), undefined);
});

test("Verified by: pipes hide exit codes unless pipefail is set", () => {
	const report = "## Verified by\n- `bun test tests/` → exit 0";
	const run = (command: string) => verifiedByErrors(report, [{ command, exitCode: 0 }]);
	assert.deepEqual(run("bun test tests/ 2>&1 | tail -5"), [
		'Verified by: "bun test tests/" exit code is hidden by a pipe; rerun it without a pipe or with set -o pipefail',
	]);
	assert.deepEqual(run("set -o pipefail; bun test tests/ | tail -5"), []);
	assert.deepEqual(run("set -euo pipefail; bun test tests/ | tail -5"), []);
	assert.deepEqual(run("bun test tests/ || true"), []);
	assert.deepEqual(run("echo hi | cat; bun test tests/"), []);
});
