# Make an invalid Parse fail the entry it belongs to

**Deferred by the Product Owner, 2026-10-16:** tracked independently as
[issue #922](https://github.com/taras/executable.md/issues/922). This is not
pending work or a gate for #883 / PR #921. The instructions below are historical
investigation material for that later correction, not an active Architect
assignment. The uncommitted probe is preserved byte-for-byte at
deferred-issue-922-repl-component-error-status.test.ts.txt outside the PR
worktree; its first failing output stays beside this document.

Follow .agents/architect.md and resolve the Core failure boundary identified
below. Return a bounded correction ruling and its canonical-outcome evidence
to the Planner. Do not change the REPL's displayed status or implement a broad
component-failure rewrite as a substitute.

## Observed state

- Implementation head: 940249af47159a3bbd960b8ca8df3f10bb53811c, parent ff0e52c6.
- Worktree: .claude/worktrees/issue-883-pr2, branch agent/issue-883-pr2.
- Task A is already PASS; B–D remain untouched with product decisions open.
- A supplied new probe is untracked at
  packages/cli/tests/repl-component-error-status.test.ts. Preserve it and any
  other work. No production source was changed by this diagnostic.

The two Parse component files have identical blobs at current HEAD, the PR base
79d404d0 and local main:

```text
Parse.ts      1c90802a07021690e763084860df889235f26252
SafeParse.ts  42a40c8537088d1f7e08140bfa382395d784f11d
```

This is a pre-existing Core boundary exposed through the REPL, not evidence
that #921 introduced either declaration. The Architect should state the proper
correction/stack boundary rather than silently expanding an accepted UI slice.

## Independent reproduction

```sh
deno task test packages/cli/tests/repl-component-error-status.test.ts
```

First output: pr921-component-error-status-review-940249af-first.log.
The probe was run unchanged. Both invalid-input steps fail at the same
observation: the canonical terminal status is `ok`, expected `err`. Both the
valid-input and explicit SafeParse-result controls pass. This is fixed input;
no agent, transport or external JSON source is involved.

The source puts Parse inside Each inside Output. One invalid input omits the
required `worry` field; the other is malformed JSON. The source then reads the
unbound `ballot` and has later text. The REPL records the entry settled and no
longer live, with an `ok` terminal rather than a failed entry.

## Trace and governing contract

1. Core's Parse.ts:46 declares its implementation with printErrors(). It throws
   ParseValidationError for bad JSON or a rejected value.
2. expand.ts's function-invocation acceptance path detects that declaration and
   installs usePrintErrors("component") around the invocation.
3. component-failures.ts installs `print` rather than the enclosing `output`
   mode and turns the component's own failure into a reported ErrorSegment.
   That is legitimate machinery for a component that intentionally declares
   recovery, but it makes Parse continue in this case.
4. Json is also a printing component; reading the missing ballot can add another
   printed failure rather than stop the document.
5. execute.ts completes the text root with a successful DocumentResult because
   no failure escaped. repl/session.ts forwards that canonical outcome. The
   REPL is not relabeling an Err as Ok.

The governing spec §6.12 says Parse binds a validated value or fails, while
SafeParse returns a result the document can inspect. The colocated
SafeParse.test.md explicitly describes SafeParse as avoiding ending the run
when the answer is no. Spec §5.4 gives a text root the `output` error mode, with
explicit printing boundaries for continued execution.

The specification also permits printErrors(fn) declarations and historically
describes Parse diagnostics as printed errors. The implementation must therefore
be corrected at the component's chosen policy, or that contradiction must be
explicitly ruled on; a blanket “all printed error text means failed run” policy
would break legitimate authored recovery.

Core's existing parse-components.test.ts does not discriminate this outcome.
Its helper records `failed`, but PC10/PC11 inspect only error wording. Several
unusable-schema rows similarly inspect diagnostics/absence of child effects
without asserting that the root failed. That explains why this can remain green.

## Recommended bounded ruling

Make Parse's own JSON/validation failure propagate under the caller's normal
failure mode; do not make Parse silently opt into printing/recovery. Keep an
authored PrintErrors region as the explicit way to continue with a diagnostic.

Keep SafeParse's successful structured invalid-input result unchanged. Its
existing typed result is how a document deliberately branches on invalid JSON.
Review its printErrors declaration separately for failures it promises not to
absorb: unusable schemas and failed child execution. Do not infer a new policy
for unrelated File, Json, TempDir or third-party components from this report.

The correction must make the canonical execution result and saved terminal
truthful. No output-string scan, REPL-only failure flag, second journal or
post-hoc rewriting of already recorded successful terminals. State how existing
completed histories retain their recorded outcome and how new executions are
tested, without rerunning old effects to manufacture another result.

## Evidence for the ruling and later Planner assignment

- Preserve both supplied invalid-input regressions and the valid/SafeParse
  controls; observe the canonical terminal and the returned execution outcome.
- Prove later work does not start after an unhandled Parse failure, and the
  existing partial-output policy survives. Do not merely change a badge.
- Distinguish ordinary failure from an explicit PrintErrors recovery control.
- Keep normalized error details, schema-before-child-effect ordering and
  SafeParse's explicit invalid-input result. If the ruling covers unusable
  SafeParse schemas, assert their actual failed outcome as well as no effects.
- Observe a completed failed execution replay without another effect or append.
- Preserve the ordinary component printing/recovery contract; do not expand
  this into a repository-wide component sweep.

The Planner freezes the final focused commands after the ruling. Likely
consumers are Core parse-components/output-error-mode and the supplied REPL
integration, with the existing component-failure boundary tests selected by
their actual imports. No full runtime suite, CI, cache repair or GitHub write is
requested by this return.

## Continuity

Produced: this Architect return and the independently preserved first output.
Unresolved: Core's parsing-component recovery policy and the correction's stack
placement. No production change is released by this document. Task A remains
accepted at 940249af; B–D's unrelated product decisions remain pending. Next
action: Architect returns the bounded ruling, then Planner issues the finite
Implementor correction.
