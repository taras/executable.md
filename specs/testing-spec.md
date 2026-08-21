# Executable.md Testing

## Motivation

Executable documents can contain probabilistic behavior. Tests ground that
behavior in observable results and give authors confidence in their documents.

## Testing Mode

Tests run only in testing mode. During regular execution, `<Test>` and its
entire body are skipped: it renders nothing, binds nothing, and runs no side
effect.

`<Testing>` enables testing mode for its expanded subtree:

```md
<Testing>
  <Example />
</Testing>
```

Installing the package registers `<Testing>`, `<AssertThrows>` and the value
assertions as ordinary **non-reserved defaults** (executable-mdx-spec.md §5.3):
a repository component of any of those names is chosen ahead of the registered
one, exactly as it would be ahead of any other package's default, and then
decides for itself what a testing boundary means.

`<Test>` is not among them. Canonical core registers and owns the default
`<Test>` construct, because core owns what an invocation of one means for the
run (see *Checked command failures inside a test* below). Installing this
package supplies that construct's testing behavior — activation, isolated
bindings and scope, the timeout, assertion and unexpected-failure
classification, TestResult staging and recording, reporting, and the testing
completion failure — through the `TestBehavior` operation core calls from
inside the invocation. `<Test>` is still an ordinary non-reserved default, so a
repository component of that name is chosen ahead of core's and decides for
itself what a test means.

A test result is journaled once the invocation that produced it has been
dismantled, so a teardown failure is part of the outcome recorded for it. That
is still while expansion runs and before the root close, in discovery order and
identified by source position. A run that ends between a test finishing and its
result being written journals nothing for that test, and re-runs it on resume.

A boundary reports how many tests ran and how many failed once its body has
finished. A body that *stopped* — expansion ended by throwing rather than by
collecting a diagnostic — never counted the tests it did not reach, so it
reports no outcome and journals none, and the failure travels on unchanged. An
error the body merely collected leaves it complete: that diagnostic is part of
what the boundary rendered, and the tests beside it still ran.

The CLI command is equivalent to wrapping the entrypoint in `<Testing>` for
activating testing mode and for journaling the results of the tests it runs. It
is not equivalent for boundary reporting: an explicit `<Testing>` reports and
journals a boundary outcome, and a root run reports none.

```sh
xmd test <entrypoint>
```

Test discovery follows normal component expansion. A test runs only when the
expanded component tree reaches it, including through imports, components, and
conditional rendering. Imported but unrendered tests do not run.

Ordinary content outside a `<Test>` expands normally. An error in that content
aborts the run as an infrastructure error.

`<Testing>` emits the naturally expanded report without adding a summary. It
fails after expansion when any test failed or when no tests were discovered.
`xmd test` exits with status `0` when every test passes and status `1`
otherwise.

Testing uses the standard journal and replay behavior. Each completed test
and each `<Testing>` boundary outcome is journaled as a testing-owned
durable operation (`test_result`, `testing_boundary`) while expansion runs,
before the root close event, identified deterministically by source
position. On a full replay of a completed journal the recorded results and
boundary outcomes are restored from the stream into the current collectors
— test bodies and their effects are not rerun — so the testing outcome and
recorded results are preserved. On live and partial runs nothing is
restored: re-expansion records each result exactly once, in discovery
order, with completed records replaying in place.

## Selecting one section of a document

A test document addresses its own sections. `--target <selector>` runs one of
them:

```sh
xmd test packages/test-agent/src/NativeSessionLaunch.test.md --target Implementor
```

The positional value stays a path. `#` and `%` in it are filename characters,
exactly as they were before the option existed, and an invocation that omits
`--target` is unchanged. Only the option's value enters the document-target
selector grammar, and it must resolve to exactly one addressable static target;
an invalid, unmatched, or ambiguous selector refuses before any authored work
runs.

What executes is the projection every document target already produces: the
document preamble, the direct content of each ancestor needed to reach the
target, and that target's complete subtree. Sibling subtrees are absent rather
than skipped — they register no tests, start no services, and invoke no
components. Selection changes nothing else: testing mode, component search
paths, journal behavior, secret detection and result containment are as they
are for a whole document.

