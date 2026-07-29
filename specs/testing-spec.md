# Executable.md Testing

## Motivation

Executable documents can contain probabilistic behavior. Tests ground that
behavior in observable results and give authors confidence in their documents.

## Testing Mode

Tests run only in testing mode. During regular execution, `<Test>` and its
entire body are skipped without output, bindings, or side effects.

`<Testing>` enables testing mode for its expanded subtree:

```md
<Testing>
  <Example />
</Testing>
```

The CLI command is equivalent to wrapping the entrypoint in `<Testing>`:

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

A test body behaves like any regular component body. Tests run sequentially in
expansion order. Each test runs in a child Effection scope and an isolated
binding environment. It inherits ambient context and bindings, but its context
changes, bindings, and ongoing effects do not escape. Its scope is fully torn
down before the next test starts.

Each test has a fixed 20-second timeout. A timed-out test is halted, reported as
failed, and fully torn down before execution continues.

An assertion failure, unexpected error, or teardown error fails only the current
test. Later tests still run. Unexpected errors remain distinct from assertion
failures. Output produced before a failure remains in the report and is followed
by the failure diagnostic.

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
`msg` where supported.

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
assertions. Like the other assertions, it emits a pass diagnostic only in
testing or verbose mode, and a failure aborts the document when it occurs outside
a test (inside a `<Test>` it is contained and recorded).

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
