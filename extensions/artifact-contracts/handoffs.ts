import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord, isSubagentChildEnvironment } from "../lib/shared.ts";
import { AGENT_OUTPUT, DEFAULT_OUTPUT, SCHEMAS, type SchemaId } from "./schemas.ts";
import { appendInstructions, renderTemplate } from "./render.ts";
import { validate } from "./validate.ts";

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

type BashRun = { command: string; exitCode: number | undefined };

function bashRun(event: { input: Record<string, unknown>; isError: boolean; structuredContent?: unknown }): BashRun | undefined {
	if (typeof event.input.command !== "string") return undefined;
	const structured = isRecord(event.structuredContent) ? event.structuredContent : undefined;
	if (typeof structured?.exit_code === "number") return { command: event.input.command, exitCode: structured.exit_code };
	return { command: event.input.command, exitCode: event.isError ? undefined : 0 };
}

function pipeMasksExit(run: BashRun, command: string): boolean {
	const end = run.command.indexOf(command) + command.length;
	const pipe = run.command.slice(end).search(/(?<!\|)\|(?!\|)/);
	if (pipe < 0) return false;
	return !/\bset\s+-\w*o\s+pipefail\b/.test(run.command.slice(0, end + pipe));
}

export function verifiedByErrors(text: string, runs: readonly BashRun[]): string[] {
	const body = text.match(/^## Verified by\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
	const errors: string[] = [];
	for (const line of body.split("\n")) {
		const item = line.match(/^- `([^`]+)` (?:→|->) exit (\d+)/);
		if (!item) continue;
		const command = item[1].trim();
		const reported = Number(item[2]);
		const included = runs.filter((run) => run.command.includes(command));
		const matching = included.filter((run) => !pipeMasksExit(run, command));
		if (included.length === 0) errors.push(`Verified by: "${command}" was not run in this session`);
		else if (matching.length === 0) errors.push(`Verified by: "${command}" exit code is hidden by a pipe; rerun it without a pipe or with set -o pipefail`);
		else if (!matching.some((run) => run.exitCode === reported)) {
			const actual = matching[0].exitCode;
			errors.push(`Verified by: "${command}" exited ${actual === undefined ? "with an unknown code" : actual}, not ${reported}`);
		}
	}
	return errors;
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
	let runs: BashRun[] = [];

	pi.on("before_agent_start", (event) => {
		appendInstructions(event.systemPromptOptions, replyInstructions(schemaId));
	});

	pi.on("agent_start", () => {
		corrections = 0;
		pending = undefined;
		runs = [];
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const run = bashRun(event);
		if (run) runs.push(run);
	});

	pi.on("message_end", (event) => {
		const message = assistantMessage(event.message);
		if (!message || message.stopReason === "aborted" || message.stopReason === "error") return;
		const text = replyText(message);
		if (text === undefined) return;
		let result = validate(schemaId, text);
		if (result.ok && SCHEMAS[schemaId].sections.some((section) => section.heading === "Verified by")) {
			const errors = verifiedByErrors(text, runs);
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
