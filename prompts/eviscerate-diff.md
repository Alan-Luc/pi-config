---
description: Run a full adversarial review of the complete task-owned diff
argument-hint: "[slice map]"
---
Act as the tech lead and review only the stable complete task-owned change: `${@:-the current changes}`. A clean review is valid; do not dispatch speculative follow-ups.

Reuse supplied same-target Git evidence. Use `inspect_change` only when Git evidence is missing or inputs changed; do not repeat a recorded failure on unchanged inputs. Establish the review target before calling it:
- Uncommitted work: `{}` (staged, unstaged, and untracked changes).
- A commit or endpoint range, including pushed task changes: explicit `base` and `head`, with `comparison: "direct"` (the default). Last commit: `{"base":"HEAD^","head":"HEAD"}`.
- A branch's changes since divergence: `{"base":"<target-branch>","head":"<task-branch>","comparison":"merge-base"}`.

An empty worktree packet does not mean there are no task changes. Omitted content is not evidence of absence. Use `inspect_context` once only when ownership, callers, or contracts remain unclear.

For an explicit review of changes that predate the current task, add one matching line to the reviewer brief's Scope: `Review range: HEAD` for current worktree changes, `Review range: <base>..<head>` for a direct committed range, or `Review range: <base>...<head>` for a committed branch compared from its merge base. Omit it for normal task-owned reviews.

## Full review/testing stage

Use the canonical acceptance table in `AGENTS.md` to select this ticket-close stage's coverage over the complete task-owned candidate, not an unbounded repository audit. Do not recreate a heavier topology here or in another skill. Direct work uses its consuming-surface check. Explicitly requested deep review retains its requested coverage; risk outranks size.

| Selected lane | Owner and output |
|---|---|
| `thermonuclear-correctness-review` | Policy-selected reviewer seat(s): correctness, security, integration, useful tests and obvious diff noise. |
| `live-verification-success` | For Focused, one fresh `live-verifier` also records a separate attack observation; for Full, a separate success worker proves requirement-derived success paths and persisted effects on the running interface and owns the single broad integration run. |
| `live-verification-attack` | For Focused, the same worker records a distinct bounded attack observation; for Full, a separate fresh `live-verifier` tries bounded failure, malicious-input and boundary cases and verifies rejection and negative promises through actual effects. |
| `thermonuclear-structural-review` (selected by risk) | A counterpart pair for a named structural risk in ownership/public API/schema/state shapes, multi-seam design or significant complexity. |
| `deslop` (selected by risk) | A counterpart pair for distinct cumulative/cross-slice noise risk or incomplete relevant coverage; not a duplicate advisory by default. |

Before dispatch, derive and record the risk/coverage map, exact candidate and prerequisites from the canonical table. Name concrete reasons for added independent live/structural/deslop lanes and for skipping relevant optional coverage. When independent live workers are not selected, the parent owns the required real-interface proof. Select distinct lenses independently; do not substitute a lane for another.

| Selected reviewer coverage | Persisted profiles |
|---|---|
| Single seat | `code-reviewer` |
| Ordinary counterpart pair | `code-reviewer` + `code-reviewer-sonnet` |
| Difficult counterpart pair | `code-reviewer-sol` + `code-reviewer-opus` |

Use exact persisted model/effort, not inferred overrides or substitutions. Start a fresh selected reviewer-profile task for each review; never resume one for a new delta. At most eight live children total, including other work; reserve room for complete pairs and the matrix-selected live workers. Derive the actual seats from selected coverage, not a target worker count. Launch every selected ready lane together; every selected pair must be complete and every selected result must join. Explicit `/eviscerate-diff` retains the requested independent coverage, never parent-only self-review. Solo mode, missing profiles/results or unavailable live prerequisites leave coverage incomplete; report the gap rather than relabeling direct review as a swarm.

