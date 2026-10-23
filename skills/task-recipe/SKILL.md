---
name: task-recipe
description: Prepare and execute task recipes for bug fixes, features, refactors, investigations, reviews, and harness changes. Use when the tech-lead router selects a work recipe.
---

# Task recipes

The tech-lead router remains the sole authority for choosing and routing work. Read [the recipe cards](references/recipes.md), select the best fit, and use its steps. Investigation and review cards link to their existing specialist procedures; do not duplicate or replace them.

For non-Direct work, copy the selected card's steps verbatim into live tasks. Keep every step; if it does not apply, preserve it as `skipped: <reason>`. Direct work is exempt from recipe and task-copy ceremony, whether or not it is committed. Do not represent skipped work as completed.

During preparation, reconcile the governing plan and work log, current branch and working state, receipts, and already completed work. For resumed work, reuse valid evidence and resolve only material uncertainties; a prior self-report is not proof. Derive the useful ready set across the remaining approved slices, including independent read-only discovery or test preparation. Start all unblocked, disjoint work together using existing tool-owned delegation guidance, then yield while it runs. Implementation order does not block independent preparation. Defer only for a named dependency, shared-state/write conflict, capacity limit, or lack of a useful independent outcome. Do not create a scheduler or require scouts.

After answering a steering or status question, reconcile live tasks and pending child/check results, then execute or launch the next unblocked approved action in the same turn. Do not wait for another continue instruction. Yield only for an active async result, a concrete prerequisite/decision/authorization gate, or an explicit stop. Child results and review findings are intermediate events, not task completion. Questions do not cancel independent work; planning/read-only and approval boundaries still apply.

Before concurrent work, identify shared mutable state such as checkout, index, branch, runtime, or fixtures. Prefer separate owned state where practical; sequence genuine shared writes. Instructions are not a lock. For rerunnable lifecycle actions, retries, and migrations, consider what a rerun or interruption leaves behind; reconcile observed owned state without renewing authorization.

At the pass, follow [the adversarial review procedure](../../prompts/eviscerate-diff.md) for required review, broad integration and live proof, including relevant failure cases. Focused checks belong during iteration; full integration and live verification belong at the pass, not after each commit. Commit only passing checked inputs and preserve unrelated dirty work; final claims must match the final candidate.

Effort selection is not active merely because a task recipe mentions it. Use the task-effort table only after package enforcement is implemented and its loaded definitions are verified; otherwise retain the currently loaded role defaults. Never infer that off/low routing is active.

## Task effort

Select the smallest justified effort once before a worker launch and include a short rationale in its existing brief. A ticket's tier or a role title does not determine every subtask's effort. Only an opted-in role's `thinking-overrides` and the locked model's supported levels permit a selection; never substitute a model. Review/design profiles retain their explicitly pinned effort.

| Effort | Actual delegated work |
|---|---|
| `off` | Execution-only: independent expected behavior, exact trigger/repro/log/error lines, owned paths, established pattern and exact checks are supplied. No diagnosis, contract choice or unresolved failure-path design. |
| `low` | One bounded local uncertainty or simple pattern adaptation; the contract is settled. |
| `medium` | Test design, ordinary implementation or diagnosis, including selecting meaningful cases. |
| `high` | Subtle concurrency/multi-process behavior, state/trust/security design, an unresolved causal mechanism or consequential assertions. |

Use `off` only where supported. Missing opt-in/support or contradictory evidence is explicit, not permission to silently drop a requested level or escalate models. A worker reports the concrete missing fact; the parent reclassifies that subtask rather than blindly retrying at higher effort. If the parent can perform an exact tiny action faster, do it directly.

## Cards

- [Bug fix](references/recipes.md#bug-fix)
- [Feature](references/recipes.md#feature)
- [Refactor](references/recipes.md#refactor)
- [Investigation](references/recipes.md#investigation)
- [Review](references/recipes.md#review)
- [Harness change](references/recipes.md#harness-change)
