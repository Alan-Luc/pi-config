---
description: Review the stable task-owned change through independent selected lanes
argument-hint: "[slice map]"
---
Review `${@:-the current changes}` as tech lead. A clean review is valid; no speculative follow-ups.

## Target and coverage

Reuse supplied same-target Git evidence. Use `inspect_change` only when Git evidence is missing or inputs changed; do not repeat a recorded failure on unchanged inputs. Establish the review target: `{}` for uncommitted work; explicit `base` and `head` with comparison `"direct"` for committed endpoints or `"merge-base"` for branch divergence. An empty worktree packet does not mean there are no task changes; omissions are not absence. Use `inspect_context` only for unresolved connected ownership/contracts.

Explicit reviews of pre-existing changes add `Review range: HEAD` for current worktree changes, `Review range: <base>..<head>` for endpoints, or `Review range: <base>...<head>` for a committed branch. Normal task-owned reviews omit this line.

The canonical Direct/Focused/Full matrix in `AGENTS.md` owns ticket-close coverage; risk outranks size. Direct work uses its consuming-surface check. Explicit deep review retains its scope. Record the risk/coverage map, frozen candidate and prerequisites. Name concrete reasons for added optional lanes and selected and skipped lanes with reasons; do not recreate the matrix or inflate topology.

| Lane | Coverage |
|---|---|
| `thermonuclear-correctness-review` | Selected correctness pair, including security, integration, tests and obvious noise. |
| `live-verification-success` / `live-verification-attack` | Focused combines its success and attack observations in one read-only live worker; Full uses separate fresh worker sessions and briefs. |
| `thermonuclear-structural-review` | Risk-selected counterpart pair for a named structural risk. |
| `deslop` | Risk-selected counterpart pair for distinct cumulative noise or missing coverage, not duplicate advisory. |

Ordinary pair: `code-reviewer` + `code-reviewer-sonnet`. Difficult pair: `code-reviewer-sol` + `code-reviewer-opus`. Use persisted model/effort; no inferred overrides. Start a fresh selected reviewer-profile session per delta; never resume one for changed-source review. Capacity is eight live children, not a target worker count; reserve complete pairs and required live lanes. Launch every selected ready lane together.

Explicit `/eviscerate-diff` retains the requested independent coverage. Solo mode, a missing counterpart or unavailable live prerequisite leaves coverage incomplete, never parent-only swarm clearance. When independent live workers are not selected, the parent owns required real-interface proof.

## Freeze and dispatch

Before freezing the candidate, reconcile or kill every task-owned background job. Keep source/dependencies protected or supply immutable copies; a committed SHA alone does not freeze live reads. Source edits invalidate affected clearance.

The shared reviewer registry must drive metadata preparation and artifact/hash/path checks for every reviewer profile. Counterparts receive the same generated immutable metadata and identical briefs: intent/lens, candidate/base/head, patch/hash, allowed connected paths, contracts, evidence and completion criteria. Include canonical `agents/code-reviewer.md` and the selected lens in Read first.

Live briefs include the canonical `agents/live-verifier.md` role and `skills/live-verification/SKILL.md`, frozen candidate, independent expected actions/effects, exact checks and permitted runtime envelope. Use the existing `live-verifier` profile, not model variants. Full uses separate workers; Focused must not claim worker independence. Isolate disposable state and keep evidence separate by observation. All observers are read-only: no source/test/expectation edits. Preserve source/input/runtime identity and owned cleanup; sequence genuinely shared resources. Missing reusable tooling: route authorized tooling creation to `build-live-verification`, not the observer. Start independent tests/live checks together.

## Join, remediate, close

Join all selected results before adjudication. Join both live results for Full, both observations for Focused. Missing, failed or stale results prevent clearance; attack silence is not success proof. Keep judgments independent; adjudicate triggers/evidence, not votes. One targeted retry may recover transient/malformed dropout, never reproducible defects.

For accepted behavioral findings, use the exact triggering input/state to establish an exact-trigger failing regression before fixing it. Nonbehavior findings use passing characterization or a direct check. Rerun affected checks and refresh affected lane pairs and live proof on the new candidate. Reuse unchanged coverage; review remediation deltas plus affected contracts, and repeat autonomously until findings are fixed or explicitly dismissed with evidence.

Live success proves promised effects; attack exercises bounded failure/malicious-input/boundary/retry/cancellation cases and negative effects. Use owned local/test resources, never production/customer effects. The success worker runs the relevant broad integration recipe once against the frozen candidate; the attack worker does not duplicate that run. Recapture candidate/input identity and collect exact verification receipts; tests and live effects do not replace each other.

Stop only when the final candidate has complete selected review, integration and live clearance, or a concrete authorization/prerequisite/tooling gap requires input. Do not stop at findings or request another continue. Reassess repeated failed premises; never weaken safety, useful errors, accessibility or cleanup. After the final commit, inspect the complete task-base-to-HEAD patch; do not independently rereview an unchanged patch.

Report each lane/profile/candidate/disposition/findings and actual evidence/gaps. Clean completed lanes may report zero; skipped/missing is not zero. List dismissed material findings with evidence-based reasons in the pass summary, not a separate artifact.
