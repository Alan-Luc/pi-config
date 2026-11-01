import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyReply,
	formatQuestion,
	resolveTopic,
	routeReply,
	tagOf,
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

export default function (pi: ExtensionAPI): void {
	const pending = new Map<string, Pending>();
	let topic: string | undefined;

	function currentTopic(): string | undefined {
		if (topic === undefined) topic = resolveTopic(process.env, readSecrets());
		return topic;
	}

	async function send(text: string): Promise<void> {
		const current = currentTopic();
		if (!current) return;
		try {
			await pi.exec("ntfy", ["publish", current, text], { timeout: 10_000 });
		} catch {
			// An unreachable server must not break the questionnaire; the dialog still works.
		}
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
			void send(`⚠️ ${routed.reason}`);
			return;
		}
		if (pending.get(entry.toolCallId) !== entry || routed.tag !== entry.tag) return;

		const outcome = applyReply(entry.draft, routed.body, entry.questions);
		switch (outcome.kind) {
			case "ignore":
				return;
			case "hint":
				void send(`⚠️ ${outcome.reason}`);
				return;
			case "partial": {
				entry.draft = outcome.draft;
				const still = outcome.missing.map((index) => index + 1).join(", ");
				void send(`got it — still need question ${still}`);
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

	pi.events.on("rpiv:ask-user:prompt", (data: unknown) => {
		const current = currentTopic();
		if (!current || !isRecord(data)) return;
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
		void send(published);

		// Seeds at the publish second and stays open: one idle connection, no repeat requests.
		const child = spawn("ntfy", ["subscribe", `--since=${Math.floor(Date.now() / 1000)}`, current], {
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
			void send("✅ answered");
			stop(verdict.toolCallId);
			return;
		}
		if (verdict.code === "not_found") {
			stop(verdict.toolCallId);
			return;
		}
		const reason = typeof verdict.reason === "string" ? `: ${verdict.reason}` : "";
		void send(`⚠️ ${typeof verdict.code === "string" ? verdict.code : "refused"}${reason}`);
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
