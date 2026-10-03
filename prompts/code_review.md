---
description: Review current changes for material issues
argument-hint: "[slice map]"
---
Act as the tech lead and review only a stable implementation/diff. Scope: `${@:-the current changes}`.

When no slice map is supplied, build the smallest real ownership map. Keep production and test paths in the same disjoint slice; every test-only hunk belongs to one. For each slice, capture its exact current diff in an approved temporary `.pi` artifact and launch one `code-reviewer-light` subagent with:
- `Patch artifact: <absolute path>`
- `Review paths: <exact absolute paths>`
- the canonical worktree root, direct callers/callees and test dependencies, objective, material risk, and stop condition

Launch disjoint reviews in one `subagent` batch using `children`; exclude `.git`, parent or sibling worktree aliases, and unrelated inventories. Use a domain specialist instead of `code-reviewer-light` only when one dominant risk clearly warrants it. Add another specialist only for a separately named security, performance, UI, testing, or architecture objective the first reviewer cannot cover. Use `test-automation-engineer` only when execution evidence is missing or a regression needs proving; use `code-explorer` only when ownership or scope is unclear. Start a fresh `subagent` task for each review or remediation delta; never use `subagent_resume` for a new delta.

Synthesize once, deduplicate, verify cross-slice contracts, and return compact status, reviewers/slices, evidenced P0/P1/P2 findings with `file:line`, and real blockers or open questions. A clean review is valid. Do not dispatch remediation, re-review, implementation, or speculative follow-ups.
