# Task recipe cards

Copy selected card steps verbatim into Focused/Full live tasks; retain inapplicable steps as `skipped: <reason>`. Direct work needs no recipe/task-copy ceremony. The canonical tier matrix in `tech-lead.md` selects coverage. A staged [Haiku/low advisory](../../deslop/SKILL.md) is risk-selected; oversized patches are skipped, and timeouts are incomplete (`deslop: timed out`). Never treat worktree review as staged review.

## Bug fix

1. Define the failure. ✓ Expected behavior, affected callers, the exact trigger and a meaningful failure case are explicit.
2. Reproduce the defect before fixing it. ✓ An assertion fails for the intended reason. Behavioral review findings use the reviewer's exact triggering input/state. Findings without behavior changes use green characterization or a direct check, not manufactured red.
3. Fix the shared root cause. ✓ The regression remains and passes; affected callers remain compatible.
4. Verify the change. ✓ Focused checks pass during iteration; real-surface behavior and relevant failure cases pass at the pass.

**Done means:** the regression fails before the fix and passes after it; checks pass and callers remain compatible.

## Feature

1. Define the user-visible contract before editing. ✓ Trust boundaries and expected success and failure outcomes are explicit.
2. Test expected behavior before implementation. ✓ Affected callers and existing patterns are known; tests express the contract.
3. Implement the smallest complete change. ✓ Promised behavior and meaningful failure paths match the contract.
4. Verify the change. ✓ Focused checks pass during iteration; the real interface, failure paths and persisted or external effects match the contract at the pass.

**Done means:** behavior, failure paths and effects match the contract; checks pass.

## Refactor

1. Map existing behavior. ✓ Owned paths, callers and the contract to preserve are explicit.
2. Characterize existing behavior. ✓ Tests pass before the refactor; no failing test is invented.
3. Refactor without changing the contract. ✓ Error handling, validation, accessibility and state protections remain intact.
4. Verify the refactor. ✓ Characterization and focused checks pass during iteration; observable behavior is compared at the pass where warranted.

**Done means:** checks pass, callers remain compatible and no unintended behavior change is observed.

## Investigation

1. Define the question. ✓ Evidence can distinguish plausible causes; resumed work uses governing plan/log context.
2. Diagnose before proposing a patch. ✓ Live signal distinguishes the mechanism and maps it to source. Use [the spike procedure](../../../prompts/spike.md) for a bounded local proof when useful.
3. Limit temporary instrumentation to owned local/test instances. ✓ Shared or production hotfixes require authorization.

**Done means:** report the evidence-backed finding, exact scope and remaining unknowns; production changes require separate authorization.

## Review

1. Freeze the exact candidate. ✓ Task-owned scope, callers, contracts and available evidence are identified.
2. Follow [the full adversarial review procedure](../../../prompts/eviscerate-diff.md). ✓ Unresolved blockers and coverage gaps are reported.

**Done means:** complete selected review, integration and live clearance cover the final candidate. Selected lanes/checks are accounted for; findings are fixed or dismissed with evidence and reason in the pass summary. Otherwise report the explicit prerequisite, authorization or tooling blocker.

## Harness change

1. Define the expected workflow. ✓ Exact invocation, independent expected outcome and a plausible broken condition are explicit.
2. Reuse existing tools. ✓ Runtime, runner, evidence format and owned disposable state are reused; source/input identities remain pinned. New infrastructure requires demonstrated need.
3. Test the rejection condition. ✓ The plausible broken condition is rejected; focused checks pass.
4. Execute the documented workflow through the real consumer at the pass. ✓ Effects and evidence match expected outcomes.
5. Check a representative safe rerun or interruption for lifecycle commands, retries or migrations. ✓ Only owned state is reconciled.

**Done means:** the workflow passes, broken conditions are rejected, evidence remains inspectable and owned resources are safely cleaned up; unverified prerequisites are explicit.
