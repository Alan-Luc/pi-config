---
name: deslop
description: Find demonstrated diff-introduced noise in the full deslop review lane or perform explicit cleanup. Check excess comments, redundant trusted-path guards, casts, nesting and local-pattern drift.
license: MIT
---

# Focused diff cleanup

Use the exact complete task-owned candidate diff, including committed slices and new files. Do not assume main or include unrelated pre-existing changes. Use the canonical acceptance table in `tech-lead.md`. Select this lens or advisory for a distinct named noise risk or explicit request. Other skills do not make it mandatory. This is a focused application of Ponytail, not a new orchestration layer or quick-task step. Do not guess AI authorship.

During the full concurrent review and testing stage, stay read-only: propose concrete simplifications without editing source, tests or proof inputs. The parent adjudicates and applies fixes after all selected lanes return, then refreshes affected evidence for each remediation round until clear or input is needed. Outside that stage, explicitly authorized cleanup may edit the bounded diff under the normal checks.

## Pre-commit staged advisory mode

When `Review target: staged` is present, read only the frozen cached patch and the named staged context copies. Do not run `inspect_change({})`, inspect working-tree source, or substitute `Review range: HEAD`. The staged path mapping names each original path and blob. This is an instruction-level read restriction, not an OS sandbox. Limit the early lens to obvious added `any` or cast escapes, debug output, log output, and dead or commented-out code.
Include excessive comments and immediately visible local-pattern noise. Do not hunt connected code, prove guard or catch redundancy, or propose more than three concise `path:line` items. Return proposals only in the required review envelope. Incomplete or unreadable input is blocked; timeout is incomplete and must be recorded as `deslop: timed out`, not clean. Do not escalate models or make cleanup edits.

Before dispatch, measure the frozen UTF-8 staged patch. If it exceeds 12 KiB or 250 added lines (excluding `+++` headers), do not dispatch or partition it; record exactly `deslop: skipped (oversized)`. Equality is eligible. Otherwise run one fixed Haiku advisory at low effort with its 30-second limit. Timeout is incomplete and recorded as `deslop: timed out`; the advisory remains non-blocking and does not replace whole-diff coverage.

## Prose lens

When writing reports, walkthroughs, MR descriptions, or similar prose, remove repetition and vague obligations. Preserve evidence and caveats. Make the requested action easy to find. This is applied while writing and does not authorize publication.

Inspect excess comments, unjustified casts, needless nesting or wrappers and inconsistent local patterns. Remove a guard or catch only after establishing its redundancy, unreachability or trusted precondition. An unusual check is not proof of redundancy.

Preserve unchanged behavior, trust-boundary validation, useful errors, data-loss protection, accessibility, cancellation, retries, cleanup and calibration. Do not replace parsing with a cast, weaken tests, swallow failures or clean adjacent code merely because it looks untidy.

Make only demonstrated simplifications. Behavioral fixes follow common test-first policy; structural edits rerun relevant checks and receive affected-delta review when warranted. Any source change invalidates stale candidate clearance. Report concise actual changes and checks and remaining gaps, without manufacturing another report.

Adapted from `cursor-team-kit/skills/deslop/SKILL.md` in the local plugins source at revision `eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10`. Replaced hard-coded assumptions about main and AI authorship with exact task provenance and protected safety behavior. [License](LICENSE).
