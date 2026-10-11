import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";
import { AGENT_OUTPUT, DEFAULT_OUTPUT, SCHEMAS, type SchemaId } from "./schemas.ts";
import { appendInstructions, renderTemplate } from "./render.ts";
import { sectionBody, validate } from "./validate.ts";
import { clearVerificationEvidence, invalidateVerificationEvidence, verificationClaimErrors } from "./verification-store.ts";

const CORRECTION_TYPE = "artifact-contract-correction";

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
		return verificationClaimErrors({ command: item[1], exitCode: Number(item[2]), evidenceId: item[3] });
	});
}

export function replySchema(env: Environment): SchemaId | null {
	if (!isSubagentChildEnvironment(env)) return null;
	const agent = env.PI_SUBAGENT_AGENT;
	if (typeof agent !== "string" || agent.trim() === "") return DEFAULT_OUTPUT;
	return AGENT_OUTPUT[agent] === undefined ? DEFAULT_OUTPUT : AGENT_OUTPUT[agent];
}

export function replyInstructions(schemaId: SchemaId): string {
	return [
		"Your final reply must validate against this exact artifact contract.",
		"Fill the template below; do not add, remove, or reorder its sections.",
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
		"Template:",
		renderTemplate(schemaId),
	].join("\n");
}

export function failureReport(errors: readonly string[], originalText: string): string {
	let longestRun = 0;
	for (const match of originalText.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return [
		"## Status",
		"failed",
		"",
		"## Validation errors",
		...errors.map((error) => `- ${error}`),
		"",
		"## Original reply",
		fence,
		originalText,
		fence,
	].join("\n");
}

export function registerHandoffHooks(pi: ExtensionAPI): void {
	const schemaId = replySchema(process.env);
	if (schemaId === null) return;

	let corrections = 0;
	let pending: PendingReply | undefined;
	const verificationCalls = new Set<string>();
	const writeCapableCalls = new Map<string, string>();

	pi.on("before_agent_start", (event) => {
		appendInstructions(event.systemPromptOptions, replyInstructions(schemaId));
	});

	pi.on("agent_start", () => {
		corrections = 0;
		pending = undefined;
		verificationCalls.clear();
		writeCapableCalls.clear();
		clearVerificationEvidence();
	});

	pi.on("tool_call", (event) => {
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

	pi.on("message_end", (event) => {
		const message = assistantMessage(event.message);
		if (!message || message.stopReason === "aborted" || message.stopReason === "error") return;
		const text = replyText(message);
		if (text === undefined) return;
		let result = validate(schemaId, text);
		if (result.ok && SCHEMAS[schemaId].sections.some((section) => section.heading === "Verified by")) {
			const errors = verifiedByErrors(text);
			if (errors.length > 0) result = { ok: false, errors };
		}
		if (result.ok) {
			pending = undefined;
			return;
		}
		pending = { errors: result.errors, originalText: text };
		if (corrections >= 2) {
			return { message: { ...event.message, content: [{ type: "text", text: failureReport(result.errors, text) }] } };
		}
	});

	pi.on("turn_end", () => {
		if (!pending || corrections >= 2) return;
		const message = correctionMessage(pending.errors, schemaId);
		corrections++;
		pending = undefined;
		return { entries: [{ type: "custom_message", customType: CORRECTION_TYPE, content: message, display: true }], continue: true };
	});
}
