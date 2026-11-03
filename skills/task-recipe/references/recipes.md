# Task recipe cards

Copy selected card steps verbatim into Focused/Full live tasks; retain inapplicable steps as `skipped: <reason>`. Direct work needs no recipe/task-copy ceremony. The canonical tier matrix in `tech-lead.md` selects coverage. A staged [Haiku/low advisory](../../deslop/SKILL.md) is risk-selected; oversized patches are skipped, and timeouts are incomplete (`deslop: timed out`). Never treat worktree review as staged review.

## Bug fix

1. Define the failure. ✓ Expected behavior, callers, exact trigger and a meaningful failure case are explicit.
2. Reproduce before fixing. ✓ An assertion fails for the intended reason; behavioral findings use the reviewer's exact triggering input/state. Findings without behavior changes use green characterization or a direct check, never manufactured red.
3. Fix the shared root cause. ✓ The retained regression passes; callers remain compatible.
4. Verify the change. ✓ Focused checks pass during iteration; real-surface behavior and failure cases pass at the pass.

**Done means:** the defect is fixed without caller regressions.

## Feature

1. Define the contract before editing. ✓ User-visible success and failure outcomes and trust boundaries are explicit.
2. Test behavior before implementation. ✓ Callers and existing patterns are known; tests express the contract.
3. Implement the smallest complete change. ✓ Promised behavior and meaningful failure paths match the contract.
4. Verify the change. ✓ Focused checks pass during iteration; real interface, failure paths and persisted or external effects match the contract at the pass.

**Done means:** the contract holds, including failure paths and effects.

## Refactor

1. Map existing behavior. ✓ Owned paths, callers and the preserved contract are explicit.
2. Characterize behavior. ✓ Tests pass before refactoring; no failing test is invented.
3. Refactor. ✓ Contract, error handling, validation, accessibility and state protections remain unchanged.
4. Verify the refactor. ✓ Characterization and focused checks pass during iteration; observable behavior is compared at the pass where warranted.

**Done means:** behavior and caller compatibility remain unchanged.

## Investigation

1. Define the question. ✓ Evidence distinguishes plausible causes; resumed work uses governing plan/log context.
2. Diagnose before proposing a patch. ✓ Live signal identifies the mechanism and its source. Use [the spike procedure](../../../prompts/spike.md) for bounded local proof when useful.
3. Limit temporary instrumentation to owned local/test instances. ✓ Shared or production hotfixes require authorization.

**Done means:** report evidence-backed findings, exact scope and unknowns; production changes require separate authorization.

## Review

1. Freeze the exact candidate. ✓ Task-owned scope, callers, contracts and evidence are identified.
2. Follow [the full adversarial review procedure](../../../prompts/eviscerate-diff.md). ✓ Unresolved prerequisite, authorization or tooling blockers and coverage gaps are reported.

**Done means:** complete selected review, integration and live clearance cover the final candidate. Lanes/checks are accounted for; findings are fixed or dismissed with evidence and reason in the pass summary.

## Harness change

1. Define the workflow. ✓ Exact invocation, independent expected outcome and a plausible broken condition are explicit.
2. Reuse runtime, runner, evidence format and owned disposable state. ✓ Source/input identities are preserved; new infrastructure has demonstrated need.
3. Test rejection. ✓ The broken condition is rejected; focused checks pass.
4. Execute the documented workflow through the real consumer at the pass. ✓ Observed effects and evidence match expectations.
5. Check a representative safe rerun or interruption for lifecycle commands, retries or migrations. ✓ Only owned state is reconciled.

**Done means:** the workflow passes; evidence is inspectable, owned resources are safely cleaned up and unverified prerequisites are explicit.
