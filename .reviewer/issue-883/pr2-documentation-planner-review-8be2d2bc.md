# Core-only documentation fallback at 8be2d2bc

REQUEST CHANGES at `8be2d2bc3c38c4a896d0b678e121beef28e02920`, parent
`91eb10bd14b279dc764958972c401810a77f230d`.

The late-middleware substitution finding is closed. The submitted fallback
does not meet the accepted requirement to preserve the execution's composed,
captured documentation: it reads only Core's package asset during evaluation
and drops chapters contributed by other bootstrapped packages.

## Decision: preserve the execution's captured reference

The Implementor correctly reports that the current public root operation cannot
reach the execution-private reference through an existing seam. That is the
remaining integration work; it does not authorize reducing canonical named
lookup to Core's documentation alone.

Pinning an implementation controls whether a response may execute it. Its
short definition description and its owning package's long-form chapter are
different reference material. A host can pin a package component; doing so does
not make that component a host-owned component or replace the package's chapter
with a short description. Canonical documentation still joins by name and owner.

The named-reference contract in Executable-MDX §5.3.1 composes package
contributions and captures them once before root import. The root correction
preserves that contract while describing the root's actual admitted vocabulary.
It must neither recollect document-time middleware nor substitute a fresh
Core-only index for the captured one. A passing Core chapter probe proves the
original regression closed, not this acknowledged loss of package contributions.

The architectural direction remains the same: reuse the owner-bound captured
reference through Core-private expansion/reference plumbing. The existing
`SyntaxReference.available()` already carries captured documentation when
narrowing; the missing part is making the appropriate trusted reference reach
the host root path. Do not expose raw contributions or install authoritative
state under a replaceable Context name. Keep the public GeneratedXmdRequest
shape and released fragment behavior unchanged.

## Next action: return the private wiring proposal

Before another implementation, bring back the smallest concrete wiring proposal
with these facts:

- Where the existing execution capture/reference is held and which canonical
  owner carries it to host root evaluation.
- Which internal expansion/reference call boundaries change, and how the root
  keeps its own admitted executable vocabulary.
- How ownership and lifetime prevent another scope, document middleware or a
  separately loaded copy from substituting the authoritative reference.
- Whether any proposed change exceeds private plumbing or the existing public
  request contract; surface that explicitly rather than replacing the contract.

This proposal resolves the missing connection. It is not a request for another
Core-only fallback, a new delivery split or another product decision.

Implementation evidence remains the focused command and the three unchanged
probes below. Add one positive regression retaining a trusted bootstrapped
package chapter for its pinned component, so the admitted limitation cannot
pass unnoticed. The existing late-middleware regression remains the negative
control; no package-by-package matrix is needed.

## Independent evidence at this revision

Working directory:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
```

PASS: 46 tests, 357 steps.

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-dc87c5fd.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-syntax-documentation-66d330dd.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-documentation-capture-91eb10bd.probe.ts
```

PASS: three tests, seven steps. No new failing probe is claimed: the loss of
package contributions is explicit in the handback and directly visible in the
new reference's sole Core contribution.

HEAD/parent match the handback. No tracked worktree changes exist;
`sidekick/gate.ts` remains untracked and outside this review. No production code,
CI or GitHub state was changed by the Planner.

## Continuity

Late middleware can no longer replace the returned Core chapter. Earlier
Syntax admission, array lookup, ordinary capture and scoped lifetime findings
remain closed. The remaining blocker is reuse of the execution's captured
composed documentation, not another syntax permutation.

Next Implementor action is the private-wiring proposal above. After its
implementation is accepted, continue the gate and R2 cases 3/4. The series
remains two PRs with the Core correction inside PR 2. No GitHub writes are
authorized by this review.
