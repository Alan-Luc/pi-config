# Pi harness

## Guard ownership

The standalone `pi-guardrails` package owns Git and publication enforcement.
Pi-config keeps verification, clearance production, review enforcement, and workflow artifacts.
The package requires current producer clearance for strict publication.
An absent or disabled package cannot enforce policy.

Run migration tests with `PI_GUARDRAILS_TEST_ROOT` pointing to the pinned package checkout.
Use `PI_MIGRATION_SDK_ROOT` to select the managed SDK package when needed.
Keep installation, activation, and every push separately authorized.

## The kitchen

The harness is modeled on a Michelin kitchen. Agents use the functional
names; the kitchen names are for people reading the repo.

| Kitchen | Harness | Where |
|---|---|---|
| Patron | Alan | — |
| Chef de cuisine | Tech lead | `extensions/tech-lead/` |
| Chefs de partie | Implementation and test engineers | `agents/implementation-engineer*.md`, `agents/test-automation-engineer.md` |
| Commis | Explorer | `agents/code-explorer.md` |
| The pass | Review panel and live verification | `agents/code-reviewer*.md`, `agents/live-verifier.md`, `prompts/eviscerate-diff.md` |
| Station | An owner's defined scope | Glossary in `AGENTS.md` |
| Recipe | Task recipe | `skills/task-recipe/` |
