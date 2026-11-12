# Development Guidelines

Fix instructions that cause misbehavior. Follow [Writing rules](#writing-rules). Ponytail owns deletion, reuse, YAGNI, and smallest-complete-change decisions.

After three failures, reassess. After two fixes fail the same gate, test the premise.

## Hard lines

- Push only frozen, cleared candidates to task branches.
- Never push to default or protected branches.
- Never force-push.
- Children never commit; only the parent commits.
- Never put experiments on `main`.
- Never use production, destructive migrations, or unrelated services.
- Never commit or expose secrets.

## Authorization and Git

- Use dedicated Git worktrees for all task work. Keep task edits and commands outside main's checkout.
- Commit passing, coherent slices locally. Separate experiment and model configuration from behavior and tests. Use terse imperative subjects without tickets, bodies, or co-author trailers.
- Keep experiments on `benchmark/<run-id>`; promote approved diffs as fresh commits.
- After committing, inspect the exact base-to-HEAD patch; reuse unchanged reviews.

## Writing rules

Apply these rules to agent communication and instructions.

Give one rule per sentence. Use active imperative sentences. Name actors and objects. Target 20 words per procedure sentence and 25 per descriptive sentence. Prefer clarity over compression.

Use plain language. Use “use”, not “utilize”. Keep precise terms when simplification loses meaning. Explain unfamiliar terms.

Rewrite confusing sentences. Delete unnecessary rules. Replace idioms, figurative language, and ambiguity with direct statements.

Use complete verbs and articles. Separate words without slashes. Spell out lists.

Put conditions first. State positive actions. Reserve “never” for Hard lines. Add a short reason when unclear.

Limit noun clusters to three words. Put warnings before affected steps. Use single-topic paragraphs of about six sentences. Omit nested parentheses.

Preserve exact code, commands, paths, identifiers, quotes, required headings, and schemas. Preserve requirement strength, uncertainty, conditions, exceptions, risks, and verification evidence. Support facts, causes, and guarantees.

Check lengths and terms before sending. Distinguish expected and observed results. State missing checks and unresolved questions. Use defined glossary terms without synonyms.

### Glossary

A pass verifies and reviews one candidate for completion.

A panel contains a pass's reviewers.

After a freeze, source changes invalidate affected verification and review results.

A candidate is the exact source under verification and review.

Clearance confirms a candidate passed all selected checks and reviews.

The governing matrix selects a Direct, Focused, or Full tier.

A station is an owner's defined scope.

## Delivery

- Before long work, check runtime, commands, network, authentication, database, and service identities.
- For ticket-shaped, resumed, or related work, reuse plans and dated logs. Map ownership, callers, contracts, risks, and checks. Stop reconnaissance when implementation is safe.
- Track multi-step work with live tasks.
- Default to concurrent workers for dependency-free disjoint paths.
- For behavior changes, run `live-verification` and tests. If reusable tooling is missing, use `build-live-verification`.
- Use `verification_evidence` with exact argv, repo-relative cwd, and timeout; use background `start` and `collect` by default. Limit synchronous `run` to explicit requests, background-service unavailability, or concrete lifecycle or correctness needs. Report unavailable checks as `Not run: <reason>`.
- Verify claims on their surface, including persistence; tests and screenshots alone cannot prove integration. Use local or test identities and owned resources. Missing prerequisites block claims.
- For integrations across Pi packages, first exercise their combined behavior in an isolated native session with exact candidate revisions. Select candidate resources explicitly; a working directory alone does not select the runtime.

## Web Search

- Use billed Kagi MCP searches: specific queries, few results; reuse before broadening.

## Implementation

- Before adding reviewer-requested defenses, identify an existing-check bypass.
- Follow repository conventions. Preserve unrelated behavior, trust-boundary validation, useful errors, accessibility, semantic HTML, state and styling patterns, strict types, and data-loss protection. Reject `any`, unjustified casts, disabled tests, swallowed errors, dead code, and debug code.
- Prove pivotal outside-diff assumptions in acceptance or logs. Inspect repeated casts, always-present optionals, and special cases before regex deletion.
- Model valid states and transitions. Distinguish semantic identifiers. Parse external input at its boundary. Derive authoritative schema types; use validated models internally without redundant guards.
- Give variables, functions, methods, classes, types, and files names whose intent is obvious to first-time readers. Use operation verbs and precise value and concept nouns. Reserve `data`, `utils`, `manager`, `handler`, and `process` for exact domain terms.
- Replace magic indexes and parallel arrays with named fields. Preserve required external indexes, then convert once. End text files with a newline.
- When overlap or dependencies require sequencing, complete, check, and inspect each increment.
- Follow [Tests](#tests) before editing production behavior.

## Tests

- Default to test-driven development (TDD) for behavior changes and bug fixes: red, green, then refactor.
- Before production edits, write requirement-derived tests. Confirm assertions fail on missing or incorrect behavior. Reject setup errors as red evidence.
- Make the smallest change that passes. Refactor only while green.
- Before behavior-preserving refactors, pass characterization tests. Check mechanical and documentation changes directly.
- If automated TDD is genuinely impractical, establish executable acceptance before editing. Explain why; disclose missing red and green evidence. Size and testing cost grant no exemption.
- Test observable contracts and failure paths. Fail plausible violations; pass internal refactors. Reject fixture-only, mock-only, and implementation-computed expectations. Preserve expectations for incorrect code.
- Run narrow checks during iteration and broad suites for final integration. Rerun expensive suites only when affected. Use `it.each([...])`.

## Comments

- Write no comments by default. Make names and structure self-explanatory.
- Comment only on essential, non-obvious reasons code cannot express.
- Explain only why, not what. Omit code restatements, doc comments, header banners, and section dividers.
- Delete unnecessary comments. Keep others short. Keep tickets in follow-up TODO or stub markers only.
