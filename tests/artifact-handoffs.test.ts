import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, it, test } from "bun:test";
import { correctionMessage, failureReport, registerHandoffHooks, replyInstructions, replySchema, verifiedByErrors } from "../extensions/artifact-contracts/handoffs.ts";
import {
	BACKGROUND_TASK_REQUEST_CHANNEL,
	BACKGROUND_TASK_RESPONSE_CHANNEL,
	BACKGROUND_TASK_RESPONSE_SCHEMA,
} from "../extensions/artifact-contracts/background-tasks.ts";
import { renderTemplate } from "../extensions/artifact-contracts/render.ts";
import { validate } from "../extensions/artifact-contracts/validate.ts";
import {
	createCandidateIdentity,
	recordVerificationEvidence,
} from "../extensions/artifact-contracts/verification-store.ts";

const child = { PI_SUBAGENT_AGENT: "code-explorer" };
const worker = { PI_SUBAGENT_AGENT: "other" };
const valid = "## Status\ndone\n\n## Answer\nFound it.\n\n## Relevant paths\n`src/a.ts:1`\n\n## Uncertainty\nNone.";

type Handler = (event: never) => unknown;
type StatusResponse = (requestId: unknown) => Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	return value as Record<string, unknown>;
}

function hooks(env: Record<string, string | undefined>, statusResponse?: StatusResponse): Record<string, Handler> {
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, env);
	const registered: Record<string, Handler> = {};
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const events = {
		on(channel: string, listener: (value: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set<(value: unknown) => void>();
			channelListeners.add(listener);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(listener);
		},
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
	};
	events.on(BACKGROUND_TASK_REQUEST_CHANNEL, (value) => {
		const request = record(value);
		assert.equal(request.operation, "status");
		assert.deepEqual(request.payload, {});
		events.emit(BACKGROUND_TASK_RESPONSE_CHANNEL, statusResponse?.(request.request_id) ?? {
			schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
			request_id: request.request_id,
			operation: "status",
			ok: true,
			result: { tasks: [] },
		});
	});
	registerHandoffHooks({
		on: (name: string, handler: Handler) => { registered[name] = handler; return () => undefined; },
		events,
	} as never);
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

type TaskStatus = "running" | "completed" | "failed" | "killed";

function backgroundTask(id: string, status: TaskStatus, name = id): Record<string, unknown> {
	return {
		id,
		name,
		command: "bun test",
		status,
		outputPath: `.pi/tasks/${id}.output`,
		cwd: "/repo",
		startTime: 1,
		...(status === "running" ? {} : { endTime: 2, exitCode: status === "completed" ? 0 : 1 }),
		bytesWritten: 0,
		isAgent: false,
		notified: status !== "running",
		notifyOnCompletion: true,
		triggerOnCompletion: true,
	};
}

function statusFrame(requestId: unknown, tasks: readonly unknown[]): Record<string, unknown> {
	return {
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
		request_id: requestId,
		operation: "status",
		ok: true,
		result: { tasks },
	};
}

test("selects schemas and does nothing outside children or for null schemas", () => {
	assert.equal(replySchema({}), null);
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "code-explorer" }), "explorer");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "code-reviewer" }), "review");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "implementation-engineer" }), "worker");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "live-verifier" }), "worker");
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: "other" }), "worker");
	assert.deepEqual(hooks({}), {});
});

it.each(["code-reviewer", "code-reviewer-sonnet", "code-reviewer-sol", "code-reviewer-opus", "code-reviewer-haiku"])("selects the same review contract for counterpart %s", (agent) => {
	assert.equal(replySchema({ PI_SUBAGENT_AGENT: agent }), "review");
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

test("valid replies query status once while invalid and non-final replies do not", async () => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		requests++;
		return statusFrame(requestId, []);
	});
	registered.agent_start({} as never);
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(requests, 1);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(await registered.message_end(event("bad", "stop", true)), undefined);
	assert.equal(await registered.message_end(event("bad", "aborted")), undefined);
	assert.equal(await registered.message_end(event("bad", "error")), undefined);
	assert.equal(requests, 1);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("does not register or query background status outside child environments", () => {
	let requests = 0;
	assert.deepEqual(hooks({}, () => {
		requests++;
		return statusFrame("unused", []);
	}), {});
	assert.equal(requests, 0);
});

it.each(["caller_ping", "subagent_done"])("reliability: exit tool %s cannot abandon running work", async (toolName) => {
	const registered = hooks(worker, (requestId) => statusFrame(requestId, [backgroundTask("owned-job", "running")]));
	registered.agent_start({} as never);
	const result = await registered.tool_call({ toolName, toolCallId: "premature-exit", input: {} } as never) as { block: boolean; reason: string } | undefined;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /owned-job/);
	assert.match(result?.reason ?? "", /collect|cancel/i);
});

