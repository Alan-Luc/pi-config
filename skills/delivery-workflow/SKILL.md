---
name: delivery-workflow
description: Execute non-trivial coding work safely from bounded reconnaissance through slicing, candidate capture, review, remediation, verification, and integration. Load before the first non-trivial source edit or implementation-agent dispatch.
---

# Delivery workflow

Use this skill for non-trivial implementation, review remediation, or coordinated verification. The Tech Lead owns the contract, scope, integration, and final claims. An active durable plan remains the source of truth; this skill supplies execution procedure, not new scope.

## Establish the delivery boundary

- Confirm governing plans/decisions, authorization, prerequisite branches or flows, owned paths, callers/consumers, fixtures, and required checks.
- Apply Ponytail: reuse one canonical pattern and existing seams; reject speculative abstractions, fallbacks, options, dependencies, and adjacent cleanup.
- Before a long command or `bg_run`, preflight the repository-required runtime, command/script existence, and any relevant network, authentication, database, or external-service identity. Do not start an expensive command while a known prerequisite is unresolved.
- Use the session task list for meaningful multi-step work. It is a live checklist, not the durable cross-session contract. Mark work in progress before editing and complete only satisfied items.
- Before the first task-owned source edit, capture the starting candidate with `verification_evidence` and retain the exact task-owned path set. When work occurs in a linked sibling worktree, pass its absolute `repositoryRoot`; keep command cwd relative to that root.

## Reconnaissance outcomes

Choose the fastest suitable evidence path for the uncertainty. There is no mandatory first tool, tool order, batching shape, or call count.

- Reuse prior bounded packets, governing artifacts, and delegated findings. Do not repeat covered discovery unless evidence conflicts or omits a required branch.
- Treat bounded search or inspection omissions as inconclusive, not proof of absence.
- Stop when governing artifacts, prerequisites, ownership, fixed contracts, callers/consumers, bounded targets, slice dependencies, and focused checks are known.
- Use direct reads/search for tight seams. Use `inspect_change` when a current delta is the input, `inspect_context` for useful lexical ownership context, and asynchronous `code-explorer` agents for genuinely independent research seams. Never delegate and duplicate the same investigation.

After mapping, briefs carry this parent-owned evidence packet:

- `Source of truth: <active plan and decision headings, or None>`
- `Verified facts: <directly confirmed facts and useful evidence>`
- `Read first: <smallest exact paths/ranges>`
- `Open questions: <only questions owned by this worker>`

Workers report contradictory evidence instead of silently reopening broad reconnaissance.

## Slice and execute

- Split by independent acceptance criteria and non-overlapping ownership. Keep production changes with their tests and fixtures. Serialize real write overlap or implementation dependencies as narrow verified increments.
- Use contract-first sequencing only when two or more disjoint slices share an API, schema, event, or serialized type: the parent lands the smallest compile-safe contract, runs its focused check, then launches consumers in parallel with shared paths read-only.
- Give each worker one objective, exact owned paths, dependencies, non-scope, focused checks, and the evidence packet. Launch genuinely disjoint work together; do not dispatch roles ceremonially.
- Write-capable workers use `verification_evidence` for reportable checks. Under `Verified by`, use an evidence-backed command item or the exact fallback list item `- Not run: <reason>`. Raw Bash and background-task output are not evidence.
- Background work is operational only. Before freezing a candidate, every task-owned job must be terminal and reconciled or explicitly killed and reported.
- Inspect worker diffs and artifacts. Rebrief off-contract work; do not widen the parent scope to accept it.

## Review and verification

For non-trivial work, default to:

1. Run the narrowest changed-area checks needed to stabilize the delta.
2. Create the exact complete task-owned patch, including new files, from the starting tree to the current tree.
3. Dispatch one independent bounded `code-reviewer` over that patch and the exact review paths.
4. Remediate material findings in one pass and rerun affected focused checks.
5. Run the required broad integration recipe once against the accepted candidate.

Do not rerun an unchanged expensive suite for ceremony. For repositories with very large suites, use their authoritative focused or sharded recipes as separate bounded commands; never mask a timeout or claim checks not completed.

Derive the review root with:

```sh
node -p "require('node:path').join(require('node:os').tmpdir(),'pi')"
```

Store the exact patch beneath that absolute root. Every reviewer brief includes literal lines:

- `Patch artifact: <absolute path under the review root>`
- `Review paths: <exact paths>`

Also include the original request, acceptance contract, candidate identity, patch SHA-256, relevant callers/tests, prior material findings, evidence packet, and stop condition. A bounded review is the default; name any connected-code, security, performance, UI, testing, or architecture expansion explicitly. Start each review or remediation review as a fresh agent.

After remediation, drain background jobs, capture the final candidate, save the exact complete patch, and hash it. If broad checks are material enough to overlap, launch `code-reviewer` and `verification-runner` together in one pure `subagent` `children` batch. Do not mix ordinary tools into that launch, keep `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` unset, and stop the parent turn after dispatch. The verifier receives only the expected candidate and exact argv/repositoryRoot/cwd/timeout commands; it never selects tests.

After both return, the parent captures the candidate again and requires an exact match. A material finding, failed or invalid check, candidate mismatch, source mutation, or failed recapture invalidates the whole batch. Remediate, rerun affected focused checks, create a new patch/candidate, and launch fresh review and verification sessions. Keep final review and verification sequential when checks are cheap, the candidate is volatile, or overlap would be slower.

## Authorized commits

A plan never authorizes commits or push. When Alan authorizes local commits, record the pre-task HEAD. Each coherent commit must contain one passing intent and its tests, exclude unrelated/sibling work, and leave the repository buildable. Review the accepted slice before staging; verify staged paths and diff exactly match the accepted artifact, then commit. Children never commit. Push requires explicit authorization.

After the final authorized commit, review one exact pre-task-base-to-final-HEAD integration patch across the complete commit set, even with a clean worktree.

## Finish

Update active-plan progress at coherent slice boundaries with changed paths, actual checks, blockers, and the exact next step. Record material deviations in its append-only decision log. Without a plan, use `work_log` for material decisions.

Before claiming completion, verify the complete task-owned delta, required review, final checks, candidate stability, and deferred scope. Append the daily work log. Create a validated handoff only when Alan still has a human-only action; otherwise record that no handoff is required.
