---
name: build-live-verification
description: Build or extend reusable repo-local tooling that runs the changed system, exercises real behavior, and produces inspectable evidence. Use when asked to establish live verification, or when authorized work needs missing reusable verification tooling; do not generate infrastructure for every change.
---

# Build live-verification tooling

Build repository tooling for [live verification](../live-verification/SKILL.md).
Read that skill's observation, authorization, and evidence contract.
These skills define the method; each repository supplies runtime-specific commands.
Paths below refer to the target repository.

Start with one meaningful behavior and the smallest tooling that proves it.
Extend existing runners, scripts, browser automation, CLI drivers, and Compose definitions.
If existing commands give repeatable proof, document and reuse them instead of adding wrappers.
Require demonstrated need before adding a plugin registry, daemon, universal runner, or dependency.

## Establish the repo contract

Read applicable instructions, bounded source, callers, tests, and startup documentation.
Locate the actual UI, API, event, or CLI entry point and resulting state or effect.
Identify the source checkout, runtime, build, local or test configuration, dependencies, credentials, ports, and disposable inputs.
Treat missing prerequisites as blockers, not permission to fabricate evidence or bypass the affected interface.

Before implementation, state one invocation and independent expected outcome, including a relevant failure.
Separate the reusable runtime lifecycle from the scenario.
When a primary checkout exists, keep tooling in its `.harness/`, outside disposable worktrees.
Select source checkouts explicitly.
Derive paths instead of embedding personal machine paths.

## Isolate shared-machine resources

Give each session, run, and worker a private temporary root.
Where supported, use OS-bound assigned ports.
Checking and releasing a port, or declaring a fixed-port convention, does not reserve it.
Give each run unique database, schema, container, project, and fixture identities.
Before exercising an instance, confirm its actual listener and runtime identity.
Clean up only this run's resources.
If shared resources cannot be isolated, block or sequence work by observed ownership.
Do not stop or reuse another session's resources.

## Supply the minimum capabilities

Use the repository's language, conventions, and installed tools.
Existing commands and a README can provide these capabilities without separate scripts or a mandatory CLI schema.

- **Run independently.** Start the real service or application in the foreground so existing background tools own its lifecycle. Support feature exploration and calls from other services without coupling lifetime to one verifier. For multiple services, reuse existing orchestration and identify owned instances. Select checkout, configuration, and port explicitly. Do not silently substitute main, production, or another listener.
- **Check readiness and identity.** A health response does not identify the intended instance. Establish its listening process, checkout, command, and start time, or appropriate container, build, and session identity. Reject occupied ports, wrong instances, and unobservable or ambiguous identity. Do not kill unrelated processes. Document platform prerequisites and identity-check limitations.
- **Exercise a bounded scenario.** Invoke the supported interface through the changed path and observe state or effects. Reuse the runner without mocking away integration. Capture evidence appropriate to interactions, persisted writes, events, silence, cancellation, or terminal outcomes. Require messages, clicks, or iterations only when meaningful.
- **Fail honestly.** Compare declared expectations with actual results. Treat missing or skipped cases, failed validators, timeouts, unexpected retries, absent effects, and identity or input drift as failures. Inspect the runner's result contract because exit zero may not mean its cases passed. Keep CLI success gates active under runtime optimisation. Fail on evidence-write errors. Preserve failures instead of rerunning for success or weakening inputs.
- **Capture inspectable proof.** Keep bulky artifacts in private temporary storage readable after exit. Record exact commands, cwd, configuration without secrets, revision, working changes, input digests, and runtime identity. Include expected and observed results, correlation IDs, mocks, and limitations. Pin source, inputs, and instance before and after. Pin ignored nested tooling inputs and selected install, SDK, and executable roots through bounded source and input identity. Do not synchronously copy or hash-walk entire package or install trees when that could stall the agent. If identity requires such a traversal, report blocked proof instead of waiving the claim. Link observations to raw reports, traces, or actual UI screenshots. Generated reports and screenshots alone do not prove effects. Reuse the repository's evidence format.
- **Clean up safely.** Track and stop only owned processes and resources. Confirm their ports and resources are released. Keep proof through review, then remove owned scratch files and artifacts. Do not delete shared data, volumes, or environments, upload customer data, log credentials, or commit a growing evidence archive.

## Prove the tooling itself

Before implementing non-trivial harness logic, define focused requirement-derived checks.
Demonstrate rejection of plausible failures.
Examples include wrong-checkout listeners, empty expectations, incorrect or missing effects, lost terminal events, and mutated fixtures.
Use disposable state and safe negative controls instead of production mutation.
Preserve validation, types, useful errors, and data-loss protections.

Execute the documented workflow against the real implementation: start, identify, exercise, inspect evidence, stop, and confirm cleanup.
Mocked helper tests do not prove integration.
Keep proof inputs unchanged across corrective runs and compare their separate hashes.
Inspect actions, outcomes, and artifacts instead of relying on paths or passing summaries.

When prerequisites are ready and state is independent, run focused tests and relevant live checks in parallel.
Isolate ports, databases, and fixtures as needed.
Sequence dependencies and shared mutable state.
Use existing background and evidence tools.
Collect every required result before accepting the candidate.

## Leave a reusable entry point

Provide `.harness/live-verification/README.md` or link the repository's equivalent from there.
For each touched feature, map its user entry, drive action, observable or persisted effect, source anchor, check, and evidence gaps and provenance.
Include commands, cwd, prerequisites, source and instance selection, inputs, assertions, expected exits, evidence paths, cleanup, and known gaps.
Keep the map limited to touched features, not a global registry.
Use synthetic examples without embedded secrets, private endpoints, or personal paths.
Identify the selected instance and include a safe stale-route or wrong-instance control.

Before calling tooling ready, walk through the README's actual commands.
Report observations, rejected broken conditions, and remaining gaps.
This work does not authorize unrelated scaffolding, infrastructure migration, or global Pi-policy changes.
