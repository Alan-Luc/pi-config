import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNotifyUserTool } from "../extensions/notify-user.ts";

function fixture(result: ExecResult = { code: 0, killed: false, stdout: "", stderr: "" }) {
	const calls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
	const exec: ExtensionAPI["exec"] = async (command, args, options) => {
		calls.push({ command, args, options });
		if (command === "sh") return { code: 0, killed: false, stdout: "/usr/local/bin/terminal-notifier\n", stderr: "" };
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
	expect(calls).toEqual([
		{ command: "sh", args: ["-c", "command -v terminal-notifier"], options: { timeout: 5000, signal } },
		{ command: "terminal-notifier", args: ["-title", "Pi", "-message", body, "-group", `pi-${reason}`, "-sound", "default"], options: { timeout: 5000, signal } },
	]);
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

test("missing optional notifier skips without trying to send", async () => {
	const calls: string[] = [];
	const tool = createNotifyUserTool(async (command) => {
		calls.push(command);
		return { code: 1, killed: false, stdout: "", stderr: "" };
	});
	const result = await tool.execute("call", { reason: "needs_input" }, undefined);
	expect(result.isError).toBe(false);
	expect(result.content[0].text).toBe("Desktop notification skipped: optional terminal-notifier is not installed.");
	expect(calls).toEqual(["sh"]);
});

test("cancelled availability checks remain errors rather than optional skips", async () => {
	const tool = createNotifyUserTool(async () => ({ code: 1, killed: true, stdout: "", stderr: "" }));
	const result = await tool.execute("call", { reason: "needs_input" }, undefined);
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toMatch(/cancelled|timed out/i);
});

test("unexpected execution errors remain visible", async () => {
	const tool = createNotifyUserTool(async () => { throw new Error("execution unavailable"); });
	const result = await tool.execute("call", { reason: "needs_input" }, undefined);
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toContain("execution unavailable");
});

test.each([
	{ reason: "arbitrary" },
	{ reason: "needs_input", message: "malicious worker text" },
	{ reason: "task_complete", execute: "open something" },
])("rejects extra text, click commands and unknown reasons: %j", (request) => {
	expect(Value.Check(fixture().tool.parameters, request)).toBe(false);
});
