---
name: deslop
description: Remove demonstrated diff-introduced noise during existing implementation/review or explicit cleanup. Use for excess comments, redundant trusted-path guards, casts, nesting or local-pattern drift; not a separate pass on every task.
license: MIT
---

# Focused diff cleanup

Use the exact complete task-owned candidate diff, including committed slices and new files; never assume main or include unrelated pre-existing changes. This is a focused application of Ponytail, not a mandatory extra agent round, report or quick-task step. Do not guess AI authorship.

Inspect excess comments, unjustified casts, needless nesting/wrappers and inconsistent local patterns. Remove a guard/catch only after establishing its redundancy, unreachability or trusted precondition. An unusual check is not proof of redundancy.

Preserve unchanged behavior, trust-boundary validation, useful errors, data-loss protection, accessibility, cancellation/retry/cleanup and calibration. Never replace parsing with a cast, weaken tests, swallow failures or clean adjacent code merely because it looks untidy.

Make only demonstrated simplifications. Behavioral fixes follow common test-first policy; structural edits rerun relevant checks and receive affected-delta review when warranted. Any source change invalidates stale candidate clearance. Report concise actual changes/checks and remaining gaps, without manufacturing another report.

Adapted from `cursor-team-kit/skills/deslop/SKILL.md` in the local plugins source at revision `eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10`. Replaced hard-coded main/AI-authorship assumptions with exact task provenance and protected safety behavior. [License](LICENSE).