Use the canonical Direct/Focused/Full matrix in `AGENTS.md` for tier selection and lane ownership; do not reproduce a tier menu here. Focused combines its success and attack observations in one read-only live worker, while Full uses separate workers. Within each review pair provide identical briefs: intent, lens, candidate/base/head, patch/hash, exact allowed source/dependency paths, caller/test contracts, supplied evidence and done criteria. Include the absolute canonical `agents/code-reviewer.md` path and the selected lane skill's absolute path in Read first; model-only variants share that body. Each live assignment receives the canonical `agents/live-verifier.md` role, `skills/live-verification/SKILL.md`, the same frozen candidate and requirements, and exact checks, expected actions/effects and permitted runtime/state envelope. Focused puts both observations in one worker brief/session; Full uses separate fresh worker sessions and briefs. Reuse the existing persisted verifier profile; do not create model variants. Isolate disposable state and keep evidence separate by observation. Keep their judgments independent until parent synthesis; neither worker may stand in for the other. If reusable verification tooling is missing, report that blocker and route authorized tooling creation to `build-live-verification`; the observer does not author tooling.

The shared reviewer registry must drive metadata preparation and artifact/hash/path checks for every reviewer profile. All counterparts receive the same generated immutable metadata; reconcile it with the selected range and frozen source.

Before freezing the candidate, reconcile or kill every task-owned background job. Freeze one source candidate before dispatch. Reviewers are read-only. No live worker may edit source, tests or proof expectations; isolate their disposable runtime state and preflight ports, identity, credentials and owned cleanup. Sequence actions if isolated instances cannot be provided; never let one worker's mutations contaminate the other's proof. Start independent automated and live checks together where safe. A committed SHA does not freeze live reads. Keep named source/dependency paths protected or supply immutable consumable copies. Source edits invalidate affected review and verification clearance.

Join all selected results before adjudication. A missing counterpart or selected live result, failed check or stale candidate leaves the stage incomplete. Join both live results for Full and both success/attack observations for Focused; success does not cancel an attack finding and an attack's failure to find a defect does not prove the success path. Keep counterpart judgments independent until parent synthesis. Permit one targeted retry for a transient/malformed dropout; reproducible defects need remediation, not respawns until green.

## Autonomous hardening and closure

After each complete join, the parent deduplicates and adjudicates concrete triggering inputs and evidence, not votes. For each accepted behavioral finding, use the reviewer's exact triggering input/state to establish the exact-trigger failing regression before its fix; for nonbehavior findings use a passing characterization/direct check. Apply approved in-scope fixes only after the join; children never commit. Rerun affected checks and refresh affected lane pairs and live proof on the new candidate. Preserve unchanged valid coverage, review remediation deltas plus affected contracts, and repeat autonomously until every finding is fixed or explicitly dismissed with evidence and reason.

Stop only when the final candidate has complete selected review, integration and live clearance, or when a concrete patron decision, authorization, prerequisite or tooling gap requires input. Do not stop at findings, wait for another continue instruction, silently defer a blocker, or retry until green. If repeated fixes fail on the same premise, test that premise before another dependent fix. Never remove trust-boundary validation, useful errors, accessibility, cancellation or data-loss protection as cleanup.

For Full, the success worker proves requirement-derived success paths and persisted effects; the independent attack worker exercises relevant failure/boundary cases on the changed real interface, including applicable retry/cancellation/concurrency paths and negative promises. For Focused, the combined live worker covers both sets of observations without claiming worker independence. Choose concrete attack inputs only within the briefed risk and authorization envelope; the expected contract stays fixed. Use bounded authorized disposable state only; no production/customer effects or source/test/expectation edits. Reproducible runtime failures enter the same hardening loop with exact trigger, regression before behavioral fix, and fresh affected live proof. Missing safe prerequisites are explicit coverage gaps, not a clean pass.

The selected success worker, or the parent when no independent success lane is required, runs the relevant broad integration recipe once against the frozen candidate; the attack worker does not duplicate that run. Each live worker recaptures its candidate and input identity after its checks. Collect exact `verification_evidence` argv/cwd/timeout results alongside real-interface proof; neither replaces the other. After the final task commit, inspect the exact pre-task-base-to-final-HEAD patch for unintended changes; do not independently rereview an unchanged patch. Report supported P0/P1/P2 findings or a clean verdict, selected and skipped lanes with reasons, actual evidence and remaining gaps. List dismissed material findings and evidence-based reasons in the pass summary, not a separate artifact.