`--target` selects a section of one document, so it is valid only when the
positional value resolves to a single document. A directory refuses the
invocation, and refuses it before any discovered document executes — no
heading, no test result and no authored effect from anything beneath that
directory. Applying a selector across many documents would need its own
identity, ambiguity, reporting and per-document failure contract, and none of
that is implied here.

## Directory Targets

`xmd test` accepts a directory as well as a document, and defaults to the
current directory. These are the same command:

```sh
xmd test
xmd test .
```

A directory target discovers the documents beneath it recursively. The default
pattern is `**/*.test.md`, so ordinary Markdown such as `README.md` or
`notes.md` does not run. `--pattern` chooses a different glob:

```sh
xmd test workflows --pattern "**/*.spec.md"
xmd test workflows --pattern "**/*.spec.md" --pattern "**/*.check.md"
```

Explicit patterns replace the default rather than adding to it, and repeating
the option forms an inclusive union. Patterns are relative to the target root.
A document that several patterns match runs once, and the documents run in the
code-point order of their normalized relative paths, whatever order the
patterns were written in. A pattern chosen deliberately to be broad, such as
`--pattern "**/*.md"`, selects and runs ordinary Markdown.

Under a directory target each document searches for components in three places,
in order: its own directory, the target root, then the configured component
directories. A repeated directory keeps its first position. A component
therefore resolves beside the test that invokes it however deep in the suite it
sits, and two directories may hold same-named components without either
reaching the other. No `--component-dir` is needed, and the working directory
does not change.

A single-document target keeps the configured component directories exactly.

Each document runs in its own execution and scope: bindings, component
registrations, and testing sessions belong to one document and are torn down
before the next one starts. A document that declares no tests fails on its own
rather than inheriting an earlier document's results.

Each document's report is preceded by a heading naming its relative path, and a
failure is reported against that path. A failing document does not stop the
run; the remaining documents still execute, and a closing line names how many
of them failed. The run exits `0` only when every discovered document passes,
and `1` when any document fails or when no document matches.

`--pattern` applies to a directory, so supplying it with a single document is
rejected. A `--pattern` with no value, or one followed by another option, is
rejected rather than read as a glob; `--pattern=<glob>` expresses a glob that
begins with `-`. Options after `--` are not inspected. `--journal` writes one
trace for one document, so a directory target rejects it before any document
runs.

## Atomic Tests

Atomic tests use `<Test>`:

```md
<Test name="Renders hello world">
  <Capture as="result">
    Hello World
  </Capture>
  <AssertEquals actual={result}>
    Hello World
  </AssertEquals>
</Test>
```

The `name` prop is optional metadata. An unnamed test is identified by its
source location; headings in the body remain ordinary output and are not
inferred as names.

The `timeout` prop is optional and declares this test's own timeout as a
duration (`500ms`, `30s`, `5min`), replacing the 20-second default. A malformed
duration is refused where it was written and fails only that test.

### Checked command failures inside a test

A foreground command that exits nonzero is a checked failure, and outside a test
it fails the run (executable-mdx-spec §3.6). Inside a `<Test>` it is
**contained**: it becomes that test's failed result, the run's own fatal record
stays clear, the tests after it still run, and the testing session's existing
completion policy is what fails the overall run. A contained outcome is decided
once — replay restores the failed result and the failing testing outcome from
the journal without running the command again.

Containment belongs to the `<Test>` construct, and canonical core owns it.
Core registers `<Test>` as one of its own defaults, and grants containment only
to that exact definition, only while it is expanding it. Nothing else confers
it: not a name, an origin, a context, a marker, an option, the request, or an
installation. `TestBehavior` supplies what a test *does* and decides nothing
about which element is one — it accepts no function, component name, marker or
container, and cannot make any other component contain a failure.

A repository component named `Test`, or another package that registers the name,
still wins ordinary default resolution and is chosen ahead of core's. Core's
definition was therefore not expanded, and the one that was receives no
containment: a checked failure inside it is the run's, exactly as it would be
anywhere else the document did not authorize one.

