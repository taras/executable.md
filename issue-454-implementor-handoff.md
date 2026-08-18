# Issue 454 Implementor Handoff

Planner role: `.agents/planner.md`

Issue: https://github.com/taras/executable.md/issues/454
Base for implementation: `origin/main` at `1948bf039ef7edfeb82fdbbcaa4c6fedd978bf0c`
Current checkout when planned: `agent/issue-301-workflow-bundle` at `5bfa88b6cf4ee5bb6dd541ee4b246c328d7404bb`, merge-base with `origin/main` `7cd1d958b320916439010569742e5c8227cd8abc`.

Start implementation from a fresh branch off `origin/main`, not from the current checkout. The current worktree has unrelated untracked handoff files.

## Sources Read

- Issue #454 body, updated 2026-08-18; it has no comments.
- Related issues: #453 is closed and supplies the root fail-fast baseline; #416 and #201 are open and explicitly do not own this harness.
- Open PRs as of planning: #497 generated XMD, #495 Git push, #181 adversarial workflow WIP. None directly implements #454.
- Required context: Effection v4 `AGENTS.md`, `architecture.md` in full, `.agents/planner.md`, and affected sections of `specs/testing-spec.md` and `specs/executable-mdx-spec.md`.
- Current implementation: `packages/core/src/execute.ts`, `execution-request.ts`, `document-request.ts`, `test-behavior.ts`, `components/Test.ts`, `component-failures.ts`; `packages/testing/src/*`; `packages/cli/src/cli.ts`, `workflow.ts`, `workflow-definition.ts`; workflow Deno host entry.

## Purpose

Implement the testing-only `Execution` harness from issue #454. A Markdown test can run another document as a real root execution under a selected production host profile (`run` or `workflow`) without translating the document into TypeScript and without spawning another `xmd` binary.

This is not `<Call>`. `<Call>` remains structural composition inside the current execution. `Execution` creates a real child document execution with its own root import, target selection, journal choice, output stream, scope, teardown, and workflow preparation where applicable.

## Settled Decisions

- Ship this as one issue stack whose final PR satisfies both `run` and `workflow` profiles. A smaller internal commit order is fine, but do not merge a state whose specs describe behavior that is not implemented.
- `@executablemd/testing` owns the authored components and request-only host-profile API: `Execution`, `WorkflowRun`, `DiagnosticJournal`, `CollectOutput`, and `CollectJournal`.
- The CLI package owns the trusted provider. Testing must not import `@executablemd/cli`; `@executablemd/cli` already depends on `@executablemd/testing`.
- Core remains authoritative for recognizing the real `<Test>`. Harness authority must derive from core's canonical `<Test>` invocation, not from component names, Context values, props, package origins, or public middleware.
- A repository component named `Test`, `Execution`, or `WorkflowRun` receives ordinary component semantics and no harness authority.
- Public host-profile middleware may observe, refuse, and delegate one immutable request. It must not create a child execution, replace the selected profile, substitute completion, or publish an outcome.
- `host="run"` accepts exactly one of `target` or `source`. `source` uses `inlineSource()` and the production inline-source path; `target` uses `fileSource()` and the existing target resolver, not component-name lookup.
- `host="workflow"` must be inside a canonical `WorkflowRun`. `action="start"` requires `target` and rejects `source`; `action="resume"` rejects both. The run id is declared on `WorkflowRun`, generated there when omitted, and shared by child attempts in that scope.
- `DiagnosticJournal` selects diagnostic retention only for `host="run"`. `CollectJournal` observes an existing child journal and never creates one. Workflow always uses the production durable workflow journal and rejects `DiagnosticJournal`.
- `CollectOutput` is passive. It accumulates the child output stream for assertions without changing display routing or child completion. Ordinary `<Capture>` remains lexical and does not capture nested child output.
- With `as`, a settled `Ok`, settled `Err`, or workflow suspension is test data and the assertion body runs. Without `as`, a settled child `Err` fails the owning test automatically. A workflow suspension is a non-failing lifecycle outcome.

## Current State

