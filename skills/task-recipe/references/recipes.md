# Task recipe cards

Copy selected card steps verbatim into Focused/Full live tasks; retain inapplicable steps as `skipped: <reason>`. Direct work needs no recipe/task-copy ceremony. The canonical tier matrix in `AGENTS.md` selects coverage. A staged [Haiku/low advisory](../../deslop/SKILL.md) is risk-selected; oversized patches are skipped, and timeouts are incomplete (`deslop: timed out`). Never treat worktree review as staged review.

## Bug fix

1. Identify the observable failure, affected callers, and expected behavior; establish the exact trigger and a meaningful failure-path case.
2. Reproduce the defect with an assertion that fails for the intended reason; for an accepted behavioral review finding, use the reviewer's exact triggering input/state before its fix. Then fix the shared root cause and retain the regression. Structural/docs/deslop findings without changed behavior use green characterization or a direct check, not a manufactured red.
3. Run focused checks while iterating; at the pass, verify the changed behavior and relevant failure cases on its real surface.
4. **Done:** the regression fails on the original defect, passes with the fix, relevant checks pass, and no affected caller is left incompatible.

## Feature

1. State the user-visible contract, trust boundary, and success and failure outcomes before editing.
2. Identify callers and existing patterns; test the expected behavior before implementation, then implement the smallest complete change.
3. Run focused checks while iterating; at the pass, verify the real interface, failure paths and resulting effects.
4. **Done:** promised behavior and meaningful failure paths are covered, checks pass, and persisted or external effects match the contract.

## Refactor

1. Map the owned paths, callers, and behavior to preserve; characterize existing behavior with passing tests rather than inventing a failing test.
2. Refactor without changing the contract, and keep error handling, validation, accessibility, and state protections intact.
3. Run focused checks while iterating; at the pass, compare observable behavior where the changed surface warrants it.
4. **Done:** characterization and focused checks pass, callers remain compatible, and no unintended behavior change is observed.

## Investigation

1. Define the question and evidence that would distinguish plausible causes; load governing plan/log context if resuming.
2. Diagnose before proposing a patch: capture relevant live signal, discriminate the mechanism, and map it to source. Use [the spike procedure](../../../prompts/spike.md) for a bounded local proof when useful.
3. Use only owned local/test instances for temporary instrumentation; do not hotfix shared or production code without authorization.
4. **Done:** report the evidence-backed finding, exact scope and remaining unknowns; make no production change unless separately authorized.

## Review

1. Freeze the exact candidate and identify task-owned scope, callers, contracts, and available evidence.
2. Follow [the full adversarial review procedure](../../../prompts/eviscerate-diff.md); report unresolved blockers or coverage gaps.
3. **Done:** complete selected review, integration and live clearance cover the final candidate; selected lanes/checks are accounted for and findings are fixed or dismissed with evidence and reason in the pass summary. Otherwise report the explicit prerequisite, authorization or tooling blocker.

## Harness change

1. Name the behavior the harness must prove, its exact invocation, independent expected outcome, and a plausible broken condition it must reject.
2. Reuse the existing runtime, runner, evidence format, and owned disposable state. Preserve source and input identity; do not add infrastructure without a demonstrated need.
3. Test the rejection condition and run focused checks; at the pass, execute the documented workflow through the real consumer and inspect its effects and evidence.
4. For lifecycle commands, retries, or migrations, check one representative safe rerun or interruption and reconcile only owned state.
5. **Done:** the real workflow passes, the broken condition is rejected, evidence remains inspectable, and owned resources are safely cleaned up; state any unverified prerequisite.
