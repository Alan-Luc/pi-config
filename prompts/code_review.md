---
description: Review current changes for material issues
argument-hint: "[slice map]"
---
Act as the tech lead and review only the stable complete task-owned change: `${@:-the current changes}`. A clean review is valid; do not dispatch speculative follow-ups.

For task execution, retain the starting candidate and exact task-owned path set captured before the first source edit. After the delta is stable, capture the final candidate and create one exact patch artifact for those paths, including new files. Hash that patch and give the reviewer the candidate and hash; the complete change receives one review, not ceremonial duplicates. Use `inspect_change` once when the current-worktree delta is the input, and `inspect_context` once only when ownership, callers, or contracts remain unclear.

Derive the review root with:

```sh
node -p "require('node:path').join(require('node:os').tmpdir(),'pi')"
```

The bounded reviewer brief must contain literal lines:

- `Patch artifact: <absolute path under the review root>`
- `Review paths: <exact absolute paths>`

Also provide the active plan/decision evidence packet, candidate identity, patch SHA-256, callers/callees, test dependencies, objective, material risks, and stop condition. Expand beyond the patch only for one named connected-code, security, performance, UI, testing, or architecture risk. Use a fresh `code-reviewer` task for each new review; never resume one for a new delta.

If material fixes occur, rerun affected focused checks and start one remediation review covering only the remediation delta and affected contracts. Do not rereview unchanged clean regions. Before freezing the candidate, reconcile or kill every task-owned background job. Run the required broad integration recipe once against the accepted candidate, then recapture the candidate. Any failed check, stale evidence, candidate mismatch, source mutation, or failed recapture invalidates the review/verification claim.

For final verification, give `verification-runner` only the expected candidate and exact argv, repository root, repository-relative cwd, and timeout. It executes only those commands through `verification_evidence`; it never selects tests. Keep review and verification sequential when checks are cheap or the candidate is volatile. After authorized commits, review the exact pre-task-base-to-final-HEAD integration patch even with a clean worktree. Report evidence-backed P0/P1/P2 findings with `file:line`, or a clean verdict.
