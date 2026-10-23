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

Focused and Full work use this ticket-close review/testing stage over the complete task-owned candidate, not an unbounded repository audit. Direct work uses its consuming-surface check instead. Risk can require Full treatment regardless of size. Bounded checks and implementation iterations do not repeatedly invoke the full process.

| Required lane | Owner and output |
|---|---|
| `correctness-review` | One counterpart pair: correctness, security, integration and useful test/evidence findings. |
| `structural-review` | One counterpart pair: ownership, state/data modeling and concrete structural simplification. |
| `deslop` | One counterpart pair: read-only proposals for demonstrated diff-introduced noise; no cleanup edits during the stage. |
| `live-verification` | `test-automation-engineer`: relevant automated checks plus real-interface actions and observed effects. |

Before dispatch, derive the risk/coverage map, exact candidate and necessary prerequisites from existing context. All four lanes are required at this stage; risk selects their depth and model tier, not which lanes to omit. Assign cross-component interactions explicitly.

| Review tier | Persisted counterpart profiles |
|---|---|
| Focused | `code-reviewer` + `code-reviewer-sonnet` |
| Difficult | `code-reviewer-sol` + `code-reviewer-opus` |
| Consequential design proposals, outside this stage | `implementation-engineer-sol` + `implementation-engineer-opus`; planning owns selection |

Pair every review lane once: six reviewers plus one live-verification worker means seven children. Use exact persisted model/effort, not inferred overrides or substitutions. Difficulty/consequence determines tier, not labels alone. At most eight live children total, including other work; eight is capacity, not a target. Reserve room for the complete pairs and live worker before starting the stage. Launch all seven in one batch through tool-owned delegation, rather than sequencing the lanes or filling the remaining slot gratuitously.

Within each pair provide identical briefs: intent, lens, candidate/base/head, patch/hash, exact allowed source/dependency paths, caller/test contracts, supplied evidence and done criteria. Include the absolute canonical `agents/code-reviewer.md` path and the one lane skill's absolute path in Read first; model-only variants share that body. The live worker receives its canonical role, `skills/live-verification/SKILL.md`, exact checks, expected actions/effects and permitted runtime/state envelope. It may reuse `build-live-verification` only where reusable tooling creation is separately authorized. A wider connected-code scope may explicitly set a larger bounded read budget; unfinished research is not a finding.

Before freezing the candidate, reconcile or kill every task-owned background job. Freeze one source candidate before dispatch. Reviewers, including deslop, are read-only. The live worker must not edit source, tests or proof expectations; isolate disposable runtime state and preflight ports, identity, credentials and owned cleanup. Start independent automated and live checks together where safe. A committed SHA does not freeze live reads: keep every named source/dependency path protected or supply immutable consumable copies. Continue parent work only outside that protected set.

Collect every required result after all four lanes have returned. A missing counterpart, blocked live prerequisite, failed check or stale candidate leaves the stage incomplete; do not substitute unit results for live proof or silently run a smaller sequential process. Keep counterpart judgments independent until parent synthesis. Permit one targeted retry for a transient/malformed dropout; reproducible defects need remediation, not respawns until green.

The parent deduplicates and adjudicates concrete triggering inputs and evidence, not votes. Apply approved correctness/structure/deslop fixes only after the join; children never commit. Source edits invalidate affected review and verification clearance. If material fixes occur, rerun affected focused checks and start one remediation review covering only the remediation delta and affected contracts. Refresh affected lane pairs and live proof against the new candidate; do not rereview unchanged clean regions. Never remove trust-boundary validation, useful errors, accessibility, cancellation or data-loss protection as cleanup.

The shared reviewer registry must drive metadata preparation and artifact/hash/path checks for every reviewer profile. All counterparts receive the same generated immutable metadata. Reconcile generated metadata with the selected range and frozen source. Use a fresh selected reviewer-profile task for each new review; never resume one for a new delta. Solo cannot supply concurrent paired coverage and must disclose that gap.

The live lane runs the required broad integration recipe once against the frozen candidate, then recaptures it. Collect exact `verification_evidence` argv/cwd/timeout results alongside the relevant real-interface proof; neither can replace the other. After the final task commit, inspect the exact pre-task-base-to-final-HEAD patch for unintended changes, do not independently rereview an unchanged patch. Report supported P0/P1/P2 findings or a clean verdict, together with each lane's actual evidence and gaps.
