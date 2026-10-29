import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";
import { requestBackgroundTask, type BackgroundTaskSnapshot } from "./background-tasks.ts";
import { AGENT_OUTPUT, DEFAULT_OUTPUT, SCHEMAS, type SchemaId } from "./schemas.ts";
import { appendInstructions, renderTemplate } from "./render.ts";
import { currentAssignment, sameAssignment, type AssignmentSnapshot } from "./assignment.ts";
import { isResultSchemaId, renderResultSubmission, resultSubmissionFieldNames, resultSubmissionParameters, type ResultSubmissionRecord } from "./result-submission.ts";
import { sectionBody, validate } from "./validate.ts";
import { clearVerificationEvidence, invalidateVerificationEvidence, verificationClaimErrors } from "./verification-store.ts";
import { pendingVerificationWork } from "./verification.ts";

const CORRECTION_TYPE = "artifact-contract-correction";
const MAX_CORRECTIONS = 3;

type Environment = Readonly<Record<string, string | undefined>>;
type PendingReply = { errors: string[]; originalText: string };

type AssistantLike = { role: string; content: readonly unknown[]; stopReason: string };

function assistantMessage(message: unknown): AssistantLike | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content) || typeof message.stopReason !== "string") {
		return undefined;
	}
	return { role: message.role, content: message.content, stopReason: message.stopReason };
}

function replyText(message: AssistantLike): string | undefined {
	const text: string[] = [];
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) return undefined;
		const candidate = block as Record<string, unknown>;
		if (candidate.type === "toolCall") return undefined;
		if (candidate.type === "text") {
			if (typeof candidate.text !== "string") return undefined;
			text.push(candidate.text);
		}
	}
	return text.join("");
}

