# `@executablemd/runtime/test`

Composable test stubs for runtime context APIs.

These helpers install `around()` middleware on `@executablemd/runtime` so tests
can replace real I/O with scoped, in-memory behavior.

## When to use this module

Use these helpers when a test needs:

- an in-memory filesystem instead of real files
- a simple `exec` stub for `echo`-style command output
- a predictable failing `exec` for error-path assertions

Use raw `API.*.around()` directly when a test needs custom behavior that the
shared helpers do not provide.

## Exports

### `useStubFs(files)`

Installs an in-memory filesystem.

- `readTextFile(path)` returns `files[path]`
- `stat(path)` reports `exists/isFile` based on whether `path` is a key
- `glob()` throws with `"glob not stubbed"`

This is the right default for `runDocument()` tests that want to supply a small
virtual document tree inline.

```ts
import { useStubFs } from "@executablemd/runtime/test";

yield* useStubFs({
  "doc.md": "# Hello\n",
  "components/Greeting.md": "Hello, {props.name}!\n",
});
```

### `useEchoExec()`

Installs a simple process stub.

- recognizes `bash -c "echo ..."`
- returns the echoed text as `stdout`
- returns the script text for other `bash -c` commands

This is useful for tests that need `exec` blocks to produce deterministic text
without running a real subprocess.

```ts
import { useEchoExec } from "@executablemd/runtime/test";

yield* useEchoExec();
```

### `useFailingExec(exitCode, stderr)`

Installs a process stub that always fails.

- returns `{ exitCode, stdout: "", stderr }`

This is useful for testing error rendering, command failures, and non-zero exit
paths.

```ts
import { useFailingExec } from "@executablemd/runtime/test";

yield* useFailingExec(127, "command not found");
```

## Composition

The helpers are designed to compose.

```ts
import {
  useStubFs,
  useEchoExec,
  useFailingExec,
} from "@executablemd/runtime/test";

yield* useStubFs({ "doc.md": "```bash exec\necho hi\n```\n" });
yield* useEchoExec();
```

Typical combinations:

- `useStubFs(...)` + `useEchoExec()` for happy-path document tests
- `useStubFs(...)` + `useFailingExec(...)` for exec error tests
- `useStubFs(...)` only for pure file-driven tests with no subprocesses

## Scope semantics

These helpers are Effection middleware. They are scoped to the current
operation scope and its children.

Install them before calling `runDocument()` or `durableRun()`:

```ts
it("renders from stubbed inputs", function* () {
  const stream = new InMemoryStream();

  yield* useStubFs({ "doc.md": "# Hello\n" });
  yield* useEchoExec();

  const execution = yield* runDocument({ docPath: "doc.md", stream });
  const output = yield* collect(execution);
});
```

## Mutable file maps

`useStubFs(files)` captures `files` by reference.

That means you can mutate the object between runs to simulate file changes:

```ts
const files = { "doc.md": "version 1\n" };

yield* useStubFs(files);

// first run...

files["doc.md"] = "version 2\n";

// second run sees updated contents
```

This is especially useful for replay and freshness tests.

## When to drop down to raw `API.*.around()`

Use raw runtime middleware when you need behavior beyond the shared defaults.

Common examples:

- custom `glob()` results
- process stubs for `ls`, `cat`, `python`, or daemon flows
- env/platform overrides through `API.Env.around()`
- fetch-specific mocking through `API.Fetch.around()`

```ts
import { API } from "@executablemd/runtime";

yield* API.Fs.around({
  *glob([options], _next) {
    return [{ path: "a.md", isFile: true }];
  },
});
```

## Guidelines

- Prefer shared helpers for common happy-path tests
- Prefer raw `API.*.around()` for operation-specific behavior
- Keep helpers composable instead of adding one giant test runtime builder
- Keep stubs local to the scope of the test
