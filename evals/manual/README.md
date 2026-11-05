# Native harness comparison

Test a harness change by running a real task in a fresh Pi session.
Use [harness-eval](../../skills/harness-eval/SKILL.md) for the workflow and session notes.
Invoke `/skill:harness-eval` after the skill is available in the initiating session.
A worktree does not install or activate the skill.
For a one-off invocation, ask the initiating agent to read its absolute `SKILL.md` path.

## Prepare

Choose one task, candidate harness, model, time limit, and permitted local resources with Alan.
Use [task-template.md](task-template.md) for the evaluator's requirements.
Keep task material and results in an owner-only directory outside Git.
Use a disposable task checkout rather than the original working repository.
Exclude historical solutions and later-answer artifacts from its prompt and source.
Record the task source, prompt, candidate resources, and their identities before launch.
Directory separation is not a sandbox.
Do not claim blind evaluation or enforced isolation from this procedure.

## Start a normal session

Request manager permission in the initiating session:

```json
{"request":{"action":"manage","enabled":true}}
```

When the configured native runtime is the harness under test, launch through `coordinate`:

```json
{"request":{"action":"start","name":"harness-eval-example","cwd":"/absolute/disposable/task","task":"<approved task brief, checks, limits, and session observation request>"}}
```

Use a unique name and one fresh conversation per attempt.
Keep the returned worker UUID for communication and resource ownership.
Ask the worker to publish questions and its final result through the existing coordinator.
Open that same worker in the coordinator dashboard to inspect or answer native permission dialogs.
The manager cannot answer those dialogs through a reply.

The `start` tool selects neither a model override nor another harness runtime.
Changing `cwd` alone does not replace installed extensions, skills, or configuration.
Verify effective resource paths and relevant loaded instructions before judging candidate behavior.
If they differ from the approved candidate, retain the attempt as wrong-runtime evidence.
Do not credit it to the candidate.

For candidate resources outside the configured runtime, use normal Pi resource options from the installed CLI documentation.
Select the candidate's changed resources explicitly without loading duplicate baseline resources.
Preserve required enforcement and native approvals.
Pin the effective resource paths, model, and command in the private notes.
Do not copy credentials, install changes, or reload the current session merely to run an evaluation.
Use native `adopt` with the exact worker UUID when a separately launched compatible session needs management.
A plain native session also works when management adds no value.
No custom runner is required.

## Inspect and compare

Read delivered results through the manager inbox and acknowledge the messages actually read.
Handle questions and blockers explicitly; an acknowledgement does not resolve them.
Inspect actual file effects, tests, transcript, and completion claims independently.
A live process, successful launch, or worker report does not prove task success.
After uncertain startup, use `list` or `doctor` rather than blindly launching another session.
Keep failures, limits, and incomplete attempts in the comparison.
Stop only owned sessions through supported native controls.

Copy [results-template.csv](results-template.csv) when a worksheet helps.
Leave unavailable measurements unknown and explain fields that do not apply.
Use the skill's notes scaffold for phase intervals, tool counts, and perceived friction.
Compare with an existing historical attempt when it has useful evidence.
Label differences in task, source, model, harness, and environment.
Run a matched baseline only when needed and separately approved.
Compare correctness first; fewer steps do not make an incorrect outcome better.
A workflow smoke test proves launch and inspection, not general harness effectiveness.

## Historical blind replay

The previous kit prepared private historical tasks but did not establish an executor access boundary.
Do not treat this simpler observational workflow as resolving that separate requirement.
Use exported starting source without later Git history if a later approved comparison requires it.
Keep hidden checks outside executor access for any claimed blind comparison.