`useTesting()` with `execute()` needs nothing else. The host attaches no
installation, names no component, and receives no identity.

A test body behaves like any regular component body. Tests run sequentially in
expansion order. Each test runs in a child Effection scope and an isolated
binding environment. It inherits ambient context and bindings, but its context
changes, bindings, and ongoing effects do not escape. Its scope is fully torn
down before the next test starts.

Each test has a 20-second timeout by default; a `timeout=<duration>` prop on the
`<Test>` element declares that one test's own. A timed-out test is halted,
reported as failed, and fully torn down before execution continues.

An assertion failure, unexpected error, or teardown error fails only the current
test. Later tests still run. Unexpected errors remain distinct from assertion
failures. Output produced before an assertion failure or an unexpected error
remains in the report and is followed by the failure diagnostic. Two failures
report the diagnostic alone: a test that timed out was halted mid-body, and a
test whose teardown failed had already returned, so neither has body output to
keep. A teardown failure is reported as a diagnostic rather than as report text,
and carries the original error as its cause.

Nested `<Test>` elements are invalid. Skip, focus, and retry behavior is not
supported.

## Nested Executions

A test can run another document as a real root execution, without translating it
into TypeScript and without launching another `xmd` process:

```md
<Test name="bootstraps a package">
  <Execution host="run" target="./scripts/bootstrap.md" props={{ name: "x" }} as="run">
    <CollectOutput as="output" />

    <AssertEquals actual={run.kind} expected="settled" />
    <AssertEquals actual={run.result.ok} expected={true} />
    <AssertStringIncludes actual={output} expected="created x" />
  </Execution>
</Test>
```

This is not component composition. `<Execution>` creates a child document
execution with its own root import, target selection, journal, output stream,
scope and teardown. `host` names a **host profile** the trusted host supplies by
reusing the production assembly its command line already produces; a host that
offers no such profile refuses before the child's root is imported, and so does
an `<Execution>` written anywhere but inside a canonical `<Test>`.

`host="run"` takes exactly one of `target` or `source`. A `target` is an ordinary
document reference — a path, optionally followed by `#` and one target selector —
resolved by the same loader `xmd run` uses, so a kebab-named document in an
arbitrary directory is addressable without being a component. A `source` is
markdown supplied directly and follows the production `run -e` path: it reports
the `<eval>` identity and writes no file. `props` are the child root's props.

`host="workflow"`, and the `<WorkflowRun>` scope it requires, are specified in
issue #454 and are not built: a host that provides no workflow profile refuses
them, naming that.

### Outcome and failure

With `as`, the binding receives one outcome, and it is readable from the
assertion body:

```ts
type ExecutionOutcome =
  | { kind: "settled"; result: Result<Json> }
  | { kind: "suspended"; runId: string; suspensionId: string };
```

A settled `Ok` or `Err` is test data: the assertion body runs and can assert
about either. Without `as` there is nothing to assert about, so a settled `Err`
fails the owning test rather than passing vacuously. A host refusal before a
child exists raises directly and binds nothing.

### Declarations

`<DiagnosticJournal>`, `<CollectOutput>` and `<CollectJournal>` are declarations,
valid only as direct children of `<Execution>` and only before assertion content.
They are installed for the whole child lifetime, before the child's root is
imported; malformed or conflicting declarations fail before it too.

`<CollectOutput as="…">` accumulates the child's rendered output for assertions.
It is passive: the child's output is displayed progressively either way, and
collection changes neither routing nor completion. When the child fails or is
cancelled, the binding holds the partial prefix. Ordinary `<Capture>` stays
lexical — it captures the rendered content it wraps and never the child's stream.

`<DiagnosticJournal>` selects an isolated diagnostic journal for a `run` child,
equivalent to what `xmd run --journal` retains. Without it a run is transient and
allocates no journal because output was displayed. `<CollectJournal as="…">`
binds a read-only snapshot of a journal the host already selected; it grants no
retention, and declaring it without a selected journal is malformed.

