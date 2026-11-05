---
description: Review the stable task-owned change through independent selected lanes
argument-hint: "[slice map]"
---
Review `${@:-the current changes}` as tech lead.

## Select coverage

Use the `tech-lead.md` matrix to select coverage by risk, not size.
Preserve explicit review scope to prevent silent coverage cuts.
Record the candidate, prerequisites, lanes, and reasons for optional or skipped coverage to make selection inspectable.
For routine Focused correctness, retain one reviewer to match existing coverage.
For explicit Direct review, retain a pair to preserve requested independent coverage.
For explicit Focused review, retain a pair unless Alan approves the single-seat trial to protect existing defaults.
For that trial, select a different model family than the builder to preserve independent judgment.
Use pairs at Full to retain independent challenge.
Pair `code-reviewer` with `code-reviewer-sonnet` for ordinary risks.
For difficult risks, pair `code-reviewer-sol` with `code-reviewer-opus` to use persisted profiles.
Keep configured models and effort to prevent unapproved substitutions.
Select structural review or deslop only for distinct named risks to prevent duplicate review.

At Focused, assign one read-only `live-verifier` success and attack observations to reduce coordination.
At Full, assign separate success and attack workers to preserve independence.
Give the success observer one applicable broad integration run to prevent duplicate runs.
Require attack inputs reachable through a real interface to exclude invented threats.
For applicable live risks, check boundaries, retries, cancellation, and negative effects to preserve failure coverage.

## Freeze and dispatch

Reuse supplied Git evidence for unchanged targets to prevent repeated discovery.
Refresh missing or changed evidence with `inspect_change` to preserve provenance.
Use `{}` for worktree changes or explicit `base` and `head` for commits to select the target.
Use `"direct"` for endpoints or `"merge-base"` for divergence to select the comparison.
Treat omissions and empty packets as incomplete evidence to prevent overlooking changes.
For pre-existing changes, supply `Review range: HEAD`, `Review range: <base>..<head>`, or `Review range: <base>...<head>` to match the target.

Reconcile task-owned jobs before freezing to prevent hidden mutations.
Protect source and dependencies or supply immutable copies to keep reads stable.
Use the shared reviewer registry for metadata, hashes, and paths to cover every profile.
Give counterparts identical briefs and frozen metadata to make judgments comparable.
Include `agents/code-reviewer.md` and the selected lens in Read first to load review restrictions.
Include `agents/live-verifier.md`, `skills/live-verification/SKILL.md`, expected effects, and permitted resources in live briefs to bound execution.
Route authorized tooling creation through `build-live-verification` to keep observers read-only.
Launch independent ready lanes together to prevent unnecessary waits.

## Adjudicate and close

Join selected results before adjudication to preserve independent judgments.
Treat missing, failed, or stale results as incomplete coverage to prevent false clearance.
Require each finding's realistic trigger and producer to exclude hypothetical failures.
Require scope within Done means and Keep to prevent unrelated remediation.
Fix qualifying P0 and P1 findings; fix P2 only when small and local to bound cleanup.
Dismiss everything else with a one-line reason or record an outside-ticket follow-up to preserve disposition.
Add regression tests only for accepted findings to exclude rejected premises.
Before behavioral fixes, reproduce the exact triggering input and state with an intended assertion failure to prove the defect.
For nonbehavior findings, use passing characterization or a direct check to prevent artificial failures.
After fixes, refresh affected checks, reviewer pairs, and live proof to preserve current clearance.
Start a fresh reviewer session for each changed-source delta to preserve independent judgment.
Review the fix delta and affected contracts instead of the whole panel to bound remediation.
Require current selected clearance on the final candidate to prevent stale completion.
Record each lane's findings, severity, disposition, and evidence in the ticket's work log to inform later downgrades.
Distinguish zero findings from skipped or missing coverage to keep that record useful.
Stop when Done means is true, Keep holds, and the tier's pass is clear to prevent extra work.
