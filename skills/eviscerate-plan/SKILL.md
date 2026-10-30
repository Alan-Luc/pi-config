---
name: eviscerate-plan
description: Independently challenge an approved plan's design, assumptions, correctness, and slop before implementation; use when a plan needs adversarial review or refinement.
---

# Eviscerate a plan

Select the canonical plan first; do not require or invent a Git patch. Require explicit requirement, decision, and source references plus generated `Review target: plan` metadata and immutable plan/reference artifacts. If any are absent, mismatched, or stale, stop and report the missing preparation/guard support.

For an explicit composite critique, dispatch fresh `code-reviewer-sol` and `code-reviewer-opus` reviewers with identical read-only briefs and the same frozen plan artifacts. Each independently covers design, assumptions, correctness, and slop, with evidence and concrete triggers. Do not share one critic's findings with the other before both return. A missing reviewer or invalid artifact means incomplete coverage, not clearance.

Join both results, adjudicate findings against the approved requirements and decisions, and refine only within authorized scope. After a material change, refresh the immutable plan/source preparation and review the changed plan with both critics. Repeat until findings are resolved or the plan needs explicit human input. Do not repeat an already-clean approved critique merely to exercise the workflow. Report the plan identity, references, findings, adjudication, and remaining blocker concisely; never describe plan content as a patch.
