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
	/** Rendered into the scaffold as `<!-- fill: hint -->`. */
	readonly hint: string;
	/** Body must be exactly one line equal to one of these values. */
	readonly oneOf?: readonly string[];
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
const SLUG = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
const SESSION_ID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

const status: Section = { heading: "Status", hint: "done | blocked | failed", oneOf: ["done", "blocked", "failed"] };
const findings = (heading: string): Section => ({
	heading,
	hint: "one item per finding: `path:line` — issue, evidence, suggested direction",
	item: { pattern: /^- `[^`]+`/, example: "- `src/file.ts:42` — <issue>" },
	none: true,
});

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
			{ heading: "Context", hint: "user goal, files to read first, patterns to mirror" },
			{ heading: "Scope", hint: "owned paths and explicit non-scope" },
			{ heading: "Constraints", hint: "rules, limits, forbidden actions" },
			{ heading: "Done when", hint: "deliverable, success criteria, checks to run" },
		],
	},
	worker: {
		preamble: [],
		sections: [
			status,
			{ heading: "Objective", hint: "the briefed objective in one line" },
			{ heading: "Current state", hint: "what now exists, including changed files" },
			{ heading: "Key decisions", hint: "choices made and why, or None." },
			{
				heading: "Verified by",
				hint: "each check with its exit code and an optional note, or Not run: <reason>",
				item: { pattern: /^- (`[^`]+` (→|->) exit \d+(?: .+)?|Not run: \S.*)$/, example: "- `<command>` → exit 0" },
			},
			{ heading: "Next steps", hint: "what the parent should do next, or None." },
			{ heading: "Do not", hint: "actions the parent or next agent must avoid, or None." },
		],
	},
	explorer: {
		preamble: [],
		sections: [
			status,
			{ heading: "Answer", hint: "the concise answer to the brief's question" },
			{ heading: "Relevant paths", hint: "absolute paths with line numbers where useful" },
			{ heading: "Uncertainty", hint: "real uncertainty or blockers, or None." },
		],
	},
	requirements: {
		preamble: [],
		sections: [
			status,
			{ heading: "Summary", hint: "one paragraph: in scope and out of scope" },
			{ heading: "User stories", hint: "prioritized P0/P1/P2, or None." },
			{ heading: "Acceptance criteria", hint: "testable happy and failure behavior" },
			{ heading: "Edge cases and constraints", hint: "concerns that actually apply, or None." },
			{ heading: "Open questions", hint: "only answers that change scope or behavior, or None." },
			{ heading: "Phases", hint: "MVP and dependencies for non-trivial requests, or None." },
		],
	},
	review: {
		preamble: [],
		sections: [
			status,
			{ heading: "Verdict", hint: "APPROVE | APPROVE WITH CHANGES | REJECT", oneOf: ["APPROVE", "APPROVE WITH CHANGES", "REJECT"] },
			{ heading: "Scope", hint: "exact paths, module, or diff range reviewed" },
			findings("Critical (P0)"),
			findings("Important (P1)"),
			findings("Nice-to-have (P2)"),
			{ heading: "Positive practices", hint: "one to three concrete decisions done well, or None." },
			{ heading: "Out of scope", hint: "follow-ups outside the requested review, or None." },
		],
	},
	reviewLight: {
		preamble: [],
		sections: [
			status,
			{
				heading: "Findings",
				hint: "one item per finding: P0|P1|P2 `path:line` — issue",
				item: { pattern: /^- (P0|P1|P2) `[^`]+` (—|-) \S/, example: "- P1 `src/file.ts:42` — <issue>" },
				none: true,
			},
		],
	},
} as const satisfies Record<string, Schema>;

export type SchemaId = keyof typeof SCHEMAS;

/** Documents validated on every agent write or edit (repo-relative POSIX paths). */
export const DOCUMENTS: readonly { readonly schema: SchemaId; readonly path: RegExp; readonly createOnly: boolean }[] = [
	{ schema: "plan", path: new RegExp(`^\\.harness/plans/${DATE}-${SLUG}\\.md$`), createOnly: false },
	{
		schema: "handoff",
		path: new RegExp(`^\\.harness/handoffs/\\d{4}/\\d{2}/\\d{2}/${SESSION_ID}-${SLUG}\\.md$`),
		createOnly: true,
	},
];

/** Paths agents may never write or edit directly. */
export const PROTECTED: readonly { readonly path: RegExp; readonly reason: string }[] = [
	{
		path: /^\.harness\/\d{4}\/\d{2}\/\d{2}\.md$/,
		reason: "Daily work logs are append-only: use the native work_log tool.",
	},
	{ path: /^\.opencode\//, reason: "Legacy .opencode records are read-only." },
];

/** Final-message schema per subagent; unlisted agents use DEFAULT_OUTPUT; null means no message schema. */
export const AGENT_OUTPUT: Readonly<Record<string, SchemaId | null>> = {
	"code-explorer": "explorer",
	"requirements-clarifier": "requirements",
	"code-reviewer": "review",
	"code-reviewer-light": "reviewLight",
	"handoff-writer": null,
};
export const DEFAULT_OUTPUT: SchemaId = "worker";
