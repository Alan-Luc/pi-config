import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNotifyUserTool } from "../extensions/notify-user.ts";

function fixture(result: ExecResult = { code: 0, killed: false, stdout: "", stderr: "" }) {
	const calls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
	const exec: ExtensionAPI["exec"] = async (command, args, options) => {
		calls.push({ command, args, options });
		return result;
	};
	return { tool: createNotifyUserTool(exec), calls };
}

test.each([
	["needs_input", "Pi needs your input. Return to your Pi session."],
	["task_complete", "Pi reports the task is complete. Review the result in Pi."],
] as const)("sends fixed generic %s notification with bounded, cancellable argv", async (reason, body) => {
	const { tool, calls } = fixture();
	const signal = new AbortController().signal;
	const result = await tool.execute("call", { reason }, signal);
	expect(calls).toEqual([{ command: "terminal-notifier", args: ["-title", "Pi", "-message", body, "-group", `pi-${reason}`, "-sound", "default"], options: { timeout: 5000, signal } }]);
	expect(result.isError).not.toBe(true);
	expect(result.content).toEqual([{ type: "text", text: "Notification submitted to macOS; visible delivery and human receipt are not confirmed." }]);
});

test.each([
	{ code: 3, killed: false, stderr: "Notifications are not allowed" },
	{ code: 0, killed: true, stderr: "" },
])("reports rejected/killed execution instead of successful notification: %j", async (outcome) => {
	const { tool } = fixture({ ...outcome, stdout: "" });
	const result = await tool.execute("call", { reason: "needs_input" }, undefined);
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toMatch(/failed|cancelled|timed out/i);
	if (outcome.stderr) expect(result.content[0].text).toContain(outcome.stderr);
});

test("already-cancelled calls never launch a notifier", async () => {
	const { tool, calls } = fixture();
	const controller = new AbortController();
	controller.abort();
	const result = await tool.execute("call", { reason: "needs_input" }, controller.signal);
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toMatch(/cancelled/i);
	expect(calls).toEqual([]);
});

test("missing executable reports the cause without pretending delivery", async () => {
	const tool = createNotifyUserTool(async () => { throw new Error("spawn terminal-notifier ENOENT"); });
	const result = await tool.execute("call", { reason: "needs_input" }, undefined);
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toContain("ENOENT");
});

test.each([
	{ reason: "arbitrary" },
	{ reason: "needs_input", message: "malicious worker text" },
	{ reason: "task_complete", execute: "open something" },
])("rejects extra text, click commands and unknown reasons: %j", (request) => {
	expect(Value.Check(fixture().tool.parameters, request)).toBe(false);
});
