import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentChildEnvironment } from "../lib/shared.ts";
import { registerHumanInputTracker } from "../lib/human-input.ts";
import { requestWorkStatus } from "../lib/work-status.ts";
import type { TaskSnapshot } from "../lib/task-snapshot.ts";
import { requestBackgroundTask } from "../artifact-contracts/background-tasks.ts";

function observationState<T extends { requestId: string }>(observation: T): string {
	const { requestId: _requestId, ...state } = observation;
	return JSON.stringify(state);
}

export function registerContinuationGuard(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>> = process.env): void {
	if (isSubagentChildEnvironment(env)) return;
	const humanInputs = registerHumanInputTracker(pi);
	const usedInputKeys = new Set<string>();
	let taskToolsUsed = false;
	let sessionId: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		const nextSessionId = ctx.sessionManager.getSessionId();
		if (nextSessionId !== sessionId) taskToolsUsed = false;
		sessionId = nextSessionId;
	});
	pi.on("tool_result", (event) => {
		if (["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"].includes(event.toolName)) taskToolsUsed = true;
	});

	function eligible(snapshot: TaskSnapshot, ctx: ExtensionContext, inputEntryId: string): boolean {
		const record = snapshot.continuation;
		if (!record || record.disposition !== "ready" || record.revision !== snapshot.revision
			|| record.basis.inputEntryId !== inputEntryId || !humanInputs.isHumanEntry(ctx, record.basis.requestEntryId)
			|| (record.basis.kind === "plan" && !humanInputs.isHumanEntry(ctx, record.basis.approvalEntryId))) return false;
		const task = snapshot.tasks.find((item) => item.id === record.taskId);
		return task !== undefined && task.status !== "completed"
			&& (task.owner === undefined || task.owner === snapshot.sessionId)
			&& task.blockedBy.every((id) => snapshot.tasks.some((dependency) => dependency.id === id && dependency.status === "completed"));
	}

	pi.on("agent_before_settle", async (event, ctx) => {
		// canContinue previews the ending context, before this hook adds its continuation entry.
		if (event.outcome !== "completed" || event.continue
			|| ctx.signal?.aborted || ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) return;
		const currentSessionId = ctx.sessionManager.getSessionId();
		const input = humanInputs.current(ctx);
		const key = `${currentSessionId}:${input?.entryId ?? "unknown"}`;
		const tasks = requestWorkStatus(pi.events, "tasks", currentSessionId);
		if (tasks && tasks.tasks.every((task) => task.status === "completed")) return;
		if (!tasks && !taskToolsUsed) return;
		if (!tasks || !input || !eligible(tasks, ctx, input.entryId)) return;
		if (usedInputKeys.has(key)) return;
		const verification = requestWorkStatus(pi.events, "verification", currentSessionId);
		const delegation = requestWorkStatus(pi.events, "delegation", currentSessionId);
		if (!verification || !delegation) return;
		if (verification.starting > 0 || verification.uncollectedTaskIds.length > 0
			|| delegation.runningChildIds.length > 0 || delegation.pendingResultIds.length > 0) return;
		try {
			const background = await requestBackgroundTask(pi.events, "status", {}, 500);
			if (background.tasks.some((task) => task.status === "running" || (task.notifyOnCompletion && !task.notified))) return;
		} catch {
			return;
		}
		if (ctx.signal?.aborted || ctx.hasPendingMessages()) return;
		const latestInput = humanInputs.current(ctx);
		const latestTasks = requestWorkStatus(pi.events, "tasks", currentSessionId);
		const latestVerification = requestWorkStatus(pi.events, "verification", currentSessionId);
		const latestDelegation = requestWorkStatus(pi.events, "delegation", currentSessionId);
		if (latestInput?.entryId !== input.entryId || latestInput.sessionId !== currentSessionId
			|| !latestTasks || !latestVerification || !latestDelegation
			|| observationState(latestTasks) !== observationState(tasks)
			|| observationState(latestVerification) !== observationState(verification)
			|| observationState(latestDelegation) !== observationState(delegation)) return;
		usedInputKeys.add(key);
		return {
			entries: [{ type: "custom_message", customType: "workflow-continuation", content: "Continue the next already-authorized ready action and reconcile its result. No new approval or permission is granted.", display: false }],
			continue: true,
		};
	});
}