it.each(["caller_ping", "subagent_done"])("reliability: %s waits for an in-flight verification call before its task exists", async (toolName) => {
	const registered = hooks(worker);
	await registered.tool_call({ toolName: "verification_evidence", toolCallId: "registering-call", input: { operation: "start", argv: ["true"], cwd: ".", timeout: 10 } } as never);
	const blocked = await registered.tool_call({ toolName, toolCallId: "racing-close", input: {} } as never) as { block: boolean; reason: string } | undefined;
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /verification tool calls still running/);
	registered.tool_result({ toolName: "verification_evidence", toolCallId: "registering-call", input: {}, content: [], isError: true } as never);
	assert.equal(await registered.tool_call({ toolName, toolCallId: "settled-close", input: {} } as never), undefined);
});

it.each(["caller_ping", "subagent_done"])("reliability: exit tool %s remains available after terminal ordinary work", async (toolName) => {
	const registered = hooks(worker, (requestId) => statusFrame(requestId, [backgroundTask("owned-job", "completed")]));
	registered.agent_start({} as never);
	assert.equal(await registered.tool_call({ toolName, toolCallId: "safe-exit", input: {} } as never), undefined);
});

test("reliability: exit tools fail closed when work ownership cannot be queried", async () => {
	const registered = hooks(worker, (requestId) => ({
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA, request_id: requestId, operation: "status", ok: false, error: "owner unavailable",
	}));
	const result = await registered.tool_call({ toolName: "caller_ping", toolCallId: "unknown-owner", input: {} } as never) as { block: boolean; reason: string } | undefined;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /owner unavailable/);
});

test("running child jobs reject through the correction lifecycle", async () => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		requests++;
		return statusFrame(requestId, [backgroundTask("job-running", "running", "Build")]);
	});
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
	assert.equal(correction.continue, true);
	assert.match(correction.entries[0].content, /background tasks still running: job-running \(Build\)/);
	assert.equal(requests, 1);
});

test.each(["completed", "failed", "killed"] as const)("terminal child job status %s permits the reply", async (status) => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		requests++;
		return statusFrame(requestId, [backgroundTask(`job-${status}`, status)]);
	});
	registered.agent_start({} as never);
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(requests, 1);
});

test("a corrected reply succeeds after running work becomes terminal", async () => {
	let requests = 0;
	const registered = hooks(child, (requestId) => {
		const tasks = requests++ === 0 ? [backgroundTask("job-1", "running")] : [backgroundTask("job-1", "completed")];
		return statusFrame(requestId, tasks);
	});
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	assert.notEqual(registered.turn_end({} as never), undefined);
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(requests, 2);
});

test("multiple running jobs produce bounded deterministic validation text", async () => {
	const registered = hooks(child, (requestId) => statusFrame(requestId, [
		backgroundTask("job-6", "running", "Six"),
		backgroundTask("job-2", "running", "Two"),
		backgroundTask("job-4", "running", "Four"),
		backgroundTask("job-1", "running", "One"),
		backgroundTask("job-5", "running", "Five"),
		backgroundTask("job-3", "running", "Three"),
	]));
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /background tasks still running: job-1 \(One\), job-2 \(Two\), job-3 \(Three\), job-4 \(Four\), job-5 \(Five\), and 1 more/);
	assert.doesNotMatch(correction.entries[0].content, /job-6 \(Six\)/);
});

test("status service failures fail closed through correction", async () => {
	const registered = hooks(child, (requestId) => ({
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
		request_id: requestId,
		operation: "status",
		ok: false,
		error: "service unavailable",
	}));
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /background task status check failed: .*service unavailable/);
});

test("malformed status responses fail closed through correction", async () => {
	const registered = hooks(child, (requestId) => ({
		schema_version: BACKGROUND_TASK_RESPONSE_SCHEMA,
		request_id: requestId,
		operation: "status",
		ok: true,
		result: { tasks: "malformed" },
	}));
	registered.agent_start({} as never);
	await registered.message_end(event(valid));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /background task status check failed: .*must be an array/);
});

