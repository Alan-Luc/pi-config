import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const parameters = Type.Object({
	reason: Type.Union([Type.Literal("needs_input"), Type.Literal("task_complete")]),
}, { additionalProperties: false });

export function createNotifyUserTool(exec: ExtensionAPI["exec"]) {
	return {
		name: "notify_user",
		label: "Notify user",
		description: "Send a generic desktop alert for main-agent human attention or verified overall task completion. Workers should report to their manager. Missing optional terminal-notifier skips cleanly. Repeated alerts of the same kind replace the earlier notification. Notification submission does not prove visible delivery, human receipt or task success; never use it for approval.",
		parameters,
		async execute(_id, { reason }, signal) {
			try {
				if (signal?.aborted) throw new Error("Notification cancelled before submission.");
				const available = await exec("sh", ["-c", "command -v terminal-notifier"], { timeout: 5000, signal });
				if (available.killed || signal?.aborted) throw new Error("Notification cancelled or timed out; delivery is unconfirmed.");
				if (available.code !== 0) return {
					content: [{ type: "text", text: "Desktop notification skipped: optional terminal-notifier is not installed." }],
					details: { reason, skipped: true }, isError: false,
				};
				const message = reason === "needs_input"
					? "Pi needs your input. Return to your Pi session."
					: "Pi reports the task is complete. Review the result in Pi.";
				const result = await exec("terminal-notifier", ["-title", "Pi", "-message", message, "-group", `pi-${reason}`, "-sound", "default"], { timeout: 5000, signal });
				if (result.killed) throw new Error("Notification cancelled or timed out; delivery is unconfirmed.");
				if (result.code !== 0) throw new Error(`Notification failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500) || "Check terminal-notifier installation and macOS notification permissions."}`);
				return {
					content: [{ type: "text", text: "Notification submitted to macOS; visible delivery and human receipt are not confirmed." }],
					details: { reason }, isError: false,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : "Notification failed with an unknown execution error." }],
					details: { reason }, isError: true,
				};
			}
		},
	} satisfies ToolDefinition<typeof parameters>;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool(createNotifyUserTool(pi.exec));
}
