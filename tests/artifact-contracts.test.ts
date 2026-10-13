import assert from "node:assert/strict";
import { test } from "bun:test";
import { renderTemplate } from "../extensions/artifact-contracts/render.ts";
import { matchPath, validate } from "../extensions/artifact-contracts/validate.ts";
import {
	ARTIFACT_CAPABILITY_VERSION,
	isArtifactCapabilityPath,
	SCHEMAS,
	type ArtifactOperation,
	type SchemaId,
} from "../extensions/artifact-contracts/schemas.ts";
import {
	ARTIFACT_CAPABILITY_CHANNEL,
	ARTIFACT_CAPABILITY_REQUEST_CHANNEL,
	registerArtifactCapability,
} from "../extensions/artifact-contracts/index.ts";

const schemaIds = Object.keys(SCHEMAS) as SchemaId[];

type Block = { heading: string; start: number; end: number };

function blocks(text: string): Block[] {
	const lines = text.split("\n");
	const starts = lines.flatMap((line, index) => (line.startsWith("## ") ? [{ heading: line.slice(3), index }] : []));
	return starts.map((start, index) => ({
		heading: start.heading,
		start: start.index,
		end: starts[index + 1]?.index ?? lines.length,
	}));
}

function filledDocument(schemaId: SchemaId): string {
	const schema = SCHEMAS[schemaId];
	const preamble = schema.preamble.map((line) => line.example.replace("YYYY-MM-DD", "2026-10-01").replace(/<[^>]+>/g, "example"));
	return [
		...preamble,
		...(preamble.length ? [""] : []),
		...schema.sections.flatMap((section) => {
			const body = section.lines?.map((line) => line.example.replace(/<!-- fill: .* -->/, "example"))
				?? (section.oneOf
					? [section.oneOf[0]]
					: section.item
						? [section.item.example, ...(section.item.labels ?? []).map((label) => `   ${label} example`)]
						: section.subheading
							? ["### 2026-10-01 — decision", "record"]
							: ["content"]);
			return [`## ${section.heading}`, ...body, ""];
		}),
	].join("\n");
}

function withSectionBody(text: string, heading: string, body: readonly string[]): string {
	const lines = text.split("\n");
	const section = blocks(text).find((candidate) => candidate.heading === heading);
	assert.ok(section);
	lines.splice(section.start + 1, section.end - section.start - 1, ...body, "");
	return lines.join("\n");
}

function replaceSection(text: string, heading: string, replacement: readonly string[]): string {
	const lines = text.split("\n");
	const section = blocks(text).find((candidate) => candidate.heading === heading);
	assert.ok(section);
	lines.splice(section.start, section.end - section.start, ...replacement);
	return lines.join("\n");
}

function swapSections(text: string, firstHeading: string, secondHeading: string): string {
	const lines = text.split("\n");
	const documentSections = blocks(text);
	const first = documentSections.find((section) => section.heading === firstHeading);
	const second = documentSections.find((section) => section.heading === secondHeading);
	assert.ok(first);
	assert.ok(second);
	const before = lines.slice(0, first.start);
	const firstBody = lines.slice(first.start, first.end);
	const between = lines.slice(first.end, second.start);
	const secondBody = lines.slice(second.start, second.end);
	const after = lines.slice(second.end);
	return [...before, ...secondBody, ...between, ...firstBody, ...after].join("\n");
}

test("every rendered template fails only on fill markers and preamble placeholders", () => {
	for (const schemaId of schemaIds) {
		const schema = SCHEMAS[schemaId];
		const placeholders = schema.preamble.filter((line) => !line.pattern.test(line.example)).length;
		const result = validate(schemaId, renderTemplate(schemaId));
		assert.equal(result.ok, false, schemaId);
		const fillMarkers = schema.sections.reduce((count, section) => count + (section.lines?.length ?? 1), 0);
		assert.equal(result.errors.length, fillMarkers + placeholders, schemaId);
		assert.ok(result.errors.every((error) => error.includes("fill marker") || error.includes("placeholder")), schemaId);
	}
});

test("a correctly filled document passes for every schema", () => {
	for (const schemaId of schemaIds) assert.deepEqual(validate(schemaId, filledDocument(schemaId)), { ok: true, errors: [] }, schemaId);
});

test("handoffs contain only human actions, blockers, and resume references", () => {
	assert.deepEqual(
		SCHEMAS.handoff.sections.map((section) => section.heading),
		["Alan's actions", "Blockers", "Resume references"],
	);
	const handoff = filledDocument("handoff");
	assert.ok(!handoff.includes("## Agent work"));
	assert.ok(!handoff.includes("## Verification"));
});