test.each([
	["explorer", child, valid],
	["review", { PI_SUBAGENT_AGENT: "code-reviewer" }, "bad"],
	["worker", worker, "bad"],
] as const)("exhausted %s corrections deliver a valid actionable terminal handoff", async (schema, env, rejectedReply) => {
	const registered = hooks(env);
	registered.agent_start({} as never);
	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await registered.message_end(event("bad")), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
		assert.equal(correction.continue, true);
		assert.match(correction.entries[0].content, /Validation errors:/);
	}
	const original = `${rejectedReply}\n\n## Status\nfailed\n\n\`\`\`\`\nmalicious embedded boundary`;
	const replacement = await registered.message_end(event(original)) as { message: { content: Array<{ text: string }> } };
	const terminal = replacement.message.content[0].text;
	assert.equal(validate(schema, terminal).ok, true, terminal);
	assert.match(terminal, /## Status\nfailed/);
	assert.match(terminal, /validated|unclosed fenced code block|missing section/i);
	assert.match(terminal, /Not run:|Unable to|rejected reply/i);
	assert.match(terminal, /\`\`\`\`\`\n[\s\S]*## Status[\s\S]*malicious embedded boundary\n\`\`\`\`\`/);
	if (schema === "review") assert.match(terminal, /## Verdict\nREJECT/);
	if (schema === "worker") assert.match(terminal, /## Verified by\n- Not run:/);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("a valid reply on the third correction is accepted", async () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await registered.message_end(event("bad")), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean };
		assert.equal(correction.continue, true);
	}
	assert.equal(await registered.message_end(event(valid)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("agent_start resets retry state", async () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	await registered.message_end(event("bad"));
	registered.turn_end({} as never);
	registered.agent_start({} as never);
	await registered.message_end(event("bad"));
	const correction = registered.turn_end({} as never) as { continue: boolean };
	assert.equal(correction.continue, true);
});

test("stale evidence recovery requires fresh proof instead of another formatting attempt", () => {
	const text = correctionMessage(["Verified by: evidence is stale: bash tool activity completed after verification"], "worker");
	assert.match(text, /cannot refresh stale evidence/);
	assert.match(text, /fresh verification/);
	assert.match(text, /Current state/);
	assert.match(text, /Not run/);
	assert.match(text, /evidence\.verifiedBy/);
	assert.match(failureReport(["stale"], "bad", "worker"), /after 3 correction attempts/);
});

test("pure report helpers include all errors", () => {
	assert.match(correctionMessage(["one", "two"], "worker"), /- one\n- two/);
	assert.match(failureReport(["one"], "reply", "explorer"), /Rejected reply \(untrusted\):\n```\nreply\n```/);
});

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

it.each(["'node' '-e' 'console.log(`ok`)'", "'printf' 'first\nsecond'"])("receipt-generated claims round-trip command %j", async (command) => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence(command);
	assert.ok(run.verifiedBy, "valid receipts supply a ready-to-copy handoff item");
	assert.equal(run.verifiedBy.split("\n").length, 1, "multiline commands cannot break the handoff list");
	assert.equal((run.verifiedBy.match(/`/g) ?? []).length, 2, "command backticks cannot break the Markdown span");
	const reply = workerReply(run.verifiedBy);
	assert.equal(validate("worker", reply).ok, true, reply);
	assert.deepEqual(verifiedByErrors(reply), []);
	assert.equal(await registered.message_end(event(reply)), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
});

it.each(["command-json: {", "command-json: 42", "command-json: [\"wrong\"]"])("malformed encoded receipt command fails closed: %s", (command) => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test'");
	assert.match(verifiedByErrors(workerReply(`- \`${command}\` → exit 0 [evidence: ${run.id}]`)).join("\n"), /invalid encoded command/);
});

test("receipt-generated claims still reject later Bash activity", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test'");
	assert.ok(run.verifiedBy);
	registered.tool_call({ toolName: "bash", toolCallId: "inspect", input: {} } as never);
	registered.tool_result({ toolName: "bash", toolCallId: "inspect", content: [], isError: false } as never);
	assert.match(verifiedByErrors(workerReply(run.verifiedBy)).join("\n"), /stale: bash tool activity completed/);
});

