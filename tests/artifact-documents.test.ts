import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import type {
	EditToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ReadToolCallEvent,
	ToolCallEvent,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	applyExactEdits,
	checkDocumentWrite,
	registerDocumentHooks,
	type ExactEdit,
} from "../extensions/artifact-contracts/documents.ts";
import { renderTemplate } from "../extensions/artifact-contracts/render.ts";
import { SCHEMAS, type SchemaId } from "../extensions/artifact-contracts/schemas.ts";

function filledDocument(schemaId: SchemaId): string {
	const schema = SCHEMAS[schemaId];
	const preamble = schema.preamble.map((line) => line.example.replace("YYYY-MM-DD", "2026-10-01").replace(/<[^>]+>/g, "example"));
	return [
		...preamble,
		...(preamble.length ? [""] : []),
		...schema.sections.flatMap((section) => {
			const body = section.oneOf
				? [section.oneOf[0]]
				: section.item
					? [section.item.example, ...(section.item.labels ?? []).map((label) => `   ${label} example`)]
					: section.subheading
						? [`### 2026-10-01 — ${section.heading === "Decision log" ? "decision" : "progress"}`, section.heading === "Decision log" ? "record" : "progress note"]
						: ["content"];
			return [`## ${section.heading}`, ...body, ""];
		}),
	].join("\n");
}

function withTempDir(run: (cwd: string) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), "artifact-documents-"));
	try {
		run(cwd);
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
}

