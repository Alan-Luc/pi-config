---
name: durable-plan
description: Create or resume durable plans while preserving governing decisions and legacy plan history.
---

# Durable plans

Use the [tech-lead matrix](../../extensions/tech-lead/tech-lead.md) for tiers, approval gates, and pass coverage.
Require a plan for Full work or explicit planning.
Require a plan for approval-gated Focused work or an existing governing plan.
When an existing plan governs, resume it instead of creating another.
For approval-gated Direct work, state bounded scope and checks unless Alan requests a plan.

Use `.harness/plans/YYYY-MM-DD-<short-slug>.md` for plans and `work_log` for dated execution records.
Keep filenames flat, lowercase, and stable.
Keep historical `.opencode` records read-only.

## Resolve context

For ticket-shaped implementation, read the governing plans and relevant dated logs before questions, edits, or delegation.

Read the named or active plan completely before edits or delegation.
Load relevant decisions and dated-log milestones before repeating investigation.
Surface conflicts affecting behavior, scope, authority, or verification.
If context is incomplete, inspect `.harness/plans/` for the governing topic.
Use the sole `in_progress` plan, otherwise the sole `ready` plan.
Ask when multiple candidates remain; do not overwrite an unrelated plan.
For Direct mechanical actions without a plan trigger, run the consuming-surface check without planning artifacts.

## Plan format

Start new plans with:

```markdown
# <Plan title>
Status: draft | ready | in_progress | blocked | complete
Updated: YYYY-MM-DD
```

Use these sections in order:

- **Goal:** Explain desired behavior, current context, scope, and non-scope.
- **Done means and Keep:** State observable acceptance, preserved guarantees, and meaningful success and failure cases.
- **Decisions:** Record current choices and rationale; point to the canonical work log for material history and progress.
- **Slices with checks:** Name ordered outcomes, ownership, dependencies, and runnable checks. Use exact paths or bounded discovery targets.
- **Open questions:** State blockers and risks, or `None.`. Mark the plan blocked when an answer changes its contract.

Keep existing nine-section plans in their original format.
Preserve their append-only Decision log and existing resume references.
Do not convert formats during edits or rewrite historical decisions.
The parser enforces document structure, not completeness of external work-log history.

## Plan and execute

Define observable acceptance before proposals or production edits.
Identify callers, contracts, trust boundaries, failure paths, and verification prerequisites.
Follow [common implementation and test-first rules](../../AGENTS.md#implementation).
Inspect only enough source to establish safe ownership and checks.
Compare independent architecture proposals only when Alan requests them.

During planning, edit only the designated plan.
Present goals, scope, decisions, slices, checks, and questions; await requested approval before implementation.
When Alan requests execution of a ready plan, proceed without replanning.
Record approval and material contract changes through `work_log` with rationale and impact.
Keep the plan's status, decisions, and log pointer current without copying the ledger.

Give workers readable governing artifacts, functional requirements, hard constraints, exact owned paths, dependencies, and checks.
The parent owns shared contracts and integration.
Check shared contracts before launching dependent disjoint writers.
Written briefs do not isolate files.

Mark completion only when Done means and Keep hold and the selected pass clears the final candidate.
Leave an exact next step on interruption.
Create a handoff only for remaining human actions.
A plan grants no additional installation, destructive-operation, or separately owned package authority.
