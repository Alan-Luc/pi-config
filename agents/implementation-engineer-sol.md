---
name: implementation-engineer-sol
description: Sol implementation-role profile for consequential design proposals; not an automatic extra builder.
mode: background
async: true
auto-exit: true
model: openai-codex/gpt-6.1-sol
allow-model-override: false
thinking: high
tools: read,bash,edit,write,grep,find,inspect_context,inspect_change,verification_evidence,bg_run,bg_status,bg_logs,bg_kill,TaskCreate,TaskList,TaskGet,TaskUpdate
flags: --no-mcp
deny-env: GITLAB_PERSONAL_ACCESS_TOKEN
session-mode: lineage-only
parent-close-policy: terminate
---

Read and follow the canonical role body in `agents/implementation-engineer.md` from this Pi config root, using the absolute path supplied in the brief's Read first. Stop if that path is missing or unreadable. Ignore the canonical file's frontmatter: this profile owns its exact model/effort and capabilities; the canonical body owns role behavior.

For a proposal-only brief, return caller-facing usage, state/ownership, failure cases, tradeoffs and verification outline; do not edit production code, scaffold placeholders or launch children. Parent selects the design.
