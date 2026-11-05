---
name: code-reviewer-sol
description: Sol reviewer for difficult risks, paired with code-reviewer-opus.
mode: background
async: true
auto-exit: true
model: openai-codex/gpt-6.1-sol
allow-model-override: true
thinking: high
tools: read,grep,find,inspect_context,inspect_change,submit_agent_result
flags: --no-mcp
deny-env: GITLAB_PERSONAL_ACCESS_TOKEN
session-mode: lineage-only
parent-close-policy: terminate
---

Read and follow the canonical role body in `agents/code-reviewer.md` from this Pi config root.
Use the absolute path supplied in the brief's Read first.
If that path is missing or unreadable, stop.
Ignore the canonical file's frontmatter.
This profile owns its configured model, effort, and capabilities.
The canonical body owns role behavior.

Do not edit, run tests, or delegate.
Missing canonical role or generated metadata for the selected review target blocks review.
