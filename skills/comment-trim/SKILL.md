---
name: comment-trim
description: Trim or audit code comments to a sparse why-not-what baseline when the user asks.
allowed-tools: read, bash, edit
---

# comment-trim

## Principle

Sparse comments. Explain the **why**, not the **what** — and only when necessary. Prefer deletion to rewriting; if a comment isn't earning its line, it goes.

If the repo has its own comment-style doc (`CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, or `STYLE.md`), read it first and let it override this skill on conflict.

## Invocation modes

**Mode 1 — Explicit user request** (`/skill:comment-trim`, "trim the comments in X"): full workflow — discover → diagnose → **propose** → wait for confirmation → apply → verify. The propose step is the safety gate.

**Mode 2 — Self-applied** (cleaning its own diff at closeout, or a tech lead applying mid-flow): no propose step, no confirmation gate. Inspect only the exact current-session patch, then diagnose → apply → report in the closing summary. **When in doubt, keep** — no gate means be conservative. Touch only comments authored in the current session; leave unrelated pre-existing comments alone.

## Scope

- **Default target:** files changed on the current branch vs the repo's default branch.
- **If the user names files/dirs:** use those instead.
- **Never touch:**
  - Generated files (`*.gen.*`, `*.pb.*`, codegen banners like `// AUTO-GENERATED`, `# DO NOT EDIT`).
  - Build outputs (`dist/`, `build/`, `target/`, `out/`, `.next/`, `.nuxt/`).
  - Third-party trees (`node_modules/`, `vendor/`, `.venv/`, `Pods/`).
  - License headers, copyright notices, shebangs.
  - Lint-suppression comments **that carry a justification** (e.g. `eslint-disable-* -- reason`, `# noqa: E501 reason`, `@ts-expect-error: reason`).
  - Snapshot files (`*.snap`, `__snapshots__/`) and golden fixtures.
  - Test data files unless explicitly requested.

## Workflow

1. **Discover targets.** With args: use them. In Mode 2, use only the exact current-session patch; never substitute a branch-wide diff. In Mode 1 with no args, resolve the remote default branch, then local `main`, then local `master`:
   ```sh
   base_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
   for ref in "$base_ref" main master; do
     if [ -n "$ref" ] && git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
       base_ref=$ref
       break
     fi
   done
   [ -n "$base_ref" ] && git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null || exit 2
   git --no-pager diff --name-only "$(git merge-base HEAD "$base_ref")"
   ```
   Filter to source files (skip lockfiles, generated paths, binaries). If no base ref resolves, ask the user for one.
2. **Diagnose.** Enumerate every comment with a proposed action: `delete` / `trim` / `keep` / `ask`.
3. **Propose** (Mode 1 only). Plan grouped by file: file → comment → action → one-line reason.
4. **Apply.** Mode 1: only after the user approves; resolve every `ask` individually first. Mode 2: apply directly.
5. **Verify.** Run the project's existing lint/format/type-check via `package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc. Do **not** introduce new tooling; if there's no clear command, confirm files still parse and ask the user how to verify.

## Decision table

| Pattern | Action |
|---|---|
| Restates the code (`// increment counter` on `counter++`) | **delete** |
| Tutorial narration (`# First we X, then Y, then Z`) | **delete** |
| Section banner (`// ===== HELPERS =====`) | **delete** |
| Filler / reassurance (`// this works`, `// safe to ignore`) | **delete** |
| AI chatter (`// Updated to handle new case`, `# Refactored above`) | **delete** |
| Over-elaboration: multi-line gloss on a short guard, alternate-timeline narration, reference trails, defensive verbosity | **trim** to one sentence |
| Bare `TODO` / `FIXME` / `XXX` with no ticket or context | **delete** (or ask to add a ticket ref) |
| Ordinary comment contradicted by current code (stale) | **delete**; for a public-API docstring, update it only within explicit scope or **ask** |
| Commented-out code with no explanation | **delete** |
| Non-obvious *why* (business rule, perf tradeoff, workaround, ordering, regulatory constraint) | **keep** |
| Invariant / gotcha / counterintuitive constraint | **keep** |
| Link to RFC, ticket, upstream issue, vendor doc | **keep** |
| Public-API docstring (JSDoc, Python `"""..."""`, Go `// Foo ...`, Rust `///`) | **keep** |
| Lint suppression with a `-- reason` / `# reason` | **keep** |
| Ambiguous — could be load-bearing context | **ask** |
