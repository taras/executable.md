# U3 Implementor feedback revision — `ac466780`

The Planner's draft `cf95c097` is superseded. Its behavior was correct against the
accepted contract; the defects were in one contract shape, one unnecessary module
move, and documentation. This revision carries the same observable behavior with
those corrected, and the frozen U3-1–U3-12 matrix and focused commands unchanged.

## Revision

| Item | Value |
| --- | --- |
| Feedback SHA | `ac466780cda608eafe974951c13c09c02b2b1cd4` |
| Tree | `1d807b062a9d4608ff37dabbc4eab755d9b2f95e` |
| Base | `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec` (landed U2, unchanged) |
| Signature | `G` (good, SSH via 1Password) |
| Worktree | `.claude/worktrees/u3-contextual-syntax`, clean |
| Branch | `agent/upstream-u3-contextual-syntax`, one commit, unpushed |
| Changed | 31 files, +1538 −394 |
| Superseded draft | `cf95c097a97273573fb7975af31b7c22fac0ef15`, preserved at `refs/tags/u3-planner-draft-cf95c097` |

The draft was an unreviewed Planner artifact, not a Planner PASS. It is retained
by ref rather than left on the branch, because U3 is one reviewable change.

## Defects corrected in the draft

### 1. Two competing descriptive setups on the Plan path (contract)

`PlanWriterProfile` carried `symbols?`, `includes?` and `plugins?`, all optional,
and `runPlanCommandDocument()` installed **both** `useCommandSyntax(...)` and
`useSyntax(profile.symbols)` at `min` in one scope when both were supplied —
which every harness-driven `runPlan` case did. Which profile a document saw was
then a question of install order, the hazard the removed one-provider count rule
existed to prevent. `PlanDependencies.symbols` had also been weakened to
optional, and `plan-cli.test.ts` was edited to add an `undefined` guard for it.

Corrected to one required setup operation, which is what A3's placement actually
needs: binding and building are different moments, so a bare symbols callback
cannot express the target-run case at all (`useSyntax` snapshots documentation
contributions from its calling scope).

- `PlanDependencies.installSyntax(includes): Operation<void>` — required.
- `PlanWriterProfile.installSyntax(): Operation<void>` — required; `includes`,
  `plugins` and `symbols` removed from the profile.
- `cli.ts` supplies `(includes) => useCommandSyntax(includes, plugins)`.
- The harness supplies its own lazy source through the same helper, so a case
  replaces the description rather than the way it reaches the execution.
- The `undefined` guard added to PO15 is reverted. PO15 now observes through
  `createPlanHarness`'s existing `symbols` option, which keeps its assertion set
  (`symbolCalls`, `before`) and its subject — *when the catalog is built*, not
  when it is bound.
- `plan-writer-profile.ts` no longer imports from `cli/src/syntax.ts`.

### 2. `NO_DOCUMENTATION` relocation (verified, kept, now correct)

The draft moved the constant into `syntax-markdown.ts` and left a re-export
behind in `documentation-index.ts` that nothing imported, with the `export const`
spliced into the middle of an import block.

I reverted the move to test whether it was needed. It is: `evaluation-profile.test.ts`
then fails with `ReferenceError: Cannot access 'SYNTAX_PROTECTED' before
initialization` at `components/protected.ts:129`. The new edge
`components/Syntax.ts → syntax-api.ts → syntax-markdown.ts →
documentation-index.ts → components/registration.ts → components/protected.ts`
closes a cycle through `protected.ts`'s own module body.

Kept the move, cutting the right edge and leaving no dead export: the constant is
defined in `syntax-markdown.ts` beside its only consumer with the structural
reason stated, `documentation-index.ts` no longer mentions it, and `mod.ts`'s
public export follows the definition.

### 3. `ProjectionState.syntax?` (optional member hid the boundary)

Every other `ProjectionState` member is explicit `| undefined`; the draft added
`syntax?: SyntaxReference` and relied on optionality at the two construction
sites. Renamed to `narrowedSyntax: SyntaxReference | undefined` and stated at all
three sites, so the distinction that matters is legible: it is set *only* where a
boundary narrowed the admission, because reinstalling the execution's own
reference as middleware on every ordinary handle would shadow an enclosing host
profile — exactly what A3 forbids.

