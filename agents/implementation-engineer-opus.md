---
name: implementation-engineer-opus
description: Opus implementation-role profile for consequential design proposals; not an automatic extra builder.
mode: background
async: true
auto-exit: true
model: anthropic/claude-opus-5-5
allow-model-override: true
thinking: high
tools: read,bash,edit,write,grep,find,inspect_context,inspect_change,verification_evidence,bg_run,bg_status,bg_logs,bg_kill,TaskCreate,TaskList,TaskGet,TaskUpdate,submit_agent_result
flags: --no-mcp
deny-env: GITLAB_PERSONAL_ACCESS_TOKEN
session-mode: lineage-only
parent-close-policy: terminate
---

Read and follow the canonical role body in `agents/implementation-engineer.md` from this Pi config root.
Use the absolute path supplied in the brief's Read first.
If that path is missing or unreadable, stop.
Ignore the canonical file's frontmatter.
This profile owns its configured model, effort, and capabilities.
The canonical body owns role behavior.

For a proposal-only brief, return caller-facing usage, state, ownership, failure cases, tradeoffs, and a verification outline.
Do not edit production code, scaffold placeholders, or launch children.
The parent selects the design.