- Core already has capability-backed `Execution.execute` and `Execution.document` policy surfaces. They are request-only public middleware with private invocation/document terminals in `packages/core/src/execute.ts`, `execution-request.ts`, and `document-request.ts`.
- Core already owns canonical `<Test>` as a default component in `packages/core/src/components/Test.ts`; testing supplies behavior through `TestBehavior`.
- `@executablemd/testing` currently registers `Testing`, assertions, and `AssertThrows`; it does not register `Test`.
- The CLI's production document assembly is private inside `packages/cli/src/cli.ts` as `runDocument()`/`runScopedDocument()` and mixes host setup with process stdout/stderr presentation. Nested execution needs the same host profile without process presentation.
- `runWorkflow()` in `packages/cli/src/workflow.ts` is already parameterized by an `execute: (WorkflowExecution) => Operation<Result<void>>`, which is the right reuse point for workflow-profile children.
- Testing helpers run core `execute()` directly with stub files. CLI tests already have `runCli()` from `@executablemd/test-support/launch`.

## Implementation Plan

1. Add a core-authenticated test harness authority.

   Extend core's canonical `<Test>` path so one invocation creates an opaque, scope-owned harness authority and makes it available only to the testing behavior that expands that invocation's body. Do not transport it through props, a stable Context, a public same-name Api, or component metadata. The authority must be one Test invocation's, invalid outside that invocation's scope, and unusable by a repository `Test` selected ahead of core's default.

   The Implementor may need to adjust `TestBehaviorApi`; if so, keep it a behavior hook, not a public authority surface. Regression coverage must prove counterfeit names, public middleware, replaceable context, and separately loaded package copies cannot acquire or spend the authority.

2. Add the testing harness API and components.

   Add a new testing module, likely `packages/testing/src/execution-harness.ts`, with:

   - `Execution` component props: `host`, optional `target`, optional `source`, optional `props`, optional `action`, optional `as`.
   - `WorkflowRun` component props: optional `id`.
   - declaration components `DiagnosticJournal`, `CollectOutput`, `CollectJournal`, each valid only as direct configuration/observer declarations inside `Execution` before assertion content.
   - a request-only host-profile Api whose default refuses before child root import.

   `Execution` must first scan and validate its children into configuration and assertion body, install all selected configuration for the whole child lifetime, run and tear down the child, publish outcome/observations, then expand the assertion body. Malformed or conflicting declaration state fails before child root import.

3. Refactor CLI production host assembly.

   Extract a reusable internal host runner from `packages/cli/src/cli.ts` so process presentation is separate from production profile assembly. Keep ordinary CLI behavior byte-for-byte where possible.

   The reusable runner should accept a child output sink and return the child `Result<Json>` plus enough journal/output state for `Execution` to bind observations. It should still use `executeInstalled()` once, install the same core/runtime/testing/web/agent/service pieces as production `xmd run` after argument parsing, and preserve the host decision for `retainProcessOutput`.

   Do not make `@executablemd/testing` import this runner. The CLI test host passes the provider as a trusted value into the test-harness installation; no public Context or Api selects it.

4. Implement `host="run"`.

   The trusted CLI provider validates the request, creates either:

   - `fileSource(target)` for a referenced root or selected target; or
   - `inlineSource(source)` for inline source.

   Use a transient `InMemoryStream` unless `DiagnosticJournal` is declared. With `DiagnosticJournal`, use an isolated diagnostic stream/file-equivalent in memory and retain process output just as production `xmd run --journal` does. Without it, retain no diagnostic process output merely because output is displayed.

   Forward the child `DocumentExecution.output` progressively into the outer document output stream and separately into `CollectOutput` when declared. The `as` binding receives:

   ```ts
   { kind: "settled", result: Result<Json> }
   ```

   Without `as`, a child `Err` propagates as the current test failure.

5. Implement `WorkflowRun` and `host="workflow"`.

   `WorkflowRun` creates an isolated production workflow storage root owned by the test scope and removed at teardown. It never reads or writes the user's configured workflow-run directory and exposes no physical path or database handle.

   The CLI provider uses a Deno workflow host backed by that private root for Deno and the compiled Deno binary. Node and Bun install the production unsupported-host refusal and must create no run state.

   `Execution host="workflow" action="start"` establishes the definition from the target and calls `runWorkflow()` with the private workflow host. `action="resume"` uses the same `WorkflowRun` id and retained state. A durable suspension binds:

   ```ts
   { kind: "suspended", runId: string, suspensionId: string }
   ```

   A completed or failed attempt binds the same settled outcome shape as `run`. Workflow always has a collectable journal snapshot and rejects `DiagnosticJournal`.