`useSyntaxReference` is renamed `useNarrowedSyntax` for the same reason: it sat
one line from `useRootSyntaxReference` while doing the opposite thing (middleware
that shadows, versus a fallback that must not).

### 4. Dead guard in `executeDocument`

`if (environment.syntax !== undefined) { yield* useRootSyntaxReference(...) }`
was unreachable-false — the object literal above always assigns it. The derived
reference is now bound to a local and installed directly.

### 5. Documentation

The draft deleted prose the change does not untrue, and left the new modules
undocumented. Nothing behavioral changed here.

- Restored and amended the module headers of `components/Syntax.ts` and
  `syntax-reference.ts`, and `SyntaxReference`'s member documentation. Amended
  only the claims contextual dispatch makes false (symbols must match what runs;
  the component answers from one lexical reference; "nothing is read from a
  context"); kept name protection, the two-input reason for named lookup, and the
  narrowing seam's reason.
- Wrote module and member documentation for `syntax-api.ts` and `use-syntax.ts` —
  in particular why the properties are Operations, and why the root fallback is a
  context while narrowing is `min` middleware.
- Documented `ExecutionApi.init`, the no-op default (versus the two refusing
  terminals beside it) and the `invoke()` call site's position.
- Documented the new `/api`, `/host` and root exports in the style each file
  uses, and `useCommandSyntax`/`syntaxText`.
- Restored architecture's pinned-bundle-bytes paragraph and the executable spec's
  reason for reading packaged documentation off the direct filesystem; both remain
  true, and the spec now states the live-middleware fact beside the reason rather
  than in place of it.
- Restored the `<Plan>`-is-part-of-the-run-profile comment dropped from
  `cli/src/syntax.ts`.
- Moved six hoisted imports back below the module headers they had detached.
- Rewrapped every added prose line in `architecture.md` and both specs to the
  surrounding width, and fixed the comma splice and run-on in `execute.ts` and
  `repl/expansion.ts`.
- Sharpened spec row SA5 ("with all live providers tripped" read as though they
  had been) and, in `plan-writer-profile.ts`, replaced an asserted reason for the
  nested scope with the verified one: the declarative bootstraps re-register
  names the operational install already holds, and registration refuses
  `two registrations for "AgentProvider" at the same scope` unless the shadowing
  one nests. Confirmed by probe before stating it.

## Row map

| Row | Evidence | Result |
| --- | --- | --- |
| U3-1 | `execution-init.test.ts` EI1; `execution-protocol.test.ts` | pass |
| U3-2 | EI2 — observed order `init, install, documentation, execute, document`; EI3 | pass |
| U3-3 | EI4 (failure joins teardown, no policy, empty stream), EI5 (cancellation), EI6 (independent + inherited) | pass |
| U3-4 | EI7 (`files-fatal`: no-op invents none, init supplies one); EI-REPL (`repl-execution`); EI-child (`testing-execution-host`) | pass |
| U3-5 | `syntax-api.test.ts` SA1 (`Api<SyntaxApi>` identity, two reads = two source reads, suspending transform), SA2, SA3 | pass |
| U3-6 | SA2 (`source === 1 && effective === 1` for one named occurrence), SA4 (two moving occurrences resolve independently), `syntax-component` SYN49/catalog, dead-code gate | pass |
| U3-7 | SA5 (replay under providers that throw if consulted, complete and partial), SA4 (final transformed text in `syntax_symbols`), SA8 (safe refusal retained; provider-thrown `UnknownComponentError` terminal) | pass |
| U3-8 | SA6, SA7; `evaluate-component` FE34; `evaluation-profile`, `generated-xmd` | pass |
| U3-9 | `syntax-loaded-copy`, `evaluate-loaded-copy`; SA9 — a separately constructed same-name descriptor supplies the description and canonical core's definition still runs | pass |
| U3-10 | `syntax-cli`, `plan-component`, `plan-command-document`, `plugin-api`, `plugin-host`; `plan-cli` PO15 | pass |
| U3-11 | `workflow-run`, `workflow-run-journal`, `workflow-component-bundle` | pass |
| U3-12 | `deno task build`, `plan-component-compiled`, `plugin-compiled`, `lint:dead-code` | pass |

## Focused commands and results

All run at tree `1d807b06`. Logs in this directory as `u3-implementor-*.log`.

| Command | Result |
| --- | --- |
| `deno task test` group 1 (`execution-init`, `execution-protocol`, `files-fatal`, `workflow-component-bundle`) | `ok \| 7 passed (112 steps) \| 0 failed (2s)` |
| `deno task test` group 2 (8 core Syntax/Evaluate/generated suites) | `ok \| 59 passed (417 steps) \| 0 failed (5s)` |
| `deno task test` group 3 (8 CLI/plugin suites) | `ok \| 41 passed (226 steps) \| 0 failed (1m26s)` |
| `deno task test` group 4 (`workflow-run`, `workflow-run-journal`) | `ok \| 10 passed (69 steps) \| 0 failed (2s)` |
| `deno task test` Plan-affected (`plan-cli`, `plan`, `plan-host-acts`, `agent-adapters`) | `ok \| 5 passed (53 steps) \| 0 failed (1m22s)` |
| `pnpm exec tsx … --test --test-concurrency=1` (4 suites) | `pass 134, fail 0` |
| `bun test --timeout=300000` (4 suites) | `134 pass, 0 fail` |
| `deno task lint:dead-code` | exit 0, no findings |
| `deno task build` | exit 0 |
| `deno task test scripts/tests/plan-component-compiled.test.ts scripts/tests/plugin-compiled.test.ts` | `ok \| 6 passed (15 steps) \| 0 failed (25s)` |
| `pnpm run lint` (oxlint + `oxfmt --check` + knip) | exit 0, no errors, pre-existing warnings only |
| `deno check --frozen` over the changed graph and the four entrypoints | exit 0 |

The Plan-affected group is additional to the frozen set, run because correcting
defect 1 touched `plan.ts`, the harness and PO15. It is not a matrix expansion.

### First failure retained

Group 2 failed once, at the intermediate state where I had reverted the
`NO_DOCUMENTATION` move to test its necessity:
`./packages/core/tests/evaluation-profile.test.ts (uncaught error)` —
`ReferenceError: Cannot access 'SYNTAX_PROTECTED' before initialization` at
`packages/core/src/components/protected.ts:129`, `FAILED | 54 passed | 1 failed`.
That is the probe described in defect 2, not a defect of this revision.

## Landed-overlap delivery implications

Cached `origin/main` advanced from `9c4f4f9a` to `a0320347` during
implementation: PR #908, `issue-907-core-comment-cleanup`, 378 files. It is a
comment/prose cleanup plus two new gates — `scripts/lint-architecture.js` and the
`no-banned-jsdoc-words` oxlint rule — enforcing `scripts/banned-words.js`, which
bans the `claim` word family in Markdown prose and JSDoc.

**The frozen base is unchanged.** This is reported, not acted on.

Thirteen of the 31 files overlap. A rebase onto `a0320347`, probed on a throwaway
branch and aborted, produces **three conflicts, all prose, no code**:

| File | Conflict | Resolution |
| --- | --- | --- |
| `architecture.md` | #908 rewrote `delegate and claim` → `delegate and register` in the paragraph U3 amends to `Its default bare form` | take U3's sentence with #908's `register` |
| `packages/core/src/components/Syntax.ts` | #908 reworded the module header U3 rewrites (two hunks: `claimed by` → `reserved by`, `It claims the occurrence identity` → `It authenticates`) | take U3's header, adopting `authenticates` |
| `packages/core/src/execute.ts` | #908 reworded the `ExecutionInstallation.symbols` doc that U3 deletes | take U3's deletion |

Two further implications for whoever rebases:

- U3's newly written prose already avoids the banned family, so the new gates
  should pass — but they have not been run against `a0320347` from this base, and
  `architecture.md` and the specs at this base still contain pre-existing `claim`
  prose outside U3's hunks that #908 renamed.
- Nothing in #908 touches `syntax-api.ts`, `use-syntax.ts`, `syntax-reference.ts`,
  the two new test files, or any behavior U3 changes.

## Blockers

None. No unresolved contract or architecture conflict arose; defect 1 was
resolved inside A3's accepted boundary (one public setup helper, one descriptive
setup per authorship, no new installation member) and needs no amendment.

Not done, by instruction: no push, no PR, no U4/U5 or #902 consumer work. Root
workspace, every other branch and every other worktree are untouched; the root's
modified guides, `AGENTS.md`, `architecture.md` and untracked
`.agents/agent-writing.md`, `.reviewer/` and `greeting.md` are as they were.

Next: Architect/Product Owner implementation review of `ac466780`.
