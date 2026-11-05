---
name: harness-eval
description: Test harness changes through fresh native Pi sessions, compare recorded behavior, and collect phase timings, tool counts, and session observations. Use for harness evaluations or requested session notes.
---

# Harness evaluation

Use ordinary Pi sessions, not a new runner.
Read [the manual kit](../../evals/manual/README.md) before launching an evaluation.
Use the notes section alone when Alan requests observations without an evaluation.

## Define one useful comparison

Select a realistic task and state the behavior the harness change should improve.
Reuse an existing recorded attempt when its task and evidence are useful.
Identify differences in source, prompt, model, tools, and services before comparing outcomes.
Call unmatched historical comparisons observational, not controlled benchmarks.
Run another baseline only when the existing record cannot answer the question and Alan approves the extra run.
Agree on the candidate, task, model, run count, time limit, and permitted resources before launching.
Keep private prompts, source copies, transcripts, and results outside Git.
Keep historical solutions out of the executor prompt.

## Run and inspect

Request native manager permission with `coordinate` action `manage` before starting managed workers.
Start one fresh evaluator with action `start`, an owned task `cwd`, and the approved task brief.
Include Done means, Keep, checks, resource limits, and the observation request in that brief.
Use the existing delegation brief template when the harness requires one.
Do not tell the evaluator which tier, implementation, or behavior should win.

Verify the loaded harness before crediting any candidate behavior.
A task worktree does not select the candidate runtime.
The `start` tool has no candidate-runtime or model override fields.
Use it only when its configured native runtime matches the approved evaluation.
For another runtime, use an explicit normal Pi CLI launch and native `adopt` if management is needed.
Preserve required organizational enforcement and native approvals when selecting resources.
Reject a wrong-runtime run as candidate evidence; retain it as a failed setup attempt.

Retain the worker UUID and native transcript path.
Handle delivered inbox notices through `inbox`, `ack`, `reply`, and `resolve` as applicable.
Direct Alan to the worker for native permission dialogs.
Treat start receipts, idle status, reports, and result publications as claims, not completion proof.
After an uncertain launch, inspect `list` or `doctor` before considering another start.
Do not automatically retry or replace an attempt.
Inspect the final diff, actual checks, persisted effects, and transcript before judging success.
Compare correctness and truthful completion before time or tool counts.
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
