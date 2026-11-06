# Temporary extension dogfooding

Use these tools for work the task already requires.
Do not add agents, checks, packet refreshes, or benchmarks merely to exercise them.
This temporary guidance does not authorize extension changes.

## Task-native use

- Prefer `inspect_context` for bounded ownership, caller, or contract discovery with exact anchors. Follow useful paths. For missing evidence, use ordinary search and reading instead of repeatedly rephrasing weak queries.
- Prefer `inspect_change` for the needed Git delta. First, select the worktree or committed range. Reuse provenance, changed paths, omissions, and configured check recipes. A bounded packet may omit part of the review patch.
- Prefer `verification_evidence` background `start`, automatic terminal notification, then `collect` for required checks. Capture the candidate first and recapture after final checks. While checks run, do independent useful work or yield. Do not poll or narrate every completion. Preserve synchronous exceptions, visible failures, and candidate invalidation.
- If a tool is unavailable, inapplicable, or insufficient, record why and use the smallest safe fallback. Do not force usage, bypass verification guarantees, or retry for a better-looking report.

## Establish once, share relevant evidence

Give each relevant implementation or review brief the same established evidence:
- Plans, work logs, and decision anchors.
- Exact paths and ranges.
- Context snapshots and receipts.
- Change targets and endpoints.
- Candidate IDs.
- Patch artifacts and hashes.
- Check results and log references.

Reference readable artifacts or include relevant excerpts.
IDs alone do not convey their contents.
Keep each agent's scope narrow.

Do not make children repeat supplied reconnaissance or identical checks.
They investigate only unresolved questions or changed inputs.
Share completed verification evidence as provenance.
Do not claim its session-local ID is registered in another session.
Stale or mismatched evidence cannot support current claims.

The review-preparation hook supplies reviewer patch metadata, not every tool result.
The parent owns sharing.
Overlap read-only review and background verification only for the same stable candidate when concurrency helps.
Do not launch an agent solely for this.

## One feedback report at closeout

Alongside the final non-trivial work-log entry, the parent records **Extension feedback** using existing log fields.
For substantial findings, write one report at `.harness/reports/YYYY/MM/DD/<session-id>-extension-feedback.md`.
Link it from the log and final reply instead of duplicating details.
Children relay friction in an existing allowed response section without creating separate reports.
For trivial work, mention friction in the reply.

Record tools used, or why they did not apply.
For each issue, include:
- The tool, operation, input, and relevant packet, task, evidence ID, or path.
- Expected help versus actual results, distinguishing contract failures from unmet workflow expectations.
- Observed extra searches, wrong turns, artifact reconstruction, reruns, waiting, or output noise.
- The fallback, workaround, outcome, and smallest improvement worth investigating.

Quantify only observed costs.
Label suspected causes and untested ideas.
Record what saved work so useful behavior survives.
If nothing went wrong, write “No extension friction observed”.
Do not add diagnostic calls, expose secrets or full logs, change Git exclusions without authorization, or claim unmeasured savings.
