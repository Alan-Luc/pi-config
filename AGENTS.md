# Development Guidelines

Fix instructions that cause misbehavior. Follow [Writing rules](#writing-rules). Ponytail owns deletion, reuse, YAGNI, and smallest-complete-change decisions.

Reassess after three failed attempts. If two fixes fail the same gate, test the premise before a third.

## Hard lines

- Never push without Alan's explicit authorization; local commits grant none.
- Children never commit; only the parent commits.
- Never put experiments or changes to prompts or configuration on `main`.
- Never use production, destructive migrations, or unrelated services.
- Never commit or expose secrets.

## Authorization and Git

- Commit passing, coherent slices locally. Separate experiment and model configuration from behavior and tests. Use terse imperative subjects without tickets, bodies, or co-author trailers.
- Keep experiments on `benchmark/<run-id>`; promote approved final diffs as fresh commits.
- After committing, inspect the exact base-to-HEAD patch for unintended changes; reuse unchanged reviews.

## Writing rules

Apply these rules to agent communication and instruction files.

Give one rule per sentence. Use imperative instructions. Use active voice with explicit actors and objects. Target 20 words per procedure sentence and 25 per descriptive sentence. If clarity requires more words, rewrite rather than compress.

Simplify everyday words and syntax. Use “use”, not “utilize”. If plainer words lose meaning, keep precise terms, such as “idempotent”, “characterization test”, and “trust boundary”. Explain unfamiliar terms.

If a sentence needs decoding, rewrite it. Save words by deleting unnecessary rules. Replace idioms, figurative language, and ambiguity with direct statements.

Include complete verbs and articles. Separate words without slashes. Spell out lists.

Put conditions before governed actions. State positive actions. Reserve “never” for Hard lines. If a reason is unclear, add one short clause.

Limit noun clusters to three words. Put warnings before affected steps. Keep each paragraph to one topic and about six sentences. Omit nested parentheses.

Preserve exact code, commands, paths, identifiers, quotes, required headings, and schemas. Preserve requirement strength, uncertainty, conditions, exceptions, risks, and verification evidence. Support stated facts, causes, and guarantees.

Before sending, check lengths and terms. Distinguish expected results from observed results. State missing checks and unresolved questions. Use glossary terms only as defined, without near-synonyms.

### Glossary

A pass verifies and reviews one candidate for completion.

A panel contains reviewers selected for a pass.

A freeze is the point after which source changes invalidate affected verification and review results.

A candidate is the exact source under verification and review.

Clearance confirms that all selected checks and reviews passed for a candidate.

A tier is Direct, Focused, or Full, selected by the governing matrix.

A station is an owner's defined scope.

## Delivery

- Before long work, check runtime, commands, network, authentication, database, and service identities.
- For ticket-shaped, resumed, or related work, reuse plans and dated logs. Map ownership, callers, contracts, risks, and checks. Stop reconnaissance when implementation is safe.
- Track multi-step work with live tasks.
- For behavior changes, use `live-verification` and, for missing reusable tooling, `build-live-verification`. Parallelize independent live checks and tests; sequence prerequisites and shared state. Require both results.
- Use `verification_evidence` with exact argv, repo-relative cwd, and timeout; use background `start` and `collect` by default. Use synchronous `run` only for an explicit request, unavailable background service, or a concrete lifecycle or correctness need. Report unavailable checks as `Not run: <reason>`.
- Verify claims on the same surface, including persistence; tests and screenshots alone cannot prove integration. Use local or test identities and owned resources. Missing prerequisites block claims.

## Web Search

- Use billed Kagi MCP searches: specific queries, few results; reuse before broadening.

## Implementation

- Before adding reviewer-requested defenses, identify an existing-check bypass.
- Follow repository conventions. Preserve unrelated behavior, trust-boundary validation, useful errors, accessibility, semantic HTML, state and styling patterns, strict types, and data-loss protection. Reject `any`, unjustified casts, disabled tests, swallowed errors, and dead code and debug code.
- Prove pivotal outside-diff assumptions in acceptance or logs. Inspect repeated casts, always-present optionals, and special cases before regex deletion.
- Model valid states and transitions. Distinguish semantic identifiers. Parse external input at its boundary. Derive authoritative schema types; use validated models internally without redundant guards.
- Name operations with verbs and values, types, and files with precise nouns. Reserve `data`, `utils`, `manager`, `handler`, and `process` for exact domain terms. Replace unclear names instead of adding comments.
- Replace magic indexes and parallel arrays with named fields. Preserve externally required indexes, then convert once. End text files with a newline.
- If overlap or dependencies require sequencing, complete, check, and inspect one increment before continuing.
- Before production behavior edits, establish requirement-derived expectations and an intended assertion failure. Follow red, green, and refactor. Check mechanical and documentation changes directly. Characterize refactors with passing tests.
- If automated TDD is genuinely impractical, establish the closest executable acceptance before editing and disclose missing red and green evidence. Size and testing cost grant no exemption.
- Test observable contracts and failure paths. Plausible violations must fail; internal refactors must pass. Reject tautological assertions based only on fixtures or mocks, implementation-computed expectations, and setup errors as red. Preserve expectations for incorrect code.

## Tests

- Run narrow checks during iteration and broad suites for final integration. Rerun expensive suites only when affected. Use `it.each([...])`.

## Comments

- Write self-explanatory code. Comment only for invisible external constraints or workaround reasons.
- Explain why. Omit code restatements, doc comments, header banners, and section dividers.
- Keep tickets in follow-up TODO or stub markers only. Shorten or delete comments.