test("missing, extra, duplicate, reordered, and renamed sections are rejected", () => {
	for (const schemaId of schemaIds) {
		const document = filledDocument(schemaId);
		const schema = SCHEMAS[schemaId];
		const first = schema.sections[0].heading;
		const second = schema.sections[1].heading;
		const firstBlock = blocks(document).find((block) => block.heading === first);
		assert.ok(firstBlock);

		assert.ok(validate(schemaId, replaceSection(document, first, [])).errors.some((error) => error.includes(`missing section "## ${first}"`)), schemaId);
		assert.ok(validate(schemaId, `${document.replace(/^/, "## Extra\ncontent\n\n")}`).errors.some((error) => error.includes("unexpected section \"## Extra\"")), schemaId);
		assert.ok(validate(schemaId, replaceSection(document, first, [`## ${first}`, "content", "", `## ${first}`])).errors.some((error) => error.includes("duplicate section")), schemaId);
		const reordered = swapSections(document, first, second);
		assert.ok(validate(schemaId, reordered).errors.some((error) => error.includes("out of order")), schemaId);
		assert.ok(
			validate(schemaId, replaceSection(document, first, ["## Renamed", "content", ""]))
				.errors.some((error) => error.includes("unexpected section \"## Renamed\"")),
			schemaId,
		);
	}
});

test("preamble violations, top-level headings, and CRLF are handled", () => {
	assert.ok(validate("plan", filledDocument("plan").replace(/^# .*$/m, "Wrong title")).errors.some((error) => error.includes("expected preamble")));
	assert.ok(validate("handoff", filledDocument("handoff").replace(/^Verified outcome: .*$/m, "Verified outcome: ")).errors.some((error) => error.includes("expected preamble")));
	assert.ok(validate("brief", withSectionBody(filledDocument("brief"), "Objective", ["# unexpected"])).errors.some((error) => error.includes("unexpected heading")));
	assert.equal(validate("handoff", filledDocument("handoff").replaceAll("\n", "\r\n")).ok, true);
});

test("headings in fenced code are ignored and unclosed fences fail", () => {
	const fenced = withSectionBody(filledDocument("brief"), "Objective", ["before", "```markdown", "## Fake section", "# Fake title", "```", "after"]);
	assert.deepEqual(validate("brief", fenced), { ok: true, errors: [] });

	const unclosed = withSectionBody(filledDocument("brief"), "Objective", ["```", "## Fake section"]);
	const result = validate("brief", unclosed);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => error.includes("unclosed fenced code block")));
});

test("oneOf, item, none, labels, and subheading rules are enforced", () => {
	const oneOf = withSectionBody(filledDocument("worker"), "Status", ["maybe", "extra"]);
	assert.ok(validate("worker", oneOf).errors.some((error) => error.includes("expected exactly one non-blank line")));

	const item = withSectionBody(filledDocument("worker"), "Verified by", ["not an item"]);
	assert.ok(validate("worker", item).errors.some((error) => error.includes("top-level item")));

	assert.equal(validate("review", withSectionBody(filledDocument("review"), "Critical (P0)", ["None."])).ok, true);
	assert.ok(validate("worker", withSectionBody(filledDocument("worker"), "Verified by", ["None."])).errors.length > 0);

	const missingLabel = withSectionBody(filledDocument("handoff"), "Alan's actions", ["1. **Do:** action", "   **Why:** reason"]);
	assert.ok(validate("handoff", missingLabel).errors.some((error) => error.includes("item label \"**Leads to:**\" is missing")));

	const badSubheading = withSectionBody(filledDocument("plan"), "Decision log", ["### bad", "record"]);
	assert.ok(validate("plan", badSubheading).errors.some((error) => error.includes("expected subheading")));
});

test("append-only sections reject edits and accept pure appends", () => {
	const previous = filledDocument("plan");
	const appended = withSectionBody(previous, "Decision log", ["### 2026-10-01 — decision", "record", "### 2026-10-02 — later", "more"]);
	assert.deepEqual(validate("plan", appended, previous), { ok: true, errors: [] });

	const changed = withSectionBody(previous, "Decision log", ["### 2026-10-01 — decision", "changed"]);
	const result = validate("plan", changed, previous);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => error.includes("append-only section")));
});

