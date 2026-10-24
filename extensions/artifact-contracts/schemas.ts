/**
 * Artifact contracts: the single source for scaffold templates, validation, and tests.
 * Parent-owned. Change only with a decision-log entry in the active plan.
 *
 * Rules validate.ts enforces for every schema:
 * - Preamble lines come first, exactly in order; nothing else precedes the first `## ` section.
 * - `## ` sections appear exactly as listed, in order, once each. Headings inside fenced code are ignored.
 * - `### ` and deeper headings are free inside a section unless `subheading` constrains them.
 * - Every section body is non-empty; no `<!-- fill` marker may remain outside code, and no preamble placeholder may remain.
 * - Up to three leading spaces are ignored, as Markdown renders them.
 */

export type LinePattern = { readonly pattern: RegExp; readonly example: string };

export type Section = {
	readonly heading: string;
	readonly input?: Readonly<{ field: string; kind: "text" | "lines" | "choice" | "findings" | "evidence" }>;
	/** Rendered into the scaffold as `<!-- fill: hint -->`. */
	readonly hint: string;
	/** Body must be exactly one line equal to one of these values. */
	readonly oneOf?: readonly string[];
	/** Body must be exactly one line per pattern, in order. */
	readonly lines?: readonly LinePattern[];
	/** Body must be a list; every top-level item matches `pattern` and contains `labels` in order. */
	readonly item?: LinePattern & { readonly labels?: readonly string[] };
	/** With `item`: a body of exactly `None.` is also valid. */
	readonly none?: boolean;
	/** Every `### ` heading inside this section must match. */
	readonly subheading?: LinePattern;
	/** The previous body must remain a prefix of the new body. */
	readonly appendOnly?: boolean;
};

export type Schema = { readonly preamble: readonly LinePattern[]; readonly sections: readonly Section[] };

const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const DATED_DIRECTORY = String.raw`\d{4}/\d{2}/\d{2}`;
const SLUG = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
const SESSION_ID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

const PLAN_PATH = new RegExp(`^\\.harness/plans/${DATE}-${SLUG}\\.md$`);
const DAILY_LOG_PATH = new RegExp(`^\\.harness/${DATED_DIRECTORY}\\.md$`);
const TOPIC_LOG_PATH = new RegExp(`^\\.harness/${DATED_DIRECTORY}/${SLUG}\\.md$`);
const HANDOFF_PATH = new RegExp(`^\\.harness/handoffs/${DATED_DIRECTORY}/${SESSION_ID}-${SLUG}\\.md$`);
const REPORT_PATH = new RegExp(`^\\.harness/reports/${DATED_DIRECTORY}/${SESSION_ID}-${SLUG}\\.md$`);

export const ARTIFACT_CAPABILITY_VERSION = 1;
export type ArtifactOperation = "read" | "write" | "edit";

const CAPABILITY_PATHS: Readonly<Record<ArtifactOperation, readonly RegExp[]>> = {
	read: [PLAN_PATH, DAILY_LOG_PATH, HANDOFF_PATH, REPORT_PATH],
	write: [PLAN_PATH, HANDOFF_PATH, REPORT_PATH],
	edit: [PLAN_PATH, REPORT_PATH],
};

export function isArtifactCapabilityPath(
	operation: ArtifactOperation,
	path: string,
	features: Readonly<{ topicLogs?: number }> = {},
): boolean {
	return CAPABILITY_PATHS[operation].some((pattern) => pattern.test(path))
		|| (operation === "read" && features.topicLogs === 1 && TOPIC_LOG_PATH.test(path));
}

