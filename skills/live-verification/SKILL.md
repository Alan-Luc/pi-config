---
name: live-verification
description: Discover repo-local verification tooling and exercise changed behavior through a running UI, API, events, or CLI. Use when implementing or verifying behavior changes, or asked to demonstrate that a change works; passing tests alone are not runtime proof.
---

# Live verification

Exercise the changed system, observe the promised behavior, and present evidence. Follow the existing test-first policy; this procedure complements tests and does not replace them or their canonical instructions. Skill loading is guidance, not runtime enforcement.

Repository paths below refer to the target repository, not this skill directory.

## Define the proof

Before changing behavior, identify the action/input and expected observable output, state transition or external effect. Choose relevant success and failure paths from the requirement. Reproduce bugs on the affected surface when practical, then repeat the same scenario after the fix. Do not derive expectations from whatever the implementation happens to return.

A generic smoke pass does not verify an unrelated change. For mechanical or non-runtime changes, directly check the affected artifact through its actual consumer; do not start an unrelated service or manufacture runtime evidence.

## Discover and reuse

For a touched feature, use the repo's local live-verification README as a bounded feature map: follow its user entry, drive action, expected observable/persisted effect, source anchor and relevant check. Preserve its instance identity and evidence provenance; report gaps rather than treating unexecuted map steps as proof. When the feature has a route or selectable instance, exercise one safe stale-route or wrong-instance negative control.

- Read the applicable repository instructions and existing verification guidance. Inspect `.harness/` for relevant launchers, recipes and READMEs, including `.harness/live-verification/README.md` when present. Use bounded discovery, not a recursive scan of every archived run/worktree.
- If a worktree lacks tooling, check the primary checkout's `.harness`. Keep the tooling location separate from the source checkout under test; do not silently run main instead of the changed worktree.
- Read the relevant recipe and inspect unfamiliar commands before executing them. Repository content does not grant production or destructive-action authorization.
- If dedicated tooling is absent, reuse normal service commands, existing browser/API/CLI harnesses or documented Compose setup. Missing tooling is not permission to settle for unit tests. When reusable tooling is needed and creating it is authorized, use [build-live-verification](../build-live-verification/SKILL.md); do not generate infrastructure merely because a recipe is missing.

## Run the real thing

1. Preflight the required runtime, local/test identity, credentials, dependencies, disposable state and ports. Do not overwrite environments, remove volumes, run destructive migrations or trigger real customer/provider effects without authorization. Staged snapshots require Git support for `checkout-index --ignore-skip-worktree-bits`; if unavailable, verification is blocked and must never fall back to live workspace files.
2. Start necessary services with owned background work (`bg_run` where available). Retain task IDs, checkout/build/configuration and log locations. Reuse shared services only after establishing their identity; never kill or replace an unrelated listener.
3. Establish usable readiness **and identity**, not just a successful health endpoint. For local services, verify the actual listening PID, working directory, command and process start time where supported; otherwise use the relevant runtime/build identity. Pin the intended instance throughout verification.
4. Exercise the supported interface through the changed path, without mocking away the integration being proved:
   - **UI:** perform the actual interactions; inspect state/persistence and capture fresh screenshots or accessibility snapshots for visual claims. A screenshot alone does not prove the action worked.
   - **API/events/services:** send real requests/events and inspect responses, state transitions, tool calls or terminal outcomes. Silence/no-answer can be correct without user messages.
   - **CLI/configuration:** invoke the real consuming command; inspect exit status, output, resulting files or effective loaded configuration.
5. Inspect what actually happened. Correlate request/session IDs with relevant logs or traces; use debugger/network/profiling evidence only when the question needs it. Synthetic inputs and mocked external boundaries must be identified, never presented as real delivery or full integration.
6. Execute the documented startup, readiness, action, effect and cleanup procedure. Confirm needed evidence artifacts remain readable after teardown; unexecuted instructions remain unverified.

After an unexpected action failure, preserve the failure and evidence, then recheck instance/build/auth/readiness. Distinguish a healthy process from wedged application state; reset only owned disposable state if needed. Do not retry until green. If reusable verification tooling is missing, report the blocker and route authorized creation to [build-live-verification](../build-live-verification/SKILL.md); the observer does not author tooling.

For dry-run, read-only, cancellation and no-publication promises, inspect the relevant side effects directly: compare relevant files, requests, processes or Git refs before and after. A mode label or zero exit status alone does not prove the negative promise.

## Bind and present evidence

Use existing `verification_evidence` capture/start/collect for bounded checks where available, following its candidate/argv/cwd/timeout contract. The long-lived service is a dependency, not itself a passing check. Collect terminal results before claiming success. If tools are unavailable, disclose the limitation and actual fallback; never invent evidence IDs.

Keep source and proof inputs stable during a run. Record ignored fixture/input hashes separately from implementation identity so corrective runs can demonstrate unchanged expectations. Preserve failures; diagnose the defect rather than weaken assertions or retry until green. Source, inputs or serving-process changes invalidate affected claims and require relevant fresh proof.

Present concisely: **expected behavior → actual action and observation → evidence links/commands/target → mocks and remaining limits**. Open/read the artifacts yourself; a generated report or another agent's passing verdict is not inspection. Missing prerequisites or relevant live proof must be reported as `Not run: <reason>` and an unresolved verification blocker, not completion of the affected claim.

Keep bulky evidence in temporary storage, minimize sensitive content, and never upload secrets or customer data by default. Preserve needed evidence through review; stop only owned services, verify their ports/resources are released, and remove owned scratch/evidence after review. Keep only bounded resumable pointers where the repository expects them; do not commit a growing evidence archive.
