---
description: Review the stable task-owned change through independent selected lanes
argument-hint: "[slice map]"
---
Review `${@:-the current changes}` as tech lead.

## Select coverage

Use the `tech-lead.md` matrix to select coverage by risk, not size.
Preserve explicit review scope.
Record the candidate, prerequisites, lanes, and reasons for optional or skipped coverage.
For routine Focused correctness, retain one reviewer to match existing coverage.
For explicit Direct review, retain a pair to preserve requested independent coverage.
For explicit Focused review, retain a pair unless Alan approves the single-seat trial to protect existing defaults.
For that trial, select a different model family than the builder to preserve independent judgment.
Use pairs at Full to retain independent challenge.
Pair `code-reviewer` with `code-reviewer-sonnet` for ordinary risks.
For difficult risks, pair `code-reviewer-sol` with `code-reviewer-opus`.
Keep configured models and effort.
Select structural review or deslop only for distinct named risks.

At Focused, assign one read-only `live-verifier` to verify success.
Include attack observations only when the change touches input handling or a trust boundary.
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
Dismiss P2 findings with one-line reasons or record outside-ticket follow-ups; do not fix them in-ticket.
Dismiss everything else with a one-line reason or record an outside-ticket follow-up.
Add regression tests only for accepted findings.
Before behavioral fixes, reproduce the exact triggering input and state with an intended assertion failure.
For nonbehavior findings, use passing characterization or a direct check.
Limit each fix to the accepted trigger and preserve unrelated behavior.
Before remediation review, run the regression and affected tests.
Give fresh reviewers the fix delta, affected contracts, and regression results.
After review fixes settle, refresh only affected live proof.
Reuse live proof while tested source, configuration, inputs, and runtime remain unchanged.
Require current selected clearance on the final candidate.
Record each lane's findings, severity, disposition, and evidence in the ticket's work log to inform later downgrades.
Distinguish zero findings from skipped or missing coverage.
Stop when Done means is true, Keep holds, and the tier's pass is clear.