A declaration is recognized by the definition it resolves to, never by its name.
A repository `CollectOutput.md` is chosen ahead of this package's, so it is an
ordinary component: it renders where it is written and configures nothing.

### Authority

Canonical core mints one opaque harness per `<Test>` invocation and expires it
with that invocation; each `<Execution>` spends a single-use authorization from
it.

The harness is delivered rather than published: a trusted host attaches an
installer to the execution, canonical `<Test>` calls it inside the invocation
with that invocation's harness, and the installer registers the definitions that
can run a child with the harness in their closure — shadowing a refusing default
for exactly that test's body. There is nothing to read, so a repository component
named `Test`, `Execution` or `WorkflowRun`, a package registering those names,
`printErrors(fn)`, public middleware on any surface including the `<Test>`
behavior hook, a separately loaded package copy, and replaceable context all
acquire none of it. A document whose host attached no installer recognizes
`<Execution>` and refuses it, inside a canonical `<Test>` as everywhere else.

Host-profile middleware is policy. It receives a request rather than a child, so
it may observe, refuse and delegate the exact immutable request — and cannot
create a child, replace target, source, props, action or journal policy,
substitute a completion, or publish an outcome. A handler that returns without
delegating produces no child and is reported as the protocol violation it is.

The trusted provider is attached to the execution as a value before untrusted
installation, middleware or document code begins. The authorized definitions
close over that provider; public host middleware never receives it.

`<Execution>` receives an invocation-owned binding channel directly from the
engine. It reports only whether this exact invocation has `as`, and publishes
the exact child outcome once before assertions expand. The channel exposes no
binding name or environment and does not travel through the public `Component`
Api, Context, props, component metadata or stable names.

## Test API

`TestApi` controls testing mode. The `testing` operation returns `false` by
default and `true` beneath `<Testing>`:

```ts
import { testing } from "@executablemd/testing";

const active = yield* testing;
```

`TestApi` records completed tests in discovery order. Each result contains its
pass or fail status, optional name, source location, and structured error
details when it failed. Rendered test output is not duplicated in the result.

`useTesting` composes testing around the core execution entrypoint. It
installs the testing components and collectors, activates testing mode for
the execution, and returns a session whose `results` operation snapshots
completed tests in discovery order:

```ts
import { execute } from "@executablemd/core";
import { useTesting } from "@executablemd/testing";

const tests = yield* useTesting();
const execution = yield* execute(options);
const outcome = yield* execution;
const results = yield* tests.results;
```

Execution completion is an Effection `Result<string>`: `Ok(output)` on
success, `Err(error)` on document, infrastructure, or testing failure —
completion never throws once the execution handle exists. Under
`useTesting`, an otherwise successful execution completes as
`Err(TestFailureError)` after the output stream closes when any test failed
or no tests were discovered. A failure produced by the document itself
passes through unchanged, and the session's results remain available after
failure. One `useTesting` session applies per execution scope; its
middleware is removed with that scope. `xmd test` composes `useTesting`
around the same `execute` call the `run` command uses.

Registering the testing components without `useTesting` leaves testing mode
inactive: `<Test>` is skipped, assertion components stay usable, and an
explicit `<Testing>` boundary still activates its subtree and turns its
failures — or an empty boundary — into an `Err` outcome for the execution.

## Assertions

Assertion components follow the conventional assertion function names and
parameter names. The initial components are:

- `<Assert>` and `<AssertFalse>`
- `<AssertEquals>` and `<AssertNotEquals>`
- `<AssertStrictEquals>` and `<AssertNotStrictEquals>`
- `<AssertExists>`
- `<AssertStringIncludes>`
- `<AssertMatch>` and `<AssertNotMatch>`
- `<AssertGreater>` and `<AssertGreaterOrEqual>`
- `<AssertLess>` and `<AssertLessOrEqual>`
- `<AssertThrows>`

