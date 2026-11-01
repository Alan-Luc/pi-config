import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyReply,
	formatQuestion,
	resolveTopic,
	routeReply,
	tagOf,
	topicProblem,
	type Draft,
	type PromptPayload,
	type PromptQuestion,
} from "./lib/ntfy-questions.ts";

interface Pending {
	toolCallId: string;
	questions: readonly PromptQuestion[];
	tag: string;
	draft: Draft;
	published: string;
	seen: Set<string>;
	child?: ReturnType<typeof spawn>;
}

interface NtfyMessage {
	id?: unknown;
	event?: unknown;
	message?: unknown;
}

interface AnswerVerdict {
	ok?: unknown;
	code?: unknown;
	reason?: unknown;
	toolCallId?: unknown;
}

interface BlockedPayload {
	active?: unknown;
	toolCallId?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** With NTFY_TOPIC set, the CLI publishes there and treats the topic argument as the message. */
function ntfyEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.NTFY_TOPIC;
	return env;
}

export default function (pi: ExtensionAPI): void {
	const pending = new Map<string, Pending>();
	let topic: string | undefined;
	let ui: ExtensionContext["ui"] | undefined;

	function currentTopic(): string | undefined {
		if (topic === undefined) topic = resolveTopic(process.env, readSecrets());
		return topic;
	}

	function publish(text: string): void {
		const current = currentTopic();
		if (!current) return;
		spawn("ntfy", ["publish", current, text], { env: ntfyEnv(), stdio: "ignore" }).on("error", () => undefined);
	}

	function stop(toolCallId: string): void {
		const entry = pending.get(toolCallId);
		if (!entry) return;
		pending.delete(toolCallId);
		entry.child?.stdout?.removeAllListeners();
		entry.child?.kill();
	}

	function handleLine(entry: Pending, line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let message: NtfyMessage;
		try {
			message = JSON.parse(trimmed) as NtfyMessage;
		} catch {
			return;
		}
		if (message.event !== "message") return;
		const id = typeof message.id === "string" ? message.id : undefined;
		const body = typeof message.message === "string" ? message.message : "";
		if (!body || body === entry.published) return;
		if (id !== undefined && entry.seen.has(id)) return;
		if (id !== undefined) entry.seen.add(id);

		const routed = routeReply(
			body,
			[...pending.values()].map((candidate) => candidate.tag),
		);
		if (routed.kind === "hint") {
			publish(`⚠️ ${routed.reason}`);
			return;
		}
		if (pending.get(entry.toolCallId) !== entry || routed.tag !== entry.tag) return;

		const outcome = applyReply(entry.draft, routed.body, entry.questions);
		switch (outcome.kind) {
			case "ignore":
				return;
			case "hint":
				publish(`⚠️ ${outcome.reason}`);
				return;
			case "partial": {
				entry.draft = outcome.draft;
				const still = outcome.missing.map((index) => index + 1).join(", ");
				publish(`got it — still need question ${still}`);
				return;
			}
			case "cancel":
				pi.events.emit("rpiv:ask-user:answer", { toolCallId: entry.toolCallId, requestId: id, cancel: true });
				return;
			case "answer":
				pi.events.emit("rpiv:ask-user:answer", {
					toolCallId: entry.toolCallId,
					requestId: id,
					answers: outcome.answers,
				});
				return;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		const configured = currentTopic();
		if (!configured) return;
		const problem = topicProblem(configured);
		if (problem) ui.notify(`ntfy answers disabled: ${problem}`, "warning");
	});

	pi.events.on("rpiv:ask-user:prompt", (data: unknown) => {
		const current = currentTopic();
		if (!current || !isRecord(data)) return;
		const problem = topicProblem(current);
		if (problem) {
			ui?.notify(`ntfy answers unavailable: ${problem}`, "warning");
			return;
		}
		const payload = data as PromptPayload;
		const toolCallId = payload.toolCallId;
		const questions = payload.questions;
		if (!toolCallId || !questions?.length) return;

		stop(toolCallId);
		const published = formatQuestion(questions, pending.size > 0 ? tagOf(toolCallId) : undefined);
		const entry: Pending = {
			toolCallId,
			questions,
			tag: tagOf(toolCallId),
			draft: {},
			published,
			seen: new Set(),
		};
		pending.set(toolCallId, entry);
		publish(published);

		// Seeds at the publish second and stays open: one idle connection, no repeat requests.
		const child = spawn("ntfy", ["subscribe", `--since=${Math.floor(Date.now() / 1000)}`, current], {
			env: ntfyEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		entry.child = child;
		child.stdout.setEncoding("utf8");
		let buffer = "";
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(entry, line);
		});
		child.on("error", () => stop(toolCallId));
	});

	pi.events.on("rpiv:ask-user:answer-result", (data: unknown) => {
		if (!isRecord(data)) return;
		const verdict = data as AnswerVerdict;
		if (typeof verdict.toolCallId !== "string") return;
		if (!pending.has(verdict.toolCallId)) return;
		if (verdict.ok === true) {
			publish("✅ answered");
			stop(verdict.toolCallId);
			return;
		}
		if (verdict.code === "not_found") {
			stop(verdict.toolCallId);
			return;
		}
		const reason = typeof verdict.reason === "string" ? `: ${verdict.reason}` : "";
		publish(`⚠️ ${typeof verdict.code === "string" ? verdict.code : "refused"}${reason}`);
	});

	pi.events.on("rpiv:ask-user:blocked", (data: unknown) => {
		if (!isRecord(data)) return;
		const payload = data as BlockedPayload;
		if (payload.active !== false || typeof payload.toolCallId !== "string") return;
		stop(payload.toolCallId);
	});

	pi.on("session_shutdown", async () => {
		for (const toolCallId of [...pending.keys()]) stop(toolCallId);
	});
}

function readSecrets(): string {
	try {
		return readFileSync(join(homedir(), ".config/zsh/secrets"), "utf8");
	} catch {
		return "";
	}
}