const status = { heading: "Status", hint: "done | blocked | failed", oneOf: ["done", "blocked", "failed"], input: { field: "status", kind: "choice" } } as const satisfies Section;
const findings = <Field extends string>(heading: string, field: Field) => ({
	input: { field, kind: "findings" },
	heading,
	hint: "one item per finding: `path:line` — issue, evidence, suggested direction",
	item: { pattern: /^- `[^`]+`/, example: "- `src/file.ts:42` — <issue>" },
	none: true,
} as const satisfies Section);

export const SCHEMAS = {
	plan: {
		preamble: [
			{ pattern: /^# [^<\s].*$/, example: "# <Plan title>" },
			{ pattern: /^Status: (draft|ready|in_progress|blocked|complete)$/, example: "Status: draft" },
			{ pattern: new RegExp(`^Updated: ${DATE}$`), example: "Updated: YYYY-MM-DD" },
		],
		sections: [
			{ heading: "Goal and context", hint: "desired behavior, current state, example or data flow" },
			{ heading: "Requirements and acceptance", hint: "observable outcomes and constraints" },
			{ heading: "Scope / non-scope", hint: "explicit boundaries" },
			{ heading: "Decisions and invariants", hint: "implementation-relevant choices with rationale" },
			{ heading: "Implementation", hint: "ordered slices: exact paths, dependencies, ownership, focused checks" },
			{ heading: "Verification", hint: "runnable commands and expected evidence, including failure paths" },
			{ heading: "Risks and open questions", hint: "blocking questions and known risks" },
			{
				heading: "Progress and handoff",
				hint: "per slice: result, changed paths, checks run, blockers, exact next step",
				subheading: { pattern: new RegExp(`^### ${DATE} — \\S.*$`), example: "### YYYY-MM-DD — <slice or milestone>" },
			},
			{
				heading: "Decision log",
				hint: "dated material decisions with session, rationale, and impact; append only",
				subheading: { pattern: new RegExp(`^### ${DATE} — \\S.*$`), example: "### YYYY-MM-DD — <decision>" },
				appendOnly: true,
			},
		],
	},
	handoff: {
		preamble: [{ pattern: /^Verified outcome: [^<\s].*$/, example: "Verified outcome: <verified result in one sentence>" }],
		sections: [
			{
				heading: "Alan's actions",
				hint: "human-only actions in dependency order",
				item: {
					pattern: /^\d+\. \*\*Do:\*\* \S/,
					example: "1. **Do:** <action>",
					labels: ["**Why:**", "**Leads to:**", "**Done when:**"],
				},
			},
			{ heading: "Blockers", hint: "blockers to the human actions, or None." },
			{ heading: "Resume references", hint: "daily work-log path for completed work and checks, active plan or no plan, task-handoff path, next state" },
		],
	},
	brief: {
		preamble: [],
		sections: [
			{ heading: "Objective", hint: "the one outcome this agent must deliver" },
			{
				heading: "Context",
				hint: "exactly four ordered, non-empty evidence lines",
				lines: [
					{ pattern: /^- Source of truth: \S.*$/, example: "- Source of truth: <!-- fill: active plan and decision headings, or None -->" },
					{ pattern: /^- Verified facts: \S.*$/, example: "- Verified facts: <!-- fill: directly confirmed facts and useful evidence -->" },
					{ pattern: /^- Read first: \S.*$/, example: "- Read first: <!-- fill: smallest exact paths/ranges -->" },
					{ pattern: /^- Open questions: \S.*$/, example: "- Open questions: <!-- fill: only questions owned by this worker -->" },
				],
			},
			{ heading: "Scope", hint: "owned paths and explicit non-scope" },
			{ heading: "Constraints", hint: "rules, limits, forbidden actions" },
			{ heading: "Done when", hint: "deliverable, success criteria, checks to run" },
		],
	},
	worker: {
		preamble: [],
		sections: [
			status,
			{ heading: "Objective", hint: "the briefed objective in one line", input: { field: "objective", kind: "text" } },
			{ heading: "Current state", hint: "what now exists, including changed files", input: { field: "currentState", kind: "text" } },
			{ heading: "Key decisions", hint: "choices made and why, or None.", input: { field: "decisions", kind: "lines" } },
			{
				heading: "Verified by",
				input: { field: "proofIds", kind: "evidence" },
				hint: "each check with its exit code, verification evidence ID, and optional note; or Not run: <reason>",
				item: {
					pattern: /^- (`[^`]+` (→|->) exit \d+ \[evidence: verify_[0-9a-f]{64}\](?: .+)?|Not run: \S.*)$/,
					example: `- \`'<command>'\` → exit 0 [evidence: verify_${"0".repeat(64)}]`,
				},
			},
			{ heading: "Next steps", hint: "what the parent should do next, or None.", input: { field: "nextSteps", kind: "lines" } },
			{ heading: "Do not", hint: "actions the parent or next agent must avoid, or None.", input: { field: "doNot", kind: "lines" } },
		],
	},
	explorer: {
		preamble: [],
		sections: [
			status,
			{ heading: "Answer", hint: "the concise answer to the brief's question", input: { field: "answer", kind: "text" } },
			{ heading: "Relevant paths", hint: "absolute paths with line numbers where useful", input: { field: "paths", kind: "lines" } },
			{ heading: "Uncertainty", hint: "real uncertainty or blockers, or None.", input: { field: "uncertainty", kind: "lines" } },
		],
	},
	review: {
		preamble: [],
		sections: [
			status,
			{ heading: "Verdict", hint: "APPROVE | APPROVE WITH CHANGES | REJECT", oneOf: ["APPROVE", "APPROVE WITH CHANGES", "REJECT"], input: { field: "verdict", kind: "choice" } },
			{ heading: "Scope", hint: "exact paths, module, or diff range reviewed", input: { field: "scope", kind: "text" } },
			findings("Critical (P0)", "critical"),
			findings("Important (P1)", "important"),
			findings("Nice-to-have (P2)", "niceToHave"),
			{ heading: "Out of scope", hint: "follow-ups outside the requested review, or None.", input: { field: "outOfScope", kind: "lines" } },
		],
	},
} as const satisfies Record<string, Schema>;