Props map directly to the corresponding function parameters: `expr` for
truthiness assertions, `actual` and `expected` for comparisons, and optional
`msg` where supported. The operands are **captures**
(executable-mdx-spec.md §6.5): the assertion evaluates them itself, so what it
compares is the value the author wrote rather than a JSON projection of it —
which is what lets `<AssertStrictEquals>` compare by reference,
`<AssertExists>` tell `undefined` from absence, and `<AssertMatch>` take a real
`RegExp`. `msg` is an ordinary validated string prop.

`as` and `slot` belong to the engine, which consumes them before validation, so
an assertion accepts them like any other component: `as` binds the assertion's
diagnostic text.

Equality assertions and `<AssertStringIncludes>` accept either an `expected`
prop or rendered children as the expected string. The two forms are mutually
exclusive. Expected children expand in the current scope and environment, use
the same trailing-whitespace trimming as `<Capture>`, and do not render
separately.

Numeric comparisons require an `expected` prop. Match assertions require a
`RegExp` through the `expected` prop. Unary assertions do not accept expected
children.

Comparisons are those of `node:assert/strict`, a runtime builtin rather than a
dependency, so a published package needs no registry configuration to install.
`<AssertEquals>` and `<AssertNotEquals>` are deep strict equality;
`<AssertStrictEquals>` and `<AssertNotStrictEquals>` are `Object.is`. Existence,
falsity, string inclusion and the ordering comparisons have no builtin
equivalent and are defined here: existence rejects only `null` and `undefined`,
string inclusion is `String.prototype.includes`, and the ordering comparisons
apply the relational operators — which coerce object operands, so a value whose
`toString` throws fails the comparison itself.

Deep equality is stricter than the `@std/assert` implementation used before
0.5.2 in two respects: `0` and `-0` are no longer equal, and an object with a
`null` prototype is no longer equal to an otherwise-identical plain object. Two
distinct `Error` values with the same name and message now compare equal, where
previously their stacks made them differ. Pathological operands — an invalid
`Date`, a `WeakMap` — are not specified and may differ between runtimes.

Assertion components work inside and outside tests. A failed assertion throws an
`AssertionError`. Outside a test, that error aborts document expansion. Inside a
test, `<Test>` contains and records it.

Assertions emit Markdown diagnostics in testing mode. During regular execution,
diagnostics are hidden unless `--verbose` is enabled. Failed assertions still
throw when diagnostics are hidden.

Diagnostics identify the assertion component and outcome. They include the
optional message and relevant actual and expected values. Failure diagnostics
include the underlying assertion detail when available. Their exact Markdown
layout is not prescribed, and formatting arbitrary values must not change the
assertion outcome or introduce a new failure.

`<AssertThrows>` is the one assertion that is not a value comparison. It wraps
children rather than taking `actual`/`expected`, and it
**requires** a `message` prop: a literal string is matched as a substring of the
raised error's message, or an expression evaluating to a `RegExp` is tested
against it. The assertion passes when expanding the body raises an error whose
message matches, and fails when the body raises nothing or raises a non-matching
error. It accepts an optional literal `as` binding that captures the complete
caught error segment — including its `cause` — into the environment for later
assertions. Unlike the other assertions it emits **no** pass diagnostic: the return channel
carries the caught segment for `as` to bind, and no other channel preserves a
durable rendered segment. A failure aborts the document when it occurs outside a
test (inside a `<Test>` it is contained and recorded), unchanged.

Additional assertion components use the same rules: they state their comparison
here, they raise an `AssertionError` on failure, and they use the shared
diagnostic behavior. A component must decide its outcome before anything formats
its operands, so that a value with a throwing or mutating `toJSON`, `toString`
or getter cannot change whether an assertion passes.

## Mocking

Testing has no separate mocking DSL. Tests install mocks through existing
context API middleware or helpers from `@executablemd/runtime/test`. Middleware
installed within a test applies to subsequent expansion in that test and is
removed with its scope.

## Unsupported Syntax

BDD syntax such as `describe`, `it`, `beforeEach`, and `beforeAll` is not
supported. Gherkin syntax such as `Given`, `When`, and `Then` is not supported.
