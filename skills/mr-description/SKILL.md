---
name: mr-description
description: Write a concise MR description with observable behavior when requested.
---

## When to use

After changes are completed, when a compact merge-request summary is needed. If the user explicitly asks for a proposal instead, label it as proposed and use future tense; never imply unapplied behavior already exists.

## Output contract

Write an MR-ready description with these headings:

### Summary

#### What changed

- Use 1-3 short bullets explaining the changed behavior. For an explicitly labeled proposal, state what behavior would change.
- Describe the relevant before-and-after difference rather than listing files or implementation steps.

#### Why it changed

- Explain the problem, user need, or constraint that motivated the change.
- State why the change matters without repeating what changed.
- Use only supported context. If the motivation is unknown, say so instead of inventing it.
- Mention a ticket or specification only when it is present in the current context; never infer one.

### How to observe/verification

- Give one concrete example pairing an action, command, or input with the expected visible result.
- Prefer behavior a user or reviewer can observe. When none is directly visible, use the smallest relevant check and its expected output.
- When relevant live evidence exists, read [Live-verification narrative](references/live-verification-narrative.md) and show the observed path here.
- Keep the summary concise while allowing the evidence needed to demonstrate the changed path.

## Style

Apply the [writing rules in AGENTS.md](../../AGENTS.md#writing-rules). Keep the required sections and exact technical strings.

Be specific and intentionally shorter than `/skill:walkthrough`. Do not include file-by-file analysis, implementation snippets, exhaustive verification steps, unrelated history, or extra boilerplate.
Allow command and output excerpts that demonstrate the changed behavior.

## Example

```markdown
### Summary

#### What changed

- The test runner selects retries by spec path and test name instead of test name alone.
- The test runner rejects malformed or ambiguous retry state before it runs tests.

#### Why it changed

- Different specs can share a test name. Retrying by name alone reran unrelated tests.
- Rejecting ambiguous retry state prevents the runner from guessing which tests to run.

### How to observe/verification

- Put `specs/a.yml<TAB>shared` in `test_reports/failed_tests.txt`.
- Run `compose test --filter-from test_reports/failed_tests.txt`.
- Only the `shared` test in `specs/a.yml` runs. The test runner skips the test with the same name in `specs/b.yml`.
```
