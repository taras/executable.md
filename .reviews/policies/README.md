# Review Policies

This directory contains discrete, executable policy documents.

- `ScopePolicy.md` checks PR size and scoping hygiene.
- `BloatPolicy.md` surfaces structural bloat patterns.
- `SlopPolicy.md` surfaces verbosity/slop indicators.
- `ExtraneousCodePolicy.md` asks for semantic/correctness-focused review.
- `RepoCleanupPolicy.md` performs repo-wide cleanup policy analysis.

Policies are composed by report components:

- `PrPolicyReport` composes PR policies.
- `RepoPolicyReport` composes repo policies.

Reusable workflow steps and primitives remain in `.reviews/components/`.
