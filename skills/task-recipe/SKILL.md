---
name: task-recipe
description: Prepare and execute task recipes for bug fixes, features, refactors, investigations, reviews, and harness changes. Use when the tech-lead router selects a work recipe.
---

# Task recipes

The tech-lead router remains the sole authority for choosing and routing work. Recipes are optional; use [the recipe cards](references/recipes.md) when their steps help. The investigation card links to its existing specialist procedure; do not duplicate or replace it.

Use the tier matrix in `tech-lead.md` for selection and required coverage; this skill does not set another tier menu. Do not represent skipped work as completed.

The tech-lead router owns scheduling, resumption and continuation. This skill owns card selection only. Before preparation, reconcile the governing plan, work log, branch, state, evidence and completed work; reuse valid evidence and resolve material uncertainties. At the pass, use the matrix in `tech-lead.md` and [the adversarial review procedure](../../prompts/eviscerate-diff.md). Keep focused checks during iteration. Preserve unrelated work and make final claims about the final candidate.

## Task effort

Select the smallest justified effort once before a worker launch and include a short rationale in its existing brief. A ticket's tier or a role title does not determine every subtask's effort. Every role accepts model and thinking overrides within the chosen model's supported levels. Do not substitute a model without saying so. Review and design profiles retain their explicitly pinned effort.

| Effort | Actual delegated work |
|---|---|
| `off` | Execution-only. Supply independent expected behavior, exact triggers, reproduction steps, log lines, error lines, owned paths, an established pattern, and exact checks. No diagnosis, contract choice or unresolved failure-path design. |
| `low` | One bounded local uncertainty or simple pattern adaptation; the contract is settled. |
| `medium` | Test design, ordinary implementation or diagnosis, including selecting meaningful cases. |
| `high` | Subtle concurrency or multi-process behavior; state, trust, or security design; an unresolved causal mechanism; or consequential assertions. |

Use `off` only where the chosen model supports it. A model without that level is explicit, not permission to silently drop a requested level or escalate models. A worker reports the concrete missing fact; the parent reclassifies that subtask rather than blindly retrying at higher effort. If the parent can perform an exact tiny action faster, do it directly.

## Cards

- [Bug fix](references/recipes.md#bug-fix)
- [Feature](references/recipes.md#feature)
- [Refactor](references/recipes.md#refactor)
- [Investigation](references/recipes.md#investigation)
- [Review](../../prompts/eviscerate-diff.md)
- [Harness change](references/recipes.md#harness-change)
