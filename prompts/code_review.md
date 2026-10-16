---
description: Review current changes for material issues
argument-hint: "[slice map]"
---
Act as the tech lead and review only the stable complete task-owned change: `${@:-the current changes}`. A clean review is valid; do not dispatch speculative follow-ups.

Establish the review target before calling `inspect_change` once:
- Uncommitted work: `{}` (staged, unstaged, and untracked changes).
- A commit or endpoint range, including pushed task changes: explicit `base` and `head`, with `comparison: "direct"` (the default). Last commit: `{"base":"HEAD^","head":"HEAD"}`.
- A branch's changes since divergence: `{"base":"<target-branch>","head":"<task-branch>","comparison":"merge-base"}`.

An empty worktree packet does not mean there are no task changes. Omitted content is not evidence of absence. Use `inspect_context` once only when ownership, callers, or contracts remain unclear.

For an explicit review of changes that predate the current task, add one matching line to the reviewer brief's Scope: `Review range: HEAD` for current worktree changes, `Review range: <base>..<head>` for a direct committed range, or `Review range: <base>...<head>` for a committed branch compared from its merge base. Omit it for normal task-owned reviews.

The generated reviewer brief supplies the candidate, patch hash, bounded patch artifact, and exact absolute review paths. Also provide the active plan/decision evidence packet, callers/callees, test dependencies, objective, material risks, and stop condition. Expand beyond the patch only for one named connected-code, security, performance, UI, testing, or architecture risk. Use a fresh `code-reviewer` task for each new review; never resume one for a new delta.

If material fixes occur, rerun affected focused checks and start one remediation review covering only the remediation delta and affected contracts. Do not rereview unchanged clean regions. Before freezing the candidate, reconcile or kill every task-owned background job. Run the required broad integration recipe once against the accepted candidate, then recapture the candidate. Any failed check, stale evidence, candidate mismatch, source mutation, or failed recapture invalidates the review/verification claim.

For final verification, run only the expected exact argv through `verification_evidence` against the candidate, repository root, repository-relative cwd, and timeout. Keep review and verification sequential when checks are cheap or the candidate is volatile. After the final task commit, inspect the exact pre-task-base-to-final-HEAD integration patch for unintended changes; do not independently rereview an unchanged patch. Report evidence-backed P0/P1/P2 findings with `file:line`, or a clean verdict.
