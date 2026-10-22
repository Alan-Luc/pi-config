---
name: durable-plan
description: Create or resume durable `.harness/plans/`, and load prior plans or decisions before ticket implementation when they may govern the work.
---

# Durable plans

The plan file is the working memory and handoff contract. Chat is not the source of truth. Canonical project artifacts live under `.harness/`: plans under `.harness/plans/`, daily records under `.harness/YYYY/MM/DD.md`, and handoffs under `.harness/handoffs/YYYY/MM/DD/<session-id>-<task-slug>.md`. Runtime Pi sessions remain under `~/.pi/agent/sessions`.

Unless Alan explicitly requests planning, truly trivial direct work is exempt: do not create or load a plan, task list, work log, review, handoff, or report for an exact mechanical action and its direct check.

During migration, read `.harness` first and legacy `.opencode` second. Never rewrite or delete legacy records. Before resuming a legacy plan, check for the same-named canonical plan to avoid duplicates; if it does not exist, copy the legacy plan once to `.harness/plans/`, add a `Migrated from:` note, and update only the canonical copy thereafter.

## Ticket context preflight

For ticket-shaped implementation, even when the user did not request planning:

1. Extract the ticket and dependency IDs.
2. Search `.harness/plans/`, `.opencode/plans/`, `.harness/YYYY/`, and `.opencode/YYYY/` for those IDs, plus relevant dated logs for resumed or related work.
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
- **Progress and handoff** — at each coherent slice start and completion, record the current objective or result, changed paths, checks actually run, blockers, and the exact next step; on completion, include either the required handoff path or that no human action remained.
- **Decision log** — the final section. After approval, append dated material decisions with session, rationale, and impact; never rewrite or remove entries.

Do not write “as discussed” or rely on chat-only context. A fresh Pi session must be able to continue from the file alone.

## Authoring

- Define observable acceptance and appropriate verification before production edits or proposal generation: caller/data shapes, meaningful success/failure cases, and the pivotal safety assumption. The common test-first obligation applies without loading a separate TDD skill; do not turn quick implementation into planning ceremony.
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
- At each coherent slice start and completion, update `Progress and handoff` with the current objective or result, changed paths, checks actually run, blockers, and exact next step. If execution stops, leave the exact next step needed to resume; when complete, add the handoff path only when human action remains. For an audit trail, record the active Pi session ID (`PI_SESSION_ID` in shell commands) when available.
- Give delegated Pi agents the plan path plus their exact objective, owned paths, dependencies, non-scope, and checks. They report updates to the parent; the parent owns plan status and shared-contract edits.
- On completion, mark the plan `complete`. Leave a concise final handoff only when human action remains; otherwise record that no handoff was required. On interruption, leave an exact next step.

A plan does not authorize commits, pushes, destructive Git, deployment, or scope expansion. Routine work without a plan needs no artifact.

## Contract-first parallel work

Use this only when at least two genuinely disjoint slices share an API, schema, event, or serialized type. Skip routine, same-file, and no-shared-contract work. The parent creates the smallest compile-safe shared contract slice, runs a focused contract/type check, then derives the ready set from approved dependencies and exact path ownership before launching every ready disjoint Pi agent together when an installed delegation tool is available.

Keep shared contract paths parent-owned and read-only to delegated agents. Delegated agents report required changes to the parent; the parent verifies once and rebriefs affected consumers. Add no placeholder behavior or broad scaffolding.