test("matchPath classifies writable, freeform, protected, and unrelated paths", () => {
	assert.deepEqual(matchPath(".harness/plans/2026-10-01-example-plan.md"), {
		kind: "document",
		schema: "plan",
		createOnly: false,
	});
	assert.deepEqual(matchPath(".harness/handoffs/2026/10/01/01234567-89ab-cdef-0123-456789abcdef-example-handoff.md"), {
		kind: "document",
		schema: "handoff",
		createOnly: true,
	});
	assert.deepEqual(matchPath(".harness/reports/2026/10/01/01234567-89ab-cdef-0123-456789abcdef-audit.md"), {
		kind: "freeform",
	});
	const daily = matchPath(".harness/2026/10/01.md");
	assert.equal(daily?.kind, "protected");
	assert.equal(matchPath(".opencode/legacy.md")?.kind, "protected");
	assert.equal(matchPath("src/unrelated.md"), null);
});

const CAPABILITY_PATHS = {
	plan: ".harness/plans/2026-10-12-lean-instruction-architecture.md",
	daily: ".harness/2026/10/12.md",
	handoff: ".harness/handoffs/2026/10/12/01234567-89ab-cdef-0123-456789abcdef-task.md",
	report: ".harness/reports/2026/10/12/01234567-89ab-cdef-0123-456789abcdef-audit.md",
} as const;

const CAPABILITY_MATRIX: Readonly<Record<ArtifactOperation, readonly string[]>> = {
	read: Object.values(CAPABILITY_PATHS),
	write: [CAPABILITY_PATHS.plan, CAPABILITY_PATHS.handoff, CAPABILITY_PATHS.report],
	edit: [CAPABILITY_PATHS.plan, CAPABILITY_PATHS.report],
};

const REJECTED_CAPABILITY_PATHS = [
	".harness/plans/2026-10-12-Lean-instruction-architecture.md",
	".harness/plans/2026-10-12-lean_instruction_architecture.md",
	".harness/handoffs/2026/10/12/01234567-89ab-cdef-0123-456789ABCDEf-task.md",
	".harness/handoffs/2026/10/12/zzzzzzzz-89ab-cdef-0123-456789abcdef-task.md",
	".harness/handoffs/2026/10/12/task.md",
	".harness/reports/2026/10/12/extra/01234567-89ab-cdef-0123-456789abcdef-audit.md",
	".harness/reports/2026/10/12/01234567-89ab-cdef-0123-456789abcdef-audit.txt",
	"/.harness/plans/2026-10-12-lean-instruction-architecture.md",
	"~/.harness/plans/2026-10-12-lean-instruction-architecture.md",
	".harness\\plans\\2026-10-12-lean-instruction-architecture.md",
	".harness//plans/2026-10-12-lean-instruction-architecture.md",
	".harness/./plans/2026-10-12-lean-instruction-architecture.md",
	".harness/plans/ignored/../2026-10-12-lean-instruction-architecture.md",
] as const;

test("capability version 1 uses the exact path and operation matrix", () => {
	assert.equal(ARTIFACT_CAPABILITY_VERSION, 1);
	for (const operation of ["read", "write", "edit"] as const) {
		for (const path of Object.values(CAPABILITY_PATHS)) {
			assert.equal(
				isArtifactCapabilityPath(operation, path),
				CAPABILITY_MATRIX[operation].includes(path),
				`${operation} ${path}`,
			);
		}
		for (const path of REJECTED_CAPABILITY_PATHS) {
			assert.equal(isArtifactCapabilityPath(operation, path), false, `${operation} ${path}`);
		}
	}
});

test("the root capability announces after listening and responds to package-first requests", () => {
	const order: string[] = [];
	const listeners = new Map<string, (payload: unknown) => void>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const events = {
		on(channel: string, listener: (payload: unknown) => void) {
			order.push(`on:${channel}`);
			listeners.set(channel, listener);
			return () => listeners.delete(channel);
		},
		emit(channel: string, payload: unknown) {
			order.push(`emit:${channel}`);
			emitted.push({ channel, payload });
		},
	};

	registerArtifactCapability({ events } as never);
	assert.deepEqual(order.slice(0, 2), [
		`on:${ARTIFACT_CAPABILITY_REQUEST_CHANNEL}`,
		`emit:${ARTIFACT_CAPABILITY_CHANNEL}`,
	]);
	assert.deepEqual(emitted, [
		{ channel: ARTIFACT_CAPABILITY_CHANNEL, payload: { version: 1, mutations: true } },
	]);

	listeners.get(ARTIFACT_CAPABILITY_REQUEST_CHANNEL)?.({});
	assert.deepEqual(emitted.at(-1), {
		channel: ARTIFACT_CAPABILITY_CHANNEL,
		payload: { version: 1, mutations: true },
	});
});

