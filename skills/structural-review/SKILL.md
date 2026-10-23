---
name: structural-review
description: Challenge structural regressions and unnecessary complexity in a stable task-owned diff. Use for the full structural-review lane or an explicit demanding maintainability review, not every quick edit.
license: MIT
---

# Structural-quality review

Apply this lens within the full concurrent counterpart review or an explicit bounded review. Review the supplied candidate, exact patch and named connected contracts. Ponytail remains the canonical minimalism policy.

Look beyond local polish for a concrete smaller coherent design:
- Can whole branches, modes, wrappers or coordination layers disappear instead of moving around? Prefer fewer concepts, not merely more files.
- Does state/data modeling prevent impossible combinations and remove repeated special cases? Are authoritative schemas/types reused, and parsing confined to real external boundaries?
- Does logic live with its owner, using existing local helpers and caller contracts rather than leaking feature details into shared infrastructure?
- Are abstractions, casts, optionality and extension seams justified by actual callers? Preserve legitimate boundary unknown and useful validation; do not propose casts or speculative infrastructure.
- Can independent work run together without shared-write hazards? Can related updates become atomic without inventing a framework?
- Has the patch made a cohesive flow materially harder to understand or maintain? File growth is evidence to inspect, never an arbitrary line-count blocker or automatic extraction mandate.

For a structural finding, show the changed source, concrete maintenance/correctness cost, a smaller behavior-preserving alternative and why its benefit earns the change. Clear material structural regressions can block under the canonical role's P1 bar. Cosmetic preferences, hypothetical elegance and unrelated rewrites cannot. Preserve trust-boundary validation, error handling, accessibility, cancellation and cleanup.

Passing behavior is necessary, not sufficient: actively challenge substantial incidental complexity, misplaced ownership and tangled special cases. Avoid both rubber-stamping and abstraction-for-abstraction's-sake. Missing connected evidence stays a coverage gap, not a speculative finding. Parent adjudicates the final result.

Adapted from `thermos/skills/thermo-nuclear-code-quality-review/SKILL.md` in the local plugins source at revision `eb4db2b55b2b7dec3d9282754cddf0a56bf4ff10`. Removed the 1,000-line threshold and blanket restructuring mandate. [License](LICENSE).
