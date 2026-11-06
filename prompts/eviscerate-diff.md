---
description: Review the stable task-owned change through independent selected lanes
argument-hint: "[slice map]"
---
Review `${@:-the current changes}` as tech lead.

## Select coverage

Use the `tech-lead.md` matrix to select coverage by risk, not size.
Preserve explicit review scope.
Record the candidate, prerequisites, lanes, and reasons for optional or skipped coverage.
Use the `tech-lead.md` matrix for correctness seat counts and the approved single-seat trial.
Pair `code-reviewer` with `code-reviewer-sonnet` for ordinary risks.
For difficult risks, pair `code-reviewer-sol` with `code-reviewer-opus`.
Keep configured models and effort.
Select structural review or deslop only for distinct named risks.

At Focused, assign one read-only `live-verifier` success and attack observations.
At Full, assign separate success and attack workers.
Give the success observer one applicable broad integration run.
Require attack inputs reachable through a real interface.
For applicable live risks, check boundaries, retries, cancellation, and negative effects.

## Freeze and dispatch

Reuse supplied Git evidence for unchanged targets.
Refresh missing or changed evidence with `inspect_change`.
Use `{}` for worktree changes or explicit `base` and `head` for commits.
Use `"direct"` for endpoints or `"merge-base"` for divergence.
Treat omissions and empty packets as incomplete evidence.
For pre-existing changes, supply `Review range: HEAD`, `Review range: <base>..<head>`, or `Review range: <base>...<head>`.

Reconcile task-owned jobs before freezing.
Protect source and dependencies or supply immutable copies.
Use the shared reviewer registry for metadata, hashes, and paths.
Give counterparts identical briefs and frozen metadata.
Include `agents/code-reviewer.md` and the selected lens in Read first.
Include `agents/live-verifier.md`, `skills/live-verification/SKILL.md`, expected effects, and permitted resources in live briefs.
Route authorized tooling creation through `build-live-verification`.
Launch independent ready lanes together.

## Adjudicate and close

Join selected results before adjudication.
Treat missing, failed, or stale results as incomplete coverage.
Require each finding's realistic trigger and producer.
Require scope within Done means and Keep.
Fix qualifying P0 and P1 findings.
Fix P2 only when small and local.
Dismiss everything else with a one-line reason or record an outside-ticket follow-up.
Add regression tests only for accepted findings.
Before behavioral fixes, reproduce the exact triggering input and state with an intended assertion failure.
For nonbehavior findings, use passing characterization or a direct check.
After fixes, refresh affected checks, reviewer pairs, and live proof.
Start a fresh reviewer session for each changed-source delta.
Review the fix delta and affected contracts instead of the whole panel.
Require current selected clearance on the final candidate.
Record each lane's findings, severity, disposition, and evidence in the ticket's work log to inform later downgrades.
Distinguish zero findings from skipped or missing coverage.
Stop when Done means is true, Keep holds, and the tier's pass is clear.
