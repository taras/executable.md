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

Testing uses the standard journal and replay behavior.

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
installs the testing vocabulary and collectors, activates testing mode for
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

Registering the testing vocabulary without `useTesting` leaves testing mode
inactive: `<Test>` is skipped, assertion components stay usable, and an
explicit `<Testing>` boundary still activates its subtree and turns its
failures — or an empty boundary — into an `Err` outcome for the execution.

## Assertions

Assertion components use `@std/assert` and follow its function names and
parameter names. The initial components are:

- `<Assert>` and `<AssertFalse>`
- `<AssertEquals>` and `<AssertNotEquals>`
- `<AssertStrictEquals>` and `<AssertNotStrictEquals>`
- `<AssertExists>`
- `<AssertStringIncludes>`
- `<AssertMatch>` and `<AssertNotMatch>`
- `<AssertGreater>` and `<AssertGreaterOrEqual>`
- `<AssertLess>` and `<AssertLessOrEqual>`

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

Assertion components work inside and outside tests. A failed assertion throws
the `@std/assert` assertion error. Outside a test, that error aborts document
expansion. Inside a test, `<Test>` contains and records it.

Assertions emit Markdown diagnostics in testing mode. During regular execution,
diagnostics are hidden unless `--verbose` is enabled. Failed assertions still
throw when diagnostics are hidden.

Diagnostics identify the assertion component and outcome. They include the
optional message and relevant actual and expected values. Failure diagnostics
include the underlying assertion detail when available. Their exact Markdown
layout is not prescribed, and formatting arbitrary values must not change the
assertion outcome or introduce a new failure.

Additional assertion components use the same rules: their names and props map to
an `@std/assert` export, they preserve its comparison and error semantics, and
they use the shared diagnostic behavior.

## Mocking

Testing has no separate mocking DSL. Tests install mocks through existing
context API middleware or helpers from `@executablemd/runtime/test`. Middleware
installed within a test applies to subsequent expansion in that test and is
removed with its scope.

## Unsupported Syntax

BDD syntax such as `describe`, `it`, `beforeEach`, and `beforeAll` is not
supported. Gherkin syntax such as `Given`, `When`, and `Then` is not supported.
