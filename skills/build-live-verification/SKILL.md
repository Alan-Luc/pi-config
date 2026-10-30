---
name: build-live-verification
description: Build or extend reusable repo-local tooling that runs the changed system, exercises real behavior, and produces inspectable evidence. Use when asked to establish live verification, or when authorized work needs missing reusable verification tooling; do not generate infrastructure for every change.
---

# Build live-verification tooling

Build the repository integration for [live verification](../live-verification/SKILL.md). Read that skill for the observation, authorization and evidence contract. These global skills define the reusable method; each repo supplies commands suited to its actual runtime and interfaces. Repository paths below refer to the target repo, not this skill directory.

Start with one meaningful behavior and the smallest complete tooling that proves it. Extend existing runners, scripts, browser automation, CLI drivers and Compose definitions rather than replacing them. If existing commands already provide a usable repeatable proof, document/reuse them instead of adding wrappers. Do not create a plugin registry, daemon, universal runner or new dependency without a demonstrated need.

## Establish the repo contract

Read applicable instructions and bounded relevant source, callers, tests and startup docs. Locate the actual UI/API/event/CLI entry point and resulting state or effect. Identify the source checkout, runtime/build, local/test configuration, dependencies, credentials, ports and disposable inputs required to exercise it safely. Missing prerequisites are blockers, not an excuse to fabricate evidence or bypass the affected interface.

Before implementation, state one concrete invocation and independent expected outcome, including a relevant failure path. Distinguish the reusable runtime lifecycle from the particular scenario. Keep tooling in the repo's `.harness/`, outside disposable worktrees when a primary checkout is available; select source checkouts explicitly and derive paths rather than embedding personal machine paths.

## Isolate shared-machine resources

Give each session, run and worker a private temporary root. Use OS-bound assigned ports where supported; an availability check followed by release, or a fixed-port convention, does not reserve a port. Give each run unique database/schema, container, project and fixture identities. Confirm the actual listener and runtime identity before exercising it, and clean up only resources this run owns. If the runtime cannot isolate a shared resource, block or sequence work based on observed ownership; never stop or reuse another session's resource.

## Supply the minimum capabilities

Use the repo's language, conventions and existing installed tools. Capabilities may be existing commands plus a README; they need not become separate scripts or a mandatory CLI schema.

- **Run independently.** Start the real service/application in the foreground so the agent's existing background tools own its lifecycle. Startup must also support feature exploration or another service calling it; do not couple service lifetime to one verifier. For multi-service setups, reuse existing orchestration and identify the owned instances. Make checkout, configuration and port selection explicit; never silently substitute main, production, or another listener.
- **Check readiness and identity.** A health response is not proof of the intended instance. Establish the actual listening process and checkout/command/start time, or appropriate container/build/session identity. Refuse occupied ports, wrong instances and unobservable/ambiguous identity. Never kill an unrelated process. Document platform prerequisites and what identity checks cannot attest.
- **Exercise a bounded scenario.** Invoke the supported interface through the changed path and observe the resulting state/effect. Reuse the existing runner without mocking away the integration under verification. Different cases need different evidence: interaction sequences, persisted writes, emitted events, silence, cancellation or terminal outcomes. Do not universally require messages, clicks or iterations where they are not meaningful.
- **Fail honestly.** Require meaningful declared expectations and actual results. Missing/skipped cases, failed validators, timeouts, unexpected retries, absent effects or identity/input drift must not become success. A general runner's exit zero may not mean its reported cases passed: inspect its result contract. Keep CLI success gates active under runtime optimisation and fail on evidence-write errors. Preserve failed attempts; do not retry until green or weaken inputs to fit the implementation.
- **Capture inspectable proof.** Write bulky artifacts to private temporary storage, available after the process exits for review. Record exact command/cwd, relevant configuration without secrets, source revision/working changes, separate per-input digests, runtime identity, expected versus observed results, correlation IDs, mocks and limitations. Pin source, inputs and instance before/after. Pin ignored nested tooling inputs and the selected install, SDK and executable roots by bounded source/input identity; do not synchronously copy or hash-walk entire package or install trees when that can stall the agent. If required identity cannot be established without such a traversal, report the proof blocked rather than waiving the identity claim. Link readable observations to raw reports/traces or actual UI screenshots; a generated report or screenshot alone is not proof. Reuse a repo's existing evidence format rather than invent a competing schema.
- **Clean up safely.** Track and stop only owned processes/resources, then confirm the relevant ports/resources are released. Keep proof through review; remove owned scratch/artifacts afterward. Do not delete shared data, volumes or environments, upload customer data, log credentials, or commit a growing evidence archive.

## Prove the tooling itself

Define focused requirement-derived checks before implementing non-trivial harness logic. Demonstrate that plausible broken conditions are detected: for example a wrong-checkout listener, empty expectations, an incorrect/missing effect, lost terminal event or mutated fixture. Use disposable state and safe negative controls, not production mutation. Preserve existing validation, types, useful errors and data-loss protections.

Then execute the full documented workflow against the real implementation: start, identify, exercise, inspect evidence, stop and confirm cleanup. Mocked helper tests do not establish that this integration works. Keep proof inputs unchanged across corrective runs and compare their separate hashes. Inspect the actual action/outcome and artifact contents, not just paths or a passing summary.

Run focused tests and relevant live checks in parallel once their prerequisites are ready and their state is independent. Isolate ports, databases and fixtures where needed; sequence real dependencies/shared mutable state rather than introduce races. Use existing background/evidence tools and collect every required result before accepting the candidate.

## Leave a reusable entry point

Provide `.harness/live-verification/README.md` or link to the repo's equivalent from there. For each touched feature, map the user entry point to a drive action, expected observable or persisted effect, source anchor, relevant check, and any evidence gap/provenance. Include runnable commands/cwd, setup prerequisites, source/instance selection, scenario inputs and assertions, expected exit behavior, evidence paths, safe cleanup and known gaps. Keep this map bounded to touched features; do not create a global registry or map every repo. Use synthetic examples and avoid embedded secrets, private endpoints or personal paths in shareable guidance. Include a safe stale-route or wrong-instance control and identify the selected instance so a healthy but unrelated service cannot satisfy the proof.

Walk through that README using the actual commands before calling the tooling ready. Report what was observed, which broken condition was rejected, and what remains unverified. No unrelated scaffolding, infrastructure migration or global Pi-policy change is implied.
