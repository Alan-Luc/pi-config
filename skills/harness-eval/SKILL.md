---
name: harness-eval
description: Test harness changes through fresh native Pi sessions, compare recorded behavior, and collect phase timings, tool counts, and session observations. Use for harness evaluations or requested session notes.
---

# Harness evaluation

Use ordinary Pi sessions, not a new runner.
Use [the task template](../../evals/manual/task-template.md) for evaluator requirements and [the results worksheet](../../evals/manual/results-template.csv) when useful.
Use the notes section alone when Alan requests observations without an evaluation.

## Define one useful comparison

Select a realistic task and state the behavior the harness change should improve.
Reuse an existing recorded attempt when its task and evidence are useful.
Identify differences in source, prompt, model, tools, and services before comparing outcomes.
Call unmatched historical comparisons observational, not controlled benchmarks.
Run another baseline only when the existing record cannot answer the question and Alan approves the extra run.
Agree on the candidate, task, model, run count, time limit, and permitted resources before launching.
Keep private prompts, source copies, transcripts, and results in an owner-only directory outside Git.
Use a disposable task checkout rather than the original working repository.
Exclude historical solutions and later-answer artifacts from the executor prompt and source.
Record the task source, prompt, candidate resources, and their identities before launch.
Directory separation is not a sandbox.

## Run and inspect

A plain native session works when management adds no value.
For managed workers, request native manager permission in the initiating session:

```json
{"request":{"action":"manage","enabled":true}}
```

Start one fresh evaluator with action `start`, a unique name, an owned task `cwd`, and the approved brief:

```json
{"request":{"action":"start","name":"harness-eval-example","cwd":"/absolute/disposable/task","task":"<approved task brief, checks, limits, and session observation request>"}}
```

Ask the worker to publish questions and its final result through the existing coordinator.
Include Done means, Keep, checks, resource limits, and the observation request in that brief.
Use the existing delegation brief template when the harness requires one.
Do not tell the evaluator which tier, implementation, or behavior should win.

Verify the loaded harness before crediting any candidate behavior.
A task worktree does not select the candidate runtime.
The `start` tool has no candidate-runtime or model override fields.
Use it only when its configured native runtime matches the approved evaluation.
For another runtime, select candidate resources through normal Pi CLI options without loading duplicate baseline resources.
Use native `adopt` with the exact worker UUID when that separately launched session needs management.
Pin effective resource paths, model, and command in private notes.
Do not copy credentials, install changes, or reload the current session merely to run an evaluation.
Preserve required organizational enforcement and native approvals when selecting resources.
Reject a wrong-runtime run as candidate evidence; retain it as a failed setup attempt.

Retain the worker UUID and native transcript path.
Handle delivered inbox notices through `inbox`, `ack`, `reply`, and `resolve` as applicable.
Open that same worker in the coordinator dashboard for native permission dialogs.
The manager cannot answer those dialogs through a reply.
Treat start receipts, idle status, reports, and result publications as claims, not completion proof.
After an uncertain launch, inspect `list` or `doctor` before considering another start.
Do not automatically retry or replace an attempt.
Inspect the final diff, actual checks, persisted effects, and transcript before judging success.
Compare correctness and truthful completion before time or tool counts.
Leave unavailable measurements unknown and explain fields that do not apply.
A workflow smoke test proves launch and inspection, not general harness effectiveness.
Stop only owned resources through supported commands and retain incomplete attempts.

## Session notes

Ask the evaluator to note phase transitions during normal work without narrating every tool call.
Record UTC timestamps at the start and at transitions among planning, implementation, and verification.
Keep repeated phases as separate intervals when work returns to an earlier phase.
Record approval waits separately from active work when the evidence permits.
Do not infer active thinking time from elapsed wall time.
Derive tool calls, failed commands, retries, and helper counts from retained transcripts when available.
State whether counts include nested calls and helpers.
Label unmeasured values unknown and retrospective phase timings estimated.
Keep perceived accelerators and blockers separate from measured outcomes.
Cite a concrete event for each observation rather than claiming a causal speedup.
Do not add telemetry tooling or extra model calls just to fill missing fields.

Use this compact scaffold in the attempt's private notes:

```markdown
# Session observations
- Attempt, task, worker UUID, transcript:
- Harness actually loaded, model, thinking, task source:
- Outcome and independent checks:
- Start, end, elapsed time, approval waits:
- Phase intervals and evidence; mark estimates:
- Tool calls, counting rule, helpers, failed commands, retries:
- Helped: concrete event and perceived effect:
- Slowed: concrete event and perceived effect:
- Comparison with prior attempt and important differences:
- Unknowns, incomplete work, and remaining resources:
```

Report missing evidence without turning this observational workflow into a blind benchmark.

## Historical blind replay

The previous kit prepared private historical tasks but did not establish an executor access boundary.
Do not claim blind evaluation or enforced isolation from this observational workflow.
Use exported starting source without later Git history if a later approved comparison requires it.
Keep hidden checks outside executor access for any claimed blind comparison.