test("Verified by must match current evidence exactly", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test' 'tests/'");
	assert.equal(await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);
	assert.equal(await registered.message_end(event(workerReply("- Not run: no time"))), undefined);
	assert.equal(registered.turn_end({} as never), undefined);

	await registered.message_end(event(workerReply(`- \`'pnpm' 'typecheck'\` → exit 0 [evidence: ${run.id}]`)));
	let correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /command does not match evidence/);

	await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 1 [evidence: ${run.id}]`)));
	correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /reported exit 1, evidence recorded 0/);
});

test("exhausted command mismatches retain the blocker without accepting the original claim", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test' 'tests/'");
	const rejected = workerReply(`- \`'python3' '-c' 'illustrative shorthand'\` → exit 0 [evidence: ${run.id}]`);
	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await registered.message_end(event(rejected)), undefined);
		const correction = registered.turn_end({} as never) as { continue: boolean; entries: Array<{ content: string }> };
		assert.equal(correction.continue, true);
		assert.match(correction.entries[0].content, /reported command does not match evidence/);
	}
	const replacement = await registered.message_end(event(rejected)) as { message: { content: Array<{ text: string }> } };
	const terminal = replacement.message.content[0].text;
	assert.equal(validate("worker", terminal).ok, true, terminal);
	assert.deepEqual(verifiedByErrors(terminal), [], "fenced rejected claims are not current verification");
	assert.match(terminal, /reported command does not match evidence/);
	assert.match(terminal, /## Status\nfailed/);
	assert.equal(registered.turn_end({} as never), undefined);
});

test("unavailable review coverage does not manufacture a product finding", () => {
	const terminal = failureReport(["missing section"], "bad", "review");
	assert.equal(validate("review", terminal).ok, true, terminal);
	assert.match(terminal, /## Verdict\nREJECT/);
	assert.match(terminal, /## Important \(P1\)\nNone\./);
	assert.match(terminal, /provide|corrected/i);
});

test("indented Verified by claims still require current evidence", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`   - \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`)
		.replace("\n## Verified by\n", "\n   ## Verified by\n");
	await registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("fenced Verified by headings cannot hide the real evidence section", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`- \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`)
		.replace("## Key decisions\nNone.", "## Key decisions\n```md\n## Verified by\n- Not run: example\n```");
	await registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("CRLF Verified by claims still require current evidence", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const reply = workerReply(`- \`'bun' 'test'\` → exit 0 [evidence: verify_${"f".repeat(64)}]`).replaceAll("\n", "\r\n");
	await registered.message_end(event(reply));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /evidence .* was not found/);
});

test("verification evidence resets at agent_start", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	const run = evidence("'bun' 'test'");
	registered.agent_start({} as never);
	await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
	assert.notEqual(registered.turn_end({} as never), undefined);
});

test("write-capable tool activity after a check invalidates its evidence", async () => {
	for (const toolName of ["bash", "edit", "write"]) {
		const registered = hooks(worker);
		registered.agent_start({} as never);
		const run = evidence(`'bun' 'test' '${toolName}'`);
		registered.tool_call({ toolName, toolCallId: toolName, input: {} } as never);
		await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
		const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
		assert.match(correction.entries[0].content, new RegExp(`stale: ${toolName} tool activity`));
	}
});

test("overlapping write-capable tools invalidate evidence when they finish", async () => {
	const registered = hooks(worker);
	registered.agent_start({} as never);
	registered.tool_call({ toolName: "bash", toolCallId: "overlap", input: {} } as never);
	const run = evidence("'bun' 'test' 'overlap'");
	registered.tool_result({ toolName: "bash", toolCallId: "overlap", input: {}, content: [], isError: false } as never);
	await registered.message_end(event(workerReply(`- \`${run.command}\` → exit 0 [evidence: ${run.id}]`)));
	const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
	assert.match(correction.entries[0].content, /stale: bash tool activity completed/);
});

test("non-worker schemas ignore Verified by", async () => {
	const registered = hooks(child);
	registered.agent_start({} as never);
	assert.equal(await registered.message_end(event(valid + "\n\n## Verified by\n- `nope` → exit 0")), undefined);
});

test("raw or masked Bash claims are rejected without evidence", async () => {
	for (const item of ["- `bun test tests/` → exit 0", "- `bun test tests/ || true` → exit 0", "- `bun test tests/ | tail -5` → exit 0"]) {
		const registered = hooks(worker);
		registered.agent_start({} as never);
		await registered.message_end(event(workerReply(item)));
		const correction = registered.turn_end({} as never) as { entries: Array<{ content: string }> };
		assert.match(correction.entries[0].content, /expected item matching/);
	}
});