export type SchemaId = keyof typeof SCHEMAS;
export type ResultSchemaId = "worker" | "explorer" | "review";
export const RESULT_FINDING_FIELDS = ["location", "issue", "evidence", "direction"] as const;
export type ResultFinding = Readonly<Record<(typeof RESULT_FINDING_FIELDS)[number], string>>;
export const RESULT_SUPPLEMENTAL_FIELDS = {
	worker: [{ field: "observationIds", kind: "evidence" }, { field: "notRun", kind: "lines" }],
	explorer: [],
	review: [],
} as const;
type InputSection<Id extends ResultSchemaId> = (typeof SCHEMAS)[Id]["sections"][number];
type InputValue<Section> = Section extends { input: { kind: "findings" } } ? readonly ResultFinding[]
	: Section extends { input: { kind: "lines" | "evidence" } } ? readonly string[]
	: Section extends { oneOf: readonly (infer Choice)[] } ? Choice : string;
export type ResultSubmission<Id extends ResultSchemaId> = {
	readonly [Section in InputSection<Id> as Section["input"]["field"]]: InputValue<Section>;
} & {
	readonly [Field in (typeof RESULT_SUPPLEMENTAL_FIELDS)[Id][number] as Field["field"]]: readonly string[];
};
export const RESULT_EVIDENCE_REFERENCE_PATTERN = "^verify_[0-9a-f]{64}$";

/** Documents validated on every agent write or edit (repo-relative POSIX paths). */
export const DOCUMENTS: readonly { readonly schema: SchemaId; readonly path: RegExp; readonly createOnly: boolean }[] = [
	{ schema: "plan", path: PLAN_PATH, createOnly: false },
	{ schema: "handoff", path: HANDOFF_PATH, createOnly: true },
];

/** Freeform artifacts that still require canonical path and symlink protection. */
export const FREEFORM: readonly RegExp[] = [REPORT_PATH];

/** Paths agents may never write or edit directly. */
export const PROTECTED: readonly { readonly path: RegExp; readonly reason: string }[] = [
	{
		path: DAILY_LOG_PATH,
		reason: "Daily work logs are append-only: use the native work_log tool.",
	},
	{ path: TOPIC_LOG_PATH, reason: "Topic work logs are append-only: use the native work_log tool." },
	{ path: /^\.opencode\//, reason: "Legacy .opencode records are read-only." },
];

/** Final-message schema per subagent; unlisted agents use DEFAULT_OUTPUT; null means no message schema. */
export const AGENT_OUTPUT: Readonly<Record<string, SchemaId | null>> = {
	"code-explorer": "explorer",
	"code-reviewer": "review",
	"code-reviewer-haiku": "review",
	"code-reviewer-sonnet": "review",
	"code-reviewer-sol": "review",
	"code-reviewer-opus": "review",
};
export const DEFAULT_OUTPUT: SchemaId = "worker";
