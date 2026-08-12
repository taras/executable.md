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

Installing the package registers `<Testing>` and `<Test>` as ordinary
**non-reserved defaults** (executable-mdx-spec.md §5.3): a repository component
of either name is chosen ahead of the registered one, exactly as it would be
ahead of any other package's default, and then decides for itself what a testing
boundary — or a test — means.

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

### Checked command failures inside a test

A foreground command that exits nonzero is a checked failure, and outside a test
it fails the run (executable-mdx-spec §3.6). Inside a `<Test>` it is
**contained**: it becomes that test's failed result, the run's own fatal record
stays clear, the tests after it still run, and the testing session's existing
completion policy is what fails the overall run. A contained outcome is decided
once — replay restores the failed result and the failing testing outcome from
the journal without running the command again.

Containment belongs to the `<Test>` a testing session built, by function
identity. The session reports that exact object to the host that starts the
execution, which hands it back on its own options; nothing a document reaches is
offered the identity or a way to nominate another. A repository component named
`Test` is chosen ahead of the package's, is a different function, and receives
no containment: a checked failure inside it is the run's, exactly as it would be
anywhere else the document did not authorize one.

A test body behaves like any regular component body. Tests run sequentially in
expansion order. Each test runs in a child Effection scope and an isolated
binding environment. It inherits ambient context and bindings, but its context
changes, bindings, and ongoing effects do not escape. Its scope is fully torn
down before the next test starts.

Each test has a fixed 20-second timeout. A timed-out test is halted, reported as
failed, and fully torn down before execution continues.

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
