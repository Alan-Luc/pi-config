---
description: Review current changes for material issues
argument-hint: "[slice map]"
---
Act as the tech lead and review only a stable implementation/diff. Scope: `${@:-the current changes}`.

For a current-worktree review without an exact supplied diff/artifact, call `inspect_change` once after the delta is stable and reuse its changed paths, excerpts, omissions, and verification recipes to seed the ownership map and Context evidence. Follow up only for explicit omissions or required caller/contract evidence outside the packet; if the tool is unavailable or unsupported, fall back once to the existing targeted reads. The bounded packet does not replace the exact patch artifact.

For task execution, capture a starting candidate with `verification_evidence` before the first task-owned source edit and retain the exact task-owned path set. Before closeout, capture the final candidate and create one exact starting-tree-to-final-tree patch for those paths, including new files. The complete task-owned delta must be reviewed once regardless of commit strategy; reuse an unchanged review of that exact patch instead of dispatching a ceremonial duplicate.

When ownership, caller, or contract context remains unclear after fixing the change scope, call `inspect_context` once before manual discovery or `code-explorer` dispatch. Reuse the packet and investigate only material gaps.

When the task contains authorized slice commits, use the recorded pre-task base and final HEAD to capture one exact integration patch across the complete commit set, then review it after the slice reviews even if the worktree is clean. Use `inspect_change` only for any residual worktree delta.

When no slice map is supplied, build the smallest real ownership map. Keep production and test paths in the same disjoint slice; every test-only hunk belongs to one. Derive the review root from `node:os.tmpdir()/pi` with `node -p "require('node:path').join(require('node:os').tmpdir(),'pi')"`, create it, and capture each slice's exact current diff beneath the printed absolute path. Launch one `code-reviewer-light` subagent per slice with:
- `Patch artifact: <absolute path under the printed root>`
- `Review paths: <exact absolute paths>`
- a Context evidence packet containing:
  - `Source of truth: <active plan and decision paths with relevant headings or None>`
  - `Verified facts: <facts the parent directly confirmed; include evidence when useful>`
  - `Read first: <smallest exact paths/ranges>`
  - `Open questions: <only unanswered questions this worker owns>`
- the canonical worktree root, direct callers/callees and test dependencies, objective, material risk, and stop condition

Launch disjoint reviews in one `subagent` batch using `children`; exclude `.git`, parent or sibling worktree aliases, and unrelated inventories. Use a domain specialist instead of `code-reviewer-light` only when one dominant risk clearly warrants it. Add another specialist only for a separately named security, performance, UI, testing, or architecture objective the first reviewer cannot cover. Use `test-automation-engineer` only when execution evidence is missing or a regression needs proving; use `code-explorer` only when ownership or scope is unclear. Start a fresh `subagent` task for each review or remediation delta; never use `subagent_resume` for a new delta.

At a final task gate, first require every task-owned background job to be terminal and reconciled or explicitly killed and reported; do not freeze or dispatch while any background job can still mutate the repository. After remediation is stable, capture the candidate identity and SHA-256 of the exact complete-task patch. When supplied broad checks are material enough to overlap, launch the final integration reviewer and `verification-runner` together in one pure `subagent` `children` batch. Do not mix ordinary tools into that launch message; keep `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` unset and stop the parent turn after launch. Give the reviewer the exact patch, review paths, acceptance contract, prior material findings, hash, and candidate. Give the verifier only the expected candidate and exact argv/cwd/timeout commands. After both children return and before consolidation, capture the candidate again in the parent and require an exact match with the dispatched candidate. If either child fails, evidence is invalid, the post-batch capture fails, or the candidate changes, invalidate the batch and never reuse its evidence. Keep the stage sequential when checks are cheap, inputs remain volatile, or capacity makes overlap slower.

Synthesize once, deduplicate, verify cross-slice contracts, and return compact status, reviewers/slices, evidenced P0/P1/P2 findings with `file:line`, and real blockers or open questions. A clean review is valid. Do not dispatch remediation, re-review, implementation, or speculative follow-ups.
