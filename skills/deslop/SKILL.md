---
name: deslop
description: Find demonstrated diff-introduced noise in the full deslop review lane or perform explicit cleanup. Check excess comments, redundant trusted-path guards, casts, nesting and local-pattern drift.
license: MIT
---

# Focused diff cleanup

Use the exact complete task-owned candidate diff, including committed slices and new files; never assume main or include unrelated pre-existing changes. This is a focused application of Ponytail, not a new orchestration layer or quick-task step. Do not guess AI authorship.

During the full concurrent review/testing stage, stay read-only: propose concrete simplifications without editing source, tests or proof inputs. The parent adjudicates and applies fixes after all selected lanes return, then refreshes affected evidence for each remediation round until clear or input is needed. Outside that stage, explicitly authorized cleanup may edit the bounded diff under the normal checks.

## Pre-commit staged advisory mode

When `Review target: staged` is present, read only the frozen cached patch and the named staged context copies. Never run `inspect_change({})`, inspect the working-tree source, or substitute `Review range: HEAD`; the staged path mapping names each original path and blob. This is an instruction-level read restriction, not an OS sandbox. Limit the early lens to obvious added `any`/cast escapes, debug/log output, dead or commented-out code, excessive comments, and immediately visible local-pattern noise. Do not hunt connected code, prove guard/catch redundancy, or propose more than three concise `path:line` items. Return proposals only in the required review envelope. Incomplete/unreadable input is blocked; timeout is incomplete and must be recorded as `deslop: timed out`, never clean. Do not escalate models or make cleanup edits.

If the staged diff cannot fit one 30-second run, based on its scope or an observed timeout, partition it among fresh Haiku/low instances. Assign non-overlapping paths or hunks that together cover the entire staged diff. Keep the same frozen staged candidate and canonical registry-prepared metadata; give each instance only its assigned bounded patch excerpt and named staged context, not the whole diff. Run ready slices in parallel within the existing eight-live-child cap and available capacity; batch any remainder. Each instance keeps its native 30-second limit. The parent must join every slice result and account for all assigned coverage; missing or timed-out slices remain incomplete, never clean, with `deslop: timed out` recorded per timed-out slice. Do not retry the same oversized brief; fresh smaller slices are permitted without changing models or extending timeouts. The whole-diff pass remains stronger.

## Prose lens

When writing a report, walkthrough, MR description, or similar prose, remove repetition and vague obligations, preserve evidence and caveats, and make the requested action easy to find. This is applied while writing and does not authorize publication.

Inspect excess comments, unjustified casts, needless nesting/wrappers and inconsistent local patterns. Remove a guard/catch only after establishing its redundancy, unreachability or trusted precondition. An unusual check is not proof of redundancy.

Preserve unchanged behavior, trust-boundary validation, useful errors, data-loss protection, accessibility, cancellation/retry/cleanup and calibration. Never replace parsing with a cast, weaken tests, swallow failures or clean adjacent code merely because it looks untidy.

Make only demonstrated simplifications. Behavioral fixes follow common test-first policy; structural edits rerun relevant checks and receive affected-delta review when warranted. Any source change invalidates stale candidate clearance. Report concise actual changes/checks and remaining gaps, without manufacturing another report.

Adapted from `cursor-team-kit/skills/deslop/SKILL.md` in the local plugins source at revision `eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10`. Replaced hard-coded main/AI-authorship assumptions with exact task provenance and protected safety behavior. [License](LICENSE).
