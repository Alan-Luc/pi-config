# Development Guidelines

Fix instructions that cause agent misbehavior. Otherwise, cite the affected ticket when adding rules; cut another rule to stay within budget. Ponytail owns deletion, reuse, YAGNI, and smallest-complete-change decisions.

Reuse patterns; make the smallest complete change. Reassess after three failed attempts. Test a premise before a third fix when two fixes fail the same gate.

## Hard lines

- Never push without Alan's explicit authorization; local commits never imply push authorization.
- Children never commit; only the parent creates local commits.
- Never put experiments or prompt/config changes on `main`.
- Never use production, destructive migrations, or unrelated services.
- Never commit or expose secrets.

## Authorization and Git

- The parent may commit during implementation. Commit each coherent, passing intent-sized slice when ready; keep behavior and tests together, experiment/model configuration separate. Use one terse imperative subject without ticket, body, or co-author trailer.
- Keep experiments on `benchmark/<run-id>`; promote only approved final diffs as fresh, clean commits.
- After the final commit, inspect the exact base-to-HEAD patch for unintended changes; do not independently rereview unchanged patches.

## Communication

- Use BLUF. Apply the writing rules below to all agent communication.
- Before non-trivial work, send a 1–3 sentence preflight: objective, next step, and completion evidence.
- During prolonged analysis, report findings, next steps, and blockers. Questions leave approved work active. Honor pause/stop requests.
- Label artifact links with their repo-relative paths: Plan, Work log, Handoff, Decision, or Report.
- Quiz only on request: one Socratic or evidence-linked Five Whys question per turn.
- For requested walkthroughs, explain changes with examples before editing; wait for readiness.
- On pushback, restate Alan's position; ask which outcome should change before reversing. Surface recorded-decision conflicts.
- Before reviewer-requested defense in depth, identify an existing-check bypass. Retain type-level gates when proposals need `as any`.

### Writing rules

- Use ASD-STE100 Simplified Technical English: approved words/meanings where known, consistent technical terms, direct verbs, active voice, explicit actors/actions/objects. Explain necessary terms; omit idioms, figurative language, ambiguity, and unnecessary words. Claim formal compliance only after checking the standard and dictionary.
- Use one topic per paragraph. Instructions: imperative, one action per step, ≤20 words/sentence. Descriptions: ≤25 words/sentence. Exceed limits when shortening loses meaning.
- Preserve exact code, commands, paths, identifiers, quotes, required headings, and schemas; simplify explanations only. Preserve requirement strength, uncertainty, conditions, exceptions, risks, and verification evidence. Add no unsupported facts, causes, or guarantees.
- Before sending, check lengths, terms, actors/actions; distinguish expected/observed results; state missing checks and unresolved questions.
- Briefs must include these rules or require reading this file’s Writing rules section through an exact readable path. Require them for replies/subsequent delegation regardless of assumed prior loading.

## Delivery

- Before long work, check runtime, commands, network, authentication, database, and service identities.
- For ticket-shaped, resumed, or related work, reuse governing plans and dated logs. Map ownership, callers, contracts, risks, and checks; stop reconnaissance when implementation is safe.
- Track meaningful multi-step work with live tasks; plans are the cross-session contract.
- For behavior changes, use `live-verification`; use `build-live-verification` for needed reusable tooling. Parallelize independent live checks and tests; sequence prerequisites/shared mutable state. Require both results before claiming verified completion.
- Run reportable checks through `verification_evidence`: exact argv, repo-relative cwd, timeout; default background `start`/`collect`. Synchronous `run` requires service unavailability, explicit request, or lifecycle/correctness need. Report unavailable checks as `Not run: <reason>`; claim only verified results.
- Dogfood purpose-built tools using `extensions/extension-dogfooding.md`; use `{}` for uncommitted `inspect_change`, explicit `base`/`head` for committed work.
- Verify claims on the same surface, including persistence; unit tests/screenshots alone cannot prove integration. Use local/test identities and owned resources. Missing prerequisites block claims. Follow `live-verification` for startup, observation, cleanup.
- The [guardrails threat model](extensions/guardrails/README.md) owns the supported command surface and out-of-model boundary; reviewers explicitly dismiss only out-of-model inputs with that reason.

## Web Search

- Use billed Kagi MCP searches: specific queries, few results; reuse before broadening.

## Implementation

- Follow repository conventions. Preserve out-of-scope behavior, trust-boundary validation, useful errors, accessibility, semantic HTML, state/styling patterns, strict types, and data-loss protection. Reject `any`, unjustified casts, disabled tests, swallowed errors, and dead/debug code.
- Prove pivotal outside-diff assumptions in existing acceptance or log evidence. Repeated casts, always-present optionals, or special cases warrant design inspection, not regex deletion.
- Model valid states and transitions; distinguish semantic identifiers. Parse external input at its boundary and derive authoritative schema types, then use validated models internally without redundant guards.
- Use purpose-first names: action verbs for operations and precise nouns for values, types, and files. Avoid vague `data`, `utils`, `manager`, `handler`, or `process` unless it is the exact domain term. Do not compensate with comments.
- Use named fields instead of magic indexes or parallel arrays. Preserve indexes for externally required order, then convert once. End text files with a newline.
- When overlap or a real dependency requires sequencing, complete one narrow increment, run its focused check, inspect it, then continue.
- Before production behavior edits, establish requirement-derived expectations and an intended assertion failure: red/green/refactor. Mechanical/docs: direct checks. Refactors: characterize existing behavior with passing tests, not manufactured failures.
- If automated TDD is genuinely impractical, establish the closest executable acceptance check before editing; disclose missing red/green evidence. Size/testing cost grants no exemption.
- Test observable contracts and failure paths: plausible violations fail; internal refactors pass. Reject tautological fixture/mock-only assertions, implementation-computed expectations, and setup errors mistaken for red. Do not weaken expectations for incorrect code.

## Tests

- Implement with the narrowest relevant checks; reserve broad suites for final integration. Rerun expensive suites only for changes reaching them. Use `it.each([...])` for visible scenarios.
- Use “malicious,” not “nasty,” for attacker-controlled inputs.

## Comments

- Default: self-explanatory code, no comments. Comments require an invisible external constraint or workaround reason absent from code.
- Explain why, never what: no restating code, signatures, types, control flow; no doc comments, header banners, section dividers.
- Keep ticket references only in follow-up TODO/stub markers. “Trim comments” means shorten/delete, not equal-length paraphrasing.
