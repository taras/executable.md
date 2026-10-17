# Documentation correction at 91eb10bd

REQUEST CHANGES at `91eb10bd14b279dc764958972c401810a77f230d`, parent
`66d330ddffd62fda07fed317cd8281894269e48f`.

The substitution probe passes at `8be2d2bc`. The
[next review](pr2-documentation-planner-review-8be2d2bc.md) rejects the acknowledged
Core-only limitation and requests a private-wiring proposal for the execution's
existing captured reference.

The missing-chapter finding is fixed: both archived Syntax probes pass. The
replacement introduces one violation of the existing documentation ownership
boundary: it collects the mutable middleware chain again after execution has
started, instead of using the snapshot canonical execution already captured.

## P1: A running component can replace Core's documentation

`packages/core/src/generated-xmd.ts:2972` calls `capturedDocumentation()` while
evaluating a generated root. That function is a collector: it invokes
`Documentation.operations.contributions(read)` and snapshots its current answer.
It is not an accessor for the execution's earlier captured index.

Canonical execution already calls that collector in `execute.ts`, after trusted
bootstrap and before root import or any document code. Executable-MDX §5.3.1
requires collection once there; later middleware must not decide what the
product says about itself. Narrowing a reference preserves those captured
contributions, rather than reading the public chain a second time.

The reproducer installs `Documentation.around(...)` inside the running
SidekickHost component, after execution's collection. It delegates, changes
one sentence of the returned Core chapter, and then calls the real public
generated-root operation with the production CLI ceiling:

```xmd
<Output>
<Syntax names={["Syntax"]} />
</Output>
```

The result reports the protected `@executablemd/core` origin and includes:

> FORGED AFTER EXECUTION COLLECTION: the element

The replacement occurs only in document-time middleware, not in the package
asset or trusted installation. The unchanged-chapter control passes. This is
an observed break of the established capture boundary, not a speculative
lookup variant or a new acceptance requirement.

Carry the already captured owner-bound documentation through Core-private
reference/expansion wiring. Keep the root's admitted symbol table and protected
dispatch. Do not collect the public documentation chain during generated
evaluation, and do not store the authoritative snapshot in replaceable context
state. No new public GeneratedXmdRequest field is needed.

## Independent evidence

Working directory:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
```

PASS: 46 tests, 356 steps.

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-dc87c5fd.probe.ts /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-syntax-documentation-66d330dd.probe.ts
```

PASS: two tests, five steps. Original admission, array lookup and missing
documentation findings are closed at this revision.

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-documentation-capture-91eb10bd.probe.ts
```

FAIL: one failed capture-boundary step, one passed unchanged-chapter control.
Source: [pr2-documentation-capture-91eb10bd.probe.ts](pr2-documentation-capture-91eb10bd.probe.ts).
The first output, including the substituted chapter, is preserved in
[pr2-documentation-capture-91eb10bd.probe.log](pr2-documentation-capture-91eb10bd.probe.log).

The feedback commit changes only generated-xmd.ts and its root regression file.
HEAD/parent match the handback. There are no tracked worktree changes;
`packages/cli/src/repl/sidekick/gate.ts` remains untracked, untouched and outside
this review. No CI or GitHub state was inspected or changed.

## Revision prompt

At 91eb10bd, keep the restored long-form chapters, canonical root Syntax
installation and admitted vocabulary. Replace the document-time
`capturedDocumentation()` call with reuse of the owner-bound snapshot captured
before root import. Pass it through canonical private reference/expansion
machinery, preserving the existing no-late-middleware-rewrite rule and fragment
behavior. Add one regression for a running component's attempted replacement
alongside the existing genuine-chapter control. Run the unchanged capture probe,
both archived Syntax probes and the focused command above. Commit promptly and
return exact SHA/parent and commands/results. Leave unfinished gate work outside
the correction commit.

## Continuity

The sole current blocker is document-time recollection of the documentation
chain. Earlier controls, names-array, scoped dispatch/lifetime, storage,
projection, process recovery and output acceptance stands. After this correction,
continue the shared admission gate and R2 cases 3/4 within PR 2. The series remains
two PRs; this review adds no GitHub-write authorization.
