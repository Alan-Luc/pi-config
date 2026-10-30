---
name: task-recipe
description: Prepare and execute task recipes for bug fixes, features, refactors, investigations, reviews, and harness changes. Use when the tech-lead router selects a work recipe.
---

# Task recipes

The tech-lead router remains the sole authority for choosing and routing work. Read [the recipe cards](references/recipes.md), select the best fit, and use its steps. Investigation and review cards link to their existing specialist procedures; do not duplicate or replace them.

Use the tier matrix in `AGENTS.md` for selection and required coverage; this skill owns recipe selection and copy semantics, not another tier menu. For Focused and Full work, copy the selected card's steps verbatim into live tasks. Keep every step; if it does not apply, preserve it as `skipped: <reason>`. Direct work is exempt from recipe and task-copy ceremony, whether or not it is committed. Do not represent skipped work as completed.

The tech-lead router owns scheduling, resumption and continuation. This skill owns card selection and copy semantics only. Before preparation, reconcile the governing plan, work log, branch, state, evidence and completed work; reuse valid evidence and resolve material uncertainties. At the pass, use the matrix in `AGENTS.md` and [the adversarial review procedure](../../prompts/eviscerate-diff.md). Keep focused checks during iteration; broad integration and live proof belong at the pass. Preserve unrelated work and make final claims about the final candidate.


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
