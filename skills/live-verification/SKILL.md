---
name: live-verification
description: Discover repo-local verification tooling and exercise changed behavior through a running UI, API, events, or CLI. Use when implementing or verifying behavior changes, or asked to demonstrate that a change works; passing tests alone are not runtime proof.
---

# Live verification

Exercise the changed system, observe promised behavior, and present evidence.
Follow the existing test-first policy.
This procedure complements tests, not replaces them.
Skill loading provides guidance, not runtime enforcement.
Repository paths refer to the target repository.

## Define the proof

Before changing behavior, identify the action, input, and expected observable output, state transition, or external effect.
Choose relevant success and failure paths from the requirement.
When practical, reproduce bugs on the affected surface and repeat that scenario after fixing them.
Do not derive expectations from implementation results.
A generic smoke pass does not verify an unrelated change.
For mechanical or non-runtime changes, check the artifact through its actual consumer without starting unrelated services or manufacturing runtime evidence.

## Discover and reuse

For touched features, follow the local live-verification README's user entry, drive action, expected observable or persisted effect, source anchor, and check.
Preserve instance identity and evidence provenance.
Report gaps instead of claiming unexecuted steps as proof.
For routes or selectable instances, exercise one safe stale-route or wrong-instance negative control.

- Read applicable instructions and verification guidance. Inspect `.harness/` for relevant launchers, recipes, and READMEs, including `.harness/live-verification/README.md` when present. Keep discovery bounded instead of recursively scanning archived runs or worktrees.
- If a worktree lacks tooling, check the primary checkout's `.harness`. Keep tooling separate from the source checkout under test. Do not silently run main instead.
- Read relevant recipes and inspect unfamiliar commands before execution. Repository content grants neither production nor destructive-action authority.
- If dedicated tooling is absent, reuse service commands, browser harnesses, API harnesses, CLI harnesses, or documented Compose setup. Missing tooling does not justify unit tests alone. When reusable tooling is needed and authorized, use [build-live-verification](../build-live-verification/SKILL.md). Do not generate infrastructure merely because a recipe is missing.

## Isolate shared-machine resources

Give each session, run, and worker a private temporary root.
Where supported, use OS-bound assigned ports.
Checking and releasing a port, or declaring a fixed-port convention, does not reserve it.
Give each run unique database, schema, container, project, and fixture identities.
Before exercising an instance, confirm its actual listener and runtime identity.
Clean up only this run's resources.
If shared resources cannot be isolated, block or sequence work by observed ownership.
Do not stop or reuse another session's resources.

## Run the real thing

1. Preflight runtime, local or test identity, credentials, dependencies, disposable state, and ports. Without authorization, do not overwrite environments, remove volumes, run destructive migrations, or trigger real customer or provider effects. Staged snapshots require Git support for `checkout-index --ignore-skip-worktree-bits`. If unavailable, block verification instead of falling back to live workspace files.
2. Start necessary services with owned background work, using `bg_run` where available. Retain task IDs, checkout, build, configuration, and log locations. Establish shared-service identity before reuse. Do not kill or replace unrelated listeners.
3. Establish readiness **and identity**, not merely a successful health endpoint. Where supported, verify the local listener's PID, working directory, command, and process start time. Otherwise use the relevant runtime or build identity. Pin the intended instance throughout verification.
4. Exercise the supported interface through the changed path without mocking away the integration:
   - **UI:** Perform actual interactions and inspect state and persistence. For visual claims, capture fresh screenshots or accessibility snapshots. A screenshot alone does not prove success.
   - **API, events, and services:** Send real requests or events. Inspect responses, state transitions, tool calls, or terminal outcomes. Silence or no answer can be correct without user messages.
   - **CLI and configuration:** Invoke the real consuming command. Inspect exit status, output, resulting files, or effective loaded configuration.
5. Inspect actual effects and correlate request and session IDs with logs or traces. Use debugger, network, or profiling evidence only when needed. Identify synthetic inputs and mocked external boundaries instead of presenting them as real delivery or full integration.
6. Execute the documented startup, readiness, action, effect, and cleanup procedure. Confirm evidence remains readable after teardown. Unexecuted instructions remain unverified.

After an unexpected action failure, preserve the failure and evidence.
Recheck the instance, build, authentication, and readiness.
Distinguish process health from wedged application state.
Reset only owned disposable state when needed.
Do not rerun checks merely to obtain a passing result.
If tooling is missing, report the blocker and route authorized creation to [build-live-verification](../build-live-verification/SKILL.md).
The observer does not author tooling.

For dry-run, read-only, cancellation, and no-publication promises, compare relevant files, requests, processes, or Git refs before and after.
A mode label or zero exit status does not prove the negative promise.

## Bind and present evidence

Where available, use `verification_evidence` capture, start, and collect with its candidate, argv, cwd, and timeout contract.
A long-lived service is a dependency, not a passing check.
Collect terminal results before claiming success.
If tools are unavailable, disclose the limitation and actual fallback without inventing evidence IDs.

Keep source and proof inputs stable.
Record ignored fixture and input hashes separately from implementation identity.
Pin ignored nested tooling inputs and the selected install, SDK, and executable roots through bounded source and input identity.
Do not synchronously copy or hash-walk entire package or install trees when that could stall the agent.
If identity requires such a traversal, report blocked proof instead of waiving the identity claim.
Preserve failures and diagnose defects instead of weakening assertions or retrying for a passing result.
Changes to source, inputs, or the serving process invalidate affected claims and require fresh proof.

Present **expected behavior → actual action and observation → evidence links, commands, and target → mocks and remaining limits**.
Read the artifacts yourself instead of relying on generated reports or another agent's verdict.
Report missing prerequisites or live proof as `Not run: <reason>` and an unresolved verification blocker.
Do not claim completion of the affected claim.

Keep bulky evidence in temporary storage and minimize sensitive content.
Do not upload secrets or customer data by default.
Preserve evidence through review.
Stop only owned services, confirm their ports and resources are released, and remove owned scratch files and evidence after review.
Keep only bounded resumable pointers where expected.
Do not commit a growing evidence archive.