6. Enforce isolation and teardown.

   The outer test owns every child. Cancelling or completing the test must halt the child execution/workflow attempt, wait for complete teardown, release workflow executor locks, then run assertions. Child bindings, testing state, services, middleware, workflow storage, and contextual providers must not leak to the outer test or sibling executions.

7. Update contracts and inventory.

   Update `architecture.md` terminology with `testing harness`, `host profile`, and `execution outcome`. Add the canonical-Test harness authority, request-only host-profile middleware, terminal ownership, child lifecycle, output/journal observation, and isolated `WorkflowRun`.

   Update `specs/testing-spec.md` for the authored components and programmatic API. Update `specs/executable-mdx-spec.md` testing, entrypoint, output, failure, workflow, and tier sections. Add a construct inventory row for the testing harness and keep test-index rows synchronized if present.

## Frozen Acceptance And Evidence Matrix

| Criterion | Evidence |
| --- | --- |
| Referenced documents and selected targets execute as roots, not components | `packages/testing/tests/execution-harness.test.ts`: arbitrary file path, kebab filename, selected heading, root props, and value/text returns |
| Inline source follows production `run -e` identity | Same test file: `source={text}` reports `<eval>` positions and creates no temp authored file |
| Host profile reuses production assembly after CLI parsing | `packages/cli/tests/testing-execution-host.test.ts`: child sees the same default components/providers and target/root semantics as `xmd run`; no subprocess launch |
| Bound and unbound child failures behave correctly | Harness tests: with `as`, `Err` is assertable; without `as`, owning `<Test>` fails; partial output is preserved |
| Progressive display and `CollectOutput` are distinct | Harness test with an explicit gate at the output consumer, not a timer; display happens without collection, collection does not alter display |
| Ordinary `<Capture>` remains lexical | Harness test: `<Capture>` around or beside `Execution` captures only lexical assertion output, never child stream bytes |
| Declarations install before root import | Harness test: child root observes configuration on its first effect; malformed/conflicting declarations fail before a root-import journal entry |
| Transient run allocates no journal | Harness test: `host="run"` without `DiagnosticJournal` plus `CollectJournal` is refused; without collection, no child journal snapshot exists |
| Diagnostic run retention and secret gate | Harness/CLI test: `DiagnosticJournal` retains child journal and process output; credential-shaped retained event/output is refused without echoing the secret |
| Workflow start/suspend/resume uses one real isolated run | CLI/workflow harness test: `WorkflowRun` start suspends, resume consumes retained state, collected journal shows production workflow events |
| Workflow storage isolation and cleanup | Workflow harness test: same public id in concurrent `WorkflowRun` scopes does not collide; private root removed at teardown; user's configured directory untouched |
| Cancellation and lock release | Workflow harness or CLI test: cancelled outer test tears child down, releases executor lock, and a later resume/start is not blocked |
| Authority cannot be forged | Core/testing tests: repository same-name components, public host-profile middleware short-circuit, replaceable Context, copied request, second spend, and separately loaded package copy cannot publish completion or acquire workflow-run authority |
| Runtime behavior | Add portable run-profile tests under `packages/testing/tests/` so Deno, Node, and Bun runtime jobs discover them. Add CLI workflow-host tests proving Node/Bun refuse workflow before child state is created. Compiled coverage remains delivery/CI unless a focused compiled smoke already exists |
| Documentation matches behavior | Diffs to `architecture.md`, `specs/testing-spec.md`, `specs/executable-mdx-spec.md`, and inventory/test-index rows describe shipped behavior in present tense |

These scenarios are finite. The Implementor should not expand the matrix for speculative permutations unless implementation proves an existing criterion cannot be established.

## Focused Feedback Commands

Run the smallest discriminating set after implementation:

```bash
deno task test packages/testing/tests/execution-harness.test.ts
deno task test packages/cli/tests/testing-execution-host.test.ts
deno task test packages/core/tests/execution-protocol.test.ts packages/core/tests/output-error-mode.test.ts
deno task test packages/cli/tests/workflow-suspension.test.ts packages/cli/tests/workflow-host.test.ts
```

If the implementation changes test discovery, runtime adapters, or package exports in a way the Deno-only commands cannot prove, add the relevant focused command or explain why only CI can cover it. Do not run full Node/Bun suites locally just for confidence; the new portable test files are discovered by the CI runtime jobs.