test("up to three leading spaces still count as structure, as in rendered Markdown", () => {
	const brief = filledDocument("brief");
	for (const indent of [" ", "   "]) {
		assert.ok(validate("brief", `${brief}\n${indent}## Extra\ncontent\n`).errors.some((error) => error.includes("unexpected section")), JSON.stringify(indent));
	}
	assert.deepEqual(validate("brief", withSectionBody(brief, "Objective", ["text", "", "    ## indented code, not a section"])), { ok: true, errors: [] });

	const worker = filledDocument("worker");
	assert.deepEqual(validate("worker", withSectionBody(worker, "Status", ["  done  "])), { ok: true, errors: [] });
	const evidenceId = `verify_${"0".repeat(64)}`;
	assert.deepEqual(validate("worker", withSectionBody(worker, "Verified by", [` - \`'bun' 'test'\` → exit 0 [evidence: ${evidenceId}]`, " - Not run: no browser"])), { ok: true, errors: [] });
	assert.deepEqual(validate("worker", withSectionBody(worker, "Verified by", [`- \`'bun' 'test'\` → exit 0 [evidence: ${evidenceId}]`, "  - nested detail"])), { ok: true, errors: [] });
});

test("fill markers quoted in code do not count as unfilled", () => {
	const brief = filledDocument("brief");
	assert.deepEqual(validate("brief", withSectionBody(brief, "Constraints", ["Reject any `<!-- fill` marker."])), { ok: true, errors: [] });
	assert.deepEqual(validate("brief", withSectionBody(brief, "Constraints", ["```", "<!-- fill: example -->", "```"])), { ok: true, errors: [] });
	assert.ok(validate("brief", withSectionBody(brief, "Constraints", ["<!-- fill: rules -->"])).errors.some((error) => error.includes("fill marker")));
});

test("unfilled preamble placeholders are rejected while valid defaults pass", () => {
	const plan = filledDocument("plan");
	assert.ok(validate("plan", plan.replace(/^Updated: .*$/m, "Updated: YYYY-MM-DD")).errors.some((error) => error.includes("replace placeholder")));
	assert.ok(validate("plan", plan.replace(/^# .*$/m, "# <Plan title>")).errors.some((error) => error.includes("replace placeholder")));
	const handoff = filledDocument("handoff").replace(/^Verified outcome: .*$/m, "Verified outcome: <verified result in one sentence>");
	assert.ok(validate("handoff", handoff).errors.some((error) => error.includes("replace placeholder")));
	assert.deepEqual(validate("plan", plan), { ok: true, errors: [] });
});

test("literal unicode escapes outside code are rejected", () => {
	const brief = filledDocument("brief");
	assert.ok(validate("brief", withSectionBody(brief, "Objective", ["Decisions 1\\u20137 are approved."])).errors.some((error) => error.includes("literal escape")));
	assert.deepEqual(validate("brief", withSectionBody(brief, "Objective", ["Write `\\u2014` only in code."])), { ok: true, errors: [] });
	assert.deepEqual(validate("brief", withSectionBody(brief, "Objective", ["```", 'const dash = "\\u2014";', "```"])), { ok: true, errors: [] });
});

test("verified-by command claims require evidence IDs and may carry notes", () => {
	const worker = filledDocument("worker");
	const evidenceId = `verify_${"a".repeat(64)}`;
	assert.deepEqual(
		validate("worker", withSectionBody(worker, "Verified by", [`- \`'bun' 'test'\` → exit 1 [evidence: ${evidenceId}] (8 pass, 1 fail)`])),
		{ ok: true, errors: [] },
	);
	assert.ok(validate("worker", withSectionBody(worker, "Verified by", ["- `bun test` → exit 0"])).errors.length > 0);
	assert.ok(validate("worker", withSectionBody(worker, "Verified by", [`- \`'bun' 'test'\` → exit 1 [evidence: ${evidenceId}](8 pass)`])).errors.length > 0);
	assert.deepEqual(validate("worker", withSectionBody(worker, "Verified by", ["- Not run: no browser"])), { ok: true, errors: [] });
});

test("progress entries need dated subheadings", () => {
	const plan = filledDocument("plan");
	assert.ok(validate("plan", withSectionBody(plan, "Progress and handoff", ["### 2026-10-01 \\", "text"])).errors.some((error) => error.includes("expected subheading")));
	assert.deepEqual(validate("plan", withSectionBody(plan, "Progress and handoff", ["### 2026-10-01 — Slice done", "text"])), { ok: true, errors: [] });
});
