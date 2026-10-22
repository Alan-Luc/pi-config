---
description: Review current changes for material issues
argument-hint: "[slice map]"
---
Act as the tech lead and review only the stable complete task-owned change: `${@:-the current changes}`. A clean review is valid; do not dispatch speculative follow-ups.

Reuse supplied same-target Git evidence. Use `inspect_change` only when Git evidence is missing or inputs changed; do not repeat a recorded failure on unchanged inputs. Establish the review target before calling it:
- Uncommitted work: `{}` (staged, unstaged, and untracked changes).
- A commit or endpoint range, including pushed task changes: explicit `base` and `head`, with `comparison: "direct"` (the default). Last commit: `{"base":"HEAD^","head":"HEAD"}`.
- A branch's changes since divergence: `{"base":"<target-branch>","head":"<task-branch>","comparison":"merge-base"}`.

An empty worktree packet does not mean there are no task changes. Omitted content is not evidence of absence. Use `inspect_context` once only when ownership, callers, or contracts remain unclear.

For an explicit review of changes that predate the current task, add one matching line to the reviewer brief's Scope: `Review range: HEAD` for current worktree changes, `Review range: <base>..<head>` for a direct committed range, or `Review range: <base>...<head>` for a committed branch compared from its merge base. Omit it for normal task-owned reviews.

Before dispatch, derive a concise risk/coverage map from the actual change using existing reasoning/plan/briefs, not a new report. Select necessary seats first; zero warranted seats stays zero. Size by uncertainty, consequences, trust/shared contracts and irreversibility, never LOC or available capacity. Assign cross-component interactions explicitly. Then pair each selected seat once across its counterpart profiles with identical briefs; different seats may own different risks. Do not inflate base seat count to fill a team.

| Selected responsibility | Persisted profiles |
|---|---|
| Focused review seat | `code-reviewer` + `code-reviewer-sonnet` |
| Difficult review seat | `code-reviewer-sol` + `code-reviewer-opus` |
| Consequential independent proposals | `implementation-engineer-sol` + `implementation-engineer-opus` (planning owns selection, not review voting) |

Use each profile's exact persisted model/effort, not inferred launch overrides or substitutions. Difficulty/consequence determines tier, not a security/architecture label alone. At most eight live children total, including other workers; eight is capacity, not a required team size. Launch ready independent work together through tool-owned delegation; admit complete pairs in capacity-bounded waves, retaining required coverage. A missing model or missing counterpart leaves the seat incomplete.

For each pair supply identical intent, risk, candidate/base/head provenance, patch/hash, absolute source/dependency paths, check evidence, skill lens and done criteria. Read first must include the absolute canonical role file (`<config-root>/agents/code-reviewer.md`, or implementation-engineer for proposals), so model-only variants reliably load the same role body. Select `correctness-review` for correctness/security/setup/evidence risks and `structural-review` for material ownership/complexity risks; one coherent seat may use both when justified. Use `deslop` within existing work, not a compulsory extra pass. Include the required skill's exact absolute path. A wider connected-code scope may explicitly authorize a larger bounded read budget; missing evidence never becomes a finished finding.

Review one immutable patch/context snapshot. A committed SHA does not freeze connected live reads: keep every named review/dependency path protected from edits until both counterparts return, or supply a consumable immutable source snapshot. Continue only outside that protected set; otherwise defer review until stable. Reconcile each result against intervening changes and dependencies. Stale clearance cannot approve changed code. Keep counterpart outcomes independent until parent synthesis; all required results must be fresh and complete. One targeted retry may address a transient/malformed dropout; reproducible defects require remediation, not repeated respawns until green. Missing coverage is not success.

Parent adjudicates concrete triggering cases and evidence, not votes. Deduplicate findings, record justified dismissals and unresolved gaps in existing plan/log artifacts, and retain a clean verdict when warranted. Hard security/correctness/data-loss failures cannot be offset by aggregate scores. Solo cannot supply paired/model-diverse review; disclose that limit without pretending coverage.

The generated default-reviewer brief supplies the candidate, patch hash, bounded patch artifact, and exact absolute review paths. Other persisted reviewer profiles require the parent to provide the same immutable metadata explicitly; do not assume the default-name preparation hook handles them. Also provide the active plan/decision evidence packet, callers/callees, test dependencies, objective, material risks, and stop condition. Expand beyond the patch only for one named connected-code, security, performance, UI, testing, or architecture risk. Use a fresh selected reviewer-profile task for each new review; never resume one for a new delta.

If material fixes occur, rerun affected focused checks and start one remediation review covering only the remediation delta and affected contracts. Do not rereview unchanged clean regions. Before freezing the candidate, reconcile or kill every task-owned background job. Run the required broad integration recipe once against the accepted candidate, then recapture the candidate. Any failed check, stale evidence, candidate mismatch, source mutation, or failed recapture invalidates the review/verification claim.

For final verification, run only the expected exact argv through `verification_evidence` against the candidate, repository root, repository-relative cwd, and timeout. Keep review and verification sequential when checks are cheap or the candidate is volatile. After the final task commit, inspect the exact pre-task-base-to-final-HEAD integration patch for unintended changes; do not independently rereview an unchanged patch. Report evidence-backed P0/P1/P2 findings with `file:line`, or a clean verdict.