export function verifiedByErrors(text: string): string[] {
	const body = sectionBody(text, "Verified by") ?? "";
	return body.split("\n").flatMap((line) => {
		const item = line.match(/^ {0,3}- `([^`]+)` (?:→|->) exit (\d+) \[evidence: (verify_[0-9a-f]{64})\]/);
		if (!item) return [];
		let command = item[1];
		if (command.startsWith("command-json: ")) {
			try {
				const decoded: unknown = JSON.parse(command.slice("command-json: ".length));
				if (typeof decoded !== "string") return [`Verified by: invalid encoded command for evidence ${item[3]}`];
				command = decoded;
			} catch {
				return [`Verified by: invalid encoded command for evidence ${item[3]}`];
			}
		}
		return verificationClaimErrors({ command, exitCode: Number(item[2]), evidenceId: item[3] });
	});
}

export function replySchema(env: Environment): SchemaId | null {
	if (!isSubagentChildEnvironment(env)) return null;
	const agent = env.PI_SUBAGENT_AGENT;
	if (typeof agent !== "string" || agent.trim() === "") return DEFAULT_OUTPUT;
	return AGENT_OUTPUT[agent] === undefined ? DEFAULT_OUTPUT : AGENT_OUTPUT[agent];
}

export function replyInstructions(schemaId: SchemaId, structured = isResultSchemaId(schemaId)): string {
	return [
		"Your final reply must validate against this exact artifact contract.",
		"Fill the template below; do not add, remove, or reorder its sections.",
		...(structured && isResultSchemaId(schemaId) ? [
			`Submit the complete result with submit_agent_result using these schema-defined fields: ${resultSubmissionFieldNames(schemaId).join(", ")}.`,
			"The tool acknowledgement means recorded, not delivered. After successful submission, finish with a normal final assistant response; the runtime renders the submitted result and revalidates its evidence.",
			"Do not write the report as Markdown or reconstruct evidence commands; proofIds and observationIds are local evidence IDs only.",
			...(schemaId === "worker" ? ["Finish raw Bash/cleanup before final verification. Any later Bash, edit, or write invalidates earlier proof IDs."] : []),
		] : SCHEMAS[schemaId].sections.some((section) => section.heading === "Verified by") ? [
			"Use current native evidence.verifiedBy items verbatim under Verified by; do not reconstruct commands or shorten their quoting.",
			"Finish raw Bash/cleanup before final verification. Even read-only Bash invalidates earlier receipts; use read/grep/find for inspection afterward.",
		] : []),
		"Template:",
		renderTemplate(schemaId),
	].join("\n");
}

export function correctionMessage(errors: readonly string[], schemaId: SchemaId): string {
	return [
		"Your previous final reply did not validate.",
		"Fix every validation error and reply again using this exact template.",
		"Validation errors:",
		...errors.map((error) => `- ${error}`),
		...(errors.some((error) => error.startsWith("Verified by:")) ? [
			"Verification recovery:",
			"Copy evidence.verifiedBy unchanged from current native receipts; never reconstruct the command.",
			"Formatting cannot refresh stale evidence. Finish raw Bash/cleanup before obtaining fresh verification, then avoid further raw Bash.",
			"Move stale/unreportable observations to Current state. If fresh proof is unavailable, report blocked or failed with a Not run reason under Verified by rather than reuse the old claim.",
		] : []),
		"Template:",
		renderTemplate(schemaId),
	].join("\n");
}

export function failureReport(errors: readonly string[], originalText: string, schemaId: SchemaId): string {
	let longestRun = 0;
	for (const match of originalText.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	const rejectedReply = ["Rejected reply (untrusted):", fence, originalText, fence].join("\n");
	const blockers = errors.map((error) => `- ${error}`);
	if (schemaId === "explorer") {
		return [
			"## Status", "failed", "", "## Answer", `Unable to provide a validated answer after ${MAX_CORRECTIONS} correction attempts.`,
			...blockers, "", "## Relevant paths", "No paths were verified from the rejected reply.", "", "## Uncertainty",
			"The reply did not satisfy its required contract; provide a corrected, schema-valid response.", "", rejectedReply,
		].join("\n");
	}
	if (schemaId === "review") {
		return [
			"## Status", "failed", "", "## Verdict", "REJECT", "", "## Scope",
			`Review could not be completed because the final reply failed validation after ${MAX_CORRECTIONS} correction attempts.`, ...blockers, "", "## Critical (P0)", "None.",
			"", "## Important (P1)", "None.",
			"", "## Nice-to-have (P2)", "None.", "", "## Out of scope",
			"Provide a complete schema-valid review before relying on its conclusions; no product findings were validated.", "", rejectedReply,
		].join("\n");
	}
	return [
		"## Status", "failed", "", "## Objective", "Deliver a schema-valid handoff after rejected final replies.",
		"", "## Current state", `A valid handoff could not be produced after ${MAX_CORRECTIONS} correction attempts.`, ...blockers, "", rejectedReply,
		"", "## Key decisions", "None.", "", "## Verified by", "- Not run: no verification claim from the rejected reply is trusted.",
		"", "## Next steps", "Provide a corrected, schema-valid handoff; verify any claims independently.", "", "## Do not",
		"Treat the rejected reply or its check claims as verified.",
	].join("\n");
}

const MAX_TASKS_IN_ERROR = 5;
const MAX_TASK_LABEL_LENGTH = 80;

function taskLabel(task: Pick<BackgroundTaskSnapshot, "id" | "name">): string {
	const label = task.name === undefined ? task.id : `${task.id} (${task.name})`;
	return label.length <= MAX_TASK_LABEL_LENGTH ? label : `${label.slice(0, MAX_TASK_LABEL_LENGTH - 1)}…`;
}

async function ownedWorkErrors(events: EventBus, activeVerificationCalls: number, sessionId: string | undefined): Promise<string[]> {
	const pending = pendingVerificationWork(events);
	const errors: string[] = [];
	if (activeVerificationCalls > 0) errors.push(`verification tool calls still running: ${activeVerificationCalls}`);
	if (pending.starting > 0) errors.push(`verification starts still registering: ${pending.starting}`);
	if (pending.uncollectedTaskIds.length > 0) {
		const shown = pending.uncollectedTaskIds.toSorted().slice(0, MAX_TASKS_IN_ERROR).map((id) => taskLabel({ id }));
		const remaining = pending.uncollectedTaskIds.length - shown.length;
		errors.push(`uncollected verification results: ${shown.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`);
	}
	if (!sessionId) return [...errors, "background task status owner session is unavailable"];
	try {
		const status = await requestBackgroundTask(events, "work-status", { sessionId });
		if (status.activeAdmissions > 0) errors.push(`background task admissions still registering: ${status.activeAdmissions}`);
		if (!status.historyComplete) errors.push("background work history incomplete or closed");
		const running = status.tasks.map((entry) => entry.task)
			.filter((task) => task.status === "running")
			.toSorted((left, right) => left.id.localeCompare(right.id) || (left.name ?? "").localeCompare(right.name ?? ""));
		if (running.length > 0) {
			const shown = running.slice(0, MAX_TASKS_IN_ERROR).map(taskLabel);
			const remaining = running.length - shown.length;
			errors.push(`background tasks still running: ${shown.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`);
		}
		const unsettled = status.tasks.filter((entry) => entry.task.status !== "running" && (
			entry.terminalPublicationState !== "delivered" || entry.terminalPublished !== true
			|| entry.terminalPublishInFlight !== false || entry.terminalEmitInFlight !== false
			|| entry.notificationInFlight !== false
			|| entry.notificationState !== (entry.task.notifyOnCompletion ? "delivered" : "not-requested")
		));
		if (unsettled.length > 0) {
			const shown = unsettled.slice(0, MAX_TASKS_IN_ERROR).map((entry) => taskLabel(entry.task));
			const remaining = unsettled.length - shown.length;
			errors.push(`background task terminal results not settled: ${shown.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`);
		}
		return errors;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return [...errors, `background task status check failed: ${detail}`];
	}
}

export function registerHandoffHooks(pi: ExtensionAPI): void {
	const schemaId = replySchema(process.env);
	if (schemaId === null) return;

	let corrections = 0;
	let pending: PendingReply | undefined;
	const verificationCalls = new Set<string>();
	const writeCapableCalls = new Map<string, string>();
	const structuredToolRegistered = isResultSchemaId(schemaId);
	let assignment: AssignmentSnapshot | undefined;
	let submission: ResultSubmissionRecord | undefined;

	function resetAssignmentState(next: AssignmentSnapshot | undefined): void {
		assignment = next;
		submission = undefined;
		corrections = 0;
		pending = undefined;
		verificationCalls.clear();
		writeCapableCalls.clear();
		clearVerificationEvidence();
	}

	function synchronizeAssignment(context: { sessionManager?: Parameters<typeof currentAssignment>[0] } | undefined): boolean {
		if (!context?.sessionManager) return false;
		const next = currentAssignment(context.sessionManager);
		const changed = assignment === undefined ? next !== undefined : next === undefined || !sameAssignment(assignment, next);
		if (changed) resetAssignmentState(next);
		else if (next) assignment = next;
		return changed;
	}

	function structuredMode(): boolean {
		return structuredToolRegistered && pi.getActiveTools().includes("submit_agent_result");
	}

	pi.on("before_agent_start", (event) => {
		appendInstructions(event.systemPromptOptions, replyInstructions(schemaId, structuredMode()));
	});

	if (isResultSchemaId(schemaId)) {
		pi.registerTool({
			name: "submit_agent_result",
			label: "Submit agent result",
			description: "Submit a structured result for deterministic final rendering. The schema and role are bound by the child runtime.",
			parameters: resultSubmissionParameters(schemaId),
			async execute(_toolCallId, params, _signal, _onUpdate, context) {
				synchronizeAssignment(context);
				if (!assignment) throw new Error("cannot record a result until the originating persisted user request is available");
				if (!isRecord(params)) throw new Error("Result submission must be an object");
				const rendered = renderResultSubmission(schemaId, params);
				if (rendered.errors.length > 0) throw new Error(`Result submission rejected: ${rendered.errors.join("; ")}`);
				submission = Object.freeze({
					version: 1,
					schemaId,
					assignment: Object.freeze({
						sessionId: assignment.sessionId,
						requestEntryId: assignment.requestEntryId,
						branchEntryIds: assignment.branchEntryIds,
					}),
					fields: Object.freeze({ ...params }),
				});
				return {
					content: [{ type: "text", text: "Recorded, not delivered. Continue to a normal final assistant response; the runtime will render and revalidate this submission." }],
					details: submission,
				};
			},
		});
	}

	pi.on("session_start", (event, context) => {
		const next = currentAssignment(context.sessionManager);
		if (event.reason === "startup" && assignment && next && sameAssignment(assignment, next)) {
			assignment = next;
			return;
		}
		resetAssignmentState(next);
	});

	pi.on("session_tree", (event, context) => {
		if (event.oldLeafId !== event.newLeafId) {
			resetAssignmentState(currentAssignment(context.sessionManager));
			return;
		}
		synchronizeAssignment(context);
	});

	pi.on("agent_start", (_event, context) => {
		if (!context?.sessionManager) {
			resetAssignmentState(undefined);
			return;
		}
		synchronizeAssignment(context);
	});

	pi.on("tool_call", async (event, context) => {
		synchronizeAssignment(context);
		if (event.toolName === "caller_ping" || event.toolName === "subagent_done") {
			const errors = await ownedWorkErrors(pi.events, verificationCalls.size, context?.sessionManager?.getSessionId());
			if (errors.length > 0) {
				return { block: true, reason: `Cannot close helper: ${errors.join("; ")}. Wait for terminal notification and collect verification results, or cancel owned work and reconcile its terminal state before exiting.` };
			}
			return;
		}
		if (event.toolName === "verification_evidence") {
			verificationCalls.add(event.toolCallId);
			return;
		}
		const nestedVerificationBash = event.toolName === "bash"
			&& event.parentToolCallId !== undefined
			&& verificationCalls.has(event.parentToolCallId);
		if (!nestedVerificationBash && (event.toolName === "bash" || event.toolName === "edit" || event.toolName === "write")) {
			writeCapableCalls.set(event.toolCallId, event.toolName);
			invalidateVerificationEvidence(`${event.toolName} tool activity occurred after verification`);
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "verification_evidence") verificationCalls.delete(event.toolCallId);
		const toolName = writeCapableCalls.get(event.toolCallId);
		if (!toolName) return;
		writeCapableCalls.delete(event.toolCallId);
		invalidateVerificationEvidence(`${toolName} tool activity completed after verification`);
	});

	pi.on("message_end", async (event, context) => {
		synchronizeAssignment(context);
		const message = assistantMessage(event.message);
		if (!message || message.stopReason === "aborted" || message.stopReason === "error") return;
		const text = replyText(message);
		if (text === undefined) return;
		if (structuredMode() && (message.stopReason === "toolUse" || message.stopReason === "tool_use")) return;
		if (structuredMode() && isResultSchemaId(schemaId)) {
			let errors = ["structured result missing; call submit_agent_result before the final assistant response"];
			let renderedText: string | undefined;
			if (submission && assignment && submission.assignment.sessionId === assignment.sessionId
				&& submission.assignment.requestEntryId === assignment.requestEntryId) {
				const rendered = renderResultSubmission(schemaId, submission.fields);
				errors = [...rendered.errors];
				if (errors.length === 0) {
					const workErrors = await ownedWorkErrors(pi.events, verificationCalls.size, context?.sessionManager?.getSessionId());
					errors.push(...workErrors);
					if (errors.length === 0) renderedText = rendered.text;
				}
			}
			if (renderedText !== undefined) {
				pending = undefined;
				return { message: { ...event.message, content: [{ type: "text", text: renderedText }] } };
			}
			pending = { errors, originalText: text };
			if (corrections >= MAX_CORRECTIONS) {
				return { message: { ...event.message, content: [{ type: "text", text: failureReport(errors, text, schemaId) }] } };
			}
			return;
		}
		let result = validate(schemaId, text);
		if (result.ok && SCHEMAS[schemaId].sections.some((section) => section.heading === "Verified by")) {
			const errors = verifiedByErrors(text);
			if (errors.length > 0) result = { ok: false, errors };
		}
		if (result.ok) {
			const errors = await ownedWorkErrors(pi.events, verificationCalls.size, context?.sessionManager?.getSessionId());
			result = errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
		}
		if (result.ok) {
			pending = undefined;
			return;
		}
		pending = { errors: result.errors, originalText: text };
		if (corrections >= MAX_CORRECTIONS) {
			return { message: { ...event.message, content: [{ type: "text", text: failureReport(result.errors, text, schemaId) }] } };
		}
	});

	pi.on("turn_end", () => {
		if (!pending || corrections >= MAX_CORRECTIONS) return;
		const message = correctionMessage(pending.errors, schemaId);
		corrections++;
		pending = undefined;
		return { entries: [{ type: "custom_message", customType: CORRECTION_TYPE, content: message, display: true }], continue: true };
	});
}
