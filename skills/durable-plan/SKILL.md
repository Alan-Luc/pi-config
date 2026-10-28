---
name: durable-plan
description: Create or resume durable `.harness/plans/`, and load prior plans or decisions before ticket implementation when they may govern the work.
---

# Durable plans

The plan file is the working memory and handoff contract. Chat is not the source of truth. Canonical project artifacts live under `.harness/`: plans under `.harness/plans/`, dated topic records under `.harness/YYYY/MM/DD/<plan-or-feature-key>.md`, and handoffs under `.harness/handoffs/YYYY/MM/DD/<session-id>-<task-slug>.md`. Runtime Pi sessions remain under `~/.pi/agent/sessions`.

Use the canonical Direct/Focused/Full acceptance matrix in `AGENTS.md`; do not recreate it here. Focused work uses recipes/tasks without a new plan unless explicitly planned, approval-gated, or governed by a prior plan. Full always requires a plan; explicit planning and approval-gated Focused work require one. Approval-gated Direct work uses a bounded scope/checks brief unless explicit planning is requested.

Unless Alan explicitly requests planning, Direct work is exempt: do not create or load a plan, task list, work log, review, handoff, or report for an exact mechanical action and its direct consuming-surface check. Inherited approval triggers and blockers still bind; use the bounded brief required by `AGENTS.md` when a Direct task is gated.

Canonical discovery uses `.harness` only. Historical `.opencode` records remain read-only; do not migrate, rewrite or delete them as routine task preparation.

## Ticket context preflight

For ticket-shaped implementation, even when the user did not request planning:

1. Extract the ticket and dependency IDs.
2. Search `.harness/plans/` and relevant dated topic logs under `.harness/YYYY/MM/DD/` for those IDs; old daily files remain readable. Keep discovery bounded to the governing topic.
3. Read matching plans, decision entries, and dated-log milestones before questions, edits, or repeated reconnaissance.
4. Tell the user which artifacts govern the work and surface implementation-relevant conflicts.

This preflight supplies context; it does not by itself create a plan or add an approval gate.

## Resolve the plan

Use, in order:

1. The exact path supplied by the user or named in the current Pi session.
2. The active plan path already named in the session.
3. If context is incomplete, inspect `.harness/plans/*.md`. Use the only plan marked `in_progress`; if none is in progress, use the only `ready` plan. Ask when multiple candidates remain.
4. When authoring outside a planning workflow with no existing path, create `.harness/plans/YYYY-MM-DD-<short-slug>.md`.

Never overwrite an unrelated plan. Keep filenames flat, lowercase, and stable after creation.

## Required document

Start every plan with:

```markdown
# <Plan title>
Status: draft | ready | in_progress | blocked | complete
Updated: YYYY-MM-DD
```

Then include enough concrete detail for an agent with no chat history:

- **Goal and context** — desired behavior, current state, and useful example or data flow.
- **Requirements and acceptance** — observable outcomes and constraints.
- **Scope / non-scope** — explicit boundaries.
- **Decisions and invariants** — implementation-relevant choices with rationale; record rejected alternatives only when they prevent future rework.
- **Implementation** — ordered slices with exact paths or bounded discovery targets, dependencies, ownership, and focused checks. Include delegation briefs when delegation is intended.
- **Verification** — runnable commands and expected evidence, including meaningful failure paths.
- **Risks and open questions** — mark the plan `blocked` when an answer changes behavior, scope, authorization, or verification.
- **Progress and handoff** — status and a minimal resume pointer to the canonical work log and next action; no per-slice check ledger. On completion, link a handoff only when human action remains.
- **Decision log** — the final section. After approval, append dated material decisions with session, rationale, and impact; never rewrite or remove entries.

Do not write “as discussed” or rely on chat-only context. A fresh Pi session must be able to continue from the file alone.

## Authoring

- Define observable acceptance and appropriate verification before production edits or proposal generation: caller/data shapes, meaningful success/failure cases, and the pivotal safety assumption. The common test-first obligation applies without loading a separate TDD skill; do not turn Direct work into planning ceremony.
- For consequential architectural choices, compare two independent proposals from the selected cross-model profiles using identical requirements, caller usage, ownership/state flow, failures, tradeoffs and verification outline. Add a third only for unresolved substantial divergence. Parent selects one coherent design by correctness, simplicity, integration/maintenance cost and justified extension seams, subject to approval gates; do not force disagreement or combine incompatible designs.
- Share functional requirements and hard constraints with every builder. Keep comparative rubric visibility distinct: follow the approved shared versus judge-only comparison, with shared fallback on inconclusive evidence. Fix judging criteria before generation; unsupported criteria remain unproven and safety failures cannot be offset by scores. Reuse existing plan/brief/test expectations rather than add universal rubric paperwork.
- Inspect only enough code to verify ownership, prerequisites, contracts, and canonical patterns.
- Apply Ponytail before slicing; omit speculative abstractions and follow-ups.
- For `plan with me`, keep the plan `draft` while collaborating, surface implementation-relevant decisions incrementally, and update the artifact as answers resolve them.
- For `brief plan`, do bounded discovery and write the shortest artifact that still satisfies the required document. Ask only questions whose answers materially change it.
- Write or update the plan before presenting it and mark it `ready` only when no blocking question remains. Present a clean review in chat with goal, decisions, scope, implementation slices, checks, and open questions; omit artifact metadata and progress bookkeeping from the review.
- During planning, edit only the designated plan file; never edit source.
- When an approval gate is requested, present the review and wait for explicit approval in chat. After approval, record it in the decision log, mark the plan `in_progress`, and continue in the same Pi session.

## Execution and maintenance

- Read the full plan before the first source edit or delegation. Confirm the repository state and named prerequisites still match it.
- When the user asks to execute a `ready` plan, mark it `in_progress` and proceed without replanning. Ask only for a real blocker or stale contract.
- Treat the approved design as the baseline. Keep status, progress, and actual verification current, but record later material decisions and deviations by appending to the final decision log rather than rewriting history. An entry that changes the effective contract must name what it supersedes.
- Record slice milestones, actual checks, execution decisions and interruptions once through `work_log`; use its returned dated topic path. Link material contract decisions to their append-only plan anchors rather than copy their rationale. Keep `Progress and handoff` to status, that log reference and the exact next action; add a handoff only for remaining human actions. The writer owns runtime session attribution. Loaded older writers retain their routing until an explicitly authorized runtime replacement; never silently reload them.
- Give delegated Pi agents the complete readable plan plus their exact objective, owned paths, dependencies, frozen inputs, non-scope and checks. Copy ignored governing inputs into owned worktrees when needed; require explicit owned cwd for commands. They report to the parent, who owns plan status and shared contracts.
- On completion, mark the plan `complete`. Leave a concise final handoff only when human action remains; otherwise record that no handoff was required. On interruption, leave an exact next step.

A plan does not authorize commits, pushes, destructive Git, deployment, or scope expansion. Routine work without a plan needs no artifact.

## Contract-first parallel work

Use this only when at least two genuinely disjoint slices share an API, schema, event, or serialized type. Skip routine, same-file, and no-shared-contract work. The parent creates the smallest compile-safe shared contract slice, runs a focused contract/type check, then derives the ready set from approved dependencies and exact path ownership before launching every ready disjoint Pi agent together when an installed delegation tool is available.

Keep shared contract paths parent-owned and read-only to delegated agents. Delegated agents report required changes to the parent; the parent verifies once and rebriefs affected consumers. Add no placeholder behavior or broad scaffolding.
