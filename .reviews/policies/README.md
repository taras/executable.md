# Review Policies

The executable policy documents and the reusable review components they compose
with are installed from `@executablemd/code-review-agent`, not from this
directory. The package declares them to every `xmd` run, so a review resolves the
same components whatever checkout it is reviewing and whatever directory it runs
from — which is the point: a review must not be answerable by its subject.

The policies live at `packages/code-review-agent/src/documents/policies/`:

- `ScopePolicy.md` checks PR size and scoping hygiene.
- `BloatPolicy.md` surfaces structural bloat patterns.
- `SlopPolicy.md` surfaces verbosity/slop indicators.
- `ExtraneousCodePolicy.md` asks for semantic/correctness-focused review.
- `RepoCleanupPolicy.md` performs repo-wide cleanup policy analysis.

Policies are composed by report components, which the same package declares:

- `PrPolicyReport` composes PR policies.
- `RepoPolicyReport` composes repo policies.

Reusable workflow steps and primitives are at
`packages/code-review-agent/src/documents/components/`, and the six TypeScript
components at `packages/code-review-agent/src/components/`.

What stays here is this repository's own review programs — `ReviewPR.md`,
`ReviewPR.local.md`, `AnalyzeRepo.md`, `AnalyzeRepoCI.md` and
`DispatchRepoAnalysis.md` — which compose the installed components, together
with the sensor configuration and runtime state those runs read and write
(`.oxlintrc.json`, `.oxlint/`, the generated `tsconfig.oxlint.json`, and the
journals). None of the review and analysis commands passes a component
`--include`.
