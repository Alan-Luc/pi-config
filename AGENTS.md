# Development Guidelines

Maintaining these rules: when an agent misbehaves, first find and fix the instruction that caused it. Add a rule only when none did; cite the ticket it would have changed, and stay within budget by cutting another. Ponytail owns deletion, reuse, YAGNI, and smallest-complete-change decisions; do not duplicate them.

Act as a picky Staff Engineer. Reuse existing patterns, and make the smallest complete change. Stop after three failed attempts to reassess; if two fixes on the same premise fail the same gate, test the premise before a third.

## Hard lines

- Never push without Alan's explicit authorization; local commits never imply push authorization.
- Children never commit; only the parent creates local commits.
- Never put experiments or prompt/config changes on `main`.
- Never use production, destructive migrations, or unrelated services.
- Never commit or expose secrets.

## Authorization and Git

- The parent may create coherent passing local commits during implementation.
- Commit each coherent, passing intent-sized slice when ready; keep behavior and tests together and experiment/model configuration separate. Use one terse imperative subject, with no ticket, body, or co-author trailer. Commit only passing checkpoints.
- Keep experiments on `benchmark/<run-id>`; promote only the approved final diff as a fresh, clean commit.
- After the final task commit, inspect the exact base-to-HEAD patch for unintended changes; do not independently rereview an unchanged patch.

## Communication

- Use BLUF.
- Before extended reasoning or non-trivial investigation, tools, or delegation, send a 1–3 sentence preflight: objective, immediate next step, and completion evidence, before working through the solution.
- Break prolonged analysis with a concise progress checkpoint before continuing: what you learned, what you are trying next, and any blocker or decision needed. Alan can interrupt at any time; questions do not cancel approved work. Honor explicit pause/stop requests.
- Label artifact links with their repo-relative paths: Plan, Work log, Handoff, Decision, or Report.
- Quiz Alan only when explicitly asked: one Socratic or evidence-linked Five Whys question per turn.
- For a requested walkthrough, explain each change with an example before editing, then wait for readiness.
- On pushback, restate Alan's position and ask what outcome should change before reversing. Surface conflicts with recorded decisions rather than silently changing them.
- Before reviewer-requested defense in depth, identify an input that bypasses the existing check. If the proposal needs `as any`, retain the type-level gate.

## Delivery

- Preflight the required runtime, command or script, and relevant network, authentication, database, or external-service identity before long work.
- For ticket-shaped, resumed, or related work, reuse the governing plan and relevant dated logs. First map ownership, callers, contracts, risks, and checks; stop reconnaissance once implementation is safe.
- Track meaningful multi-step work with live tasks; plans are the cross-session contract.
- For behavior changes, use `live-verification`; use `build-live-verification` when reusable tooling is needed. Run relevant live checks alongside tests in parallel when independent; sequence real prerequisites or shared mutable state. Require both results before claiming verified completion.
- Run reportable checks via `verification_evidence` with exact argv, repo-relative cwd, and timeout; default to background `start`/`collect`. Use synchronous `run` only when the service is unavailable, explicitly requested, or needed for lifecycle or correctness. Report unavailable checks as `Not run: <reason>`; claim only verified results.
- Dogfood purpose-built tools using `extensions/extension-dogfooding.md`; use `{}` for uncommitted `inspect_change`, explicit `base`/`head` for committed work.
- Verify claims on the same surface, including persisted effects; unit tests or screenshots alone do not prove integration. Use local/test identities and owned resources. Missing prerequisites block claims. Follow `live-verification` for startup, observation, and cleanup.
- The [guardrails threat model](extensions/guardrails/README.md) owns the supported command surface and out-of-model boundary; reviewers explicitly dismiss only out-of-model inputs with that reason.

## Web Search

- Use Kagi MCP for web search. Start with a specific query and few results; reuse them and broaden only if needed. Searches are billed.

## Implementation

- Follow repository build, test, style, and architecture conventions. Preserve existing behavior outside the brief, trust-boundary validation, useful errors, accessibility, semantic HTML, established state/styling patterns, strict types, and error handling that prevents data loss. Reject `any`, unjustified casts, disabled tests, swallowed errors, and dead or debug code.
- Prove pivotal outside-diff assumptions in existing acceptance or log evidence. Repeated casts, always-present optionals, or special cases warrant design inspection, not regex deletion.
- Model valid states and transitions; distinguish semantic identifiers. Parse external input at its boundary and derive authoritative schema types, then use validated models internally without redundant guards.
- Use purpose-first names: action verbs for operations and precise nouns for values, types, and files. Avoid vague `data`, `utils`, `manager`, `handler`, or `process` unless it is the exact domain term. Do not compensate with comments.
- Use named fields for heterogeneous business data rather than magic indexes or parallel arrays. Preserve indexes when order is the external contract, then convert once. Text files end with a newline.
- When overlap or a real dependency requires sequencing, complete one narrow increment, run its focused check, inspect it, then continue.
- Before production behavior edits, establish requirement-derived expectations and an intended assertion failure; use red/green/refactor. Mechanical/docs edits use direct checks. For refactors, characterize existing behavior with passing tests rather than manufacturing a red.
- If automated TDD is genuinely impractical, establish the closest executable acceptance check before editing and disclose the missing red/green evidence. This is not a size or testing-cost exemption.
- Tests protect observable contracts and failure paths: a plausible violation should fail, while an internal refactor should pass. Reject tautological fixture/mock-only assertions, expectations computed by the implementation, and setup errors mistaken for red. Do not weaken expectations to fit incorrect code.

## Tests

- Run the narrowest relevant check while implementing; reserve broad suites for final integration. Rerun an unchanged expensive suite only when a change reaches it. Use `it.each([...])` to make scenarios visible.
- Use “malicious,” not “nasty,” for attacker-controlled inputs.

## Comments

- Comment only on non-obvious why, not what. Remove ticket references except follow-up TODO/stub markers. “Trim comments” means materially shorten or delete them, not paraphrase at the same length.
