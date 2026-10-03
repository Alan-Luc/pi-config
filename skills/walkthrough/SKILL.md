---
name: walkthrough
description: Explain and verify this session's changes when the user asks for a walkthrough or change summary.
---

## When to use

Only when the user invokes this skill or explicitly asks for a walkthrough with phrases such as "walk me through it", "what did you change", "summarize the changes", or "close it out". Do not run it automatically after ordinary multi-file work.

## What to produce

### 1. Verification commands

Provide concrete commands to test the changes end-to-end:
- Exact shell commands with correct flags, paths, URLs, and expected output
- Call out any manual verification steps (e.g. "open the app and check X")
- Flag missing tests — if a change isn't covered by an automated test, say so explicitly

### 2. File-by-file walkthrough

For every file changed in this session:

1. **State the file path**
2. **What changed** — summarize the diff in plain language
3. **Why it was necessary** — what breaks or degrades without this change
4. **Show the relevant code** — include the key snippet (not the full file, just the meaningful part), with line numbers when relevant. Prefer a `path:Lx-Ly` label above the snippet. Quote actual changed lines only when they contain no credentials, tokens, private keys, personal data, or other sensitive values; redact or describe sensitive config instead.
5. **How it connects** — explain how this file's change relates to the other files in the changeset

### 3. Big-picture summary

After the file-by-file breakdown:
- Explain how all the pieces compose into the broader system
- Call out design decisions or tradeoffs made
- Note anything intentionally **not** changed and why
- List follow-up work or known gaps

## Style

Be concrete, not abstract. Show code, not just descriptions. If a change is trivial (e.g. formatting), say so in one line and move on. If a change is consequential, spend proportional space on it. Group related files together rather than going alphabetically.
