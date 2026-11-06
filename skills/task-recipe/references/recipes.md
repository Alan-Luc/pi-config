# Task recipe cards

For Direct work, skip recipe selection. Use the canonical tier matrix in `tech-lead.md` to select coverage.

If risk warrants it, use the staged [Haiku advisory at low effort](../../deslop/SKILL.md). Skip oversized patches. Report timeouts as incomplete with `deslop: timed out`. Review worktree changes separately from staged changes.

## Bug fix

1. Define the failure. ✓ State the expected behavior, callers, exact trigger, and a meaningful failure case.
2. Reproduce before fixing. ✓ Confirm that an assertion fails for the intended reason. For accepted behavioral findings, use the reviewer's exact triggering input and state. For findings without behavior changes, use passing characterization or a direct check instead of manufacturing a failure.
3. Fix the shared root cause. ✓ Confirm that the retained regression passes and callers remain compatible.
4. Verify the change. ✓ Run focused checks during iteration. Verify behavior and failure cases through the real interface.

**Done means:** The defect is fixed without caller regressions.

## Feature

1. Define the contract before editing. ✓ State user-visible success and failure outcomes. Identify trust boundaries.
2. Test behavior before implementation. ✓ Identify callers and existing patterns. Write tests that express the contract.
3. Implement the smallest complete change. ✓ Confirm that promised behavior and meaningful failure paths match the contract.
4. Verify the change. ✓ Run focused checks during iteration. Check the real interface and failure paths. Confirm that persisted or external effects match the contract.

**Done means:** The contract holds, including failure paths and effects.

## Refactor

1. Map existing behavior. ✓ Identify owned paths, callers, and the preserved contract.
2. Characterize behavior. ✓ Confirm that tests pass before refactoring. Use characterization instead of inventing a failing test.
3. Refactor. ✓ Preserve the contract, error handling, validation, accessibility, and state protections.
4. Verify the refactor. ✓ Run characterization and focused checks during iteration. If warranted, compare observable behavior.

**Done means:** Behavior and caller compatibility remain unchanged.

## Investigation

1. Define the question. ✓ Use evidence to distinguish plausible causes. If resuming work, read the governing plan and work log.
2. Diagnose before proposing a patch. ✓ Use live observations to identify the mechanism and its source. If bounded local proof helps, follow [the spike procedure](../../../prompts/spike.md).
3. Limit temporary instrumentation to owned local or test instances. ✓ Before applying shared or production hotfixes, obtain authorization.

**Done means:** The report states findings supported by evidence, exact scope, and unknowns. Production changes require separate authorization.

## Review

1. Freeze the exact candidate. ✓ Identify the scope owned by this ticket, callers, contracts, and evidence.
2. Follow [the full adversarial review procedure](../../../prompts/eviscerate-diff.md). ✓ Report unresolved prerequisites, authorization or tooling blockers, and coverage gaps.

**Done means:** Complete selected review, integration, and live clearance cover the final candidate. Account for each lane and check. In the pass summary, record fixes or dismissals with evidence and a reason.

## Harness change

1. Define the workflow. ✓ State the exact invocation, independent expected outcome, and a plausible broken condition. For instruction changes, follow [Writing rules](../../../AGENTS.md#writing-rules).
2. Reuse the runtime, runner, evidence format, and owned disposable state. ✓ Preserve source and input identities. Justify new infrastructure with demonstrated need.
3. Test rejection. ✓ Confirm that the broken condition is rejected and focused checks pass.
4. Execute the documented workflow through the real consumer. ✓ Compare observed effects and evidence with expectations.
5. For lifecycle commands, retries, or migrations, check a representative safe rerun or interruption. ✓ Reconcile only owned state.

**Done means:** The workflow passes, evidence is inspectable, and owned resources are safely cleaned up. State unverified prerequisites explicitly.