When the focused evidence passes, create a feedback commit promptly and hand back the exact SHA plus every focused command run.

Delivery before merge remains the repository delivery gate: required CI and the applicable `deno task verify` battery, with `deno task verify:clean` only if dependency/cache-purity boundaries move.

## Risks And Watchpoints

- The largest risk is accidentally making testing or middleware authoritative. Every completion must come from the invocation-owned terminal tied to the canonical Test authority.
- Avoid using Context as an authority transport. Contextual APIs are policy and composition only in this architecture.
- Do not let `CollectJournal` enable retention. It observes only after the host selected a journal.
- Do not double-normalize or double-format output when forwarding child output into the parent. CLI presentation is downstream; the nested harness should forward child rendered chunks into the parent document output path.
- Workflow tests must use real workflow persistence in an isolated root, not a mock store and not the user's configured run directory.
- `runWorkflow()` already accepts document execution as a callback. Prefer using that seam over reimplementing workflow lifecycle policy in testing.

## Next Action

Implementor: branch from `origin/main` at `1948bf039ef7edfeb82fdbbcaa4c6fedd978bf0c`, implement the plan above, run the focused feedback commands, commit as soon as they pass, and return the commit SHA with the command list and any acceptance criterion that could not be proven.

---

## Implementor Feedback

Worktree: `/private/tmp/xmd-454-impl`
Branch: `agent/issue-454-execution-harness`, branched from `origin/main` at `1948bf039ef7edfeb82fdbbcaa4c6fedd978bf0c`.
Commit: **`b3e6304`** — 🧪 Run another document as a root from inside a Markdown test. Not pushed; no PR.

### What the commit ships

Plan steps 1, 2, 3, 4, 6 and the run-profile half of step 7.

- **Step 1 — core authority.** `packages/core/src/test-harness.ts`. An invocation of
  canonical `<Test>` mints one `TestHarness`: a private-field-branded object delivered to
  host-attached installer functions inside the invocation's own frame and expired when
  that frame unwinds. `authorize()` yields a single-use `TestHarnessAuthorization`; a
  second spend, and a spend after the test finished, are refusals. There is no harness
  reader and no context holding the harness. The installer context holds only branded
  functions captured before untrusted code begins, and calling one requires a harness
  only canonical core mints. `TestBehaviorApi` was **not** changed: handing the harness
  through a public same-name Api would have given every `TestBehavior.around` handler the
  authority by construction.
- **Step 2 — testing API and components.** `packages/testing/src/execution-host.ts`
  (one-use `ExecutionHostRequest`, the `ExecutionHost` Api whose public default always
  refuses, immutable host profiles, `ExecutionHostProvider`) and
  `packages/testing/src/execution-harness.ts` (`<Execution>`, `<WorkflowRun>`,
  `<DiagnosticJournal>`, `<CollectOutput>`, `<CollectJournal>`).
