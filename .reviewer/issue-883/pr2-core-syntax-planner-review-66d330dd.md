# Core Syntax correction at 66d330dd

REQUEST CHANGES at `66d330ddffd62fda07fed317cd8281894269e48f`, parent
`80a2c4b604e039cdacec663efdef60b063484b74`.

The missing-chapter finding closes at `91eb10bd`. The
[subsequent review](pr2-documentation-planner-review-91eb10bd.md) records a
capture-boundary regression introduced by recollecting documentation at runtime.

Canonical Syntax admission, protected dispatch, ordinary capture and read-class
selection now work through the public root operation. All three original
controls probe cases pass. One existing canonical-reference requirement remains
unmet: named lookup drops the owning package's long-form documentation.

## P2: Named Syntax lookup loses package documentation

`packages/core/src/generated-xmd.ts:2958` creates the root reference with
`syntaxReference(admittedSymbols(entries.map(captured)))`. The reference
factory's third argument is the captured documentation contributions. Omitting
it supplies an empty index. The admitted symbols therefore survive, but the
package chapters do not.

Through the actual CLI response ceiling and public Core root operation:

```xmd
<Output>
<Syntax names={["Syntax"]} />
</Output>
```

The response identifies Syntax as an available protected component from
`@executablemd/core`, prints its props/returns metadata, then says:

> No long-form documentation is available for this component.

Core ships that documentation in `packages/core/src/components/components.md`,
under `## Syntax`. Its first paragraph begins “Inspects the components and
control-flow constructs available where the element is written.” None of that
chapter reaches this response.

This is the established named Syntax contract in executable-mdx-spec.md §5.3.1:
selected metadata followed by owning-package documentation, joined by name and
owner. The no-documentation fallback is for custom components. The accepted
Sidekick architecture preserves canonical Syntax and its reference semantics;
the authorized correction explicitly uses the canonical symbol and
documentation machinery. This finding restores that requirement rather than
adding another lookup permutation.

GR24 (`packages/core/tests/generated-xmd-root.test.ts:863`) currently checks only
that the output contains “Json”. That assertion passes on metadata alone and
does not establish the named documentation behavior its title claims.

Keep the current protected installation and root-only admitted vocabulary.
Supply the canonical owner-bound documentation contributions to the reference
without inheriting wider executable authority. Strengthen GR24 to compare
actual first-party chapter content, and keep the bare read as a control. Do not
copy chapter prose into an alternative catalog or loader.

## Accepted portions

The scoped installation reuses the minted identity domain and protected routing.
It is inert until activated; cleanup registration precedes activation and
expansion. The encompassing scope joins its work before revocation. Syntax is
added only to root read selection, retained in root policy, and absent from the
unchanged fragment path. Ordinary rendering and response-local capture work.

The lazy `coreDocumentedNames()` change is a reasonable correction to the
module-initialization cycle introduced by this integration. It preserves the
same names and consumer, deferring the read until documentation collection.
It needs no separate delivery split or architecture decision.

The CLI lists canonical Syntax as a non-designated read. The names-array
correction remains accepted. These portions do not need redesign for the
remaining documentation fix.

## Independent evidence

Working directory:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
```

PASS: 46 tests, 355 steps.

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-dc87c5fd.probe.ts
```

PASS: one test, three steps. The original Syntax refusal and names-array
refusal both close at this revision.

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-syntax-documentation-66d330dd.probe.ts
```

FAIL: one failed documentation step, one passed bare-read control. The source
uses the submitted response profile and actual Core evaluator. The first output
including the actual missing-documentation response is preserved in
[pr2-syntax-documentation-66d330dd.probe.log](pr2-syntax-documentation-66d330dd.probe.log).
The reproducer is
[pr2-syntax-documentation-66d330dd.probe.ts](pr2-syntax-documentation-66d330dd.probe.ts).

HEAD/parent match the handback and the implementation worktree is clean.
No production files, CI or GitHub state were changed by this review. The user's
whole-Core, lint/check and docs-gate results are reported evidence; the independent
commands above are the basis of this review.

## Revision prompt

At 66d330dd, retain the current scoped canonical Syntax installation and root
admission. Correct the root reference's empty documentation index so named
Syntax reads include the owning package's real chapter through the canonical
documentation machinery. Keep the executable vocabulary limited to the root's
admitted table, preserve capture/retention and leave released fragment behavior
unchanged. Strengthen GR24 to establish actual chapter content rather than a
component name. Run both unchanged Planner probes and the focused test command
above, then commit promptly and return the exact SHA/parent and evidence.
No guide-asset, admission-gate or conversation-owner work is required to close
this correction.

## Continuity

The original dc87c5fd findings are closed at this revision. The sole blocker for
accepting this correction is the named documentation requirement above. Earlier
storage, projection, recovery and output acceptance stands. After correction,
continue the shared root gate, separate Draft/Message revisions, reservation and
R2 cases 3/4. The series remains two PRs, with complete CLI PR 2 still unfinished.
