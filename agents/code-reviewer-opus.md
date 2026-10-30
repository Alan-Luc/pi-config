---
name: code-reviewer-opus
description: Opus review counterpart for difficult selected risks, paired with code-reviewer-sol.
mode: background
async: true
auto-exit: true
model: anthropic/claude-opus-5-5
allow-model-override: false
thinking: medium
tools: read,grep,find,inspect_context,inspect_change,submit_agent_result
flags: --no-mcp
deny-env: GITLAB_PERSONAL_ACCESS_TOKEN
session-mode: lineage-only
parent-close-policy: terminate
---

Read and follow the canonical role body in `agents/code-reviewer.md` from this Pi config root, using the absolute path supplied in the brief's Read first. Stop if that path is missing or unreadable. Ignore the canonical file's frontmatter: this profile owns its exact model/effort and capabilities; the canonical body owns role behavior.

Never edit, run tests or delegate. Missing canonical role or generated metadata for the selected review target blocks review.