- **Step 3 — CLI host assembly.** `installDocumentComponents()` extracted from
  `runDocument()` in `packages/cli/src/cli.ts` and reused verbatim by the nested host.
  Process presentation (journal file, `--verbose` echo, normalization, terminal
  formatting, the value root's stdout) stayed with the command that owns those streams,
  so ordinary CLI behaviour is byte-for-byte unchanged.
- **Step 4 — `host="run"`.** `packages/cli/src/testing-host.ts`. `fileSource(target)` or
  `inlineSource(source)`, `executeInstalled()`, `retainProcessOutput` following the
  declared journal policy, output forwarded chunk by chunk.
- **Step 6 — isolation and teardown.** The child runs in `createScope()` with no parent.
  That is the only way it does not inherit the outer document's contextual state — the
  `useTesting()` session and its one-execution-per-session guard, output routing, service
  adapters, providers. Ownership is unchanged: the invocation `ensure()`s the scope's
  destruction, so cancelling or completing the test halts the child and waits for teardown.

Two-pass body reading is how "declarations install before root import" is met with the
authored surface the issue specifies: a scan expands the declaration prefix and stops at
the first element that is not a declaration, then the ordinary pass runs after the child
is over. A declaration is recognized by the definition it resolves to, so a repository
`CollectOutput.md` is an ordinary component.

One core addition beyond the plan: an engine-owned binding channel for harness-created
components. The engine binds `as` from what a component *returns* — after the content it
expanded — and never hands over the name. `<Execution>` needs its assertion body to read
the child outcome before the invocation returns, so canonical `<Test>` creates
binding-aware definitions through the delivered harness. The channel answers only whether
this exact invocation has `as` and accepts one early publication of the child outcome; it
is not part of the public `Component` Api.

### Focused commands run — all green

```bash
deno task test packages/testing/tests/execution-harness.test.ts          # 6 passed (31 steps)
deno task test packages/cli/tests/testing-execution-host.test.ts         # 1 passed (4 steps)
deno task test packages/test-agent/tests/cross-package-resolution.test.ts # 1 passed (5 steps)
deno task check                                                          # exit 0
git diff --check                                                         # exit 0
pnpm exec oxfmt --check architecture.md issue-454-implementor-handoff.md packages/cli/src/cli.ts packages/cli/src/testing-host.ts packages/core/host.ts packages/core/mod.ts packages/core/src/component-api.ts packages/core/src/components/registration.ts packages/core/src/expand.ts packages/core/src/test-harness.ts packages/core/src/types.ts packages/testing/mod.ts packages/testing/src/execution-harness.ts packages/testing/src/execution-host.ts packages/testing/tests/execution-harness.test.ts packages/testing/tests/execution-host-stub.ts specs/executable-mdx-spec.md specs/testing-spec.md # exit 0
```

No focused core component-invocation test was added; the private binding path is
covered by the harness regressions above and typechecked by `deno task check`.

### Acceptance criteria not proven

**Step 5 — `<WorkflowRun>` and `host="workflow"` — is not built.** Rather than ship a
half-wired construct, `ExecutionHostProvider.useWorkflowRun` is **optional**: the CLI
provider supplies none, and `<WorkflowRun>` refuses naming that ("needs a host that can
execute workflow runs, and this one has no workflow profile"). That is the same shape
Node and Bun will use once Deno's arrives, so nothing has to be undone. No spec text
claims workflow behaviour.

Unproven matrix rows, all workflow:

| Criterion | Why |
| --- | --- |
| Workflow start/suspend/resume uses one real isolated run | unbuilt |
| Workflow storage isolation and cleanup | unbuilt |
| Cancellation and lock release | unbuilt for the workflow path; the run path's teardown is covered by the isolated-scope ownership above |
| Node/Bun reproduce the production workflow refusal before child state | partially: `<WorkflowRun>` refuses on every host today, but not yet *through* `unsupportedWorkflowHost()` |

What the next slice needs, in order:

1. Thread `installWorkflowHost` (a `HostWorkflowInstaller`, already resolved in `runXmd`)
   down into `runDocument` and into `TestingHostSettings`.
2. Add `useDenoWorkflowHostAt(root)` beside `useDenoWorkflowHost()` in
   `packages/cli/src/deno-workflow.ts`; the existing function becomes the env-reading
   caller.
3. `useWorkflowRun`: a `resource()` owning a temp directory, removed on teardown, with a
   `WorkflowHost` bound to it and a generated run id when none is declared — the id must
   be generated by the provider, not by `runWorkflow()`, because a suspended outcome has
   to report it.
4. `runChild` for the workflow profile: `establishDefinition(target)` for `start`, then
   `runWorkflow(request, start, host, execute)` with the CLI's own document callback.
   Map `exitCode` to the outcome (2 = suspended); read `suspensionId` back from the run's
   journal the way `suspensionEvent()` does.
5. Tests: a Git-repo fixture (see `packages/cli/tests/workflow-suspension.test.ts`) plus
   a Node/Bun refusal case.

### Two behaviours worth a decision before the next slice

- **Forwarded child output reaches the chunk stream but not the close value.** A child's
  chunks go out through `DocumentOutput.operations.output()`; the close value stays
  `result.output`, the outer document's own rendered text. Piped `xmd run` and `xmd test`
  write the close value, so nested child output is visible on a TTY and to stream
  consumers but not in piped stdout. Closing that gap means changing what core closes the
  channel with, which is a separate contract (`emittedText` is post-normalization while
  `result.output` is not).
- **`<Execution as="x">` renders nothing**, as every `as` invocation does, so a refusal is
  observable through the test result rather than inline. Assert on the result, not output.
