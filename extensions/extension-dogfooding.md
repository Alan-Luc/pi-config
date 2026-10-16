# Temporary extension dogfooding

Use these tools to remove work the task already requires, not to manufacture usage. No extra agents, checks, packet refreshes, or benchmarks just to exercise them. This is temporary observation guidance, not authorization to change extensions.

## Task-native use

- Prefer `inspect_context` for bounded ownership, caller, or contract discovery with exact anchors. Follow useful returned paths; use ordinary search/read for missing evidence rather than repeatedly reformulating a weak query.
- Prefer `inspect_change` for the needed Git delta. Establish worktree versus committed-range input first. Reuse its provenance, changed paths, omissions, and configured check recipes; it is bounded evidence, not necessarily the complete review patch.
- Prefer `verification_evidence` background `start`, automatic terminal notification, then `collect` for checks already required. Capture the candidate first and recapture after final checks. Do independent useful work while checks run, otherwise yield; do not poll or narrate every completion. Preserve existing synchronous exceptions, failure visibility, and candidate invalidation.
- If a tool is unavailable, inapplicable, or insufficient, record why and use the smallest safe fallback. Do not force usage, silently bypass verification guarantees, or keep retrying to produce a better-looking report.

## Establish once, share relevant evidence

Put the same established evidence in each relevant implementation/review brief: plan/decisions, exact paths/ranges, context snapshot/receipt, change target/endpoints, candidate ID, patch artifact/hash, and check results/log references as applicable. Reference existing readable artifacts or include the bounded relevant excerpts; IDs alone do not convey their contents. Keep each agent's scope narrow.

Do not make children repeat reconnaissance or rerun identical checks merely to establish facts already supplied. They investigate only unresolved questions or changed inputs. Share completed verification evidence as provenance, not as a claim that its session-local ID is registered in another session. Stale or mismatched evidence cannot support current claims.

The current review-preparation hook supplies reviewer patch metadata; it does not broadcast all tool results to all agents. The parent owns sharing. Overlap read-only review and background verification only when both target the same stable candidate and concurrency is worthwhile; do not launch an agent solely for this.

## One feedback report at closeout

Alongside the final non-trivial work-log entry, the parent records **Extension feedback** using existing log fields. For substantial findings, write one report at `.harness/reports/YYYY/MM/DD/<session-id>-extension-feedback.md`, link it from the log and final reply, and avoid duplicating its detail. Children relay observed friction in an existing allowed response section; they do not create separate reports. Trivial work needs no new artifact; mention encountered friction in the reply.

Record tools used, or why they were not applicable. For each observed issue include:

- Tool and input/operation, packet/task/evidence ID or relevant path.
- Expected help versus actual result; distinguish a contract failure from an unmet workflow expectation.
- Concrete friction: extra searches, wrong turns, manual artifact reconstruction, reruns, waiting, or output noise. Quantify only what was observed.
- Fallback/workaround and outcome; the smallest improvement worth investigating. Label suspected causes and untested ideas, not invented defects.

Include what saved work so useful behavior survives improvements. If nothing went wrong, one line—“No extension friction observed”—is enough. Do not create diagnostic calls to populate this report, paste secrets/full logs, change Git exclusions without authorization, or claim unmeasured time savings.
