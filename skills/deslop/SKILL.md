---
name: deslop
description: Find demonstrated diff-introduced noise in the full deslop review lane or perform explicit cleanup. Check excess comments, redundant trusted-path guards, casts, nesting and local-pattern drift.
license: MIT
---

# Focused diff cleanup

Use the exact complete task-owned candidate diff, including committed slices and new files; never assume main or include unrelated pre-existing changes. This is a focused application of Ponytail, not a new orchestration layer or quick-task step. Do not guess AI authorship.

During the full concurrent review/testing stage, stay read-only: propose concrete simplifications without editing source, tests or proof inputs. The parent adjudicates and applies fixes after all selected lanes return, then refreshes affected evidence for each remediation round until clear or input is needed. Outside that stage, explicitly authorized cleanup may edit the bounded diff under the normal checks.

## Pre-commit staged advisory mode

When `Review target: staged` is present, read only the frozen cached patch and the named staged context copies. Never run `inspect_change({})`, inspect the working-tree source, or substitute `Review range: HEAD`; the staged path mapping names each original path and blob. This is an instruction-level read restriction, not an OS sandbox. Limit the early lens to obvious added `any`/cast escapes, debug/log output, dead or commented-out code, excessive comments, and immediately visible local-pattern noise. Do not hunt connected code, prove guard/catch redundancy, or propose more than three concise `path:line` items. Return proposals only in the required review envelope. Incomplete/unreadable input is blocked; timeout is incomplete and must be recorded as `deslop: timed out`, never clean. Do not retry, escalate models, or make cleanup edits; the seat is advisory and the whole-diff pass remains stronger.

## Prose lens

When writing a report, walkthrough, MR description, or similar prose, remove repetition and vague obligations, preserve evidence and caveats, and make the requested action easy to find. This is applied while writing and does not authorize publication.

Inspect excess comments, unjustified casts, needless nesting/wrappers and inconsistent local patterns. Remove a guard/catch only after establishing its redundancy, unreachability or trusted precondition. An unusual check is not proof of redundancy.

Preserve unchanged behavior, trust-boundary validation, useful errors, data-loss protection, accessibility, cancellation/retry/cleanup and calibration. Never replace parsing with a cast, weaken tests, swallow failures or clean adjacent code merely because it looks untidy.

Make only demonstrated simplifications. Behavioral fixes follow common test-first policy; structural edits rerun relevant checks and receive affected-delta review when warranted. Any source change invalidates stale candidate clearance. Report concise actual changes/checks and remaining gaps, without manufacturing another report.

Adapted from `cursor-team-kit/skills/deslop/SKILL.md` in the local plugins source at revision `eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10`. Replaced hard-coded main/AI-authorship assumptions with exact task provenance and protected safety behavior. [License](LICENSE).
