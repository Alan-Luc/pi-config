import { expect, test } from "bun:test";
import { registerGitGuard } from "../extensions/git-guard/git-guard.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;
type Handlers = Record<string, Handler[]>;

function createGuard(env: Record<string, string | undefined> = {}) {
	const handlers: Handlers = {};
	registerGitGuard({ on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); return () => undefined; } } as never, env);
	return handlers;
}

async function call(handlers: Handlers, toolName: string, command: string) {
	for (const handler of handlers.tool_call ?? []) await handler({ type: "tool_call", toolName, toolCallId: toolName, input: { command } }, { cwd: "/tmp/project" });
}

test.each(["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"])('blocks child Git mutations marked by %s', async (marker) => {
	const child = createGuard({ [marker]: "child" });
	for (const toolName of ["bash", "bg_run"]) {
		for (const command of ["git commit -m change", "git push origin feature"]) {
			await expect(call(child, toolName, command)).rejects.toMatchObject({
				message: "Subagents cannot commit or push; report changes to the parent, which owns commits and task-branch pushes under policy.",
			});
		}
	}
});

test("allows parent Git commands and accepts literal matching wrapper bypasses", async () => {
	const parent = createGuard();
	await call(parent, "bash", "git commit -m change");
	await call(parent, "bash", "git push origin feature");
	const child = createGuard({ PI_SUBAGENT_AGENT: "1" });
	await call(child, "bash", "command git commit -m change");
	await call(child, "bash", "command git push origin feature");
});

function result(handlers: Handlers, command: string, text: string): void {
	for (const handler of handlers.tool_result ?? []) handler({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "result",
		input: { command },
		content: [{ type: "text", text }],
		isError: text !== "passed",
	}, { cwd: "/tmp/project" });
}

test("blocks whitespace-normalized retries after database failures until a clean override result", async () => {
	const guard = createGuard();
	const command = "bun test tests/example.test.ts";
	result(guard, "bun   test   tests/example.test.ts", "ECONNREFUSED localhost:55432");
	await expect(call(guard, "bash", command)).rejects.toMatchObject({ code: "infra_retry" });
	await call(guard, "bash", `PI_ALLOW_INFRA_RETRY=1 ${command}`);
	result(guard, `PI_ALLOW_INFRA_RETRY=1 ${command}`, "passed");
	await call(guard, "bash", command);
});

test.each([
	["a non-database failure", "syntax error"],
	["a different test command", "ECONNREFUSED localhost:55432"],
])("allows retries after %s", async (kind, failure) => {
	const guard = createGuard();
	const failedCommand = "bun test tests/example.test.ts";
	result(guard, failedCommand, failure);
	await call(guard, "bash", kind === "a different test command" ? "bun test tests/other.test.ts" : failedCommand);
});
