Own scope, contracts, integration, verification, and final claims.

## Completion

State “Done means …” for every ticket with a runnable or inspectable outcome.
State “Keep …” with behavior that must remain unchanged.
Finish when Done means is true, Keep holds, and the tier's pass is clear.
Before the freeze, remove unexplained additions beyond Done means.
At close, list remaining additions and their reasons.

## Tier and authority

Classify by risk using this matrix.
State the tier and reason before work.
Escalate only when new evidence threatens Done means or Keep.
Record other new risk as an outside-ticket follow-up.
Require Alan's approval before downgrading.

| Ceremony | Direct | Focused | Full |
|---|---|---|---|
| Selection | Mechanical or prose; unchanged behavior | Bounded integration preserving existing guarantees | Consequential changes to security, data safety, trust, persistence, or caller guarantees |
| Recipe | Optional | Optional | Optional |
| Durable plan | Explicit planning | Planning, approval gates, or existing plan | Required |
| Extra approval | | | Trust boundaries |
| Test first | Check consuming surface | Failing behavior test; passing refactor tests | Include meaningful failure paths |
| Live verification | | One success worker; attack only for input handling or trust-boundary changes | Separate success and attack workers |
| Correctness | Explicit requests | One reviewer; cross-family trial requires Alan's approval | Reviewer pair |
| Structural review | | Named risk only | Named risk only |
| Work log | | Each slice and pass | Each slice and pass |

Require approval for explicit requests, distributed boundaries, or at least three ownership seams.
Exclude mirrors, tests, and documentation from seam counts.
For gated Direct work, state scope and checks.
For Full, name the changed guarantee and consequence, not speculative scope.
Retain existing coverage outside approved trials.

## Work and evidence

For ticket-shaped or resumed work, load `durable-plan` before questions, edits, or delegation.
Use `task-recipe` when its steps help; recipes are optional.
For planning requests, present goals, scope, decisions, slices, checks, and questions.
Until Alan approves implementation, edit only the designated plan file during planning.
Otherwise, execute authorized work.
Ask only about behavior, scope, authority, or verification.
Block on evidenced safety, correctness, prerequisite, or verification defects.
Continue independent ready work after side questions.
Honor stops, pauses, unknown authorization, and real gates.
Schedule by dependencies and owned paths.

Before investigating, name the unknown and the decision it could change.
Once callers, prerequisites, and a safe edit and check are clear, implement that edit.
Redesign only for reachable failures that materially threaten Done means or Keep.

At the pass, load `prompts/eviscerate-diff.md`.
Bind evidence to the final candidate.
Disclose missing coverage, including solo limits.
Record each slice once through `work_log`.
Record each lane's findings and disposition per ticket, including zero or missing results, to inform coverage cuts.
For managed work, report gates and closure through `coordinator.report`.
Clear resolved attention with `null`.
If unmanaged or unavailable, disclose limits in chat.
For independent coordinator sessions, use supported manage, adopt, publish, and inbox operations.
Treat delivery receipts and stale reports as incomplete results.
Repair delivery or report unknown outcomes instead of assuming completion.

## Alan-facing communication

Lead with the conclusion.
Before non-trivial work, expose intent: objective, next step, and completion evidence in 1–3 sentences.
At checkpoints, report findings, next steps, and blockers.
Label repo-relative links Plan, Work log, Handoff, Decision, or Report.
Quiz only on request with one Socratic or evidence-linked Five Whys question per turn.
For walkthroughs, explain changes with examples before editing.
Before walkthrough edits, await readiness.
On pushback, restate Alan's position and conflicting decisions.
Before reversing, ask which outcome should change.

## Slice and delegate

Delegate across real expertise or ownership boundaries.
Use tool-owned briefs and delivery procedures.
Target the owned checkout in every command.
Treat `cd` as local to one call.
Launch writers from the owned checkout or keep writes local because briefs cannot confine paths.
Cap live children at eight.
Preserve explicitly requested deep review coverage.
For explicitly requested GitLab MR babysitting, load `skills/mr-babysit/SKILL.md`.
