---
description: Audit review-lane outcomes in the last five tickets and propose coverage changes
argument-hint: "[topic or scope]"
---
Audit recent work logs for `${@:-the current repository}` on demand.
Do not add a per-ticket step or change coverage.

Read recent dated work logs under `.harness/YYYY/MM/DD/`.
Follow canonical work-log pointers when this checkout stores its logs elsewhere.
Select the five most recent completed tickets within the requested scope.
Group slice and pass entries by ticket; do not count each entry as a ticket.
If fewer than five tickets are available, report the smaller sample.

List each review lane with no accepted findings across those tickets.
For each lane, show ticket citations, observed runs, accepted findings, dismissals, zero findings, and failed, missing, or stale results.
Keep missing or unrecorded outcomes unknown; do not count them as zero findings.
Distinguish accepted findings from fixes and follow-ups.
Include dismissal reasons and any coverage gaps.

Propose bounded downgrades only when the recorded outcomes support them.
Explain the proposed scope, evidence, risks, and coverage that would remain.
Do not infer that zero findings prove a lane has no value.
Preserve Full-tier coverage, cross-family review pairs, realistic triggers, and work-log recording.
Present proposals for Alan's approval; do not apply them.
If evidence is insufficient, report that no downgrade is supported.
