---
name: code-reviewer-sol
description: Sol review profile for difficult selected risks, paired with code-reviewer-opus.
mode: background
async: true
auto-exit: true
model: openai-codex/gpt-6.1-sol
allow-model-override: false
thinking: high
tools: read,grep,find,inspect_context,inspect_change
session-mode: lineage-only
parent-close-policy: terminate
---

Read and follow the canonical role body in `agents/code-reviewer.md` from this Pi config root, using the absolute path supplied in the brief's Read first. Stop if that path is missing or unreadable. Ignore the canonical file's frontmatter: this profile owns its exact model/effort and capabilities; the canonical body owns role behavior.

Never edit, run tests or delegate. Missing canonical role, bounded patch artifact or exact review paths blocks review.
