---
name: walkthrough
description: Explain and verify this session's changes when the user asks for a walkthrough or change summary.
---

## When to use

Only when the user invokes this skill or explicitly asks for a walkthrough with phrases such as "walk me through it", "what did you change", "summarize the changes", or "close it out". Do not run it automatically after ordinary multi-file work.

## Presentation scaffold

Use this output spine:

```markdown
## BLUF

## 1. <short label>

### Current problem

### <Proposed implementation OR What changed>

### Result

## How the pieces fit together

## Where the changes go

## Implementation order / Verification results

## Intentionally not changed

## Follow-ups or known gaps
```

Repeat the numbered logical-change section for every meaningful item and increment its number. The scaffold is fixed, but its content is elastic. This is a presentation scaffold, not an artifact schema. Do not add a runtime validator or require a fixed number of logical changes, paragraphs, or diagrams.

### BLUF

Start with the user-visible outcome, the problem it addresses, and the current state. Keep the first paragraph useful on its own.

### Logical change blocks

For each numbered item, keep `### Current problem` first, choose exactly one of `### Proposed implementation` or `### What changed`, and end with `### Result`. Do not add a `Logical change blocks` wrapper or invent filler items just to reach a count.

For a completed walkthrough, use `### What changed` instead of `### Proposed implementation`; never emit both headings for one item. Explain the behavior or risk, then the intended or actual change, then its expected or observed result. Include a compact flow diagram only when it improves understanding; diagrams are optional.

Planned walkthroughs use proposed/future wording and expected checks. Completed walkthroughs use actual changes, observed results, and verification that actually ran. Never present an expected result as an observed result.

### How the pieces fit together

This section is mandatory and follows all logical change blocks. Explain the big picture: how the local changes compose, where data or control flows, and which boundary or behavior the combined change protects.

### Where the changes go

After the behavior is clear, give file-by-file detail for every changed file:

1. State the exact path.
2. Summarize what changed and why it was necessary.
3. Show only the relevant snippet, with a path and line range when useful. Protect credentials, tokens, private keys, personal data, and other sensitive values by redacting or describing them.
4. Explain how the file connects to the other changed files.

Scale detail to consequence. Do not turn a trivial formatting change into a long tour.

### Implementation order / Verification results

Cover these categories, scaling detail to the work:

- **Commands:** For planned work, provide concrete commands with correct flags, paths, URLs, and expected output. For completed work, report exact commands that actually ran.
- **Outcomes:** Distinguish expected results from actual exit codes and observed outcomes.
- **Manual checks:** Name required or completed manual verification.
- **Coverage gaps:** Explicitly disclose missing automated tests.
- **Risk evidence:** Preserve useful safety, accessibility, input-validation, and error-handling evidence when relevant.

### Intentionally not changed

Name proportional tradeoffs, deliberate non-changes, and boundaries that were preserved. Explain why adjacent work was out of scope rather than implying it was forgotten.

### Follow-ups or known gaps

List only real remaining actions, limitations, or known coverage gaps. Do not claim a follow-up is complete or invent verification that did not happen.