function writeFixture(cwd: string, relPath: string, content: string): void {
	const path = join(cwd, relPath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => ToolCallEventResult | void | Promise<ToolCallEventResult | void>;

function registeredHandler(): ToolCallHandler {
	let handler: ToolCallHandler | undefined;
	const pi = {
		on(event: "tool_call", next: ToolCallHandler): () => void {
			assert.equal(event, "tool_call");
			handler = next;
			return () => undefined;
		},
	} as unknown as ExtensionAPI;
	registerDocumentHooks(pi);
	if (!handler) throw new Error("document hook was not registered");
	return handler;
}

function context(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

function writeEvent(path: string, content: string): WriteToolCallEvent {
	return { type: "tool_call", toolCallId: "write-1", toolName: "write", input: { path, content } };
}

function editEvent(path: string, edits: readonly ExactEdit[]): EditToolCallEvent {
	return { type: "tool_call", toolCallId: "edit-1", toolName: "edit", input: { path, edits: [...edits] } };
}

function blockedReason(result: { block: boolean; reason?: string } | void): string {
	if (!result?.block || result.reason === undefined) throw new Error("expected a blocked result");
	return result.reason;
}

test("applyExactEdits normalizes LF, requires unique matches, and rejects overlap", () => {
	assert.deepEqual(applyExactEdits("a\r\nb\r\nc", [{ oldText: "b\r\n", newText: "B\n" }]), {
		ok: true,
		content: "a\nB\nc",
	});
	const missing = applyExactEdits("abc", [{ oldText: "x", newText: "y" }]);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.error, /not found exactly/);
	const duplicate = applyExactEdits("aba", [{ oldText: "a", newText: "x" }]);
	assert.equal(duplicate.ok, false);
	if (!duplicate.ok) assert.match(duplicate.error, /exactly once/);
	const overlap = applyExactEdits("abcdef", [
		{ oldText: "abc", newText: "x" },
		{ oldText: "cde", newText: "y" },
	]);
	assert.equal(overlap.ok, false);
	if (!overlap.ok) assert.match(overlap.error, /overlap/);
});

test("valid plan writes pass and invalid writes include errors and template", () => {
	const plan = filledDocument("plan");
	assert.deepEqual(checkDocumentWrite({ relPath: ".harness/plans/2026-10-01-example.md", exists: false, proposed: plan }), {
		block: false,
	});

	const result = checkDocumentWrite({
		relPath: ".harness/plans/2026-10-01-example.md",
		exists: false,
		proposed: `${plan}## Extra\ncontent\n`,
	});
	const reason = blockedReason(result);
	assert.match(reason, /unexpected section/);
	assert.ok(reason.includes("Template:\n"));
	assert.ok(reason.includes(renderTemplate("plan")));
});

test("plan edits validate the resulting document and preserve append-only decisions", () => {
	withTempDir((cwd) => {
		const relPath = ".harness/plans/2026-10-01-example.md";
		const plan = filledDocument("plan");
		writeFixture(cwd, relPath, plan);
		const handler = registeredHandler();

		assert.equal(
			handler(editEvent(relPath, [{ oldText: "## Goal and context\ncontent", newText: "## Goal and context\nupdated" }]), context(cwd)),
			undefined,
		);

		const extra = handler(
			editEvent(relPath, [{ oldText: "## Goal and context\ncontent", newText: "## Extra\ncontent\n\n## Goal and context\ncontent" }]),
			context(cwd),
		);
		assert.match(blockedReason(extra), /unexpected section/);

		const changedDecision = handler(editEvent(relPath, [{ oldText: "record", newText: "changed" }]), context(cwd));
		assert.match(blockedReason(changedDecision), /append-only/);

		const appended = handler(
			editEvent(relPath, [
				{
					oldText: "### 2026-10-01 — decision\nrecord",
					newText: "### 2026-10-01 — decision\nrecord\n### 2026-10-02 — later\nmore",
				},
			]),
			context(cwd),
		);
		assert.equal(appended, undefined);
	});
});

test("non-exact plan edits are blocked with an exact unique oldText retry", () => {
	withTempDir((cwd) => {
		const relPath = ".harness/plans/2026-10-01-example.md";
		writeFixture(cwd, relPath, filledDocument("plan"));
		const result = registeredHandler()(editEvent(relPath, [{ oldText: "not in current", newText: "replacement" }]), context(cwd));
		assert.equal(result?.block, true);
		assert.match(result && "reason" in result ? result.reason : "", /exact, unique oldText/);
	});
});

test("handoff documents are create-only and validate new writes", () => {
	withTempDir((cwd) => {
		const relPath = ".harness/handoffs/2026/10/01/01234567-89ab-cdef-0123-456789abcdef-example.md";
		const handoff = filledDocument("handoff");
		const handler = registeredHandler();

		assert.equal(handler(writeEvent(relPath, handoff), context(cwd)), undefined);
		writeFixture(cwd, relPath, handoff);
		const overwrite = handler(writeEvent(relPath, handoff), context(cwd));
		assert.match(blockedReason(overwrite), /create-only/);

		const edit = handler(editEvent(relPath, [{ oldText: "content", newText: "changed" }]), context(cwd));
		assert.match(blockedReason(edit), /create-only/);
	});
});

test("protected paths block while unrelated paths and outside absolute paths pass", () => {
	withTempDir((cwd) => {
		const handler = registeredHandler();
		const daily = handler(writeEvent(".harness/2026/10/01.md", "content"), context(cwd));
		assert.match(blockedReason(daily), /Daily work logs/);

		const opencode = handler(writeEvent(".opencode/legacy.md", "content"), context(cwd));
		assert.match(blockedReason(opencode), /Legacy .opencode/);

		assert.equal(handler(writeEvent("src/unrelated.md", "content"), context(cwd)), undefined);
		assert.equal(handler(writeEvent(join(cwd, "../outside.md"), "content"), context(cwd)), undefined);

		const readEvent: ReadToolCallEvent = {
			type: "tool_call",
			toolCallId: "read-1",
			toolName: "read",
			input: { path: ".harness/plans/2026-10-01-example.md" },
		};
		assert.equal(handler(readEvent, context(cwd)), undefined);
	});
});

test("registerDocumentHooks installs a blocking tool_call handler", () => {
	withTempDir((cwd) => {
		const relPath = ".harness/plans/2026-10-01-example.md";
		const handler = registeredHandler();
		assert.ok(blockedReason(handler(writeEvent(relPath, "invalid"), context(cwd))));
	});
});
