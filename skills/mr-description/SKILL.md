---
name: mr-description
description: Write a concise MR description with observable behavior when requested.
---

## When to use

After changes are completed, when a compact merge-request summary is needed. If the user explicitly asks for a proposal instead, label it as proposed and use future tense; never imply unapplied behavior already exists.

## Output contract

Write an MR-ready description with exactly these sections:

### Summary

- Use 1-3 short bullets stating what behavior changed and why it matters. For an explicitly labeled proposal, state what behavior would change.
- Lead with behavior and value, not files, implementation chronology, or internal mechanics.
- Mention a ticket or specification only when it is present in the current context; never infer one.

### How to observe

- Give one concrete example pairing an action, command, or input with the expected visible result.
- Prefer behavior a user or reviewer can observe. When none is directly visible, use the smallest relevant check and its expected output.

## Style

Be specific and intentionally shorter than `/skill:walkthrough`. Do not include file-by-file analysis, code snippets, exhaustive verification steps, unrelated history, or extra boilerplate.

## Example

```markdown
### Summary

- Routes failed-test filters by spec so identical test names in other specs no longer trigger unrelated retries.
- Rejects malformed or ambiguous retry state before test execution.

### How to observe

- Run `compose test --filter-from test_reports/failed_tests.txt` with `specs/a.yml<TAB>shared`; only the `shared` test from `specs/a.yml` runs, while the same name in `specs/b.yml` is skipped.
```
