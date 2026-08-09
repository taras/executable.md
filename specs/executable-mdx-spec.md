# Executable MDX: Specification

**Status:** Draft
**Audience:** Implementing agent
**Inputs:** Prior streaming MDX research, `@effectionx/durable-streams` (journal protocol and journaling), `@effectionx/process` (`daemon`), `@effectionx/converge` (`when`), Document Output Api specification (ui-improvement-spec)

---

## 1. Overview

An executable MDX document is a markdown file containing embedded JSX
component invocations and annotated code blocks. The system treats each
document as an executable workflow: text is emitted immediately, component
references are resolved from the file system and expanded recursively,
and code blocks marked as executable are either run as subprocess
commands, evaluated in-process as Effection generator operations, or spawned as long-running
background processes via the `daemon` modifier. The journal records
operation journal entries as a diagnostic JSONL trace.

`--journal` names a path that does not exist; the CLI creates it for the
current run and fails rather than appending to or interpreting an existing
trace.

The execution boundary uses `createDurableOperation` from the internal
`durable-streams` package to write structured journal entries. This is a
journaling implementation detail, not a durability guarantee. The main
features are component import (a journaled operation that wraps the Resolve
Api and runtime file read), the in-process evaluation system (source transform,
module compilation, binding environment, and eval scope for resource
lifetime management — see §4), daemon process management (the
`daemon` terminal modifier, eval binding interpolation, and the
provider component pattern — see §3.3 and §6.6–6.7), and the
Document Output Api (an Effection Api with composable middleware for
streaming, whitespace-normalized, ANSI-formatted output — see §9).

Expansion also supports binding capture: component invocations may
declare `as="name"` to route rendered output into `env.values` instead
of the document, and the built-in `<Capture as="name">...</Capture>`
directive captures inline rendered content into `env.values`,
optionally applying a CSS selector (via remark + `unist-util-select`)
to extract specific markdown nodes from the rendered content, without
creating a new component boundary (see §6.5).

### 1.1 Example

Given three files:

```markdown
<!-- README.md -->
---
title: My Project
---

# {meta.title}

<Greeting name="world" />

The following files exist:

\`\`\`bash exec
ls ./src
\`\`\`
```

```markdown
<!-- components/Greeting.md -->
---
emoji: 👋

props:
  type: object
  properties:
    name: { type: string }
  required: [name]
  additionalProperties: false
---

{meta.emoji} Hello, {props.name}!

<Content />
```

Execution produces:

```
# My Project

👋 Hello, world!

The following files exist:

src/main.ts
src/utils.ts
```

The journal records:

```
[0] yield root  { type: "import_component", name: "__root__" }
    result: { status: "ok", value: { path: "README.md", content: "---\ntitle: ..." } }
[1] yield root  { type: "import_component", name: "Greeting" }
    result: { status: "ok", value: { path: "components/Greeting.md", content: "---\nemoji: ..." } }
[2] yield root  { type: "exec", name: "exec:ls ./src", command: ["bash", "-c", "ls ./src"] }
    result: { status: "ok", value: { exitCode: 0, stdout: "main.ts\nutils.ts\n", stderr: "" } }
[3] close root  result: { status: "ok", value: "# My Project\n\n👋 Hello, world!\n\n..." }
```

### 1.2 Workspace-relative paths

All paths stored in a diagnostic trace are **relative to the workspace root**
(the current working directory when `execute` is called). This
makes traces easier to compare and avoids leaking absolute local paths.

Runtime operations (`readTextFile`, `stat`, `exec`, `glob`) all resolve
paths relative to cwd, and the engine's own file access is written that way:
component search directories (`["./components", "./"]`) are relative, and
resolved paths in the journal (`"components/Greeting.md"`) are relative.

#### Document data and engine control plane

Two kinds of filesystem access are separate boundaries, and the separation is
what lets one document mean the same thing in two environments.

**Document data** — the files a document names in its own text — goes through
`API.Files`, a contextual Api of whole semantic operations. `<File>` (§6.13),
`<Glob>` (§6.14), and `<TempDir>` (§6.11) speak only that Api, hold no host
path, and never learn which provider answered. `xmd run` installs a host
provider that resolves those paths in the caller's filesystem; a workflow run
installs one whose paths name entries in a logical filesystem the run owns.
The Api has **no host default**: with no provider installed, every operation
fails the execution rather than reaching the host.

**The engine's own control plane** — the root document, component search,
replay guards, the eval compiler, the diagnostic journal, and the test target
— reads host paths the caller selected, through the low-level `API.Fs`. Those
are not document-addressable, and they stay where they are.

A path a document authored is always relative and always resolved by the
provider, against the contextual `Env.cwd` the component supplies with it.
Nothing the provider resolves reaches a printed error or the journal: what
crosses back is a reason from a fixed vocabulary (§6.13), never a resolved
path, a symlink target, a temporary name, an errno code, or a platform
message.

#### The contextual working directory

`exec` and `daemon` blocks launch their processes in the **contextual working
directory** — `Env.cwd`, read where the block runs. Its default is the
process's own working directory, so a document that rebinds nothing behaves as
it always has.

A component rebinds it for its content by installing `Env.cwd` middleware on
its own invocation:

```typescript
yield* API.Env.around({ *cwd() { return directory; } }, { at: "min" });
return yield* content();
```

Everything expanded inside then observes that directory, including nested
components and the processes their blocks start, and the binding ends with the
invocation (§4.4). A nested rebinding shadows the enclosing one for its own
content; siblings share nothing.

A `daemon` block reads the directory on the expansion frame, before entering
the eval scope that anchors the process. The eval-scope loop task is on a
different context chain, so a directory read from inside it would be the
process's own rather than the document's.

---

## 2. Segment IR

The boundary scanner (from prior research — 12-state JSX state machine)
parses raw markdown text into a flat sequence of segments. Segments are
the intermediate representation between parsing and expansion.

### 2.1 Segment types

```typescript
type Segment =
  | TextSegment
  | ComponentElement
  | ExecutableCodeBlock
  | ExecOutputSegment
  | ErrorSegment;

interface TextSegment {
  type: "text";
  content: string;
}

interface ComponentElement {
  type: "component";
  name: string;                          // PascalCase, e.g. "Greeting", "Ns.Sub"
  props: Record<string, Json>;           // JSX props resolved at scan time
  expressions: Record<string, string>;   // Eval expression props — raw text, resolved at expansion time
  children: Segment[];                   // Segments between opening and closing tags
  selfClosing: boolean;
}

interface ExecutableCodeBlock {
  type: "codeBlock";
  language: string;                      // e.g. "bash", "python"
  content: string;                       // The code inside the fence
  modifiers: Modifier[];                 // The middleware chain (e.g. [silent, exec])
  executable: true;
}

interface ExecOutputSegment {
  type: "execOutput";
  command: string;
  result: ExecResult;                    // { exitCode, stdout, stderr }
}

interface ErrorSegment {
  type: "error";
  message: string;
  source?: string;                       // Component name or command that failed
  cause?: Json;                          // Structured detail (e.g. prop-validation issues)
}
```

Non-executable code blocks are `TextSegment`s — the fence is preserved
as raw markdown text and passed through to the output without
interpretation.

### 2.2 Parsing: what produces segments

The boundary scanner identifies two kinds of execution boundaries in
markdown text:

**Component invocations.** Opening tags matching `<[A-Z]` trigger the
12-state JSX scanner. The scanner handles string attributes, expression
attributes with nested braces, template literals, nested JSX in
attributes, and spread props. Self-closing tags (`<Comp />`) produce a
single `ComponentElement` with no children. Block tags
(`<Comp>...</Comp>`) produce a `ComponentElement` whose `children`
are the recursively scanned segments between the tags — including
fenced code blocks (executable ones become `ExecutableCodeBlock`
segments, non-executable ones become `TextSegment`s) and nested
component invocations.

**Inline code spans.** Content inside backtick code spans (`` `...` ``,
``` ``...`` ```, etc.) is inert — `<[A-Z]` inside an inline code span
does not trigger component parsing. The scanner skips past matching
backtick sequences per CommonMark rules before checking for component
invocations. This applies at both the top level and inside component
children.

**Executable code blocks.** A fenced code block whose info string
contains `exec` or `eval` after the language identifier is executable.
Everything else in the document — paragraphs, headings, lists, links,
images, standard code fences — is passive text.

Parsing is a runtime operation. It is deterministic from its input text
and produces no journal entries.

### 2.3 Markdown healing: remend

Components and executable code blocks are **semantic boundaries**.
Markdown constructs (emphasis, links, code spans, math) cannot span
them. Each text segment must be valid markdown independently.

When the boundary scanner splits a document at an execution boundary,
the text segment before the boundary may contain unclosed markdown
constructs. For example:

```markdown
Hello **world
<Component />
more text
```

Produces two text segments: `Hello **world\n` (unclosed bold) and
`\nmore text`. Without healing, the unclosed `**` in the first
segment would bleed into the component expansion output, corrupting
the rendered markdown.

**remend** (`remend` npm package, MIT, Vercel) heals incomplete
streaming markdown. It is a pure function `string → string` that
closes unclosed constructs: bold, italic, strikethrough, code spans,
links, images, code fences, and math blocks.

#### Where healing runs in the pipeline

```
raw text → boundary scanner → text segments
                                    ↓
                               remend(segment, { htmlTags: false })
                                    ↓
                               interpolation ({meta.key}, {props.key})
                                    ↓
                               expansion / rendering
```

Healing runs **after** the boundary scanner (which produces segments)
and **before** interpolation (which resolves `{meta.key}` references).
This ordering is important:

- **After scanning:** The scanner guarantees no incomplete JSX in
  text segments. Remend only sees passive markdown.
- **Before interpolation:** If an interpolation result contains
  markdown markers (e.g., `{meta.title}` resolves to `**bold**`),
  those markers are *not* double-healed — they were introduced after
  healing.
- **Before expansion:** Children passed through `<Content />` are
  healed before substitution into the parent body.

#### `htmlTags: false`

This option is **required**. It tells remend not to close HTML-like
tags (`<div>`, `<span>`, etc.) in text segments. Without it, remend
would try to close any `<` it finds, including:

- Legitimate angle brackets in text (`a < b`, `x > y`)
- Lowercase HTML tags that the scanner correctly passed through
- Residual angle brackets from scanner edge cases

The boundary scanner owns JSX/HTML completeness. Remend owns
markdown construct completeness. `htmlTags: false` enforces this
separation.

#### What remend heals

| Construct | Unclosed example | Healed output |
|-----------|-----------------|---------------|
| Bold | `**text` | `**text**` |
| Italic | `*text` | `*text*` |
| Strikethrough | `~~text` | `~~text~~` |
| Inline code | `` `code `` | `` `code` `` |
| Link | `[text](url` | `[text](url)` |
| Link text | `[text` | `[text]` |
| Image | `![alt](url` | `![alt](url)` |
| Code fence | ```` ``` ```` (unclosed) | ```` ``` ```` + closing fence |
| Math | `$$formula` | `$$formula$$` |

remend does not distinguish an orphaned *closing* marker from an opener:
a trailing `**` or `*` is read as an unclosed emphasis run, so remend
appends a matching closer (`world** more` → `world** more**`,
`text* more` → `text* more*`).

#### What remend does NOT heal

- **JSX/HTML tags.** Disabled via `htmlTags: false`.
- **Cross-boundary constructs.** If a user writes `**` before a
  component and `**` after, these are two separate incomplete
  constructs, not one spanning construct. Each is healed independently.

#### Implementation

```typescript
import remend from "remend";

function healSegment(text: string): string {
  return remend(text, { htmlTags: false });
}
```

Healing is a **runtime operation** — pure, synchronous, deterministic
from its input. It produces no journal entry and runs on every execution.

---

## 3. Executable code block syntax

### 3.1 The info string as a middleware chain

````markdown
```bash silent exec
ls -la ./components
```
````

The CommonMark spec says the info string's first word specifies the
language and "this spec does not mandate any particular treatment of
the info string" beyond that. Standard markdown renderers (GitHub,
VS Code, markdown-it, micromark, Hugo, Docusaurus) use only the first
word for syntax highlighting and ignore the rest. This means:

- ```` ```bash silent exec ```` renders as a bash-highlighted code
  block in every standard renderer — the modifiers are invisible to
  renderers that don't understand them.
- No curly braces, no special prefix characters, no conflict with any
  existing markdown extension syntax.
- The document remains valid, readable markdown when opened in any
  editor or viewer that doesn't know about executable blocks.

The words after the language form a **middleware chain** read
left-to-right, where each modifier wraps the next. The rightmost
modifier is the innermost operation:

````
bash silent exec
     ^^^^^^ ^^^^
     |      |
     |      └─ innermost: execute the code block
     └─ wraps exec: suppresses output
````

This is middleware composition, not a bag of flags. Order matters:
`silent exec` means "execute, then suppress the output."
`exec` alone means "execute, show the output."

### 3.2 Detection rule

A fenced code block is executable when the info string contains `exec`
or `eval` as one of the words after the language (case-sensitive). The
first word is always the language. All subsequent words are the
middleware chain.

A code block with neither `exec` nor `eval` anywhere in the chain is
passive text — not executable, not processed.

### 3.3 Modifier middleware and registration

Each modifier in the info string is a **middleware** that wraps the
next handler in the chain. The rightmost modifier (`exec` or `eval`)
is the terminal — it performs the actual I/O. Every other modifier
calls `next()` to invoke the inner chain, then transforms the result.

The modifier system uses the `Middleware<TArgs, TReturn>` type and
`combine()` function from `@effectionx/middleware`, ensuring a single
composable middleware primitive across the codebase.

#### Middleware primitive

```typescript
/**
 * Reusable middleware type — matches Effection v4.1 exactly.
 *
 * - `args`  — arguments to the function being surrounded
 * - `next`  — delegate to the next link (accepts the same args shape)
 */
type Middleware<TArgs extends unknown[], TReturn> = (
  args: TArgs,
  next: (...args: TArgs) => TReturn,
) => TReturn;
```

#### Code block context

```typescript
interface CodeBlockContext {
  language: string;       // "bash", "python", etc.
  content: string;        // The code inside the fence
  blockId: string;        // Unique within the document run, e.g. "eval:root:0"
  componentName?: string; // Component this block is inside (if any)
}

interface CodeBlockResult {
  output: string;         // What gets rendered in the document
  exitCode: number;
  stderr: string;
}
```

The code block context is delivered contextually through the Component
Api (§5.5): the chain runner provides it for the duration of the chain,
and handlers that need it read `yield* useCodeBlock()` (an ergonomic
alias for the `codeBlock()` operation). Outside a running chain,
`codeBlock()` reports a clear missing-provider error.

This follows the Effection convention: shared execution context
lives on the scope and is accessed via contextual operations, not
threaded through function parameters.

#### Modifier factory and middleware types

Each modifier is registered as a **factory** — a function that
receives the modifier's parsed params and returns a middleware.
The middleware itself conforms to `Middleware<[], CodeBlockWorkflow>`
— no arguments flow through `next` (params are captured in the
factory closure, context is on the scope):

```typescript
type CodeBlockWorkflow = Workflow<CodeBlockResult>;
type ModifierMiddleware = Middleware<[], CodeBlockWorkflow>;

/**
 * A modifier factory — takes per-modifier params and returns a middleware.
 *
 * Terminal factories (exec, eval) ignore `next`.
 * Wrapping factories (silent, sample) call `next()` and transform the result.
 */
type ModifierFactory = (params: string | undefined) => ModifierMiddleware;
```

#### Registration

Modifier factories are registered on a `ModifierRegistry`:

```typescript
type ModifierRegistry = Map<string, ModifierFactory>;
```

The host installs built-in factories before `durableRun`:

```typescript
registry.set("exec", createExecFactory(runtime));
registry.set("silent", silentFactory);
registry.set("eval", evalFactory);
registry.set("persist", persistFactory);
registry.set("timeout", timeoutFactory);
registry.set("daemon", daemonFactory);
registry.set("ephemeral", ephemeralFactory);
registry.set("service", serviceFactory);
```

Custom factories can be provided via `ExecuteOptions.modifiers`.

#### Built-in terminal handlers

**`exec`** — executes the code block as a shell command via
`durableExec`. This is a terminal handler — it does not call `next()`.
It reads the code block info from the Effection context via
`useCodeBlock()`:

```typescript
function createExecFactory(): ModifierFactory {
  return (_params) => (_args, _next) => function* () {
    const context = yield* useCodeBlock();
    const command = buildCommand(context.language, context.content);
    const result = yield* durableExec(
      `exec:${truncate(context.content, 40)}`,
      { command, timeout: 30_000, throwOnError: false },
    );
    return {
      output: result.stdout,
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  }();
}
```

**`eval`** — evaluates the code block in-process as a journaled Effection
generator operation. Also a terminal handler. Unlike
`exec` (subprocess), `eval` executes code in the same Effection
process, enabling direct access to live in-memory objects, native
`yield*` of Effection operations, and shared state across blocks
within a component via a binding environment (see §4).

Eval blocks produce **no rendered output by default**. They can
optionally produce output via the `output()` function (see §4.7).

Observable behavior of an `eval` block:

- The block and its binding environment are read contextually (§5.5);
  running an eval block without an environment in scope is a clear error.
- Execution is journaled as one `eval` entry named after the block id.
  The JSON-serializable exports (plus the `__output` text, §4.7) are
  stored in the entry; on replay they are restored into the environment
  without re-executing the block.
- New bindings the block exports merge into the shared environment, so
  later blocks in the same component can read them.
- Under `persist`, only the compiled block runs inside the component
  eval scope (§4.4), so resources it spawns outlive the block.
- The block's rendered output is the `output()` text, or the coerced
  return value when `output()` was not called (§4.7).

**`ephemeral eval`** evaluates the compiled block without a durable operation
or journal entry. It reconstructs execution-owned state during partial replay,
so it reads the component's durable bindings plus its live binding overlay and
publishes new live bindings atomically after successful completion. It accepts
only a nullish return value, and calling `output()` is an error. The modifier is
valid only directly around the terminal `eval`; `persist ephemeral eval` keeps
installed middleware in the invocation eval scope.

**`service=<binding>`** is a terminal service-attachment modifier. The code
block content is the shell command passed to `startService()`, and the required
parameter is the live binding that receives the frozen
`{ hostname: "127.0.0.1", port }` endpoint. Binding syntax and collisions are
validated before process attachment. The modifier produces no output or
journal entry, and the service attachment remains supervised until the
component invocation closes.

````markdown
```bash service=server exec
./handshake-compatible-server
```

```ts persist ephemeral eval
import { callProvider } from "./client.ts";

const endpoint = server;
yield* Sample.around({ /* provider middleware using endpoint */ });
```
````

**`daemon`** — spawns a long-running subprocess and immediately
returns control to the document. The process is alive for the
duration of the component invocation and killed when that invocation's
eval scope closes (§4.4). Unlike `exec`, it produces no journal entry and never waits
for the process to exit.

`daemon` is a **terminal modifier** — it ignores `next()` and does
not call the inner chain. Because the detection rule (§3.2) requires
`exec` or `eval` as a word in the info string, `daemon` blocks are
written with `exec` present:

````markdown
```bash daemon exec
./server --port {port} --nobrowser
```
````

The `exec` modifier appears in the chain but is never invoked —
`daemon` is outermost and ignores `next`. The presence of `exec` in
the info string is purely syntactic: it satisfies the detection rule
and signals to readers that this block runs a command.

`daemon` is for fixed-configuration background processes. It does not allocate
or publish a dynamic endpoint and does not perform the XMD service handshake;
attached network services use `service=<binding>`.

| Property | `exec` | `daemon` |
|---|---|---|
| Waits for exit | Yes | No |
| Journal entry | Yes — stdout/stderr/exitCode | No |
| Crash detection | Via non-zero exit code in result | Via `daemon()` from `@effectionx/process` throwing |
| Lifetime | Until command exits | Until the component invocation completes |
| Repeated-run behavior | Spawns a fresh subprocess every run | Spawns a fresh subprocess every run |

Observable behavior of a `daemon` block:

- The block's command (its content, already interpolated by the
  expansion engine) is forked into the component eval scope (§4.4);
  running a daemon block without an eval scope in scope is a clear
  error.
- The block produces no journal entry and no rendered output — control
  returns to the document immediately after the fork.

**Process lifetime.** The forked task calls `daemon(command)` from
`@effectionx/process`. `daemon` spawns the process and suspends
indefinitely. When the invocation's eval scope closes — the third stage of
the invocation teardown in §4.4 — the forked task is cancelled, which tears
down the daemon and terminates the subprocess. No explicit teardown, no finalizer
registration, no lifecycle hooks are required — Effection's structured
concurrency handles it.

**Crash propagation.** If the process exits prematurely, `daemon()`
throws with a descriptive error. This error propagates to the
`evalScope`, which tears it down. The eval scope teardown propagates
to the component expansion, failing it before any child blocks are
attempted. The error surfaces as an `ErrorSegment`.

**Repeated-run behavior.** `daemon` runs on every document execution. The
process starts, runs for the duration of the component invocation, and is
terminated when that invocation completes.

#### Built-in wrapping handlers

**`silent`** — calls `next()` (the inner chain runs, effects are
journaled), then suppresses the output while preserving the command's
outcome. The exit code and stderr are the inner chain's, so a silenced
command that failed is still a failure:

```typescript
const silentFactory: ModifierFactory = (_params) =>
  (_args, next) => function* () {
    const result = yield* next();   // inner chain runs — exec journals its result
    return { ...result, output: "" };
  }();
```

**`persist`** — extends resource lifetime from block scope to the
component's eval scope. Without `persist`, resources spawned inside an
eval block are torn down when the block completes. With `persist`, the
block's compiled code runs via `evalScope.eval()`, retaining spawned
resources for the lifetime of the component expansion. See §4.5 for
the context flag pattern.

`persist` itself does not call `evalScope.eval()` — it makes the
contextual `persistent` value (§5.5) answer true for the duration
of the inner chain, and `evalFactory` reads that to decide whether to
route through the eval scope. The install is scope-local, so
`persistent` reverts to false as soon as the persist-wrapped chain
completes.

| Info string | Behavior |
|---|---|
| `js eval` | Block completes; spawned resources torn down at block end |
| `js persist eval` | Block completes; spawned resources live until component ends |

**`timeout`** — cancels the block if it does not complete within the
specified duration. Uses `timebox()` from `@effectionx/timebox`, which
returns a discriminated union (`Timeboxed<T>`) instead of throwing.
Accepted units: `ms`, `s`, `m`. Default: `30s`.

```typescript
export const timeoutFactory: ModifierFactory = (params) =>
  (_args, next) => (function* () {
    const ms = parseDuration(params ?? "30s");
    const result = yield* timebox(ms, () => next());
    if (result.timeout) {
      throw new Error(`eval block timed out after ${params ?? "30s"}`);
    }
    return result.value;
  })();

function parseDuration(s: string): number {
  if (s.endsWith("ms")) return parseInt(s, 10);
  if (s.endsWith("m"))  return parseInt(s, 10) * 60_000;
  if (s.endsWith("s"))  return parseInt(s, 10) * 1_000;
  return parseInt(s, 10);
}
```

#### Chain composition

When a code block is encountered during expansion, the modifier chain
is composed using the reusable `combine()` primitive. Each factory is
called with its parsed params to produce a middleware, then all
middlewares are combined into a single chain. A missing factory or a
chain with no terminal modifier is an error. While the chain runs, the
block's `CodeBlockContext` is available to every handler through the
contextual `codeBlock()` operation (§5.5), and it is gone when the
chain completes.

For ```` ```bash silent timeout[30s] exec ````:

```
exec    = execFactory(undefined)       // terminal middleware
timeout = timeoutFactory("30s")        // wraps exec
silent  = silentFactory(undefined)     // wraps timeout
composed = combine([silent, timeout, exec])
```

Calling `composed([], terminal)` runs silent → timeout → exec. The
exec handler journals the command result. The timeout handler cancels
the block if it overruns. The silent handler discards the output and
keeps the outcome.

#### Overriding per-scope

Because factories are stored in a registry that can be extended,
custom modifiers can be provided via `ExecuteOptions`:

```typescript
yield* execute({
  path: "README.md",
  stream,
  runtime,
  modifiers: {
    uppercase: (_params) => (_args, next) => function* () {
      const inner = yield* next();
      return { ...inner, output: inner.output.toUpperCase() };
    }(),
  },
});
```

This follows the same mental model as `scope.around(Divergence, ...)`
or `scope.around(Resolve, ...)` — composable behavioral override
via middleware.

### 3.4 The Sample Api

The `<Sample>` component delegates LLM access to the
**Sample Api** — an Effection Api with middleware that determines
which model is called, what prompt is constructed, and how the
response is post-processed.

`SampleContext` is content-centric (DEC-87): providers receive the
rendered content and build their own message arrays.

```typescript
// src/types.ts
interface SampleContext {
  /** The content to send to the LLM (rendered children or prompt text). */
  content: string;
  /**
   * Model identifier requested by the sample call. Undefined if the author
   * did not specify a model — in which case the innermost active provider wins.
   */
  model?: string;
  /** Additional params for the sample call. */
  params?: string;
  /** System prompt set by enclosing `<Instructions>` components. */
  system?: string;
  /** Name of the component that initiated the sample call. */
  componentName?: string;
}

interface SampleApi {
  sample(context: SampleContext): Operation<string>;
}

const Sample = createApi<SampleApi>("Sample", {
  *sample(context: SampleContext): Operation<string> {
    throw new Error(
      "Sample Api requires provider middleware — " +
      "install a provider (e.g., OllamaProvider) or " +
      "install middleware on the Sample Api before using <Sample> components"
    );
  },
});
```

Sample Api calls route through the `EvalScope` so that middleware
installed by `persist ephemeral eval` blocks in provider components is
visible — `evalScope.eval()` runs the operation in
the same spawned task where the middleware was installed.

#### Sample middleware examples

```typescript
// Default: generic summarization
scope.around(Sample, {
  *sample([context], next): Operation<string> {
    return yield* callLLM(buildPrompt(context));
  },
});

// Model routing by component
scope.around(Sample, {
  *sample([context], next): Operation<string> {
    if (context.componentName === "TestReport") {
      return yield* callClaude("claude-sonnet-4-20250514", context);
    }
    return yield* next(context);  // fall through to default
  },
});

// Param-driven: sample=passthrough skips LLM
scope.around(Sample, {
  *sample([context], next): Operation<string> {
    if (context.params === "passthrough") return context.content;
    return yield* next(context);
  },
});

// Testing stub
scope.around(Sample, {
  *sample([context], next): Operation<string> {
    return `[stub] sampled ${context.content.length} bytes`;
  },
});
```

### 3.5 Modifier parsing

The info string is split on whitespace. The first token is the
language. The remaining tokens are the modifier chain:

```typescript
interface ParsedInfoString {
  language: string;
  modifiers: Modifier[];
  executable: boolean;       // true if 'exec' or 'eval' is in the chain
}

interface Modifier {
  name: string;              // e.g. "silent", "exec", "timeout"
  params?: string;           // e.g. "30s" from "timeout=30s"
}

function parseInfoString(infoString: string): ParsedInfoString {
  const tokens = infoString.trim().split(/\s+/);
  const language = tokens[0] ?? "";
  const modifiers: Modifier[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const eqIdx = tokens[i].indexOf("=");
    if (eqIdx >= 0) {
      modifiers.push({
        name: tokens[i].slice(0, eqIdx),
        params: tokens[i].slice(eqIdx + 1),
      });
    } else {
      modifiers.push({ name: tokens[i] });
    }
  }

  return {
    language,
    modifiers,
    executable: modifiers.some(m => m.name === "exec" || m.name === "eval"),
  };
}
```

### 3.6 What is the command?

The content of the code block is the command. The language determines
how it is invoked:

| Language | Command construction |
|----------|---------------------|
| `bash`, `sh` | `["bash", "-c", content]` |
| `python`, `py` | `["python", "-c", content]` |
| `node`, `javascript`, `js` | `["node", "-e", content]` |
| Other | `[language, "-c", content]` (convention) |

Multi-line code blocks are passed as a single string to the `-c` flag.

### 3.7 Examples of modifier chain execution

**`exec` alone** — `exec` runs the command via `durableExec`
(one journal entry). stdout becomes the output.

Whether a block failed is a separate question from what it printed, and
the exit code alone answers it. A non-zero exit produces an
`ErrorSegment` — decided by the ambient error mode, so a comment under
`print` and a failure under `output` or `throw` (§6.9) —
whatever the command wrote. Output the command produced is kept as its
`execOutput` segment and precedes that printed error, because a command
that prints before it fails is usually explaining itself.

**`silent exec`** — `exec` runs the command and journals the
result as usual. `silent` calls `next()` (so exec runs), then returns
the same outcome with empty output. No extra journal entry from
`silent`. A non-zero exit is still a failure: `silent` hides what the
command printed, not whether it worked.

**`silent timeout[30s] exec`** — `exec` journals the command result.
`timeout` cancels the block if it overruns. `silent` discards the
output. The journal entry is still written; the document gets nothing.
The inner chain still runs because `silent` wraps `timeout` — it calls
`next()` which runs the entire inner chain before discarding.

**`daemon exec`** — `daemon` is the outermost terminal modifier. It
ignores `next` entirely — `exec` is never invoked. `daemon` forks the
command as a background process into the eval scope. No journal entry.
The process lives until the component scope closes.

---

## 4. In-process evaluation

Eval blocks run JavaScript **in-process** as Effection generator operations.
Unlike `exec` blocks (which run shell commands in a subprocess), `eval`
blocks execute in the same Effection process. This section describes the
architecture: source transform, module compilation, binding environment,
eval scope, and diagnostic journaling.

### 4.1 Source transform

Top-level `const`/`let`/`function`/`class` declarations are scoped to the
block invocation. The source transform rewrites them so their values are
also written to `env`, making them available to subsequent blocks and to
the journal system.

**Implementation:** `src/eval-transform.ts` using **acorn** for parsing
and **magic-string** for string mutations.

```typescript
interface TransformResult {
  code: string;        // transformed body, without the generator wrapper
  map: string;         // V3 source map JSON
  exports: string[];   // top-level names written to env
  imports: string[];   // names read from env (free variables present in env)
  mode: "generator" | "async" | "sync";
  userImports: string[]; // import declarations hoisted to module level
}

function transformBlock(
  source: string,
  blockId: string,
  currentEnvKeys: string[],
): TransformResult;
```

#### User import extraction (DEC-93)

Eval blocks may contain standard `import` declarations. These are
extracted from the AST during `transformBlock` and hoisted to the
generated module's top level by `compileBlock`.

Acorn's `allowImportExportEverywhere: true` option allows `import`
declarations inside the generator function wrapper alongside `yield`
expressions. The transform separates `ImportDeclaration` nodes from
body nodes — imports go to `userImports`, body nodes proceed through
the existing pipeline (mode detection, export collection, etc.).

TypeScript `import type { X }` syntax is handled by normalizing
`type` to spaces (same length, preserving AST positions) before
acorn parse, then extracting the original source text.

```typescript
// Eval block source:
import { parseDiff } from "@executablemd/code-review-agent";
const pr = parseDiff(rawDiff, rawFiles, meta);

// transformBlock produces:
//   userImports: ['import { parseDiff } from "@executablemd/code-review-agent";']
//   code: 'const { rawDiff, rawFiles, meta } = env;\nconst pr = parseDiff(rawDiff, rawFiles, meta); env.pr = pr;'

// compileBlock generates:
import { sleep, spawn, ... } from "effection";       // STANDARD_IMPORTS
import { parseDiff } from "@executablemd/code-review-agent";  // userImports
export default function*(env) {
  const { rawDiff, rawFiles, meta } = env;
  const pr = parseDiff(rawDiff, rawFiles, meta); env.pr = pr;
}
```

#### Transform rules

| Statement | Transform |
|---|---|
| `const x = expr` | `const x = expr; env.x = x;` |
| `let x = expr` | `let x = expr; env.x = x;` |
| `function f() {}` | `function f() {} env.f = f;` |
| `class C {}` | `class C {} env.C = C;` |
| `const { a, b } = expr` | `const { a, b } = expr; env.a = a; env.b = b;` |
| Nested declarations | Not exported — only direct `ast.body` children |

Top-level free variable references that exist in the current `env` are
injected as a destructuring preamble:

```typescript
// If block references `port` and env.values.port exists:
const { port } = env;
```

Only names actually used as free variables are injected — not all of `env`.

#### Transform pipeline

1. **Parse** with acorn (`ecmaVersion: "latest"`, `sourceType: "module"`)
2. **Detect mode** — see below
3. **Collect exports** — walk `ast.body`; extract bound names from each
   top-level declaration, recursively unpacking destructuring patterns
4. **Collect imports** — find free variable references in `currentEnvKeys`
5. **Build preamble** — `const { a, b } = env;` for each imported name
6. **Append env-writes** — `env.x = x;` after each top-level declaration
   via `s.appendLeft(node.end, ...)`
7. **Append** `//# sourceURL=eval:${blockId}` for debugger identification
8. **Generate** source map via `s.generateMap({ source: blockId, hires: true })`

The transform produces the **body** of the generator function. The
`function*(env) {` wrapper is added by `compileBlock` (§4.2).

#### Execution mode auto-detection

Mode is detected from the AST — no modifier needed:

| Condition | Mode |
|---|---|
| Top-level `yield` expression in `ast.body` | `"generator"` |
| Top-level `await` expression in `ast.body` | `"async"` |
| Neither | `"sync"` |

Only direct children of `ast.body` are inspected. `yield`/`await` inside
nested function bodies do not count.

A block with both top-level `yield` and top-level `await` is a
transform-time error.

#### Generator wrapping

All blocks are wrapped in a generator function by `compileBlock`. The
source must be wrapped in `(async function*() {...})` before parsing so
both `yield` and `await` are syntactically valid. Mode detection then
rejects mixed yield+await at the semantic level. The acorn wrapper
prefix `(async function*() {\n` is 22 characters — AST node positions
must be offset-corrected when used with MagicString on the original
source.

#### Binding serialization

```typescript
function serializeExports(
  env: Record<string, unknown>,
  names: string[],
): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const name of names) {
    const value = env[name];
    if (isJson(value)) {
      result[name] = value as Json;
    }
    // Non-serializable values silently omitted.
    // They remain in env.values as live references during this run
    // but are absent from the diagnostic journal.
  }
  return result;
}
```

### 4.2 Module compilation

Eval blocks are compiled into TypeScript modules and dynamically imported
(`compileBlock` in `src/eval-context.ts`, delegating to `API.Env.compile`).
Eval blocks can use standard `import` statements, resolved through the host's
module resolution.

#### The compiler contract

```typescript
type EvalBlock = (
  env: Record<string, unknown>,
) => Operation<unknown>;

compile(
  source: string,
  options?: { imports: string[] },
): Operation<EvalBlock>;
```

A compiled block accepts the document binding environment and returns an
Operation, which the caller runs with `yield*`. Current compilers implement it
with generated `function*` modules, but callers do not depend on that
representation.

#### Who installs a compiler

Compiling a block means loading a module the way this host loads modules, so
`compile` sits on `API.Env` beside `command`: both are capabilities only the
entrypoint that knows the host can supply. `execute()` neither detects the
runtime nor installs a compiler.

- A document with **no eval blocks** never reaches `API.Env.compile`, and runs
  with no compiler middleware installed.
- A document **with eval blocks** requires the caller to have installed
  middleware via `API.Env.around()`. With none installed, the default handler
  fails with `compiler not installed — install platform-specific middleware
  via API.Env.around()`. It does not guess.
- A compiler the caller installs is the one used. `execute()` does not
  replace or wrap it.

The CLI satisfies this from its runtime-named entrypoints (§9.6). Two
implementations ship, and neither is locked to the runtime its name once
suggested:

| Middleware | Mechanism | Hosts |
| --- | --- | --- |
| `useDataUriCompiler()` | imports a `data:` URI; touches no disk | Deno, Bun, the compiled binary |
| `useTempFileCompiler()` | writes `.xmd-eval/<uuid>.ts` and imports `file://` | any host, and the only one Node's tsx loader accepts |

An entrypoint installs whichever its host can load, with `{ at: "min" }`, so
it sits at the base of the middleware chain. Where the two disagree — Node's
tsx loader rejects `data:` URI imports — that is a property of the loader, not
of the eval block.

Because the entrypoint's compiler is a base provider, ordinary middleware
wraps it rather than racing it. The behavior-document policy in
`packages/test-agent/src/worker/profile.ts` is exactly this: it inspects a
block, rejects static and dynamic imports, and delegates the rest to whatever
the entrypoint installed.

#### The generated file belongs to the compilation

`useTempFileCompiler()` writes a file, so it owns one. Each compilation runs in
a private scope, and the removal of `.xmd-eval/<uuid>.ts` is registered against
that path before anything can create it. The file is therefore gone before the
compilation settles, whichever way it settles: before a compiled block is
returned, before a failing import reaches the caller, and before a cancelled
compilation finishes halting. A removal that fails for any reason other than
the file already being absent leaves that scope rather than being discarded.

`.xmd-eval` is a relative literal, resolved against the host process's current
working directory when a compilation chooses the path. Running
`path/to/document.md` does not itself move that directory to the document's
directory, and the contextual `API.Env.cwd` does not control it, because this
compiler does not consult that Api.

#### Standard imports

Every generated eval module is prepended with standard imports:

```typescript
import { sleep, spawn, call, resource, useScope, createChannel, each, suspend, createSignal } from "effection";
import { when } from "@effectionx/converge";
import { fetch } from "@effectionx/fetch";
import { Sample } from "@executablemd/core";
```

These imports resolve through Deno's import map (`deno.json`).
`@executablemd/core` re-exports executable.md-specific APIs from its root
barrel (`packages/core/mod.ts`).

`useContent` is **not** among them. It projects content, and a projection
settles its errors under the error mode of the block that started it, which the
binding environment carries per evaluation (§4.3) and a module import cannot.
It arrives instead as a bare binding alongside `renderChildren` and `render`. A
block may still import it explicitly, which shadows the binding and settles
under the invocation's baseline error mode — a low-level escape hatch, not the
ordinary way to project content.

A name a block imports is treated as already declared, so the preamble never
destructures it from `env` as well; an explicit import and an injected binding
of the same name cannot collide.

The exact list lives in the `STANDARD_IMPORTS` constant, which both
compilers share (`src/data-uri-compiler.ts`, `src/temp-file-compiler.ts`).

#### Attached service API

`@executablemd/runtime` exports provider-neutral `API.Service` under the stable
context-api name `runtime.service`, and its ordinary operation as
`startService()`:

```typescript
interface ServiceEndpoint {
  readonly hostname: string;
  readonly port: number;
}

interface ServiceStartOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly startupTimeout?: number;
}

interface ServiceAttachment {
  readonly endpoint: Readonly<ServiceEndpoint>;
}

interface ServiceHandler {
  start(options: ServiceStartOptions): Operation<ServiceAttachment>;
}
```

The endpoint is exactly a newly constructed frozen `{ hostname, port }` object.
The terminal handler throws `ServiceProviderError`; shared runtime code never
detects a host or silently starts a native process. Runtime-named CLI adapters
provide the authenticated loopback implementation described in §6.7.

#### `when`

`when` from `@effectionx/converge` retries an inner operation with
backoff until it completes without throwing. It is useful for transient
application-level conditions after an endpoint already exists:

```typescript
yield* when(function* () {
  yield* fetch(`${baseUrl}/health`).expect();
});
```

`fetch().expect()` from `@effectionx/fetch` throws `HttpError` on non-2xx
responses. `when` catches it and retries until the assertion passes or the
timeout expires. Attached-service startup is established by the XMD service
handshake protocol, not by polling from a document.

#### Compiling blocks

`compileBlock` generates a `data:` URI TypeScript module, dynamically
imports it, and returns the default-exported generator function.
It is an async operation (`Operation<GeneratorFunction>`) because
`import()` is asynchronous.

```typescript
export function* compileBlock(
  transformedBodyCode: string,
  userImports: string[],
): Operation<(env: Record<string, unknown>) => Generator<unknown, void, unknown>> {
  const userImportLines = userImports.length > 0
    ? userImports.join("\n") + "\n"
    : "";

  const moduleSource = [
    STANDARD_IMPORTS,
    userImportLines,
    `export default function*(env) {`,
    transformedBodyCode,
    `}`,
  ].join("\n");

  const dataUri = `data:application/typescript,${encodeURIComponent(moduleSource)}`;
  const mod = yield* call(() => import(dataUri));

  return mod.default;
}
```

The env preamble (`const { x, y } = env;`) is already in the
`transformedBodyCode` — generated by `transformBlock()`.
`compileBlock` does NOT add a second preamble.

Each run compiles and imports the current transformed source.

### 4.3 Durable and live binding environments

```typescript
// src/types.ts
export interface EvalEnv {
  values: Record<string, unknown>;
}
```

Created fresh at the start of root or Markdown-component expansion. A root or
Markdown component installs the exact validated, defaulted props object under
the single `values.props` key; it does not spread properties into `values`.
Each eval block reads bindings from `values` (via env preamble) and writes new bindings back
(via env-write transforms). The current environment is read contextually
via the `env` value (§5.5); the expansion engine provides it
scope-locally around each component body, so eval blocks within a
component share bindings without leaking into parent or sibling
components.

`EvalEnv.values` is the **durable binding environment**. A private live overlay
belongs to the same component environment but is not part of the public
`EvalEnv` shape. The overlay holds service endpoints and values exported by
`ephemeral eval`. Content projection switches back to the caller's environment,
so a component's live overlay remains isolated from its parent, siblings and
projected caller content.

| Consumer | Durable bindings | Live bindings |
| --- | --- | --- |
| ordinary `eval` | yes | no |
| `ephemeral eval` | yes | yes |
| code-block and prose interpolation | yes | no |
| journal serialization and replay restore | yes | no |

The two namespaces may not overlap. `service=<binding>` validates the binding
name and checks both environments before attaching a process. Ordinary durable
eval first transforms the block to discover its declared exports, then validates
them against live names before constructing its durable effect. An invalid eval
is document validation: it never becomes a `DurableEffect` and appends no eval
`Yield`. A valid partial replay performs the same validation before yielding an
effect, so a diagnostic from the original run leaves later recorded effects
aligned. If retained history instead contains a successful eval `Yield` that the
current definition no longer yields, the existing replay guard, divergence and
stale-input rules reject that incompatible history; validation never consumes
the recorded result or substitutes an unjournaled error. If collision handling
terminates the document before another durable effect is reached, the durable
root detects the unaligned eval `Yield` before writing `Close(err)`, raises
`TerminalDivergenceError` with the collision as its cause, and leaves the
retained journal unchanged. Root and child termination apply this check to the
whole retained coroutine subtree, including completed children the current
definition never claimed. A compatible definition can still replay it.
`ephemeral eval`
validates its exports against durable names before execution; it may atomically
replace an existing live binding. A failed block publishes none of its exports.
Values from the live overlay are never substituted into a durable effect's
source and never serialized.

**Each evaluation runs against a snapshot, and commits its exports.** A block
receives a plain object holding the bindings as they stood when it started. Its
declared exports are published to the shared record once it completes
successfully — which is what carries a function or a live object to later
blocks, since the journal keeps only the JSON-serializable subset (§4.5).

A block therefore never observes a later block's changes to the shared record,
and work that outlives its block keeps the values it captured. Nothing is
written to the invocation's contexts and nothing is swapped on the shared
record, so evaluations cannot interfere with one another's bindings.

`renderChildren`, `render` and `useContent` project content, and a projection
settles its errors under the error mode of the block that started it (§6.9) — a
`persist eval` block runs on the invocation's eval-scope loop task, which was
created before that error mode existed and does not inherit it. The snapshot carries
those three as ordinary closures bound to the error mode where the block sits, so
persistent work keeps projecting under its own.

### 4.4 Eval scope and resource lifetime

An **eval scope** anchors resources that outlive the block which created them.
The current one is read contextually via the `evalScope` value (§5.5). There are
three, nested:

- the **document** scope, created in `execute()` (§8.1) **before** `durableRun`.
  This is critical: `evalScope.eval()` sends to a channel whose processor must be
  reachable by the Effection scheduler, which only works when both sender and
  processor share an ancestor scope outside the durable execution boundary.
  Root-level blocks anchor here.
- an **invocation** scope, one per component invocation (§6.2). `persist` blocks
  and daemons in a component's body anchor here.
- a **content** scope, created at an invocation's first projection and shared by
  the rest of them (§6.3). Everything projected content creates anchors here —
  Markdown `<Content />`, a function component's `content()`, and the
  `renderChildren()`, `render()` and `useContent()` bindings injected into eval
  blocks (§4.3) alike.

#### The invocation boundary

A component invocation creates its eval scope on its own expansion frame and
runs its body inside a task that scope owns:

```
invocation frame           expansion providers, error mode, DurableContext
└─ evalHost
   └─ A's loop task        the invocation's eval scope
      └─ body task         the component body, its resources and its middleware
         └─ content host   the content scope, at the first projection
```

One context chain therefore carries the expansion providers down to projected
content and persistent middleware back up: middleware a component installs is
visible to its projected content, including persistent work created there, and
ancestor persistent middleware stays visible to nested invocations. The body is
a child task of the loop task rather than the loop itself, so a block calling
`evalScope.eval()` never waits on the channel that is running it.

An invocation needs no ambient eval scope to exist. Expansion driven directly
through `expandSegments` — without the document scope — still gives every
invocation its own.

#### Teardown

Leaving an invocation runs one destructor with three ordered stages:

1. halt the content scope, to completion — everything projected content created;
2. halt the body — the resources the component itself acquired;
3. halt the invocation scope — whatever `persist` and `daemon` retained.

Each stage finishes before the next begins, so projected content has stopped
before the component releases anything of its own, whichever order the component
happened to acquire things in. The ordering is the boundary's, not a
consequence of acquisition order within a scope: a provider that retains a
resource *after* projecting still releases it after that content stops. Every stage is attempted even when an earlier one
fails; the failures are reported together as one teardown error.

Success, error and cancellation all leave through that destructor. A body that
throws has its throw caught at its task boundary, so its resources are still
alive when the first stage runs.

Body execution and teardown are different failure domains, and cleanup failure
never erases the failure that caused the unwind. A body failure with clean
teardown is rethrown unchanged; a teardown failure alone is the single teardown
error; when both fail, the caller receives one aggregate whose ordered members
are the body failure and that teardown error. Every original failure stays
reachable by object identity, so fatal discovery (§6.11) traverses the combined
graph with its usual precedence.

Nested invocations tear down leaf-first: a component inside projected content
has its own boundary beneath the content scope, so halting that scope dismantles
the whole subtree first. Sibling invocations share nothing.

#### Retained resources

A component whose result is only useful while something stays alive — a
directory a later sibling still has to read, a server a later block still has
to reach — needs the opposite lifetime: the resource has to outlive the
invocation that produced it. `retain()` gives it one:

```typescript
const dir = yield* retain(() => useTemporaryDirectory());
```

Each call opens an **isolated child of the invocation-site eval scope** — the
scope that was current where the element was written, read before the
invocation installs its own — and runs the factory there. The child is owned by
the site, so the resource lives as long as the site does; nothing is
transferred, and nothing outlives the tree it was created in. It is released
when the site succeeds, fails, or is cancelled.

Which scope the site is follows from the nesting above. An element written
inside another component's projected content retains into that component's
**content scope**, so it is released by stage 1 of the enclosing invocation's
teardown — ahead of the resources that component acquired for itself. An
element at the root retains into the **document scope** and lives for the
execution.

The child is what keeps retention a lifetime rather than authority over the
caller. A factory is arbitrary code: run directly on the site it could set a
context value or install middleware — the same mechanism that lets a `persist`
block install a provider for the rest of its invocation — and every later
sibling expanding in that scope would observe it. Inside the child, those
writes land on the child and stop there. Only the provided value crosses back.

Neither scope is handed to the component. `retain()` takes a factory and
returns its value; there is no accessor for either, and a component cannot
inspect or install anything on its caller.

Retaining delays release; it does not opt out of it. The site is an ordinary
scope, so a retained resource is torn down with it — leaf-first, on success,
failure, and cancellation alike.

Every invocation answers `retain()` for itself. One with no site to retain into
reports that rather than falling back to invocation lifetime, which would hand
the caller a resource that is about to disappear, and rather than deferring to
whatever provider it happens to inherit, which would create the resource in a
scope with no relationship to the call site.

#### Retention is component execution, not eval

`retain()` is an operation of TypeScript component execution. A component runs
in full on every execution, which is what makes invocation-site lifetime
meaningful: each execution re-establishes what it retained, and each execution's
site scope releases it.

An eval block does not. Its execution is durable — a replay restores the block's
exported values from the journal without entering the executor — so a block that
retained a resource would, on replay, produce a restored value naming a resource
nothing re-created. Eval execution therefore installs a provider that refuses
`retain()`; a block that needs a resource to outlive it belongs in a TypeScript
component. Making eval retention replay-safe is a durability question this
contract does not answer.

The refusal is installed where the block runs. An ordinary block runs on the
expansion frame and is refused for the length of the block, so content projected
later in the same invocation still reaches the invocation's own provider. A
`persist` block runs on the invocation's eval-scope loop task and is refused
there, without a nested scope — the work and middleware such a block installs
belong to that loop task and must outlive the block.

#### The persistent-flag pattern

`persist` does not wrap the entire modifier chain in `evalScope.eval()`.
That would hang because the durable effects in the workflow can't
interact with the journal from within the eval scope's channel
processor. Instead:

1. `persist` makes the contextual `persistent` value answer true
   for the duration of the inner chain
2. `evalFactory` reads `persistent` after compiling the block
3. When true, only the **compiled VM block** (`fn(env.values)`) runs
   inside `evalScope.eval()` — not the entire modifier chain
4. Resources spawned during that execution are retained until the
   invocation's eval scope is destroyed, when the invocation completes

### 4.5 Eval journal entries

#### What is journaled

After transformation and live-binding collision validation, `evalFactory` wraps
execution in `createDurableOperation`. Diagnostic journal shape:

```json
{ "type": "eval", "name": "eval:root:0", "language": "js" }

{ "status": "ok", "value": {
    "value": { "port": 4321, "config": { "debug": true } },
  }
}
```

`value.value` contains only the JSON-serializable subset of exports.
Non-serializable bindings (functions, class instances, live objects) are
omitted. They remain in `env.values` as live references during the current
run but are absent from the diagnostic trace.

### 4.6 File locations

| File | Contents |
|---|---|
| `src/eval-transform.ts` | `transformBlock()`, `serializeExports()`, `isJson()`, `TransformResult` |
| `src/component-api.ts` | `Component` Api + `ComponentApi` interface and the direct operations (`importComponent`, `applyModifiers`, `raise`, `env`, `evalScope`, `codeBlock`, `persistent`, `content`) — §5.5 |
| `src/eval-context.ts` | `compileBlock()` — delegates to `API.Env.compile` |
| `src/data-uri-compiler.ts` | `useDataUriCompiler()` — data: URI compiler middleware for Deno/Bun; owns `STANDARD_IMPORTS` |
| `src/temp-file-compiler.ts` | `useTempFileCompiler()` — temp-file compiler middleware for Node/Bun; owns `STANDARD_IMPORTS` |
| `src/content-context.ts` | `useContent()`, `hasContent()` — compatibility aliases for the canonical `content(slot?)` (§5.5) |
| `src/structural.ts` | `RESERVED_STRUCTURAL` — the structural constructs, reserved against registration and repository files (§5.3) |
| `src/scope-local.ts` | `updateOwn()`, `readOwn()` — own-scope context updates, the one use of `Scope.hasOwn` (§5.3) |
| `src/components/registration.ts` | `registerComponents()`, `ComponentRegistration`, `ComponentRegistrationError`, `mergeRegistry()` — scope-local registration (§5.3) |
| `src/components/select.ts` | `selectComponent()`, `DEFAULT_COMPONENT_DIRS` — the resolver execution and inspection share (§5.3) |
| `src/components/registry.ts` | `CORE_REGISTRY` — the components core supplies, as non-reserved defaults (§5.3) |
| `src/invocation.ts` | `withInvocation()`, `Invocation`, `InvocationTeardownError` — the component invocation boundary (§4.4) |
| `src/expansion.ts` | `Expansion`, `getExpansion()` — what an executable element knows about its own expansion (§5.6) |
| `src/projection.ts` | `ProjectionHandle`, `ProjectionRequest`, `ActiveProjection` — content projection (§6.3) |
| `src/eval-env.ts` | `evaluationEnv()`, `commitExports()` — per-evaluation binding snapshot and commit (§4.3) |
| `src/live-env.ts` | execution-owned live binding overlay, collision validation and atomic export commit (§4.3) |
| `src/errors.ts` | `ErrorMode`, `settle()`, `DocumentationError`, `ContentError` — the error-mode decision (§6.9) and the function-content failure boundary (§5.1.2) |
| `packages/test-support/bdd.ts` | Cross-runtime Effection BDD adapter — drives `@std/testing/bdd`, `node:test`, and `bun:test` |
| `src/eval-handler.ts` | `evalFactory` |
| `src/eval-interpolate.ts` | `interpolateEvalBindings()` — bare `{name}` substitution |
| `src/modifiers/persist.ts` | `persistFactory` |
| `src/modifiers/timeout.ts` | `timeoutFactory`, `parseDuration()` |
| `src/modifiers/daemon.ts` | `daemonFactory` — long-running subprocess terminal modifier |
| `src/modifiers/ephemeral.ts` | `ephemeralFactory` — replay-safe live eval wrapper |
| `src/modifiers/service.ts` | `serviceFactory` — scoped service attachment |
| `src/sample-api.ts` | `Sample` Api definition (§3.4) — LLM middleware surface |
| `packages/runtime/service.ts` | provider-neutral `API.Service`, XMD service handshake types and `startService()` attachment |
| `src/api.ts` | Document Output Api definition, exports `output` (§9.2) |
| `src/collect.ts` | `collect()` — stream consumption helper, returns `Result<string>` |
| `src/output/mod.ts` | Barrel export for output middleware |
| `src/output/normalize.ts` | `useNormalizedOutput()` — whitespace normalization middleware (§9.4) |
| `src/output/terminal.ts` | `useTerminalOutput()` — terminal ANSI formatting middleware (§9.5) |
| `packages/cli/src/cli.ts` | Runtime-neutral CLI (separate `cli` workspace package) with `--verbose`, `--journal`, and `--raw` flags; Output Api stream consumption (§9.6) |
| `packages/cli/src/service-host.ts` | shared XMD service handshake observer and supervised host-process adapter |
| `packages/cli/src/{deno,node,bun,compiled}-service.ts` | runtime-named service adapters for token, environment and stdio behavior |
| `packages/cli/src/{deno,node,bun,compiled}.ts` | Entrypoints — each installs matching `API.Env` and `API.Service` adapters, then calls `runXmd` |
| `packages/workflow/src/service-denial.ts` | `useWorkflowServiceDenial()`, the tested non-delegating provider for future workflow start and resume scopes (#366) |
| `packages/cli/src/file-stream.ts` | `FileStream` — JSONL-backed `DurableStream` implementation |

Dependencies: `@effectionx/scope-eval`, `@effectionx/timebox`,
`@effectionx/converge`, `@effectionx/process`, `@effectionx/node`,
`@effectionx/stream-helpers`, `acorn`, `magic-string`, `marked`,
`marked-terminal`.

### 4.7 Eval block output

Eval blocks can produce rendered output in two ways:

1. **`return` value** — if the generator returns a non-null value,
   `String(returnValue)` becomes the block's rendered output.
2. **`output()` function** — explicit side-effect call that sets
   the output text.

If both are used, `output()` wins. `null`/`undefined` returns produce
no output.

#### `return` as output

```typescript
return "This text appears in the rendered document";
return 42;  // coerced to "42"
```

#### `output()` function

`output()` is a plain synchronous function call (not `yield*`):

```typescript
output("This text appears in the rendered document");
```

#### Injection

`output()` is injected into `env.values` before `transformBlock` is
called, so the auto-detect mechanism sees it as an available binding
and includes it in the preamble. It is a regular function, not a
generator — no `yield*` needed.

The mutable `outputRef` captures the output text. `serializeExports`
silently omits non-JSON values (functions), so the `output` function
itself won't pollute the journal.

#### Journaling

The output text is journaled alongside exports as `__output` in the eval entry.
It is extracted before exports are merged into `env.values` in the current
run:

```json
{ "type": "eval", "name": "eval:root:0", "language": "js" }
{ "status": "ok", "value": {
    "value": {
      "port": 4321,
      "__output": "This text appears in the document"
    },
  }
}
```

#### Interaction with the modifier chain

When `outputRef.text` is non-empty, `evalFactory` returns
`{ output: outputRef.text, exitCode: 0, stderr: "" }` instead of
empty output. This means the expansion engine treats the block like an
`exec` block that produced output — an `ExecOutputSegment` is created
and rendered in the document.

#### Non-string values

`output()` calls `String(text)` on its argument, so non-string values
are coerced. `output(42)` produces `"42"`.

### 4.8 Render closures: `renderChildren()` and `render()`

Every component's binding environment (`env.values`) is pre-populated
with two closure functions that eval blocks can `yield*` to render
content within the current expansion context:

**`renderChildren(override?)`** — expands and renders the component's
children segments. Returns the rendered string. For self-closing components
(no children), returns an empty string.

```typescript
const childrenOutput = yield* renderChildren();
// childrenOutput contains the fully expanded + rendered children text
```

An optional `override` layers extra bindings over the caller env for that
render only: children expand against `{ ...caller.values, ...override }` in a
fresh scope, so the override shadows caller values but is discarded afterward
and never mutates or leaks into the caller env. An explicit `override` must be
a plain object — `null`, arrays, and primitives are rejected with a printed error
rather than silently spread. Omitting the argument behaves exactly like a bare
`renderChildren()`. This per-render binding layer is the same mechanism the
native `<Each>` directive (§6.5) uses to inject each item.

**`render(markdown)`** — scans, expands, and renders an arbitrary
markdown string within the current component's context. Useful for
dynamically constructing content:

```typescript
const rendered = yield* render("# Dynamic heading\n\n<Note message='hello' />");
```

#### Injection point

Both closures are injected in `expandComponent()` (in `src/expand.ts`)
after the component's `EvalEnv` is created but before `expandSegments`
processes the component body. They capture explicit projection frames:
`renderChildren()` and `useContent()` use the caller's metadata, validated
props, hide set, and ordinary binding environment; `render(markdown)` uses the
component-authored metadata, validated props, hide set, and environment.
Structural `<Content />` projection preserves the caller's props object while
retaining the existing ordinary-binding layering of the current authored
frame. No projection surface promises that every caller ordinary binding is
visible.

Both use `parentEvalScope`, not `childEvalScope`. Children are
caller-provided content and expand in the caller's scope context.
The component's `childEvalScope` and its sequential channel are for
the component's own `persist eval` blocks (middleware installation,
etc.), not for expanding caller content. Children may contain
operations that create resources (nested components, `persist eval`
blocks, daemons), but those resources are scoped to the expansion —
their lifecycle is bound by their place in the structured concurrency
tree. Inner components create their own child scopes off
`parentEvalScope`, and ancestor middleware is visible through
Effection's scope prototype chain.

Each installs its selected binding environment and eval scope as scope-local
Component providers (§5.5) around its `expandSegments` call, so the full
expansion context is available regardless of which task the closure runs in
(e.g., inside `evalScope.eval()`).

#### Non-serializable

Both functions are non-JSON values. `isJson()` returns `false` for
functions, so `serializeExports` silently omits them from the journal.
They exist only as live references during the current run.

#### `transformBlock` auto-detection

Because `renderChildren` and `render` are in `env.values` before
`transformBlock` is called, the transform sees them as available
bindings and injects `const { renderChildren, render } = env;` in
the preamble automatically (§4.1).

---

## 5. Component model

### 5.1 Components are markdown or TypeScript files

A component is either a **markdown file** (`.md`) with YAML frontmatter
or a **TypeScript file** (`.ts`) that exports a generator function.
The file name (without extension) is the component name. PascalCase
naming is a convention, not enforced.

#### 5.1.1 Markdown components

Markdown components have YAML frontmatter that declares
both the component's own metadata and its props interface.

```markdown
<!-- components/Greeting.md -->
---
emoji: 👋

props:
  type: object
  properties:
    name: { type: string }
    greeting: { type: string, default: Hello }
  required: [name]
  additionalProperties: false
---

{meta.emoji} {props.greeting}, {props.name}!

<Content />
```

#### Frontmatter structure

Frontmatter has three sections: **meta** (the component's own data),
**props** (the declared caller interface), and **returns** (the declared
return value).

**Meta** — every frontmatter key except `props`, `required`, and
`returns` is a meta value. Meta values are the component's own constants,
accessible via `{meta.key}` in the body. They can be any YAML value:
strings, numbers, booleans, arrays, objects.

**Props** — the reserved `props` key declares the props callers can
pass. Its value is either a map of prop names to draft-07 subschemas or
a complete draft-07 object schema. The reserved `required` key names the
props a caller must supply when `props` is a map.

**Returns** — the reserved `returns` key declares the value the component
produces instead of rendered text (§6.10). A component that omits it returns
its rendering.

#### Input definitions

`props` declares the props a component accepts. Most components name a
few props and leave the enclosing object implicit:

```yaml
required: [name]

props:
  name: { type: string }
  greeting: { type: string, default: Hello }
```

`props` is a map of prop names to draft-07 subschemas, and the
top-level `required` array names the props a caller must supply. The
declaration means exactly this schema:

```yaml
props:
  type: object
  properties:
    name: { type: string }
    greeting: { type: string, default: Hello }
  required: [name]
  additionalProperties: false
```

Writing that schema directly is the second form, and it is what a
component needs when the root object is not a plain closed map — `$ref`,
`allOf`, `patternProperties`, or a root that accepts additional
properties. A `type` or `$schema` key selects it, even when the value is
malformed, so a broken schema is reported as one rather than read as a
map of props. Two consequences follow: the map form cannot declare props
named `type` or `$schema`, which the full form declares under
`properties` like any other name; and the map form never carries
`$schema`, because it is draft-07 by construction.

The forms are alternatives. A top-level `required` beside a full schema
is a configuration error and the two lists are never merged, as is a
top-level `required` with no `props`. A name in `required` that the map
does not declare is an error too: the map is closed, so the name could
never be supplied.

Property definitions are ordinary draft-07 subschemas in both forms.
`properties` names the accepted props, and each property value is a
subschema. Requiredness is expressed by a `required` array — never a
per-field flag. An object that rejects unknown keys sets
`additionalProperties: false`; the map form is always closed.

```yaml
props:
  type: object
  properties:
    files: { type: array, items: { type: string } }
    rows:
      type: array
      items:
        type: object
        properties:
          symbol: { type: string }
          line: { type: number, default: 0 }
        required: [symbol]
        additionalProperties: false
  required: [files, rows]
  additionalProperties: false
```

The schema follows draft-07 verbatim, with these conventions:

- **Requiredness is a parent `required` array.** It lists the names of
  the props a caller must supply. There is no per-field `required: true`
  or `required: false`, and no inferred requiredness.
- **Unconstrained props** accept any value and declare the empty schema
  `{}` (or `true`).
- **Closed objects** reject unknown keys with
  `additionalProperties: false`. The root object is normally closed, so
  undeclared props are rejected (§6.5).
- **No declared props.** A component that declares no `props` uses the
  closed empty-object schema
  `{ type: object, properties: {}, additionalProperties: false }` and so
  accepts no props.
- **Defaults.** A subschema's `default` fills the prop when the caller
  omits it (§6.5). Object-property defaults fill missing properties
  recursively.
- **Enums and the rest of draft-07.** `enum`, `items`, nested
  `properties`, and every other draft-07 keyword apply. `format` is an
  annotation only, never an assertion.

The root document receives its declared props from programmatic `props` or
from the sources generated by `xmd run`. Source names, precedence, help, and
failure behavior are defined in
[Root Document Props](./root-document-props-spec.md).

**Project contract.** The root schema MUST declare `type: "object"`. The
reserved prop names `slot` and `as` (§6.3.5) cannot be declared as
properties. Schemas are self-contained: only local `$ref`s are allowed
(no remote references), and asynchronous schemas (`$async: true`) are
rejected. These rules are enforced when the component definition loads.

Both forms compile to one canonical draft-07 schema, so the map form is
a spelling of the enclosing object and nothing else. There is no
per-field `required`, no inferred requiredness, and no `type: any`, and
property definitions are never a mini-language. The map form is a
Markdown frontmatter spelling: a function component's `props` export is
always the full schema (§5.1.2).

#### Meta with type constraints (optional)

Meta values are normally plain YAML values. For components that want a
resolved default for their own metadata (e.g., when meta values are
overridden by a parent component's frontmatter), a meta entry may be
written as a **typed definition** — an object with a `type` key —
placed under a `meta` key. Its `default` is used as the resolved value:

```yaml
---
meta:
  model:
    type: string
    enum: [gpt-4, claude-3]
    default: gpt-4
  temperature:
    type: number
    default: 0.7

props:
  type: object
  properties:
    prompt: { type: string }
  required: [prompt]
  additionalProperties: false
---
```

When `meta` is a mapping and an entry is a typed definition (an object
with a `type` key), its `default` becomes the resolved value; any other
entry is used verbatim. When `meta` is absent, all top-level keys except
`props` and `required` are meta values (the simple case).

This convention is independent of `props`, which is always a canonical
draft-07 JSON Schema — it lets a component's own metadata range from
minimal (plain key-value pairs) to typed defaults.

#### 5.1.2 Function components

Function components are TypeScript files (`.ts`) that export an
Effection generator function as their default export. They receive
validated props directly and return rendered output as a string.

```typescript
// components/Greeting.ts
import type { Json } from "@executablemd/core";

export const props = {
  type: "object",
  properties: {
    name: { type: "string" },
    greeting: { type: "string", default: "Hello" },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

export default function*(props: Record<string, Json>) {
  return `${props.greeting}, ${props.name}!`;
}
```

**Contract:**

```typescript
/**
 * One run of a component: durable-capable, and free to acquire runtime
 * resources that belong to the component invocation.
 */
export type ComponentExecution<T> = Operation<T>;

export interface FunctionComponent {
  (props: Record<string, Json>): ComponentExecution<Json>;
}

export interface FunctionComponentDefinition {
  kind: "function";
  name: string;
  path: string;
  props: PropsSchema;      // canonical draft-07 JSON Schema (§5.1.1)
  returns?: ReturnsSchema; // declared return schema (§6.10); absent in text mode
  fn: FunctionComponent;
}
```

**Resources.** A component acquires resources with ordinary operations —
`yield* useTempDir()` — and needs no wrapper of its own. They belong to the
invocation and are released when it completes, after the content it projected
has stopped (§4.4), so a component can hold something open for its children:

```typescript
export default function*() {
  const directory = yield* useTempDir();
  return yield* content();
}
```

Durable effects a component yields are journaled and replayed as usual, because
the engine runs it inside the document's durable routine. The two compose: a
component may perform a durable effect and hold an ordinary resource in the same
body, and on replay the effect is restored from the journal while the resource
is re-established.

**Props declaration.** Function components declare their props via
a named `export const props = { ... }` holding a canonical draft-07
JSON Schema (§5.1.1), enforced by the same project contract as Markdown
components at load time. This is equivalent to the full `props:` schema
in markdown component frontmatter; the prop-name map is a frontmatter
spelling and does not apply to a TypeScript export. If no `props`
export exists, the component accepts no props.

The exported schema is the runtime contract. The engine resolves expression
props, validates them against it, strips the reserved names, and passes only
validated `Record<string, Json>` props to the generator (§6.5) — a component
never sees the raw element or an unvalidated value. A JSON Schema a document
hands over as a prop value, `schema={responseSchema}`, is ordinary JSON data on
those props and is validated as such.

**Return declaration.** A named `export const returns = { ... }` declares a
return value under the same contract as the `returns:` frontmatter key,
including the object-return shorthand (§6.10). The generator of a value
function component returns that JSON value rather than a string; without the
export, its returned string is its rendering, and returning anything else is
an error.

**Content via `content()`.** Function components reach their invocation
content contextually, not from props: there is no React-style `children` prop.
The expansion engine installs a scope-local content provider (§5.5) around each
function component invocation, and `content()` is the canonical operation a
component calls for it:

```typescript
// components/Card.ts
import { content, type Json } from "@executablemd/core";

export default function*(props: Record<string, Json>) {
  const rendered = yield* content();
  return `<div class="card">\n${rendered}\n</div>`;
}
```

Named slots are supported — `content("header")` returns the content assigned to
that slot, matching `<Content slot="header" />` in markdown components:

```typescript
const header = yield* content("header");
const body = yield* content();  // default slot
```

`useContent(slot?)` is a supported compatibility alias for the same operation
(§5.5); components written against it keep working unchanged.

Only the requested slot is expanded. Content nobody asks for is never expanded,
and a component that never calls `content()` does not expand its invocation
content at all — `hasContent()` answers the shape of the invocation without
projecting (§5.5). Calling `content()` outside a function component invocation
reports a clear missing-provider error. The provider is removed when the
invocation completes, so content never leaks into sibling expansions.

**`content()` is the failure boundary.** Each call is where invocation content
either becomes a string or fails. When the requested content carries no
`ErrorSegment`, the call returns the rendered string and the generator resumes
normally: text returns, declared returns, expression props and `as` behave as
they do everywhere else.

When expanding the requested content produces one or more `ErrorSegment`s, the
call does not return and normal continuation stops at the `yield* content()`
expression:

- code after the call does not run through normal continuation;
- the function's return value is not processed and a declared return is not
  validated;
- no `as` binding is created;
- left uncaught, the whole invocation is replaced by the original error
  segments — the same objects, with their metadata and source order intact —
  and partial content plus any wrapper the function would have produced are
  discarded;
- later document siblings continue under `print` and stop under `output` or
  `throw`, as they do for any other first error.

One rule covers captured and uncaptured invocations, default content and named
slots, and both text and declared-return components. For

```markdown
<Probe>before<Broken />after</Probe>TAIL
```

the result is the original error from `<Broken />` followed by `TAIL` — not
`before`, `after`, or a wrapper `Probe` returns. Printing inside the projected
content is unchanged: a printing projection still discovers every error it can
before returning, and the short circuit happens where control would otherwise
resume the function.

Code before the call has already run and cannot be undone. A component that
validates its content before opening a port, starting a server, or acquiring
anything comparable places `content()` ahead of those effects.

**Recovery: `ContentError`.** The failure arrives at the `yield* content()`
expression as `ContentError`, exported from `@executablemd/core`:

```typescript
export class ContentError extends Error {
  readonly errors: readonly ErrorSegment[];
}
```

`errors` holds the original `ErrorSegment` objects in source order — not copies,
and not a rendered string. A component recognizes intended content recovery with
`error instanceof ContentError`; it does not branch on the ambient error mode,
because the same public error is presented under `print` and under `throw`, so
one piece of recovery code covers both:

```typescript
import { content, ContentError } from "@executablemd/core";

export default function* Preview() {
  try {
    return yield* content();
  } catch (error) {
    if (error instanceof ContentError) {
      return "Content is unavailable";
    }
    throw error;
  }
}
```

`content()` fails as an ordinary Effection operation, so a `try/catch` around it
is ordinary recovery:

- a catch directly around the call is explicit recovery. The component may
  inspect `error.errors`, return fallback content, or deliberately do different
  work — effects included. "Post-content code does not execute" means it does
  not execute through *normal continuation*; structured concurrency guarantees
  ownership and teardown, it does not forbid error recovery.
- recovery keeps the enclosing invocation alive. Work owned by the failed
  projection unwinds with its scope, while resources deliberately retained to
  invocation lifetime stay owned by the invocation until it exits (§4.4).
- a caught failure is finished with. The engine does not reassert it, and it
  never reaches the component's consumer boundary.
- a component that recovers and then fails on its own terms reports *its*
  failure, and the failure it reports keeps the content failure in its cause
  chain, so the original error segments stay reachable from the outside.
  Recovery decides which failure the document reports: discovery of a
  documentation failure stops at a content failure it reaches there rather than
  continuing into the decision the component replaced, so what the document
  reports is the component's own printed error and not the child's. Discovery of a
  durability failure does not stop there (§6.11).
- the engine never uses `halt()` or cancellation to make a documentation failure
  uncatchable. Cancellation remains a lifecycle mechanism, not a way to deliver
  a domain error.
- durability failures (§6.11) and unrelated engine failures are never presented
  as `ContentError`; they keep their own identity and precedence.

Left uncaught, the boundary hands the failure to the invocation's consumer:
under `print` it transports the original error segments, already decided where
they were raised, and under `output` or `throw` it restores the original
`DocumentationError` — rethrown for a `throw` decision, and offered to the
nearest printing boundary for an `output` one (§6.9). The recovery type and the
propagated type are deliberately two views of one boundary — a component catches
`ContentError` at `content()`, and a caller the component did not recover for
still observes `DocumentationError`.

**A reported failure carries what it was translated from.** A function component
that throws anything else — an ordinary error, a failure of its own after
recovering from content — is reported as a printed error naming the component, and
that printed error is what the document says. Under `output` or `throw` the
`DocumentationError` built for it keeps the thrown value itself as its `cause`,
whatever kind of value it was, so a host inspecting what ended the execution
reaches the component's own failure and everything beneath it. The link is in
place before the failure is observable: `Component.raise` middleware that catches
what the chain throws already sees it, and the segment is still observed exactly
once.

Under a printing error mode nothing is thrown, so there is no error to carry a
cause: what the document keeps is the `ErrorSegment` itself, whose own `cause`
field is structured diagnostic detail (§2.1) and unrelated to this link.

**Resolution priority.** When both `Name.md` and `Name.ts` exist,
the `.md` file wins. This ensures backward compatibility — existing
markdown components are not shadowed by TypeScript files.

**Journaling.** Function components are imported via
`durableImportComponent`, which journals the resolved path and current file
content. The function component is imported from the current file on every
run because the function itself is not serializable.

### 5.2 Resolution (Resolve Api)

Resolution maps a component name to a file system path. It is an
**Effection Api** — the core behavior is overridable via middleware
installed on the scope.

```typescript
interface ResolveResult {
  path: string;         // Workspace-relative path (e.g. "components/Greeting.md")
}

interface ResolveApi {
  resolve(name: string): Operation<ResolveResult>;
}

const Resolve = createApi<ResolveApi>("Resolve", {
  *resolve(name: string): Operation<ResolveResult> {
    throw new Error(`Cannot resolve component: ${name}`);
  },
});
```

#### Default resolver middleware

The default middleware checks a search path in order:

1. `./components/{Name}.md`
2. `./components/{Name}.ts`
3. `./components/{Name}/index.md`
4. `./components/{Name}/index.ts`
5. `./{Name}.md`

`.md` is checked before `.ts` at each level to ensure backward
compatibility — existing markdown components are not shadowed by
TypeScript files added later.

For dotted names like `Ns.Sub`, the dot maps to a directory separator:
`./components/Ns/Sub.md` (then `./components/Ns/Sub.ts`, etc.).

```typescript
function* useDirectoryResolver(
  searchPaths: string[],
): Operation<void> {
  const scope = yield* useScope();
  const stat = API.Fs.operations.stat;

  scope.around(Resolve, {
    *resolve([name], next): Operation<ResolveResult> {
      const fileName = name.replace(/\./g, "/") + ".md";
      for (const dir of searchPaths) {
        const candidate = join(dir, fileName);
        const statResult = yield* stat(candidate);
        if (statResult.exists && statResult.isFile) {
          return { path: candidate };
        }

        const indexCandidate = join(dir, name.replace(/\./g, "/"), "index.md");
        const indexStat = yield* stat(indexCandidate);
        if (indexStat.exists && indexStat.isFile) {
          return { path: indexCandidate };
        }
      }
      return yield* next(name);
    },
  });
}
```

### 5.3 Import: `durableImportComponent`

Import is a single journaled operation that resolves a component name and
reads the file during a CLI invocation.

Parsing the current content into frontmatter and segments is a **runtime
operation** that runs after the journaled operation returns. It is
deterministic from the content, so it needs no separate journal entry.

#### Registration and resolution order

A component name is resolved in tiers, and the first tier that answers wins:

1. **structural syntax** — `<Content>`, `<Output>`, `<Return>`, `<Capture>`,
   `<Each>`, `<If>`/`<Else>`, `<Loop>`/`<Break>`, `<PrintErrors>`,
   `<Answers>`/`<Answer>`. These are the language's own
   constructs. They are reserved: a registration cannot claim one, and a
   repository file named after one never stands in for it. A structural name
   written where its construct gives it no meaning is a printed error, not a
   missing component.
2. **a reserved registration** — a host protecting a language or security
   invariant.
3. **a repository-local file**, by the candidate order below.
4. **a registered default**, including the components core supplies.
5. **nothing**, which is the unresolved printed error.

So a repository component overrides any ordinary package default, core's
included, and a reserved registration overrides the repository. Only genuine
absence falls through to a default: a candidate that exists but cannot be read,
imported, parsed, or compiled fails where it is loaded, so a broken local
component is never quietly replaced.

Two registrations for one name and kind at the same scope are a configuration
error naming both origins. Installation order is not a resolution mechanism —
reserved and default registrations are held apart, so which one wins is decided
by the tiers above however they were installed.

**Registration is scope-local.** `registerComponents()` makes names resolvable
for the installing scope and its descendants. A child scope may register a name
its parent already registered — that shadows, and the parent is unchanged.
Siblings and concurrent executions never see one another's registrations, and
leaving the installing scope removes them. Registering describes a component; it
runs nothing and acquires nothing. Names and schemas are validated where they
are installed, so a malformed registration is an error in the host rather than a
printed error that appears the first time a document writes the name.

**What a registration declares.** Beyond its name, origin, function and props
schema, a registration may declare two things the schema cannot describe.

`captures` names props the engine does not resolve. They are stripped before
expression resolution and excluded from validation, and the component evaluates
each itself, so what it receives is the value the author wrote rather than a
JSON projection of it. A capture may not also be a schema property — a schema
cannot describe a value it never sees — nor may it be `as` or `slot`, which the
engine owns.

**A return binds by reference.** `as` binds the value the component returned —
the object itself, not a rendering of it — so a component can hand its caller
something a schema could not describe. Such a binding is not durable: nothing is
journaled for it, and a re-expansion recomputes it by running the component
again.

`returns` is the opt-in that says a particular return is instead a **validated
JSON record**: the value is checked against the schema before it is bound, and a
component declaring it must be invoked with `as`, since it renders nothing.

Without `as` there is nowhere to bind, so only text can be observed: a component
returning a string renders it, and a component returning anything else renders
nothing. A non-string is not an error — it is a value with no destination.

#### The components core supplies

Some components are core's own: `<TempDir>` (§6.11), `<Parse>` and
`<SafeParse>` (§6.12), `<File>` (§6.13), and `<Glob>` (§6.14). Each is already
in the module graph, so it ships in the compiled binary and every published
package without a search path or a bundling step, and a document invokes it with
no `--component-dir`.

They are ordinary **defaults**, not reserved names: a repository component
called `Parse.md` is chosen ahead of core's `<Parse>`, exactly as it would be
ahead of any other package's registration. Nothing core supplies claims a name a
document cannot take back.

The definitions are module-resident and reused — one object per component for
the life of the process. That is not what varies between runs. What each
`<TempDir>` invocation creates fresh is the directory (§6.11); the component
describing it is the same one every time.

A definition carries no path. A registration names no file, and a repository
definition's source is already described by the selection that chose it, so
source identity lives on the selection rather than being copied onto every
definition.

#### Origin

Every selected implementation has a structured origin, and one resolver answers
for both execution and inspection so they cannot disagree about which tier won:

```typescript
type ComponentOrigin =
  | { kind: "structural"; construct: string }
  | { kind: "repository"; path: string }
  | { kind: "registered"; origin: string; reserved: boolean };
```

`inspectComponent(name)` reports the selected kind and origin without running
anything. A registration and a Markdown file describe themselves fully — both
are already parsed or already in the module graph. A repository `.ts` component
reports only where it is: its schemas live on the module's exports, and loading
the module would run its top-level code. Collision and unresolved printed errors
name the origins and the searched locations they considered.


Which implementation a name resolves to is an observation of the environment —
which files exist, and what is registered — so it is made **inside** the durable
operation, with the read it leads to. What the journal holds is serializable: a
repository selection records the chosen path and its content, and a registration
records its origin, never its function.

The root's selection carries one more member. A targeted root resolves its
selector here too, against the text this operation is about to record, and
records the **exact** target it resolved to — so the section the run executed is
part of the record rather than something a later read rediscovers (§5.4). An
untargeted root records no `target` member, which is what keeps journals written
before targets existed readable.

```typescript
type DurableSelection =
  | { kind: "repository"; path: string; content: string; target?: string }
  | { kind: "registered"; origin: string; reserved: boolean };

function* durableImportComponent(
  name: string,
): Workflow<ComponentDefinition | FunctionComponentDefinition> {
  // Single durable effect: select + read
  const selection = (yield createDurableOperation<DurableSelection>(
    { type: "import_component", name },
    function* () {
      const selected = yield* selectComponent(name, { componentDirs, registry });

      if (selected.kind === "repository") {
        const readTextFile = API.Fs.operations.readTextFile;
        return { kind: "repository", path: selected.path,
                 content: yield* readTextFile(selected.path) };
      }
      if (selected.kind === "registered") {
        return { kind: "registered", origin: selected.origin.origin,
                 reserved: selected.origin.reserved };
      }
      throw new Error(`Cannot resolve component: ${name} (searched: …)`);
    },
  )) as DurableSelection;

  // A registration is restored by origin: the implementation comes from the
  // registry this run has, and a recorded origin that is no longer registered
  // fails rather than quietly invoking a different component.
  if (selection.kind === "registered") {
    const found = lookUp(name, selection);
    if (!found) {
      throw new Error(`Component ${name} was recorded as "${selection.origin}", …`);
    }
    return found.definition;
  }

  // Function component: .ts file — import() the module
  if (selection.path.endsWith(".ts")) {
    const absolutePath = `${process.cwd()}/${selection.path}`;
    const mod = yield* call(() => import(`file://${absolutePath}`));
    return {
      kind: "function" as const,
      name,
      props: mod.props === undefined
        ? { type: "object", properties: {}, additionalProperties: false }
        : parseJsonObject(mod.props),
      fn: mod.default,
    };
  }

  // Markdown component: parse at runtime — deterministic from content
  const { data: frontmatter, content: body } = grayMatter(selection.content);
  const { meta, props } = parseFrontmatter(frontmatter);
  const bodySegments = scanSegments(body);

  return {
    name,
    path: selection.path,
    meta,
    props,
    bodySegments,
  };
}
```

**Journal shape:**

```json
{ "type": "import_component", "name": "Greeting" }
{ "status": "ok", "value": {
    "kind": "repository",
    "path": "components/Greeting.md",
    "content": "---\nemoji: 👋\n..." } }

{ "type": "import_component", "name": "TempDir" }
{ "status": "ok", "value": {
    "kind": "registered",
    "origin": "@executablemd/core",
    "reserved": false } }
```

One journal entry per component, whatever it resolved to. A repository entry
captures both *which file was found* (path) and *what was in it* (content); a
registration entry captures the origin that named it, because a function cannot
be serialized and the implementation is looked up again on replay.

```typescript
// A component's declared props interface is a canonical draft-07 JSON
// Schema object (§5.1.1). Held as a plain JSON object so it doubles as a
// stable key for the compiled-validator cache.
type PropsSchema = JsonObject;

interface ComponentDefinition {
  name: string;
  path: string;
  meta: Record<string, unknown>;   // Resolved meta values
  props: PropsSchema;              // Declared props interface (draft-07 schema)
  bodySegments: Segment[];         // Parsed body (after frontmatter)
}
```

#### Frontmatter parsing

The frontmatter root is narrowed from `unknown` through the shared JSON
parser (§5.1.1), so a non-JSON value anywhere rejects the frontmatter
before Ajv sees it. `props` is then normalized to the component's
canonical schema: a declaration carrying `type` or `$schema` is the
schema itself and passes through unchanged, and any other declaration is
a prop-name map that becomes `{ type: "object", properties,
additionalProperties: false }` with the top-level `required` array
attached. Normalization is the only rewrite, and it builds a fresh
object per component so the compiled-validator cache never shares state
across definitions. The project contract (root `type: "object"`,
reserved `slot`/`as`, local refs only, no `$async`) is enforced later,
when the schema is compiled to a validator (§6.5). Meta is everything
except `props` and `required`; a `meta` entry written as a typed
definition (an object with a `type` key) resolves to its `default`.

```typescript
function parseFrontmatter(raw: unknown): {
  meta: Record<string, unknown>;
  props: PropsSchema;
} {
  const root: JsonObject = raw === null || raw === undefined ? {} : parseJsonObject(raw);

  // `props` is the component's JSON Schema, in either spelling. Absent →
  // the closed empty-object schema. A fresh object per component keeps the
  // compiled-validator cache from sharing state across definitions.
  const props: PropsSchema = normalizeProps(root.props, root.required);

  const meta: Record<string, unknown> = {};
  const rawMeta = root.meta;
  if (isPlainObject(rawMeta)) {
    for (const [key, value] of Object.entries(rawMeta)) {
      meta[key] = isTypedDefinition(value) ? value.default : value;
    }
  } else {
    for (const [key, value] of Object.entries(root)) {
      if (key !== "props" && key !== "required") {
        meta[key] = value;
      }
    }
  }

  return { meta, props };
}

function normalizeProps(declared: Json | undefined, required: Json | undefined): PropsSchema {
  if (declared === undefined) {
    if (required !== undefined) {
      throw new Error('frontmatter declares "required" without "props"');
    }
    return { type: "object", properties: {}, additionalProperties: false };
  }

  const declaration = parseJsonObject(declared);

  if ("type" in declaration || "$schema" in declaration) {
    if (required !== undefined) {
      throw new Error('frontmatter declares "required" alongside a full "props" schema');
    }
    return checkDialect(declaration);
  }

  const properties: JsonObject = {};
  for (const [name, definition] of Object.entries(declaration)) {
    // Draft-07 schemas include the booleans `true` and `false`.
    if (typeof definition !== "boolean" && !isPlainObject(definition)) {
      throw new Error(`input "${name}" must declare a JSON Schema object or boolean`);
    }
    properties[name] = definition;
  }

  if (required === undefined) {
    return { type: "object", properties, additionalProperties: false };
  }
  return {
    type: "object",
    properties,
    required: checkRequiredNames(required, properties),
    additionalProperties: false,
  };
}

function checkDialect(schema: JsonObject): PropsSchema {
  const dialect = schema.$schema;
  if (dialect !== undefined && dialect !== "http://json-schema.org/draft-07/schema#") {
    throw new Error(`props "$schema" must be draft-07, got ${JSON.stringify(dialect)}`);
  }
  return schema;
}

/** Every name must identify a declared property: the map is closed, so a
 *  name it does not declare could never be supplied. */
function checkRequiredNames(required: Json, properties: JsonObject): string[] {
  if (!Array.isArray(required)) {
    throw new Error('frontmatter "required" must be an array of input names');
  }
  for (const name of required) {
    if (typeof name !== "string") {
      throw new Error('frontmatter "required" must list input names as strings');
    }
    if (!(name in properties)) {
      throw new Error(`frontmatter "required" names "${name}", which no input declares`);
    }
  }
  return required;
}

/** A typed `meta` definition — an object with a `type` key. Used only to
 *  resolve typed-meta defaults; unrelated to the `props` schema. */
function isTypedDefinition(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && !Array.isArray(value) && "type" in (value as Record<string, unknown>);
}
```

### 5.4 The root document is a component

The entry point treats the root document through the same import
pipeline as any component. This gives it uniform resolution, parsing, and
error handling.

The root obeys the same `<Output>` rules as any component (§6.9), and how its
output is emitted depends on whether it declares one. Without `<Output>`, the
root's top-level segments are expanded in document order and each segment's
rendered text is emitted incrementally through the Document Output Api (§9) as
it is produced. With `<Output>`, the whole body is expanded before anything is
emitted; only the selected content is emitted, and only after the body has
completed successfully — a failure while executing documentation produces no
emission, and an empty selection emits nothing. A component invoked within the
root expands recursively and its result is buffered into the surrounding
output in both cases.

#### Text roots and value roots

A root has the same two return modes as any component (§6.10), with one
difference: it has no caller, so it needs no `as`.

A **text root** declares no `returns` and behaves exactly as described above:
its rendered Markdown is its return value, and `execute()` completes with that
text.

A **value root** declares `returns`. It executes its complete body, holds
exactly one direct top-level `<Return>`, validates that value against its
schema, and completes with the validated JSON. Its rendered body Markdown is
not its result: the output stream stays an observability channel a consumer may
watch independently, and a printed error can never pass for a result. A value
root's body therefore runs fail-fast — a structural violation, an invalid
schema, an invalid value, a body error, and a failure raised after `<Return>`
all complete `Err`, and body text emitted before the failure remains only on
the output stream.

#### Document targets

A root document addresses its own sections. A **document target** is an
addressable static heading in the document's root Markdown flow, named by the
canonical path of heading labels that reaches it. Selecting one executes:

1. the document preamble;
2. the direct content of every ancestor needed to reach the target; and
3. the selected heading's complete subtree.

Sibling subtrees do not execute. Retained headings stay in the projected body,
so the projection reads as a document rather than as an excerpt.

##### Which headings are targets

Only root-level Markdown heading nodes form the outline. A heading inside a
block quote, a list, a fenced block, raw HTML, or component children is not one.

Heading discovery does not parse raw XMD with a Markdown parser. A component's
children are ordinary text to that parser, and a blank line among them ends the
HTML block it inferred, which surfaces a child heading as a root heading.
Discovery instead parses a copy of the body in which the boundary scanner's
top-level component spans are replaced by spaces of the same length. Newline
positions, offsets, and everything outside those spans are unchanged, so a
heading found in the masked copy sits where it sits in the original, and the
original supplies its text and its source.

A heading's parent is the nearest preceding heading with a smaller depth.
Skipped depths are ordinary. **Outermost** means the smallest heading depth
present in the root flow, which need not be `h1`.

When the document has exactly one outermost heading, that heading is the
document **title**: it takes no level in any target path, it is no target
itself, and its heading and direct content are retained in every projection
beneath it. When the document has more than one outermost heading, each of them
takes a path level. A document with no addressable heading has an empty
catalog.

A heading is **not addressable** when its own source overlaps executable
component syntax, or contains an unescaped Executable MDX interpolation —
`{meta.key}`, `{props.key}`, `{binding}`, and the dotted forms of each. Escaped
interpolation (`\{meta.key\}`) is literal static text and stays addressable. A
heading that renders no text is not addressable. An unaddressable heading
required as a path level makes its whole subtree unaddressable; because the sole
title is not a path level, static sections beneath a computed title remain
addressable.

##### Labels and canonical encoding

A label is the statically rendered Markdown text of the heading: formatting and
link destinations are removed, while visible text, inline-code text, and image
alternative text are retained. The result is normalized to NFC, every run of
Unicode whitespace collapses to one ASCII space, leading and trailing
whitespace is trimmed, and case is preserved. There are no generated slugs,
suffixes, case folding, or punctuation removal.

A canonical target is the sequence of labels from the target's outermost
addressable ancestor to the target, each percent-encoded and joined with raw
`/`. Encoding leaves the RFC 3986 unreserved characters (`A-Z a-z 0-9 - . _ ~`)
alone and escapes everything else as uppercase UTF-8 hexadecimal, so a `/`,
`*`, `#`, or `%` inside a heading becomes `%2F`, `%2A`, `%23`, or `%25` and
cannot be read as syntax.

A fragment is an **exact** canonical target only when every level survives the
whole round trip: decoding it, normalizing the label, and re-encoding that label
reproduce the level byte for byte. That one rule rejects a wildcard operator, an
empty level, a lowercase escape, a raw `#`, an NFD spelling, a tab, and leading,
trailing, or uncollapsed whitespace, because none of them is what the encoder
writes. Two spellings of one section are therefore never two identities.

The catalog is in source order and retains duplicates: two sections whose
canonical paths are equal stay two entries, so the ambiguity is observable.

##### Selectors

A document reference is:

```text
<encoded-document-path>#<target-selector-or-exact-target>
```

The first raw `#` separates the two. Raw `/` separates target levels and raw
`*` and `**` are operators; the selector is split on those before its literal
chunks are percent-decoded, which is what keeps `%2F` a slash inside one label
and `%2A` a literal asterisk. Decoding is URI path decoding: `+` is a plus, not
a space. Malformed escapes, byte sequences that are not UTF-8, NUL, a leading
or trailing slash, an empty level, and a raw `#` — the reference's own
delimiter, written `%23` when a heading really contains one — are all refused.
Matching is case-sensitive.

- A literal level matches one canonical label exactly, after decoding and label
  normalization.
- `*` within a level matches zero or more characters of that one label, and may
  appear more than once.
- A level that is exactly `**` matches zero or more complete path levels.

There is no `?`, character class, brace, or backslash dialect. Within a
wildcard level only the literal chunks are decoded and normalized; whitespace
beside a wildcard is part of what the selector asked for, and only the beginning
of the first chunk and the end of the last are trimmed. Matching compares
Unicode code points and completes in time bounded by the product of the pattern
and label sizes.

A selector must resolve to exactly one catalog entry. Zero matches and several
matches both fail. Diagnostics report canonical encoded references, so a
duplicate canonical path is reported as an ambiguity rather than resolved.

##### Projection

Source ranges are defined against the original, unprojected body:

- the **preamble** runs from the body start to immediately before the first
  outermost heading;
- an **ancestor's direct content** runs from its heading start to its first
  child heading's start, or to its subtree end when it has no child heading;
  and
- the **selected subtree** runs from the selected heading's start to the next
  heading of equal or smaller depth, or to the body end.

The projected body is the preamble, each retained ancestor's direct content in
order, and the selected subtree. For a sole outermost title, the title is the
first retained ancestor even though it takes no level in the path.

Each retained range is scanned separately, under the origin that range has in
the original file — its path, its offset, and its line. The ranges are not
concatenated and rescanned: skipped source must not renumber what follows it,
because a retained element's source position is what its expansion identifier
is derived from. A retained element therefore carries the same expansion ID in
a targeted run as in a full one, and two targets that retain it agree with each
other. The target string takes no part in expansion identity; a run's own
identity is what distinguishes the effects of two target runs.

Frontmatter, root props, `returns`, the return mode, and `<Output>` behavior are
unchanged and apply to the projected body. Structural validation applies to the
projected body too: an invalid skipped sibling is irrelevant, while an invalid
retained range fails before any authored effect in the projection runs.

##### Failure timing and durable identity

Selection happens before the body expands. An invalid, unmatched, or ambiguous
selector runs no authored document effect.

The live root import records the **exact canonical target**, never the caller's
selector. An untargeted import records no target member at all, so journals
written before targets existed stay readable by untargeted runs.

A replay guard validates the selection before the recorded run is reused. It
resolves the current selector against the *recorded* content and requires the
same selection outcome; the recorded content is then what the projection is
taken from. A different selector naming the same section replays, and so does
the same failing selector. A different exact target, a targeted request against
an untargeted record, an untargeted request against a targeted record, and any
difference in a failed selection are all stale input (§6.11). Stale input is
reported as itself: the guard retains no failure object from the selection it
could not match. The check runs before a completed run's recorded terminal
result can be reused, so a finished journal cannot answer for a selection it
never made.

##### Naming a root document

`@executablemd/core` exposes the shared shapes:

```ts
interface FileRootDocument {
  readonly path: string;
  readonly source?: undefined;
  readonly target?: string;
}

interface InlineRootDocument {
  readonly path: "<eval>";
  readonly source: string;
  readonly target?: string;
}

type RootDocumentSource = FileRootDocument | InlineRootDocument;

function fileSource(reference: string): FileRootDocument;
function inlineSource(source: string, options?: { readonly target?: string }): InlineRootDocument;
function formatDocumentReference(path: string, target?: string): string;
```

`fileSource()` splits a document reference at the first raw `#`, percent-decodes
the path portion, and stores the fragment — still encoded — as `target`. It does
not decode the fragment as one string, because `%2F` must stay distinguishable
from a level separator. An empty path, a malformed escape, a byte sequence that
is not UTF-8, and NUL each fail with a cause-free `TypeError` whose message is
exactly `Invalid document reference`; the input is a command-line argument, and
echoing it back would put arbitrary bytes into a diagnostic. A filename
containing `#` is written `%23`, and one containing a literal `%HH` sequence is
written `%25HH`.

`formatDocumentReference()` takes a decoded path and, optionally, an
already-canonical exact target. It encodes the path, validates the target rather
than encoding it again, and joins them with `#`. It is the one formatter
diagnostics, command output, and workflow handoff use. Making an authored glob
canonical is the selector parser's work, not this function's.

It only formats what `fileSource()` reads back: the encoded path is decoded
again and must reproduce the path exactly. NUL, which the decoder refuses, and
an unpaired surrogate, which encodes lossily to the replacement character, are
therefore rejected rather than turned into a reference naming a different file.

Existing programmatic `{ path }` values and `inlineSource(source)` remain valid
and untargeted.

An unresolvable target raises `DocumentTargetError`. It is an ordinary
invocation failure, not a durability or `API.Files` failure, and it is the same
error on every public path: `inspectDocument()`, a live `execute()`, and a
replayed `execute()` all raise one carrying the same fields.

```ts
interface DocumentTargetFailure {
  readonly type: "executablemd.document-target-failure";
  readonly kind: "invalid-selector" | "no-match" | "multiple-matches";
  readonly selector: string;
  readonly matches: readonly string[];
  readonly available: readonly string[];
}

class DocumentTargetError extends Error {
  readonly data: DocumentTargetFailure;
}

function isDocumentTargetError(error: unknown): error is DocumentTargetError;
function asDocumentTargetError(error: unknown): DocumentTargetError | undefined;
function parseDocumentTargetFailure(value: unknown): DocumentTargetFailure | undefined;
```

`selector` is the fragment as it arrived. `matches` is the ambiguity list and is
empty for every other kind; `available` is the whole catalog. The message is
derived from the data, quotes the selector as JSON, and lists canonical encoded
references, so a heading holding a control character cannot reach a diagnostic
literally.

Recognition is structural and total. The data carries a stable namespaced tag,
so a failure built by a separately loaded copy of the package is recognized on
the same terms as one built locally — `instanceof` cannot answer that question
across two copies. Recognition also requires the name, the message its own data
derives, frozen data with exactly the described members, no cause, and no other
enumerable member: a recognized failure is handed onward by identity, so a
candidate carrying a path or a foreign object is refused rather than adopted.
The data is rebuilt from validated parts wherever it crosses a boundary, so
nothing a candidate owns is retained.

##### A failed selection is recorded, not merely failed

A selection that names no single section is an observation of the document: the
text was read, and it does not offer what was asked for. The root import records
that outcome structurally — its kind, the requested selector, the matches, and
the catalog — and the failure is then rebuilt from that record and raised.

Recording it is what makes a resumed run correct. A journal is matched by effect
type and name alone, so without the record a run whose selector matched nothing
would leave a completed journal that answers a later request for a section that
does exist. The replay guard therefore compares whole selection outcomes — the
whole document, one exact target, or one failure — rather than target strings,
and reproduces a recorded failure with its fields intact before the recorded
terminal result can be reused. The same failing selector replays its own
failure; any difference in outcome, including a different selector that fails
the same way, is stale input. No authored effect runs in either case.

The recorded selector is sanitized invocation metadata, retained only so an
ordinary failed execution can be reproduced. It never occupies the exact-target
field and never reaches a workflow definition.

### 5.5 The Component Api

Expansion's context-dependent operations are exposed through one public
Effection Api. `Component` is the Api value, `ComponentApi` its
interface, and each operation is also exported directly:

| Operation | Meaning | Without a provider |
|---|---|---|
| `importComponent(name)` | Resolve and import a component; `"__root__"` is the root document | throws a missing-provider error |
| `applyModifiers(modifiers, block)` | Execute a code block through its modifier chain | throws a missing-provider error |
| `raise(error)` | Report an `ErrorSegment` under the ambient error mode (§6.9); whoever creates one calls this | decides it: printed under `print`, thrown under `output` or `throw` |
| `env` | The current binding environment (§4.3) | `undefined` |
| `evalScope` | The current eval scope (§4.4) | `undefined` |
| `codeBlock()` | The code block executing through the modifier chain (§3.3) | throws a missing-provider error |
| `persistent` | Whether the current block runs with persistent lifetime (§4.4) | `false` |
| `content(slot?)` | Render the invoking component's content, or a named slot of it; throws `ContentError` when that content fails (§5.1.2, §6.3) | throws a missing-provider error |
| `hasContent()` | Whether the invoking element was written with content rather than self-closed | throws a missing-provider error |
| `handleFailure(failure)` | What an ordinary function-component failure means, after complete invocation teardown (§6.9) | fails the operation with `failure.error` |
| `retain(resource)` | Create a resource in the invocation-site scope, so it outlives this invocation (§4.4) | throws: not inside a component invocation |

What an element can learn about its own expansion is not a Component Api
operation, because there is no legitimate reason to intercept it: durable
identities are derived from it. See §5.6.

**There is no operation for claiming a name.** A component name means what §5.3
says it means — a structural construct, a reserved registration, a repository
file, or a registered default — and nothing installed at runtime preempts that
ordering. A host contributes components with `registerComponents`, and the
registration itself says which tier they land in: an ordinary registration is a
default, which a repository file of the same name overrides, while one marked
`reserved` sits above the repository because replacing it would break a language
or security invariant. Reserving is a property of the registration, declared
where it is installed and visible to inspection — not something a name acquires
by being handled first.

`env`, `evalScope`, and `persistent` are value operations — read without
invocation (`yield* env`); a provider is middleware returning the value.
`content(slot?)` is the canonical content operation for function components
(§5.1.2); `useCodeBlock()` and `useContent(slot?)` remain as ergonomic
compatibility aliases backed by `codeBlock()` and `content(slot?)`. The
`useContent` binding injected into eval blocks (§4.3) is a separate,
mode-carrying closure rather than this alias.

`hasContent()` reports the shape of the invocation, not a prediction about what
it renders: `<C>…</C>` and `<C></C>` both have content — content that renders
an empty string is still content — and only `<C />` does not. A component whose
two forms mean different things branches on it without projecting, so asking
the question never expands the invocation content.

**Providers are scope-local middleware.** Behavior is installed with
`Component.around(middlewares, { at })` and lasts until the installing
scope exits. Runtime implementations — the document's import and
modifier providers, and every piece of per-component state — install at
`{ at: "min" }`; caller instrumentation and overrides wrap at the
default `"max"` and may delegate with `next(...)` or short-circuit by
returning without calling it.

**Observable scoping behavior:**

- A provider installed in a nested scope takes precedence over an
  ancestor's provider for the same operation, without calling `next`.
  This is how each component's fresh binding environment and child eval
  scope shadow the parent's during body expansion.
- When the installing scope exits, its providers are gone — siblings
  never observe each other's state. Caller-projected content, the
  current code block, the persistent flag, and function-component
  content all rely on this.
- `execute` installs the document's `importComponent` /
  `applyModifiers` / root `evalScope` providers before starting the
  durable workflow, so the whole run inherits them; the journal shape
  of import, exec, and eval effects is unchanged by contextual
  dispatch.
- Calls from `Workflow`-typed code bridge with `ephemeral()` (typing
  only — a durable operation performed by a provider still journals);
  calls from `Operation` code yield the operations directly.

---

### 5.6 Expansion identity

An **expansion** is one logical evaluation of an authored executable element.
Core describes the one being evaluated:

```ts
interface Expansion {
  readonly id: string;
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
}

function* getExpansion(): Operation<Expansion>;
```

`getExpansion()` answers with a detached, frozen snapshot, and answers with the
same object throughout one live expansion. `name` is the authored tag name,
independent of which repository, registered or built-in component resolved it.
`position` is the opening tag's source position, carrying `path`, `offset`,
`line` and `column`; `path` is absent for markdown scanned at runtime, which
belongs to no file, and `position` itself is absent for an element that carries
none. A nested expansion covers the enclosing one, and leaving it uncovers that
one again. Nothing else about the expansion is reachable — not the element, its
props, its bindings, its projected content, the definition resolution selected,
or any live scope.

Calling it where nothing has published an expansion throws.

It is delivered as a context value under a stable name. An Effection context is
identified by its name, so a descriptor built independently — as a separately
loaded copy of core builds one, when a repository `.ts` component imports it
from disk while the compiled binary carries its own — reads the same expansion.
The same property means a descendant may bind that name, and its own
descendants read what it bound, exactly as with any context value.

It is therefore not an authority boundary: security enforcement and durable
identity never trust replaceable context state (architecture.md, *State across
loaded copies*). What a document can rebind, it can rebind.

**The identifier.** `id` is derived from the root document and the structural
path that reached the element. Each step contributes a frame — an authored
element and where it sits in its own file, a `<Loop>` iteration, an `<Each>`
item, and a projection — and the path is carried as the digest so far, so
extending it costs one hash. Every element that expands descendants contributes
its frame exactly once, so two elements at the same local index under different
parents cannot arrive at the same path. The identifier is opaque and supports
equality only.

It uses no process-global counter, no clock, no randomness and no scheduling
order. Replay, retry attempts and restoration of the same loop iteration
therefore arrive at the identifier already recorded, while different authored
elements, loop iterations, projections, component expansions and root documents
each receive their own.

An authored element is placed by its source path and offset, which is what makes
the derivation independent of how much ran before it — and what carries the root
document's identity, since every element in a root's body reports that
document's path. The root contributes no frame of its own; one would add nothing
an assertion could observe. An element carrying no
position at all — one built rather than scanned — falls back to its index in the
list being expanded.

A projection is identified by the invocation that performed it, so the same
authored content projected through two different components is two expansions.
What that content is made of still comes from where the caller wrote it: every
element inside carries its own source position. An authored `<Content />` is
placed by where *it* was written; a programmatic projection — `content(slot)`,
`renderChildren()`, `render()`, `useContent()` — has no source of its own, so
repeated calls are told apart by the order the component made them in. That
ordinal is taken when the projection operation is interpreted and before it
suspends, so it follows the component's own program order rather than the order
projections finish in, and an operation that is constructed and never yielded
takes none.

Supplied text reports the stable root identity `<eval>` (§8.1), so two inline
runs of the same text derive the same identifiers. That is what `<eval>` means
everywhere else, and workflow-wide identity is a run identifier together with an
expansion identifier, never the expansion identifier alone.

`Expansion` and `getExpansion()` belong to `@executablemd/core`, so ordinary
document execution receives expansion identity with no extension installed.

## 6. Expansion

### 6.1 The expansion algorithm

Expansion is a term-rewriting process. Each component invocation is
replaced by the component's body, with `<Content />` substituted by
the invocation's children and `{meta.key}` / `{props.key}` resolved.

Expansion is **top-down with bottom-up child processing**: children
are expanded first, then substituted into the component body, then the
substituted body is expanded recursively.

#### Block ID counter

`expandSegments` accepts a `BlockCounter` to generate unique, deterministic
`blockId` values for executable code blocks. The counter is threaded
through the expansion context to ensure stable IDs across per-segment
expansion calls (§5.4, §9.10).

Previously, `result.length` was used as the `blockId` index. With
per-root-segment emission, each `expandSegments` call would reset the
counter, producing duplicate diagnostic operation names. The mutable counter
fixes this:

```typescript
interface BlockCounter {
  next(): number;
}

function createBlockCounter(): BlockCounter {
  let id = 0;
  return { next: () => id++ };
}
```

The counter increment is guarded by the same scope and cancellation
that protects the expansion — if the scope is cancelled, no further
increments occur, preventing state leaks on abort.

#### Algorithm

Segment expansion rewrites a list of segments into rendered segments, in
document order:

- **Text** is healed at segment boundaries (§2.3), then interpolated for
  `{meta.key}` / `{props.key}` (§6.4) and for eval bindings (§6.6).
- **`<Capture>`** expands its children in the current scope and stores the
  rendered result in the named binding — optionally narrowed by a `select`
  prop (§6.5) — and itself renders nothing. `<Content />` is replaced by the
  caller's projected children (§6.3).
- **Any other component** is expanded (§6.2) and replaced by its result.
- **Executable code blocks** run their modifier chain (§3.3); a block
  contributes its emitted output, or an `ErrorSegment` when it fails with no
  output.

Errors are represented as `ErrorSegment`s and render as HTML comments by
default (§11.2). Deterministic `blockId` values come from the block counter
above, so per-segment expansion produces stable diagnostic identifiers.

Where a component (or the root) declares `<Output>`, this same rewriting drives
each of its regions, but only the content of declared output regions is
retained; content outside them executes for its effects without rendering, and
the first error produced while executing that non-rendered documentation stops
the body immediately (§6.9).

The modifier chain composition and handler registration are defined in §3.3.

### 6.2 Component expansion with cycle detection

Expanding a component invocation proceeds as:

- **Cycle and depth guards.** A component already being expanded on the active
  expansion path, or an expansion nested beyond the maximum depth (64),
  produces an `ErrorSegment` instead of expanding — preventing infinite and
  runaway expansion.
- **Import and props.** The component is imported (§5.3); the reserved `slot`
  and `as` props are consumed by the engine and stripped before the remaining
  props are validated against the declared props (§6.3.5, §6.5).
- **Body expansion.** The caller's children are substituted into `<Content />`
  positions (§6.3), and the body is expanded in a fresh binding environment
  whose `props` binding points at the validated props object, exposing
  `renderChildren()` / `render()` (§4.8) to eval blocks. Expression props
  resolve in the caller's scope. When
  the component declares `<Output>`, its placement is validated before any body
  content executes and only its declared regions render (§6.9).
- **Capture (`as=`).** With `as="binding"`, the rendered result is written to
  that binding in the caller's environment and nothing is emitted at the call
  site — capturing only the selected output when the component declares
  `<Output>`.
- **Resource lifetime.** The whole invocation runs inside its own resource scope
  (§4.4). Resources it creates — `persist` blocks, daemons, anything a component
  acquires while its body runs — are released when the invocation completes,
  after the content it projected has stopped.

Cycle detection and depth limiting are runtime operations — no journal
entries. They are deterministic from the component dependency graph read in
the current run.

### 6.3 Content slots: `<Content />` and `<Content slot="name" />`

When the boundary scanner encounters `<Content />` inside a component
body, it produces a `ComponentElement` with `name: "Content"`.
During expansion, this is a special case — it is not resolved from the
file system. Instead, it is replaced by the caller's children,
partitioned by slot assignment.

A projection point is anywhere the body writes one: a top-level segment, a
position inside an `<Output>` region, and equally a position nested inside
another invocation, inside a structural construct, or several levels down. Only
the body is walked. Content that arrives through a projection was written by the
caller, whose own body resolved its projections already, so a `<Content />` that
rides in on projected content belongs to the invocation that resolved it and is
not re-read here.

#### 6.3.1 Named slots

Components can render caller-provided content in multiple distinct
regions using the `slot` prop — the same pattern used by Web
Components, Astro, and Svelte.

**Caller side:**

```markdown
<Report>
  <Section slot="header">
    ## Title
  </Section>
  <Section slot="body">
    Body content.
  </Section>
  Default content (no slot).
</Report>
```

**Component side (Report.md):**

```markdown
<Content slot="header" />
---
<Content slot="body" />
---
<Content />
```

#### 6.3.2 Slot assignment rules

A direct child of a component invocation is assigned to a named slot
if and only if it is a `ComponentElement` segment with a `slot`
prop. All other children — text segments, executable code blocks, and
component invocations without a `slot` prop — are assigned to the
**default slot**.

The `slot` prop is **consumed** during slot partitioning — it is not
passed through to the child component as a regular prop.

#### 6.3.3 Slot partitioning

Before content substitution, children are partitioned into slot
buckets:

```typescript
interface SlotMap {
  default: Segment[];
  named: Map<string, Segment[]>;
  errors: ErrorSegment[];
}

function partitionBySlot(children: Segment[]): SlotMap;
```

Invalid slot names (empty strings or names not matching
`[a-zA-Z][a-zA-Z0-9_-]*`) produce `ErrorSegment` entries in the
`errors` array. These are emitted at the first `<Content />` or
`<Content slot="..." />` projection point.

#### 6.3.4 Projection and where it executes

Slot resolution happens during body substitution — partitioning, validation and
the once-only slot errors of §6.3.3 — and the resolved segments ride on the
`<Content />` element rather than replacing it. Expansion then runs them in the
invocation's content scope (§4.4), so a resource projected content creates stops
when that scope is halted, before the component releases its own.

Only the resource scope moves. Projected content keeps the caller's metadata,
validated props object, cycle-detection hide set, and block counter. For
ordinary bindings, `renderChildren()` and `useContent()` retain their caller
environment, while structural `<Content />` layers the caller's props binding
with the existing authored/current environment precedence. Component-authored
body content and `render(markdown)` keep the component frame. Expression props
on projected children resolve against the caller's environment, while authored
content resolves against the component's environment. The props guarantee is
deliberate; #305 does not broaden ordinary-binding lookup.

The error mode travels with them. A content task does not inherit the
documentation or `<Output>` frame the `<Content />` sits in, so the error mode is
captured at the expansion site and carried across (§6.9): a projected error in
documentation stops the body, and the same error inside an output region renders
as a comment. It is reported once, where it is created, and passes back to the
caller as an ordinary segment.

A throwing projection fails toward its caller, not into the content scope. An
eval block that catches the `DocumentationError` has recovered it explicitly:
nothing was recorded for a capture refusal, the invocation completes without
re-reporting the caught failure, and the work the projected content started is
torn down with its scope rather than escaping past the invocation.

A function component's `content()` is the same boundary in its own vocabulary: it
presents the failure as `ContentError` under either error mode (§5.1.2), a catch
there is the same explicit recovery, and the projected work still unwinds with
the content scope.

Substitution resolves the slots. It runs once per invocation, over the
component's own body, and does the following:

1. Partition the caller's children into slot buckets (§6.3.3). The buckets and
   the once-only error flag are shared by every projection point in the body.
2. Walk the body segments. A segment that is not a component element is kept as
   it is; a component element that is not `<Content />` is kept with its
   children walked the same way, so a projection point is found wherever the
   body writes one — nested inside another invocation, inside a structural
   construct, or several levels down.
3. At a `<Content />`, select the bucket its `slot` prop names, or the default
   bucket when it has none. Named-slot children have their own `slot` prop
   stripped (§6.3.2), and children of either kind are tagged with the caller's
   binding environment so their expression props resolve where the JSX was
   written.
4. Replace the element with a **claimed** `<Content />`: the same element,
   carrying the selected children and with its own `slot` prop removed. The
   claim is recorded by object identity on the invocation that made it. The
   selected children are not spliced into the body, because the claimed element
   is what expansion needs in order to run them in the invocation's content
   scope rather than its own.
5. Emit the slot-name errors of §6.3.3 immediately before the first claimed
   element, and only there.

The walk covers the body and stops at what a projection resolves to. Content
that arrives through a projection was written by the caller, whose own body
substituted its projections already, so a claimed `<Content />` riding in on
projected content is passed through untouched: re-reading it would give the
enclosing component content addressed to someone else, and copying it would lose
the claim its lifecycle depends on. A `<Content />` that no invocation claimed —
one an author wrote in a document rather than a component body — never becomes a
projection, however many bodies it passes through; it reaches component
resolution and fails as the reserved name it is (§5.3).

The `slot` prop is consumed by the projection that reads it. A resolved
projection nested inside another invocation therefore carries no `slot` prop of
its own and partitions into that invocation's default slot, like any other
content written at that position. To place caller content in a named slot of a
nested invocation, wrap it:

```markdown
<Layout>
  <Section slot="header"><Content slot="header" /></Section>
</Layout>
```

Text interpolation is deferred until the expansion frame is installed. This
keeps a scoped authored binding named `props` authoritative for text just as it
is for eval blocks and executable-block interpolation.

#### 6.3.5 Reserved prop names

The names `slot` and `as` are reserved. Declaring either in a
component's `props` frontmatter is a validation error.

- `slot` is consumed during slot partitioning and stripped before prop
  validation.
- `as` is consumed by binding capture and stripped before prop
  validation.

In both cases, the child component never sees the reserved prop in its
`validatedProps`. A registration's captures are not reserved names — an author
chooses them — but they are consumed the same way: stripped before validation
and delivered through `capture()` rather than forwarded as props. And `as` binds
the returned value itself by reference rather than its rendered text.

#### 6.3.6 Interaction with `renderChildren()`

`renderChildren()` renders **all** children (all slots combined), not
just the default slot. This preserves backward compatibility — existing
components that use `renderChildren()` continue to receive all content.

#### 6.3.7 Multiple projections

If the component body does not contain `<Content />`, children from the
invocation site are silently discarded. If the component body contains
multiple `<Content />` or multiple `<Content slot="X" />`, each is
replaced independently (all receive the same children for that slot),
and their depth in the body makes no difference: two at different depths
behave exactly like two at top level.

### 6.4 Frontmatter interpolation: `{meta.key}` and `{props.key}`

Inside component text segments, `{meta.key}` references resolve against
the component's own frontmatter. `{props.key}` references resolve
against the JSX props passed from the invocation site.

```typescript
function interpolate(
  text: string,
  meta: Record<string, unknown>,
  props: unknown,
): string {
  return text.replace(/\{(meta|props)\.([^}]+)\}/g, (match, namespace, keyPath) => {
    const source = namespace === "meta" ? meta : props;
    const value = getNestedValue(source, keyPath);
    if (value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}

function getNestedValue(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}
```

Rules:
- Nested access via dot notation: `{meta.config.retry.count}`
- Missing key → empty string (no error)
- Arrays → comma-joined: `{meta.tags}` → `"alpha, beta"`
- Inside fenced code blocks: never interpolated
- Inside backtick code spans: interpolated (use `\{...\}` for literal braces)
- Escaped braces: `\{not interpolated\}` → literal `{not interpolated}`

Interpolation is a runtime operation — deterministic from its inputs,
no journal entry.

#### Text segment interpolation pipeline

Text segments undergo two interpolation passes in sequence:

```
text segment
  → remend (heal markdown)
  → interpolate {meta.key}, {props.key} from the current frame ← first pass
  → interpolateEvalBindings {name}, {props.name} ← second pass
  → output
```

The second pass (`interpolateEvalBindings`) runs on text segments
when an `EvalEnv` is present on the scope. It resolves bare `{name}`
and dotted `{props.name}` references from `env.values`. This allows eval
block exports and the validated props namespace to flow into surrounding
prose naturally:

````markdown
```ts eval
const environment = "staging";
const dashboard = "https://status.example.test/staging";
```

{environment} status: {dashboard}.
````

Renders: `staging status: https://status.example.test/staging.`

**Precedence:** Text `{meta.*}` references resolve from the dedicated metadata
frame. Text `{props.*}` references, eval blocks, and executable-block content
all read the current `env.values.props` binding when it exists; a frame's
validated props object is the fallback for expansion without an environment.
An authored binding named `props` therefore shadows the validated namespace in
all three surfaces and normal scope, commit, and restoration rules apply. A
declared prop does not create `{title}`; bare `{title}` resolves only when an
eval, capture, loop, or component-return binding named `title` exists.

**Escaping:** `\{name}` is left as literal `{name}` in the output.
Both passes respect `\{` escaping — the backslash is consumed and
the brace is preserved as a literal character.

**No EvalEnv:** If no `EvalEnv` is on the scope (e.g., text outside
component expansion), the second pass is skipped and bare `{name}`
references are left verbatim.

### 6.5 Prop validation

Components only accept props described by their `props` schema. When
the root object is closed (`additionalProperties: false`), undeclared
props are rejected; missing required props are rejected; and default
values fill in for omitted props. Validation is by [Ajv](https://ajv.js.org).

```typescript
function validateProps(
  componentName: string,
  callerProps: Record<string, Json>,
  schema: PropsSchema,
): Record<string, Json> {
  const validate = compilePropsSchema(schema);   // cached per schema
  const clone = structuredClone(callerProps);     // useDefaults mutates
  if (!validate(clone)) {
    throw new PropValidationError(componentName, validate.errors ?? []);
  }
  return clone;                                    // defaults applied
}
```

The caller's props are cloned first because Ajv's `useDefaults` mutates
the validated object in place; the caller's environment value is never
touched. The compiled validator runs against the clone, and the defaulted
clone is returned as the component's resolved props. A failure raises a
structured `PropValidationError` (see below).

**Ajv contract.** A single shared, synchronous Ajv instance validates
every component, configured `strict`, `allErrors`, `validateSchema`,
`useDefaults`, `coerceTypes: false`, `removeAdditional: false`,
`addUsedSchema: false`, `validateFormats: false`. On top of draft-07 the
project imposes:

- the root props schema MUST declare `type: "object"`;
- `slot` and `as` are reserved and cannot be declared properties (§6.3.5);
- schemas are self-contained with **local references only** — no remote
  `$ref`;
- asynchronous schemas (`$async: true`) are rejected, so validation never
  introduces a promise into the Effection path;
- `format` is an annotation, not an assertion.

These rules — plus Ajv's own meta-schema check — are enforced when a
component definition loads, for both Markdown and function components, so
a malformed schema fails fast rather than at the first invocation. The
compiled validator is cached by schema identity and reused by
`validateProps`.

**Defaults are an extension.** Applying `default` values is an
executable.md extension enabled through Ajv's `useDefaults` — not portable
JSON Schema validation behavior. Object-property defaults fill missing
properties recursively; a missing parent object is not synthesized. A
tuple-form `items` default MAY extend an array (native Ajv behavior).

Validation is a runtime operation — deterministic from the component
definition and the caller's props. It runs after import but before
expansion. Errors are raised immediately, not deferred.

**Failure shape.** On a validation failure the component raises an error
segment whose `cause` is `{ componentName, errors }`, where `errors` is a
JSON-safe array of normalized Ajv issues, each
`{ instancePath, schemaPath, keyword, params, message }`.

#### Binding capture: `as` and `<Capture>`

Two expansion-level mechanisms capture rendered output into
`env.values` instead of the document:

- Component invocation capture: `<Comp as="binding" />`
- Inline capture directive: `<Capture as="binding">...</Capture>`

Both write a string to `env.values[binding]` and produce no output at
the capture site.

##### Component `as`

When a component invocation has `as="name"`:

1. `as` is stripped before prop validation.
2. The component expands normally.
3. Expanded segments are rendered to a string.
4. The string is stored in the invocation site's `EvalEnv`.
5. The invocation contributes zero output segments.

`as` must be a string literal and a valid JavaScript identifier:

```
/^[a-zA-Z_$][a-zA-Z0-9_$]*$/
```

The regex is the allowed identifier **shape**, but it is not sufficient:
reserved and contextual words (`in`, `let`, `await`, …) match it yet cannot
form an ES-module binding, which is where these names end up (eval blocks
destructure `const { name } = env;`). Binding-name validation therefore also
parses the destructuring shape and rejects any name that is not a legal
ES-module binding. This rule governs every binding name — component `as`,
`<Capture as>`, and `<Each let>`/`<Each as>`.

Invalid values produce `PropValidationError`.

##### `<Capture as="name">...</Capture>`

`<Capture>` is a built-in directive handled by the expansion engine.
It is not imported from the filesystem.

Rules:

- `as` is required and must be a valid identifier.
- `<Capture />` (self-closing) is invalid.
- `<Capture>` must have content.
- `<Capture>` accepts `as` (required) and `select` (optional) props.
  No other props are allowed.
- `as={expr}` is invalid (must be string literal).

`<Capture>` is **not an observation boundary**. Under the one-observation rule
(§6.9) it reports only the errors it creates itself — a missing or invalid `as`,
an unknown prop, an empty body — and hands the body's segments back untouched,
because they were already reported where they were produced.

Behavior:

1. Expand children in the **current env/scope** (no new `EvalEnv`, no
   new `EvalScope`).
2. If the expanded children contain any `ErrorSegment`, store no binding and
   return those error segments as they are — already reported (§6.9). Steps 3–7
   do not run, so rendering and `select` never fold an error comment into the
   captured value.
3. Render children to string.
4. Trim trailing whitespace (`/\s+$/`).
5. If `select` prop is present, apply CSS selector extraction (see below).
6. Store the resulting string in `env.values[as]`.
7. Produce no output segment.

Overwrites are allowed for both mechanisms: last writer wins.

##### `select` prop — CSS selector extraction

When the `select` prop is present, `<Capture>` parses the rendered
children as markdown via `remark` and queries the AST with
`unist-util-select` using CSS selector syntax. The text content of the
first matching node is stored instead of the full rendered output.

| Selector | Matches |
|---|---|
| `code` | Any fenced code block |
| `code[lang=json]` | Code block with `lang` attribute "json" |
| `heading[depth=1]` | h1 heading |
| `paragraph:first-child` | First paragraph |

If no node matches the selector, the full rendered content is stored
(fallback behavior).

For matched nodes, literal nodes (`Code`, `InlineCode`, `Html`, `Text`)
use their `.value` property directly. Parent nodes (e.g., `Paragraph`,
`Heading`) use `mdast-util-to-string` to extract concatenated child text.

**Example.** A component that returns prose narration followed by
JSON wrapped in a `` ```json `` code fence. The caller uses
`<Capture as="doctorJson" select="code[lang=json]">` to extract
only the JSON value, ignoring the surrounding prose. If the
component later adds or removes narration text, the captured
binding is unaffected — the selector isolates the structured data
from the human-readable content.

#### Expression props

Expression props pass runtime values from eval blocks to child
components. The scanner distinguishes between **resolved props**
(JSON literals known at scan time) and **eval expressions** (raw
expression text to evaluate at expansion time).

The `ComponentElement` segment has an `expressions` field that
holds raw expression text for eval expression props. At expansion
time, `expandComponent` evaluates these against `env.values` using
`new Function()` with env values destructured into scope parameters.
Results are validated via JSON round-trip for serialization safety.

| Expression | Scan time | Expansion time |
|---|---|---|
| `count={42}` | `props.count = 42` | — |
| `verbose={true}` | `props.verbose = true` | — |
| `data={{ key: "val" }}` | `props.data = { key: "val" }` | — |
| `pr={pr}` | `expressions.pr = "pr"` | eval → `props.pr = env.values.pr` |
| `total={a + b}` | `expressions.total = "a + b"` | eval → `props.total = 3` |

Expression evaluation happens **before** `validateProps` so that
resolved values can be type-checked. Results must be JSON-serializable
(validated via JSON round-trip). Evaluation errors are thrown, not
rendered as ErrorSegments — consistent with PropValidationError.

A **capture** is the exception. A registration may declare props the engine does
not resolve at all: they are stripped before expression resolution and excluded
from validation, so they meet neither the JSON round-trip nor the clone, and the
component evaluates each itself with `capture()` — when, and if, it wants to.
The value therefore arrives as the author wrote it, which is how an operand that
JSON cannot describe (a `RegExp`, `undefined`, a particular object) reaches a
component. Nothing is evaluated for a capture the component never asks for, and
an expression that throws throws into that component rather than becoming an
engine prop error. A capture is not durable: it is journaled neither as a prop
nor as a value, and a replay recomputes it from the restored bindings.

The `expressions` field is always present on `ComponentElement`
(empty `{}` when no eval expressions exist). A prop name appears in
either `props` or `expressions`, never both.

#### Props at the invocation site

Components receive props via JSX syntax:

```markdown
<Greeting name="world" greeting="Hi" />
```

The boundary scanner extracts props into `Record<string, Json>`:

```typescript
{ name: "world", greeting: "Hi" }
```

Validated props are available inside the component body via
`{props.name}`, `{props.greeting}`, etc. Default values from the
`props` schema are applied before interpolation, so `{props.greeting}`
resolves to `"Hello"` even if the caller wrote `<Greeting name="world" />`
(assuming the `greeting` property declares `default: "Hello"`).

Props also affect expansion when passed through to child components:

```markdown
<!-- Wrapper.md -->
---
props:
  type: object
  properties:
    label: { type: string }
  required: [label]
  additionalProperties: false
---
<Inner label={props.label} />
<Content />
```

Expression props (`count={42}`, `data={{ key: "value" }}`) are parsed
by the JSX boundary scanner's expression state tracking (brace depth
counting). The scanner extracts the raw expression string; evaluation
of the expression to a JSON value is handled during segment
construction. Only JSON-serializable values are supported, except for props a
registration declares as captures (see above); function props are outside the
component contract.

#### Components with no props

A component with no `props` key in its frontmatter accepts no props.
Passing any props to it produces a validation error:

```markdown
<!-- Badge.md -->
---
color: blue
---
🔵 Badge
```

```markdown
<!-- Error: Unknown prop "size" passed to <Badge /> -->
<Badge size="lg" />
```

#### `<Each>` iteration directive

`<Each>` renders its body once per element of an array, with each element
bound to a name that is visible to `{...}` interpolation and to eval blocks
in the body. It is a native directive handled by the expansion engine — like
`<Capture>`, it is not imported from the filesystem — because its `in` prop
would otherwise be a component input named after a JavaScript reserved word,
which cannot appear in an eval block's binding preamble.

```markdown
<Each in={findings} let="finding">
| `{finding.symbol}` | `{finding.file}:{finding.line}` | {finding.refs} |
</Each>
```

Props (only these three are accepted; any other prop is an error):

- `in` — the array to iterate. An eval expression (`in={findings}`) resolves
  against the caller/projected env at expansion time; a JSON literal
  (`in={[1, 2, 3]}`) resolves at scan time. A value that is not an array is an
  error.
- `let` — a **string-literal** identifier naming the per-item binding.
  `let={expr}` is an error. The name must be a valid ES-module binding, so
  reserved and contextual words (`in`, `let`, `await`) are rejected even
  though they match the identifier shape (see §6.5 binding names).
- `as` — optional. A **string-literal** identifier; when present the whole
  rendered loop is captured into `env.values[as]` and the directive emits no
  output at the invocation site (as with component `as` / `<Capture>`).

`<Each>` is **structural**: each iteration expands the body to segments that
are appended to the loop output, so `ErrorSegment` and `execOutput` segments
survive and the ambient error mode applies to them exactly as elsewhere. The
loop is rendered to a string only when `as` captures it.

Like `<If>` and `<Loop>`, `<Each>` is **not an observation boundary**. Under the
one-observation rule (§6.9) it reports only the errors it creates itself — an
unknown prop, a `let`, `as`, or `in` that does not hold up — and hands every
iteration's segments back untouched, because they were already reported where
they were produced. A failing element inside the body therefore settles exactly
once, as it would inline.

A capture never swallows an error. When the expanded body contains any
`ErrorSegment`, `as` creates no binding: the error segments stand in place of
the capture, already reported, so a printing error mode keeps them in the document
and a throwing error mode aborts.

This holds for all four capture paths:

| Path | Refuses the capture when |
| --- | --- |
| Native `<Capture as>` | its expanded children carry an `ErrorSegment` — checked before rendering and before `select` is applied |
| `<Each as>` | the expanded loop output carries an `ErrorSegment` |
| Markdown component `as=` | its expanded body carries an `ErrorSegment`, or a string projection in its body (`renderChildren()`, `render()`, `useContent()`) rendered one away |
| Function component `as=` | the content it requested carried an `ErrorSegment`, so `content()` never returned (§5.1.2) |

A function component's `as` needs no separate refusal rule, because
`content()` is itself the boundary (§5.1.2): a requested-content error stops
normal continuation at the `yield* content()` call, the invocation is replaced by
the original error segments, and there is no return value to validate and no
rendered text to bind. This is the same rule captured and uncaptured — an
uncaptured invocation drops its partial content and wrapper for the original
errors rather than rendering them inline — and it holds for the default content,
for a named slot, and for both text and declared-return components. A component
that catches `ContentError` around the call has recovered explicitly: it renders
what it chose to render, and its `as` binds that.

A markdown component's body hides errors when an eval block string-projects its
content, so the invocation tracks those and refuses the capture with the recorded
segments. A value component cannot reach a recorded projection error: `<Output>`
and `returns` are exclusive, its eval-block projections are bound to the block's
snapshot error mode — `throw` in value-body documentation — and that failure
stops the body.

Uncaptured `<Each>` is unaffected: without `as` it keeps emitting its body
segments structurally.

**Block scoping.** Each iteration expands its body in a fresh env object —
`{ values: { ...caller.values, [let]: item } }` — created inside a scope that
is discarded when the iteration ends. Therefore the loop binding:

- exists only while that iteration's body renders, then is discarded;
- does not leak to siblings, the parent, or later iterations (the caller env
  is never mutated — it is shallow-copied);
- shadows correctly when `<Each>` nests, with the outer binding intact on exit;
- is visible to body eval blocks, whose env mutations stay in that iteration's
  throwaway object.

An empty array produces no output. A projected `<Each>` (reached through a
component's `<Content />`) resolves `in`, the item, and other caller bindings
against the same caller/context-merged env used for expression props (§6.5).

**Known limitation.** This is runtime scoping that behaves like block scope;
there is no static/lexical analysis. An unknown reference in the body (e.g.
`{itm.name}` when the binding is `item`) is left verbatim rather than raising
(§6.6).

#### `<If>` conditional directive

`<If>` selects one branch of a document and expands only that branch. Like
`<Capture>` and `<Each>` it is a native directive handled by the expansion
engine, never resolved from the filesystem.

```markdown
<If condition={hasFailures}>
## Test failures

<FailureReport />
<Else>
All checks passed.
</Else>
</If>
```

`condition` is the only accepted prop; any other prop is an error. It resolves
in the invocation's evaluation environment — an eval expression
(`condition={verdict.passed}`) against the caller/projected env at expansion
time, a JSON literal (`condition={true}`) at scan time — and the resolved value
then selects a branch by ordinary JavaScript truthiness, `!!value`. A document
branches on the value it already has: `<If condition={review.note}>` asks
whether the reviewer wrote anything, with no conversion to a boolean first.

**Falsy** — `false`, `0`, `-0`, `0n`, `NaN`, `""`, `null`, `undefined` — selects
the false branch. Every other value is **truthy**, including `"false"`, `"0"`,
`[]`, and `{}`. Those are JavaScript's familiar edges rather than a rule `<If>`
invents: a non-empty string is truthy whatever it spells, and an empty array or
object is a value rather than an absence. A document that means "no findings"
writes `condition={findings.length === 0}`, not `condition={findings}`.

An absent member of a declared object resolves to `undefined` and selects the
false branch without an error, so a misspelled `review.aproved` reads as false.
An undeclared root identifier still fails evaluation and is reported as an
`<If>`-owned printed error.

**The condition is not restricted to JSON.** An expression prop must be
JSON-serializable because its value is passed to a component and recorded; a
condition is neither. `<If>` takes whatever the expression evaluates to — a
`BigInt`, a `Symbol`, a function, a class instance, `undefined`, `NaN`, `-0` —
decides one branch with it, and discards it. The value is never interpolated,
journaled, or forwarded, so it crosses no serialization boundary and no
serialization rule constrains it.

`<Else>` holds the alternative branch. It is optional, accepts no props, takes
content, and may appear once as a **direct child** of its `<If>`. A nested
`<If>` owns the `<Else>` elements beneath it. An `<Else>` written anywhere else
is a printed error, not a component invocation — the name never resolves from the
filesystem. `<Else>` structure is validated against the source before either
branch expands, so a malformed `<Else>` is reported even when it sits in the
branch the condition does not select.

`<Else>` is also the **final substantive child** of its `<If>`. An `<If>` has
exactly two branches, so content between `</Else>` and `</If>` belongs to
neither: whitespace there is Markdown formatting and is ignored, and any text,
component, or executable block is a source-positioned error rather than a third
region silently folded into the true branch. Like every other structural
violation this is decided before the condition is evaluated, so neither branch
runs.

A truthy condition expands the children before `<Else>`; a falsy one expands the
`<Else>` children, or nothing when there is no `<Else>`.

**Only the selected branch does work.** The other branch is not hidden output:
it never expands, so nothing in it imports a component, runs an eval or exec
block, reaches a provider, performs a filesystem effect, creates a binding, or
writes a journal entry. Placing a deliberately failing assertion in the
unselected branch is therefore the direct way to test non-execution.

**`<If>` opens no binding scope.** The selected branch expands in the enclosing
environment, so a `<Capture>` or component `as=` inside it behaves like inline
content and stays available after `</If>`. Nested `<If>` blocks select
independently, and `<If>` is otherwise transparent: it neither adds nor removes
an environment for the content it expands.

Like `<Each>`, `<If>` is **structural** — the selected branch expands to
segments that are spliced into the surrounding output, so `ErrorSegment` and
`execOutput` segments survive and the ambient error mode applies to them
exactly as elsewhere.

`<If>` is **not an observation boundary**. Under the one-observation rule
(§6.9), it reports only the errors it creates itself — a missing `condition`, a
condition expression that fails to evaluate, an unknown prop, a malformed
`<Else>` — and hands back the selected branch's segments untouched, because they
were already reported where they were produced. A failing element inside a
selected branch therefore settles exactly once, as it would inline, and an
ambient `throw` error mode still aborts at the first error.

Printed errors from `<If>` and `<Else>` carry the source location of the element
that caused them, as `path:line:column` when the element came from a file and
`line:column` for text scanned without an origin.

#### `<Loop>` bounded repetition directive

`<Loop>` expands a region of a document more than once, under a bound the
document states. Like `<Capture>`, `<Each>` and `<If>` it is a native directive
handled by the expansion engine, never resolved from the filesystem.

```markdown
<Loop name="planning" max={5}>
<Plan />
<Review as="verdict" />
<If condition={verdict.passed}>
<Break />
</If>
</Loop>
```

Props (only these two are accepted; any other prop is an error):

- `max` — required. The bound on how many times the body expands. An eval
  expression (`max={policy.attempts}`) resolves against the caller/projected
  env at expansion time, a JSON literal (`max={5}`) at scan time, and the
  result must be a **positive integer**. Zero, a negative number, a fraction, a
  non-finite number, and any non-number are errors rather than a bound to round
  or coerce. There is no unbounded form of the directive.
- `name` — optional. A **string-literal**, non-empty label. It is diagnostic
  metadata: the loop's own errors name it, and nothing else observes it. It is
  not passed to descendants, and it creates no binding.

The body expands in document order, at most `max` times. **Reaching `max`
completes the loop normally** — exhaustion is not a failure and produces no
printed error. Whether an exhausted bound means the work succeeded is the
surrounding document's error mode to state, written as an ordinary `<If>` on
whatever the body bound. Retry-limit failure is therefore something a document
declares, not something `<Loop>` does.

**`<Loop>` opens no binding scope.** Every iteration expands in the enclosing
environment, so an iteration reads what earlier ones bound, and the final
values stay readable after `</Loop>` — that is how a document acts on what the
repetition produced. This is the opposite of `<Each>`, whose per-item binding
exists only for the iteration that renders it.

Like `<Each>` and `<If>`, `<Loop>` is **structural**: each iteration expands to
segments appended to the loop's output, so `ErrorSegment` and `execOutput`
segments survive and the ambient error mode applies to them exactly as
elsewhere. It is **not an observation boundary** either — it reports the errors
it creates itself (an invalid bound, an invalid name, an unknown prop) and
hands the body's segments back untouched.

`<Loop>` adds no error mode of its own. Under a throwing error mode the first
failure ends the loop by propagating out of it; under a printing one the
printed error renders and the next iteration runs. Cancellation stops the loop
where it stands. Resources an iteration acquires are released at their own
invocation boundary (§4.4), so an iteration's resources are gone before the
next one begins and none of them outlive the loop.

**Execution records.** A loop writes its own journal entries rather than
leaving its behavior to be inferred from whatever the body happened to record.
Two kinds, both ordinary durable entries on the document's coroutine:

| Entry | Description | Value |
| --- | --- | --- |
| Iteration entry | `{ type: "loop_iteration", name: "loop:<id>:iteration:<n>", loop? }` | `{ iteration: <n> }` |
| Terminal | `{ type: "loop", name: "loop:<id>", loop? }` | `{ iterations, outcome }` |

`<id>` comes from the block ID counter (§6.1), so every `<Loop>` an execution
enters has a distinct identity — including each entry into a loop nested in
another one — and lands on the same identity when the document replays. The
optional `loop` field carries the author's `name`; like every field beyond
`type` and `name` it is stored for readers and never compared during divergence
detection.

**An iteration entry records that an iteration was entered.** It does not mean
the body completed: the entry is written *before* the body runs, so the record
never depends on what the body contains. An iteration whose body is empty has
one, and so does the iteration an interrupted document stopped inside.
`iteration` is the iteration's **deterministic, zero-based identity**, and it is
internal — not a binding, not a prop, not a value the body can read.

**The `loop` entry is terminal.** It is written when the loop finishes, it
exists only for the three ways a loop reaches an end, and `outcome` says which:

| `outcome` | Means |
| --- | --- |
| `exhausted` | The loop reached `max`. |
| `break` | A `<Break>` ended it. |
| `error` | A failure left the loop, under a throwing error mode. |

`iterations` counts the iterations that were **entered**, so a loop that breaks
on its final iteration and one that exhausts the same bound have identical
iteration entries and differ only in `outcome`.

**A replayed terminal entry is validated.** An iteration entry names its own
number, so replay's identity match already checks it. A terminal entry names
only the loop, so replay would match it whatever this run derived, and the
protocol's default is that the journal is authoritative — the stored value would
be handed back and the derived one discarded. Recording a terminal entry
therefore compares the two. A stored `outcome` or `iterations` that disagrees
with what this run reached means the journal no longer describes this run, and
raises a `StaleInputError` (§6.11): a document that resumes from such a journal
stops rather than continuing under an outcome it did not reach. Live, the value
compared is the one just written, so the check costs nothing.

A stored value that is not a terminal record at all is **described, not quoted**.
The printed error names the loop and the outcome this run derived; what the entry
held is reported as "an invalid terminal record". Journal content is external
data, and a printed error that reproduced it would carry whatever it happened to
hold into logs and rendered output. A well-formed record is safe to name: the
outcome is one of three known words and the count is a number.

**A durability failure is never a loop outcome.** A stale recorded input or a
divergence says the journal is already wrong about this run, so the loop records
nothing for it and the durability failure stays the primary error. Writing an
`error` outcome there would append to a journal known to be wrong and, on a
resumed run, consume a terminal entry an earlier run wrote — the exact path by
which a stale journal could hand a loop an outcome it never reached. Only an
ordinary document failure produces the `error` outcome; where a stale entry is
what that recording runs into, the `StaleInputError` becomes the primary error
and carries the document failure as its cause.

**The durability failure itself is what the caller receives**, not the wrapper it
travelled in. A teardown aggregate or an `AggregateError` says how a failure
propagated, not what went wrong, and what matters is which journal entry stopped
describing the run — so the loop rethrows the failure found inside the wrapper,
on the same terms as §6.9's fatal-cause discovery.

A print error mode is not a loop failure. The printed error is content, the loop
keeps iterating, and the outcome is `exhausted` or `break` as usual.

**An interrupted loop has iteration entries and no terminal entry.** This is
deliberate rather than a gap: an entry appended while the loop is being torn
down would sit after the iteration entries a resumed run still has to replay,
and would make that run diverge — so nothing is written, and the journal stays
resumable.

At execution level the same shape holds. A run that finishes ends with a root
`Close`: `ok` on success, `err` for a document failure, which a loop's `error`
outcome precedes. **An interrupted execution has no root `Close` at all.**

| Durable state | Loop entries | Root `Close` |
| --- | --- | --- |
| Completed | terminal entry, `exhausted` or `break` | `ok` |
| Failed | terminal entry, `error` | `err` |
| Interrupted | iteration entries only | absent |

The journal therefore says whether an execution finished, and does **not** say
why an unfinished one stopped. Cancellation and a process crash leave the same
durable state, because they mean the same thing to a reader — the execution did
not finish — and take the same recovery path: resume from the journal, which
replays what completed and runs the rest live. Which of the two happened is
runtime knowledge held by whoever cancelled or observed the process, not
journal state.

#### `<Break>` loop exit

`<Break>` ends the loop it is written in. It is self-closing, accepts no props
and no content, and is reserved: the name never resolves a component.

```markdown
<Loop max={5}>
<Attempt as="result" />
<If condition={result.ok}>
<Break />
</If>
</Loop>
```

It stops the remainder of the current iteration and exits the nearest enclosing
`<Loop>`. Content after it does not expand, so it imports no component, runs no
eval or exec block, reaches no provider, creates no binding, and writes no
journal entry — placing a deliberately failing assertion after a `<Break>` is
the direct way to test that. Everything the iteration produced before the
`<Break>` stands, bindings included.

A nested `<Loop>` handles its own `<Break>`: the inner loop exits and the outer
one keeps running. There is no way to break a named outer loop.

**Which loop a `<Break>` means is decided by where the author wrote it.** A
component's own body is isolated from the loop that invoked it: a `<Break>`
written there belongs to a `<Loop>` in that body, and is a printed error when the
body has none. Content the caller projects **through** a component is the
caller's text, written where the caller can see the loop, so a `<Break>` in it
ends the caller's loop — whether the component renders it through `<Content />`,
`content()`, or `renderChildren()`. Markdown the component itself produces
with `render()` is the component's own text and follows the body's rule.

A projected `<Break>` stops the projected content and marks the caller's loop.
The component's own body still finishes: the loop has no authority over how a
component renders. The break takes effect where it was written — at the
invocation site, once the invocation returns — so the rest of that iteration and
the iterations that were left do not expand.

A `<Break>` outside any `<Loop>` is a printed error rather than a component
invocation. **A malformed `<Break>` performs no control action**: props or
content on the element mean it does not carry the author's instruction, so the
printed error settles under the ambient error mode — aborting under a throwing one,
rendering under a printing one while the loop runs to its bound — rather than
a rejected element also ending the loop.

Printed errors from `<Loop>` and `<Break>` carry source locations on the same
terms as `<If>`.

### 6.6 Eval binding interpolation

Bare `{name}` references (no namespace prefix) resolve against
`env.values` — the eval binding environment populated by preceding
`eval` blocks within the same component. This applies to both
**code block content** and **text segments** (see §6.4 for the text
segment interpolation pipeline).

````markdown
```ts eval
const outputDirectory = "./build";
```

```bash exec
mkdir -p {outputDirectory}
```
````

`{outputDirectory}` resolves to the string exported by the first block. The
substituted content is used to build the subprocess command.

#### Interpolation syntax and precedence

Eval-binding references use JavaScript identifier syntax with optional dotted
paths:

```
\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\}
```

`{meta.*}` is handled by the text interpolation pass. `{props.*}` is
handled by that pass in text and by this pass in executable block content;
both use the `props` root in `env.values`. If `env.values` has no matching
root or an intermediate path is missing/null, the reference is left
verbatim. Non-string values are converted via `String()`.

Note: `{meta.*}` interpolation applies only to text segments. The
validated `props` object is installed at `env.values.props`, so
`{props.name}` uses the same dotted-path interpolation in executable block
content and in text. Eval blocks read `props.name` directly through the env
preamble. A prop does not create a bare `{name}` binding; use an eval,
capture, loop, or component-return binding when bare interpolation is wanted.
Text segments receive the text pass for `{meta.*}` and `{props.*}`, then the
eval-binding pass.

#### Where interpolation runs

Eval binding interpolation runs in `expandSegments` in two places:

1. **Code blocks** — immediately before the modifier chain is composed
   for a `codeBlock` segment. By the time any modifier factory receives
   `ctx.content`, the content is already fully interpolated — modifiers
   are not responsible for text preparation. This resolves `{props.name}`
   from `env.values.props` without changing the modifier API.

2. **Text segments** — after `{meta.*}`/`{props.*}` interpolation
   (§6.4). The second pass resolves bare and dotted references from
   `env.values` when an `EvalEnv` is present on the scope.

Eval blocks skip interpolation entirely — they access bindings directly
via the env preamble (`const { props } = env;`). Interpolating would
mangle JS template literals like `` `${name}` `` into `$<value>`.

```typescript
function interpolateEvalBindings(
  content: string,
  bindings: Record<string, unknown>,
): string {
  // Protect escaped braces: \{ → placeholder
  const escaped = content.replaceAll("\\{", PLACEHOLDER);
  const interpolated = escaped.replace(
    /\{([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\}/g,
    (match, key) => {
      let value: unknown = bindings;
      for (const part of key.split(".")) {
        if (value == null || typeof value !== "object" || !(part in value)) {
          return match;
        }
        value = value[part];
      }
      return String(value);
    },
  );
  // Restore escaped braces: placeholder → literal {
  return interpolated.replaceAll(PLACEHOLDER, "{");
}
```

This is a runtime operation, deterministic from the current `env.values` and
content. It produces no journal entry. Preceding eval blocks populate the
environment before subsequent blocks are interpolated.

**Escaping:** `\{name}` is preserved as literal `{name}`. The
`interpolateEvalBindings` function protects escaped braces via a
Unicode private-use placeholder before running the regex, then restores
them afterward. This is consistent with how `interpolate()` handles
`\{meta.key}`.

#### Serialization constraint

Only JSON-serializable values in `env.values` are stored in the diagnostic
journal entry (§4.1). Non-serializable values (functions, class instances) remain in
`env.values` as live references during the current run. Values used in
`{name}` substitutions are normally primitives such as port numbers, URLs,
and strings.

### 6.7 Provider component pattern

A **provider component** is a regular markdown component whose body starts an
attached service and installs middleware for its subtree. It composes
`service=<binding>` + `persist ephemeral eval` + `<Content />`; the host, not
the document, owns endpoint allocation and the authenticated XMD service
handshake.

#### Structure

1. A `service=<binding>` block starts the handshake-compatible command and waits
   for an authenticated handshake record.
2. A `persist ephemeral eval` block reads the live endpoint and installs
   provider middleware in the component eval scope.
3. `<Content />` expands the subtree while the supervised process and
   middleware are active.

#### Example

````markdown
---
props:
  type: object
  properties:
    command:
      type: string
  required: [command]
  additionalProperties: false
---

```bash service=server exec
{props.command}
```

```ts persist ephemeral eval
const endpoint = server;
yield* Sample.around({
  *sample([context], next) {
    if (context.model !== undefined && context.model !== "local") {
      return yield* next(context);
    }
    return yield* callProvider(endpoint, context);
  },
});
```

<Content />
````

The executable receives `XMD_SERVICE_HOST`, `XMD_SERVICE_PORT` and a
cryptographically random `XMD_SERVICE_TOKEN`. It binds exactly the supplied
loopback host and port, then writes one newline-terminated handshake record to
stdout:

```text
XMD_SERVICE_READY:{"version":1,"token":"<token>","hostname":"127.0.0.1","port":43210}
```

The host installs its byte-level stdout observer before spawn. At each line
start it retains only bytes that can still match `XMD_SERVICE_READY:`; on the
first mismatch it forwards those bytes and all subsequent ordinary bytes
immediately, without waiting for a newline. Only an actual handshake candidate
is buffered, under a finite bound. The observer suppresses valid and invalid
handshake records and accepts the handshake only when the JSON object has
exactly those fields and matches the expected version, token, host and port.
Malformed, forged, duplicate or late records fail the attached service without
exposing the token or raw handshake line.
Startup races the handshake against process exit, handshake failure and the
contextual startup timeout. After the handshake the host continues supervising
process exit and duplicate records until the attachment ends. An observable host
process teardown failure becomes `ServiceTeardownError`; when execution is
already failing, the invocation teardown aggregate preserves that execution
failure first and keeps the service failure reachable through its teardown
member.

The attached-service binding is live, so only the `ephemeral eval` block can read it.
The block installs middleware in the invocation scope through `persist`; plain
eval, interpolation and the journal cannot observe the endpoint. Partial replay
runs both blocks again to reconstruct a current process and middleware chain.
A completed replay expands nothing and starts no process.

#### Props namespace (DEC-EX-09)

Root documents and Markdown components install one `props` binding whose
value is the exact object returned by validation. They do not spread declared
properties into `env.values`:

```typescript
const componentEnv: EvalEnv = { values: { props: validatedProps } };
```

Validation and defaults complete before this environment is installed or any
body effect starts. Text interpolation continues to resolve `{props.command}`
through the text pass. Executable block content resolves `{props.command}`
through eval binding interpolation, and eval blocks read `props.command`
directly. Eval-created values such as `endpoint` remain ordinary bare
bindings. A declaration of `command` therefore does not create `{command}`.

Function components keep their separate contract: their function receives the
validated object directly and does not receive the Markdown environment helper.

#### Nesting providers

Provider components nest naturally — each establishes its own eval
scope boundary:

```markdown
<LocalProvider command="./first-server">
  <DatabaseProvider command="./db-server">
    <MyReport />
  </DatabaseProvider>
</LocalProvider>
```

Each service attachment receives a distinct host-selected endpoint and token. Both
services remain live while the nested report expands; the inner service tears
down before the outer in standard structured-concurrency order.

### 6.8 Sample component

The `<Sample>` component (`components/Sample.md`) is a standard library
component that routes content through the Sample Api for LLM processing.
It uses `output()` (§4.7) to produce rendered output and
`renderChildren()` (§4.8) to capture children.

#### Two modes

**With children:** Expand children → capture rendered output →
send to Sample Api → output LLM response.

```markdown
<Sample model="phi3-mini">
This content is rendered first, then sampled by the LLM.
</Sample>
```

**Self-closing with prompt:** Send prompt directly to the Sample Api →
output LLM response.

```markdown
<Sample prompt="summarize the test results" model="phi3-mini" />
```

#### Component file

````markdown
---
meta:
  componentName: Sample

props:
  type: object
  properties:
    prompt: { type: string, default: "" }
    model: { type: string, default: "" }
    params: { type: string, default: "" }
  additionalProperties: false
---

```js persist eval
const childrenOutput = yield* renderChildren();
const content = childrenOutput || props.prompt || '';

const sampleResult = yield* Sample.operations.sample({
  stdout: content,
  stderr: '',
  exitCode: 0,
  command: content,
  language: 'markdown',
  params: props.params || undefined,
  componentName: 'Sample',
  model: props.model || undefined,
});

output(sampleResult);
```
````

#### How it works

1. `renderChildren()` expands and renders the component's children.
   For self-closing invocations, this returns an empty string.
2. `content` falls back to the `props.prompt` value if children are empty.
3. `Sample.operations.sample()` is called directly from the eval block. The
   enclosing eval operation journals the block result, including output.
4. `output(sampleResult)` sets the block's rendered output to the
   LLM response.

#### Props

All three props are optional with empty-string defaults:

- **`prompt`** — Text to send when no children are provided.
- **`model`** — Model routing key. Empty string is converted to
  `undefined` so provider routing treats it as "no model specified"
  (innermost provider wins).
- **`params`** — Additional instruction params for the Sample Api
  middleware.

#### Repeated-run behavior of the provider pattern

Every run allocates a current free port, creates the service attachment,
performs the XMD service handshake and child operations, then terminates the
attached service when the component closes. A previous diagnostic trace does
not suppress any of these actions.

### 6.8.1 When a function component fails

A function component that fails fails the operation it is part of, like any
other Effection work. Its invocation is dismantled first — projected content,
then the component's own resources, then anything it retained — so the failure
that leaves the boundary accounts for the body and its teardown together. An
`Error` propagates by identity, keeping its type and `cause`; a thrown non-Error
becomes an `Error` carrying the original value as its `cause`. Later siblings do
not run.

Continuing instead is an explicit, scope-local choice. `printErrors(fn)`
says it about one component, keyed by the exact function object — a repository
component that shares a registered component's name is a different function and
inherits nothing. The declaration uses a stable string property, so another
loaded copy of Executable.md that receives the function recognises it.
`<PrintErrors>` says it about a region of a document:

```md
<PrintErrors>
  <MayFail />
  <StillRuns />
</PrintErrors>
```

`<PrintErrors>` accepts no props: it names a region and nothing else, so any
prop — `as` and `slot` included, written as a literal or as an expression — is a
syntax error reported against the element. An element written that way performs
no action at all: its body does not expand, and a prop expression is never
evaluated.

Both install the same middleware, so the nearest printing boundary is the one
that handles a failure from the invocation tree beneath it, exactly once. The
boundary sits outside the whole invocation, which is what lets it see a failure
that happens while the invocation is being dismantled.

A boundary does two things, and they are the same decision: it sets `print` for
its region (§6.9), and it turns a failure that reaches it into one printed error
whose `cause` is the complete original failure. The mode is a context value, so
it governs by lexical structure and nothing else — a region nested inside that
chooses its own shadows it, and what happens in that nested region is the same
whether or not a boundary is written around it.

`throw` is the one mode a boundary does not replace. Documentation and value
roots render nothing, so a printed error there is one nobody can read, and the
failure stays a failure.

Some failures are classified before any of this and are never printed: a
durability failure, a failure a `throw` decision already selected, the content
transport that restores already-reported segments, and a schema printed error
that already has a structured representation. Cancellation is not a printed
error either. A failure an `output` decision selected is not in that list: the
region it left has already stopped, so printing it resumes nothing.

### 6.9 Component-declared output: `<Output>`

A component (or root document) declares which region of its body renders using
an `<Output>…</Output>` boundary tag. Everything outside the declared regions
is **documentation**: it executes for its side effects — eval and exec blocks
run, `<Capture>` populates bindings, nested components run — but its rendered
result never reaches the consumer. Without `<Output>`, the whole body renders,
so existing components are unaffected.

````markdown
# Release Config Files

The following files participate in the release process. (Documentation — it
does not render into the consumer.)

<Capture as="releaseConfigFiles">
- .github/workflows/release.yml
</Capture>

```ts eval
const releaseChanged = files.filter((p) => releaseConfigFiles.includes(`- ${p}`));
```

<Output>

<If condition={releaseChanged.length > 0}>

> [!WARNING]
> Release configuration changed — update the release spec.

</If>

</Output>
````

#### Placement

Only a **direct top-level** `<Output>` is a valid declaration. Placement is
checked against the component's (or root's) source structure, including regions
that never render — content inside `<If condition={false}>`, content passed to a
component that has no `<Content />`, an `<Output>` nested inside another
`<Output>`, or the children of any component that declines to render them. An
`<Output>` anywhere other than the top level is misplaced; all misplaced
occurrences in a single component are reported together as one printed error that
advises `<Output>` must be a direct top-level declaration and that conditional
rendering uses `<If>` inside `<Output>`.

Placement is owned by the declaring component. Child expansion cannot
introduce, remove, or redefine it, and an `<Output>` a caller passes as content
is diagnosed against the caller's own structure — it never becomes the callee's
declaration.

#### Definition-owned structure and rendering

A component's output regions are fixed by its own source, independent of the
content a caller projects through `<Content />`, so caller content can neither
add an output region nor suppress the declared body. `<Content />` inside a
top-level `<Output>` projects the caller's content into that region.
`<Output>` accepts no props. `<Output />` and `<Output></Output>` are
equivalent and contribute no rendered content. Multiple top-level `<Output>`
regions render in document order and concatenate. A component invoked with
`as="binding"` captures only its selected output; its documentation executes
but is neither rendered nor captured.

#### Execution order and error behavior

Documentation and output regions execute in document order, so an output region
can use bindings a preceding documentation block computed, and documentation
after a region still runs. The required sequencing:

- Structural placement is validated before any body content executes; a
  structurally invalid component or root runs no eval, exec, `<Capture>`, or
  nested components and produces only the printed error.
- Documentation and output regions execute in document order.
- The first error produced while executing documentation stops that body's
  execution immediately and propagates to the caller.
- An error produced while rendering an output region fails the run. Nothing
  after it begins: not the rest of the region, not a later region, not the
  documentation between them. A body that declares no `<Output>` is unaffected —
  it runs under whatever mode encloses it, and at a root that is `print`.
- A root containing `<Output>` buffers its selection and emits it once. A run
  that fails emits what its regions rendered before the failure, and an empty
  selection emits nothing.

Each construct installs one mode for its own region, and the nearest one governs
(§6.9 Error modes):

| Region | Mode |
| --- | --- |
| the root, and any body with no `<Output>` | inherited; `print` at a root |
| an `<Output>` region | `output` |
| documentation, and a value root | `throw` |
| a `<PrintErrors>` region, or a `printErrors(fn)` invocation | `print`, except over `throw` |

Because a mode is read from the enclosing structure, wrapping a printing
boundary around a component whose own body declares `<Output>` changes nothing
inside that component: its region installs `output` for itself, stops at its
failure, and the boundary prints the failure that left it rather than resuming
it. A region's author gates what follows a failure behind it, and no caller
undoes that gate.

**Reporting and deciding are separate.** `Component.raise` is where an error is
reported: its middleware chain observes each `ErrorSegment` once, where the
segment is created, which is what lets instrumentation and `<Test>` count
failures. Its default implementation then *decides* the segment under the
ambient error mode — printed into the document, or thrown as a failure.
A documentation chunk and an `<Output>` region select the error mode by value
rather than by installing reporting middleware, so what an error becomes depends
only on where it was raised.

**Whoever creates an `ErrorSegment` reports it.** `Component.raise` is called at
the point the failure is decided, and a printed error that reaches the document
without that call never passes the observation chain — middleware that counts,
logs, or forwards failures never sees it.

**Every path reports once, and decides once.** The rule is the same wherever
segments cross a construct: `<If>`, `<Else>`, `<Each>`, `<Capture>`, `<Loop>`,
`<Break>` and a component invocation report the errors they create and hand a
body's segments on untouched. So a failing element is reported exactly once
wherever it is written: inline, in a selected branch, in an iteration, inside a
capture, in a component body, or projected into a `<Content />`.

**A printed error crosses an invocation as data.** A printed error was decided
where it was raised, under the mode governing that region, and nothing decides
it again — including the consumer that reads it. A child that printed an error
inside a `<PrintErrors>` region of its own hands its caller a document
containing that error; a parent whose documentation reads it neither stops the
rest of the child's rendering nor fails. A *failure* is the other half of the
same rule: uncaptured, it propagates out of the child and the parent does stop.
`content()` adds an inner boundary to a function component's own control flow —
the content provider projects structured segments and presents `ContentError` at
the `content()` call — and a component that does not recover is replaced by what
the projection already reported, under `print`, or by the failure a `throw` or
`output` decision already made.

#### Partial output

A failing region keeps what it rendered. Everything rendered before the failure
stays in the document and reaches the output stream, not only the journal —
including when an earlier segment already streamed, so a consumer reading chunks
sees the prefix before it sees the failure.

Only work the document was going to render can reach the output. Expansion
writes into the accumulator its caller gave it, and a call site producing
something other than document text passes none: a binding (`as=`, `<Capture as>`,
`<Each as>`), a value component's return, a string projection
(`renderChildren`, `render`, `useContent`), and documentation each keep a
private buffer. A failure part-way through one of those adds nothing to the
document.

#### Root and component consistency

A root document obeys exactly the same rules as an imported component (§5.4).
Because selecting output requires the whole body, a root that declares
`<Output>` is buffered — executed to completion, then emitted once — while a
root without `<Output>` keeps per-segment streaming. Buffering defers only when
output is emitted, not what executes, so replay is deterministic.

#### Outcomes and the journal

A run that fails is still a complete record. The document's workflow returns its
outcome — the rendered output together with a description of the failure — and
the root closes `ok` around it, so replaying restores both halves without
re-entering the workflow and without re-executing anything.

What crosses the journal is data, not objects. The record holds the failure's
name and message, the message and source of the segment that failed, its own
`cause` as text when it had one, and its aggregate members when it was an
`AggregateError`. A field is absent when the failure had nothing to say there,
which is what keeps a failure with no cause distinct from one whose cause was
the value `undefined`. A live run therefore reports the error it actually
caught, by identity; a replayed run reports the reconstruction its record
describes.

The record is parsed, never trusted. A shape this version cannot read — a name
that is not text, a segment with no message, aggregate members that are not a
list, a journal written before this contract — is refused with a message naming
the situation, rather than coerced into a failure that quietly disagrees with
the one recorded.

Only a durability failure (§6.11) escapes this. It says the journal no longer
describes the run, so it is never recorded as the run's own outcome.

### 6.10 Component return values: `returns` and `<Return>`

A component has one return path. It either returns its rendered Markdown or
declares and produces a typed value — never both. Agent workflows need values
for control flow (a verdict, a list of findings, a question), and a value
component gives the caller one directly instead of text to re-parse.

`Review.md` decides whether a change passes; its caller renders the outcome:

````markdown
---
returns:
  passed: { type: boolean }
  revisionPrompt: { type: string }
---

```js eval
const verdict = { passed: true, revisionPrompt: "" };
```

<Return value={verdict} />
````

```markdown
<Review as="review" />

<If condition={review.passed}>
Review passed.
</If>
```

#### The two modes

A component **without** a `returns` declaration is a **text component**: its
rendered Markdown is its return value, `<Output>` selects which region renders,
invoking it normally renders that text, and invoking it with `as` binds the
text and renders nothing. Its effective return schema is `{ type: "string" }`.

A component **with** a `returns` declaration is a **value component**. It
renders nothing, must be invoked with `as`, and binds one schema-validated JSON
value. Absence of the declaration is what selects text mode, so an explicit
`returns: { type: string }` is a value component that happens to return a
string.

#### Declaring a return value

`returns` is an object: either a draft-07 JSON Schema, marked by `type` or
`$schema` and validated for dialect exactly as `props` is, or the concise
**object-return shorthand**, a map of property names to subschemas. A schema
may describe any JSON value: string, number, boolean, array, object, or null.
Booleans and other non-object declarations are rejected.

```yaml
returns:
  passed: { type: boolean }
  revisionPrompt: { type: string }
```

The shorthand above normalizes to `type: object` with both properties,
`required: [passed, revisionPrompt]`, and `additionalProperties: false`: **every
shorthand property is required**. A component with an optional property
declares the full schema instead, where `required` names only what the caller
can rely on.

#### `<Return>` selects the value

A value component contains exactly one direct top-level `<Return value={…} />`.
It takes that one prop, takes no children, and renders nothing.

`<Return>` marks *which* value the body produces; it does not end the body.
Everything else in the body is documentation: it executes in document order for
its side effects and what it renders is discarded. The return expression is
evaluated at its own position, so it sees bindings computed before it and not
bindings created after it, and documentation after `<Return>` still runs. The
value is held until the whole body completes.

`<Return>` is reserved throughout expansion. Only a definition-owned direct
top-level `<Return>` is consumed, so a `<Return>` that reaches ordinary
expansion — projected caller content, `render(markdown)` output, any
dynamically produced segment — is diagnosed rather than resolved as a component
named `Return`.

#### Validation

The produced value crosses the JSON boundary before its schema: a value that
could not survive capture and replay — `undefined`, a non-finite number, a
function, a class instance, a sparse array, a cyclic object — is rejected
there. Validation then runs against a clone, so schema defaults fill the
returned value without mutating the producer's own object, and only that
normalized clone reaches the caller. Every failure names the component and
carries its normalized issues.

#### Structure is checked before body effects

Placement is validated against the component's own source, before `<Content />`
substitution, so projected content can neither introduce nor satisfy a
declaration. All violations are reported together, and a structurally invalid
component runs no eval, exec, `<Capture>`, or nested component:

- `<Return>` in a text component;
- a missing, duplicated, nested, or otherwise misplaced `<Return>`;
- `<Output>` in a component that declares `returns` — the two are mutually
  exclusive;
- a `<Return>` with children, with any prop other than `value`, or without
  `value`.

Invoking a value component without `as` fails the same way, before its body
runs: a component that renders nothing and is not captured produces nothing.

#### Function components

Markdown and TypeScript components share one contract. A function component
declares `export const returns` (§5.1.2), and its generator returns the JSON
value validated against that schema. It renders nothing and must be captured
with `as`. Without the declaration it returns its rendered string, as before.
Validation and capture happen only after the generator completes normally, so an
unrecovered content failure reaches neither: nothing is validated and nothing is
bound (§5.1.2).

#### Roots

A root uses the same modes, minus `as` (§5.4). Typed root returns reach the
command line through the JSON result contract of `xmd run` (§9.6).

---

### 6.11 Temporary working directories: `<TempDir>`

A test needs a filesystem it can dirty without coordinating with anything else.
`<TempDir>` gives its content one:

```markdown
<TempDir>
```sh exec
pwd
```
</TempDir>
```

The block prints a fresh directory, and by the time the document finishes that
directory is gone.

#### The two forms

Written **with content**, `<TempDir>` is a working directory. It creates a
unique directory, installs its canonical path as the contextual `Env.cwd` for
everything expanded inside, renders the content, and removes the directory when
the content finishes, fails, or is cancelled. Nested components, code blocks,
processes, and agents inherit it without being handed a path.

Written **self-closing**, `<TempDir />` is an allocation. There is nothing to
wrap, so it renders its canonical path and retains the directory at the
invocation site (§4.4) — long enough for the siblings that follow to use it,
and removed when that scope ends. `<TempDir as="workspace" />` captures the
path through the ordinary `as` mechanism and renders nothing.

Passing the path onward is the document's business. Cleanup is not: both forms
remove the directory through structured concurrency, and there is no `retain`
prop and no retention after failure. A future execution-level inspection policy
may keep scoped resources without changing this component's contract.

#### Where the directory comes from

`<TempDir>` creates nothing itself. It asks the installed `API.Files` provider
(§1.2) for a temporary directory, and the provider owns creation, the canonical
path, and removal as one acquisition — so nothing can land between creating a
directory and owning its removal, and a cancellation arriving mid-acquisition
cannot leave one behind.

A provider is allowed to have none to give. A run whose whole filesystem is a
database transaction has no temporary directories, and inventing a logical one
would put the content somewhere the run does not own — so that provider refuses
the operation outright, with the fixed diagnostic `Files provider does not
support temporary-directory`. The refusal is **fatal** on §6.13's terms: the
content does not run, nothing is rendered, and no later sibling expands. It is
never a printed error, because there is no directory for the document to work
in and carrying on would mean carrying on somewhere else.

With no provider installed at all, `<TempDir>` fails the same way and for the
same reason (§6.13).

#### Why the path is canonical

`<TempDir>` renders the directory's resolved path, not the one the host's
temporary root reports. On macOS those differ — `/var/folders/…` against
`/private/var/…` — and a subprocess reports the resolved one. Canonicalizing
makes the rendered path, `Env.cwd`, and a subprocess's own working directory
the same string, so a document can compare them.

#### Resuming from a partial journal

A document containing a wrapping `<TempDir>` does not resume from a partial
journal. Every execution creates a new directory, but a recorded effect is
matched by its description, so replaying one recorded under an earlier run
returns output naming a directory that has since been removed and skips the
filesystem work the effect stands for. Neither is visible to anything
downstream.

`<TempDir>` refuses that replay where it is recognisable. An effect consumed
from the journal inside its content raises `StaleInputError`, naming both the
directory this run created and the reason, and that **ends the execution**: the
`DocumentExecution` completes `Err`, nothing after the component runs, and the
document must be re-run from the beginning.

The refusal is not decided under the ambient error mode (§6.9). An error mode
that prints would turn a durability failure into a comment and let later
siblings run on top of work that never happened, so `StaleInputError` joins
`DocumentationError` as an error the engine's generic catches rethrow rather
than convert — including through a teardown aggregate, which must not launder
it into an ordinary failure. Ordinary failures inside a `<TempDir>` are
unaffected and remain printed errors.

**Divergence errors are rethrown on the same terms.** A `DivergenceError`, a
`TerminalDivergenceError` or its `EarlyReturnDivergenceError` specialization,
and a `ContinuePastCloseDivergenceError` all say the journal no longer describes
this run, so a generic catch that converted one into a printed error would let
expansion continue to the *next* durable operation — whose own mismatch is then
the failure reported, at a position that has nothing to do with where the
journal actually stopped describing the run. Every one of these is discovered
through the same cycle-safe cause traversal, so what the caller receives is the
failure itself rather than the wrapper it travelled in.

**Backing-journal persistence failures are rethrown on the same terms.** A
failed `Yield` append raises `DurablePersistenceError` before the effect
consumer can resume successfully. A failed `Close` append raises the same
error. Its cause is the storage adapter's error, and neither case writes a
compensating `Close(err)` that would misstate the persistence failure as a
document outcome. Pre-persistence policy rejection remains the policy's
ordinary failure and may be recorded by a separately admitted `Close(err)`.

**Durability discovery traverses the whole cause graph.** No wrapper keeps a
durability failure from being found, including a content failure a component
recovered from (§5.1.2). Recovery settles which failure the *document* reports,
which is why documentation discovery stops there; a durability failure is not
something a document reports, and `ContentError` is a public type an author
constructs and subclasses, so what one carries underneath is never taken as a
guarantee that nothing fatal is inside it.

**A Files infrastructure failure is fatal on the same terms.** A missing
document filesystem provider, an operation a provider refuses, and a provider
that broke its own contract (§6.13) are none of them things a document did or
can act on. Each is discovered through the same cycle-safe traversal, each
crosses a `ContentError` the way a durability failure does, and each is
recognized by its structural tag rather than by class — so a failure a
separately loaded copy of the runtime package constructed is found on the same
terms as one this copy did. Durability failures keep their own recognition
unchanged; only Files failures are recognized structurally, because only that
boundary is crossed by a second loaded copy.

Recognition is strict, because a recognized failure travels onward as the exact
object that was thrown. It must carry the fixed diagnostic for its kind, frozen
data with no extra fields, and no cause. A failure that carries the right tag
and anything else — a raw platform message, an errno beneath it — is not
preserved: it is replaced by a fresh invariant carrying none of it.

**Precedence is decided by kind rather than by position.** A wrapper carries
whatever failed together, in whatever order the platform happened to collect
it: an `AggregateError`'s members and an `InvocationTeardownError`'s stage
failures are both positional. The cause graph is therefore searched for a
durability failure first, then for a Files infrastructure failure, and only a
graph with neither reports a documentation failure. Position-based discovery
would let one ordering of the same teardown report the document's failure
instead, which `<Loop>` would then record as an ordinary `error` outcome onto a
journal already known not to describe the run.

Whichever is selected comes back **by identity** — the object that was thrown,
not a replacement — because a fail-stop that records "the first error" has to
record the one that happened. Only an output-mode `DocumentationError` is a
decision a printing boundary may still act on; a durability failure and a Files
infrastructure failure never are.

This is a limitation of the current durable model, not of the component. The
`import_component` entry recording that `<TempDir>` resolved to core's
registration (§5.3) says nothing about it — the risk lies with the effects
*inside* the directory, not with resolving the component. Re-executing recorded effects inside a freshly established
environment is issue #218.

The standalone form is outside this gate, and cannot be brought inside it. A
directory it retains belongs to the invocation site, and `retain()` gives a
component no way to install anything there (§4.4) — the isolation that makes
retention a lifetime rather than authority over the caller. A sibling replaying
an effect that uses a captured path is therefore **not detected**: it continues
with the recorded result, and nothing observes that the directory that result
came from has been removed. Resuming a document that captures a temporary path
is unsupported for that reason, and #218 owns closing the gap.

#### Isolation and cleanup

Nested and sibling instances are separate directories. A nested `<TempDir>`
shadows the enclosing one for its own content and restores it on exit; siblings
share nothing.

The directory is created synchronously, so nothing can suspend between
creating it and owning its removal: a cancellation arriving mid-acquisition
cannot leave one behind.

Cleanup participates in structured shutdown rather than racing it. For the
wrapping form the directory is the invocation's own resource, so §4.4's teardown
stops everything the content created — including daemons started inside it —
before the directory is removed. No filesystem operation is fire-and-forget.

### 6.12 Parsing JSON: `<Parse>` and `<SafeParse>`

Generated content becomes a value a document can act on by being parsed against
a schema. `<Parse>` binds the validated value or fails; `<SafeParse>` binds a
result the document can inspect. Both are core's own components (§5.3), and
neither calls an agent: parsing is provider-neutral, and repair is written in
Markdown where a reader can see it.

```md
<Parse schema={schema} as="verdict">
  <Content />
</Parse>

<SafeParse schema={schema} as="result">
  <Content />
</SafeParse>
```

Both require `schema` and `as`, render nothing, and bind one JSON value.
Children expand to the text being parsed.

#### The schema

`schema` is either captured JSON text or an already structured JSON Schema
value. Both forms normalize through the same draft-07 compilation, so a schema
held in a code fence and one written as a prop accept and reject the same
content.

The complete schema compiles **before** child content expands. Schema text that
is not JSON, a schema that is not a JSON Schema object, a schema Ajv rejects,
and an asynchronous schema (`$async: true`) all fail before any child effect
runs — so a document never does work whose result an unusable schema would then
refuse to judge.

Only references contained within the supplied schema resolve. An external file
or HTTP(S) `$ref` fails at compilation with a printed error naming the limit;
resolving them is issue #192.

#### What each one binds

`<Parse>` binds the validated JSON value directly — any JSON value, including an
object, an array, a scalar, and `null`. Malformed JSON and content the schema
rejects both fail, naming the component and carrying the normalized issues.

`<SafeParse>` binds one of two shapes:

```json
{ "ok": true, "value": "<validated JSON value>" }
```

```json
{
  "ok": false,
  "input": "<original rendered text>",
  "errors": [
    { "instancePath": "", "schemaPath": "", "keyword": "parse", "params": {}, "message": "…" }
  ]
}
```

Schema failures use the normalized validation issue shape of §6.5. Malformed
JSON produces one issue with `keyword: "parse"`, so a document reads both kinds
of failure the same way. A failed result preserves the rendered input exactly,
which is what lets a corrective prompt quote what was actually said.

`<SafeParse>` absorbs JSON syntax and schema-validation failures, and nothing
else. An unusable schema still fails, and a child execution failure propagates
unchanged.

#### Validation does not transform

Parsing and validation judge the value; they never edit it. A declared `default`
is not inserted, a type is not coerced, an undeclared property is not removed.
What a document binds is exactly what its content said.

#### Repair stays in the document

Neither component repairs content. A document may inspect a `<SafeParse>`
failure, render its errors into a corrective prompt, and finish with `<Parse>`
after a bounded retry. That loop is ordinary Markdown, so it is visible and
testable like anything else.

### 6.13 Reading and writing text: `<File>`

A document reads a repository file, writes a source file, or lays out a
fixture without asking an agent to choose a path or run a command. `<File>` is
core's own component (§5.3) and takes one required prop, `path`, resolved
relative to the contextual `Env.cwd`:

```md
<File path="request.md" />
```

Because the path is contextual, `<File>` composes with `<TempDir>` (§6.11)
without either component knowing about the other:

```md
<TempDir>
<File path="fixtures/request.md">
Request content
</File>
</TempDir>
```

#### The two forms

Written **self-closing**, `<File>` reads. It renders the file's text, and `as`
captures that text and renders nothing, exactly as it does for any component
that returns text.

```md
<File path="request.md" as="request" />
```

Written **with content**, `<File>` writes. It expands its children, writes the
result, and renders nothing at all: no output, no path, no file handle. Where
the file went is what the document already said, and there is nothing to
capture.

Missing parent directories are created. An existing target is replaced, so
writing the same content twice leaves the same file.

#### What gets written

Exactly what the children rendered. Nothing is added, trimmed, normalized, or
reformatted, so where the tags sit is where the file's first and last bytes
come from. Content on the same line as the tags is the whole file:

```md
<File path="a.txt">one line</File>
```

writes `one line`, with no trailing newline. Content on its own line is
surrounded by line breaks that are themselves inside the element:

```md
<File path="a.txt">
one line
</File>
```

writes `\none line\n`. That is the exact-content contract: a document that
needs a file to start or end a particular way says so by where it puts the
tags, and the component never guesses.

#### A failed child writes nothing

Children expand completely before anything reaches the filesystem, so an
existing target survives whatever happens among them.

A code block that fails is ordinarily a printed error (§6.9): the content still
renders, with the printed error in place. A component that renders its content
shows it to the reader. `<File>` renders nothing, so the same printed error would
be written into the file instead. It therefore fails the invocation rather
than writing, and carries the underlying messages in its own printed error —
which is the only place a reader would otherwise learn what went wrong.

When the failure propagates, the reported failure is `<File>`'s as well: the
write is what the document asked for, and that it did not happen is the fact a
reader needs. The
general rule then applies (§5.1.2) — the `DocumentationError` keeps `<File>`'s own
error as its cause, and the content failure that error was translated from stays
reachable beneath it, carrying the same error segments the document reported — so
reporting the component's account costs nothing that a host inspecting the
failure needs.

#### The provider boundary

`<File>` makes no filesystem call of its own. It calls `API.Files` (§1.2), a
contextual Api of whole semantic operations, and what "the filesystem" means
belongs to whichever provider is installed. `xmd run` installs a host provider;
a workflow run installs one whose paths name entries in a logical filesystem
the run owns. The component holds no host path, learns no resolved name, and
receives no handle or capability — the two forms it performs are `readTextFile`
and `writeTextFile`, and each is one call.

What the component owns is **order**, and it owns it because ordering is what
containment depends on.

#### Containment

Everything `<File>` touches stays inside `Env.cwd`, checked in two stages that
answer different questions and therefore run at different times. Both stages
are the provider's; the component decides when each happens.

The **lexical** stage is `checkFilePath`: path arithmetic against `Env.cwd` and
nothing else.
An empty path, an absolute path, and a `..` escape are all decided there,
before any filesystem call — so the failure reveals nothing about what the
path named. Only a complete `..` segment escapes: a name that merely begins
with two dots — `..notes.md` — is an ordinary file inside the directory.

The working directory is inside itself, so `.` is not an escape. It is a
directory, which is a question about the target rather than about containment,
and it fails as one.

For the write form this stage runs **before the children expand**. An unusable
path costs nothing, and the printed error it produces is about the path rather
than about whatever the children then did.

`checkFilePath` returns nothing usable — no path, no resolved name, no handle,
no capability. It answers one question, "may the children run?", and the answer
authorizes nothing else. A check that was skipped, replaced by middleware, or
answered by a different provider therefore cannot admit the write that follows.

A lexical check is not enough on its own, because a symlink inside the
directory can point anywhere. The **resolving** stage takes the part of the
path that already exists — the file itself when it is there, the deepest
existing ancestor when it is not — and re-checks the result. A symlink whose
destination is still inside the directory is ordinary and is followed to the
file it names; one that leaves is refused, before the content outside is read
or changed.

For the write form this stage is inside `writeTextFile`, which runs **after the
children have finished**. A child can change what a path means — replacing a
directory with a symlink out of the workspace — so a destination resolved any
earlier would not be the one the write lands on. That one call **repeats
lexical admission** from the same authored path and contextual directory and
then owns every later step: resolution, target classification, parent creation,
and the commit. Nothing is handed between the two stages, which is why the
earlier check cannot be turned into authority for the later write.

The read form is one call, `readTextFile`, and that call owns admission,
resolution, target classification, and the read together.

A **host** provider lands writes through a sibling temporary file and a rename,
which also closes the one case resolution cannot: a dangling symlink has
nothing to resolve, and `rename` replaces the link rather than following it
wherever it points. Removal of the temporary is registered before it is
written, so the write is covered by it rather than the other way round, and
removal is attempted on every exit including cancellation.

Reading a path that does not exist, or a directory, fails naming which it was.

#### The commit point

Every provider commits, but not every provider commits the same way, and the
difference is visible only when a write fails. A host provider's commit is a
rename; a transaction-bound provider's is a savepoint released into the
transaction that owns it. A successful write renders nothing under either, so
the distinction never reaches a document that succeeds.

The rename is the **host** write's commit point, and the guarantees are stated
around it:

- A failure or a cancellation **before** the rename leaves the previous target
  exactly as it was. Nothing has replaced it yet.
- The rename **is** the commit. What an observer sees is the complete old file
  or the complete new one — never a partial write.
- A commit is not a transaction. `rename` is a single filesystem call that
  cannot be interrupted once started, and a cancellation arriving after it has
  completed does not undo it.

What is guaranteed is that no write is ever half visible, not that a finished
write can be taken back.

##### What a failed write can say about the target

A failed write reports **where it stopped**, and where it stopped is what
decides what may be said about the target. The provider names the phase; the
component chooses the sentence. No other combination exists, and a provider
that reports one is a provider that broke its contract (below).

A rename is an operation on the contextual Fs Api, and an `around` handler may
do work on both sides of `next()`. So a rename that **throws** may have thrown
before the underlying rename ran, or after it succeeded, and no provider can
tell which.

| Where the write stopped | What is reported |
|---|---|
| Admission, resolution, target, or parent creation | no outcome sentence — nothing was attempted on the target |
| Preparation — writing the temporary | `The previous file is unchanged.` |
| The commit threw | `Whether the replacement committed is unknown: the target holds either the complete previous content or the complete replacement, never a partial write.` |
| The commit returned, cleanup failed | `The file was written.` |
| A transaction rolled the change back | `The Workspace change was rolled back.` |

The unknown row is the honest answer rather than a missing one: atomicity still
holds, so it is one of two whole files, but which one is not knowable from
there. Reporting that the previous file survived would be a guess, and wrong in
exactly the case where a handler failed after committing.

The last row belongs to a transaction-bound provider and cannot appear from a
host one; equally, no host rename or temporary-leftover wording appears from a
transaction-bound one. A rolled-back change is a conclusion — the write did not
happen, and nothing is left over.

A failed cleanup is orthogonal to all of them and appends:

```text
A temporary file beside it may remain.
```

#### Printed errors

A printed error names the path the document wrote, and nothing else. The resolved
working directory, the destination a symlink pointed at, the temporary file,
and a rejected absolute path are all withheld: §1.2 keeps absolute paths out of
printed errors, and reporting where an escape led would perform the disclosure the
refusal exists to prevent.

A platform error carries the path it failed on — `ENOTDIR: not a directory,
stat '/private/var/…'` — so forwarding one would leak exactly what the rest of
this withholds. Nothing from one crosses the provider boundary. What a provider
returns is a **reason** drawn from a fixed vocabulary, and the reason *selects*
a phrase; an unrecognized reason, and a condition the provider could not
classify, both select `the filesystem operation failed`.

The reasons are:

```text
empty-path, absolute-path, lexical-escape, resolved-escape, missing,
directory, special-file, not-directory, permission-denied, read-only,
too-many-symlinks, path-too-long, no-space, quota-exhausted, cross-device,
busy, too-many-open-files, directory-not-empty, invalid-pattern,
operation-failed
```

A failure carries that reason and the phase it came from, as a plain frozen
object under a stable tag, and it is **parsed** before any field is read. Data
that does not validate is treated as absent rather than trusted: for a non-write
operation that means the generic phrase, and for a write it is a
provider-contract failure (below), because every sentence a write could print
makes a claim about whether the file was replaced.

The outcome a provider returns is checked the same way, and the distinction
matters more than it looks. An outcome that **will not say** what it is — one
that does not report whether it succeeded, or whose success value or failure
cannot be read at all — has described nothing, and is a provider-contract
failure. An outcome that reads perfectly well but carries a failure the
vocabulary does not recognize *has* described something, just not in terms this
version knows: for a non-write operation that is the generic sentence and the
document carries on.

One operation qualifies that. Admitting a path succeeds with no value at all, so
an outcome that carries none is its ordinary success; what is refused there is a
value that cannot be read, and one that is present but is something other than
nothing. Every other operation's success carries a value and requires it to be
readable.

Nothing a provider returned is passed onward. What reaches the component is
rebuilt from the fields that validated — including a search's list of paths,
which is copied, so what a document binds is not something the provider can
still change.

The error's class carries no authority either. A `FileAccessError` arriving
from a provider call is replaced like any other, because a class says nothing
about whether a message is safe to show — trusting one would let a provider
choose the text of a printed error by choosing what to throw. Recognition is by
structural tag rather than by `instanceof` for the same reason two copies of the
runtime package can be loaded at once, and `instanceof` answers false across
them.

#### When the provider is the problem

An ordinary filesystem condition is something the document did and can act on.
Three things are not, and none of them becomes a printed error:

- **No provider is installed.** Every operation fails with the fixed diagnostic
  `Files provider is not installed`. The write form reaches it at
  `checkFilePath`, so it lands before the children; the read form, `<Glob>`,
  and `<TempDir>` reach it at their first call. Nothing falls back to the host.
- **The provider refuses the operation.** `Files provider does not support
  temporary-directory` is the one such refusal (§6.11).
- **The provider broke its contract** — stale authority, a failed rollback, a
  handler that threw, or result data that does not validate. All report
  `Files provider invariant failed`, and which contract broke is structural
  data for a consumer deciding what to fence rather than text: the category is
  never interpolated into the message.

All three **end the execution** (§6.11's rules for a durability failure apply
here too): no printed error, no `<File>` output, no root or child `Close`, and
no later sibling runs. A missing provider is an installation fault, and a
document that carried on after one would run every step after the file work as
though the file work had happened.

Precedence among fatal failures is by kind rather than position: a durability
failure first, then a Files infrastructure failure, then a documentation
failure, wherever each sits in the cause graph.

Cancellation is none of these. Halting resumes a generator rather than throwing,
so no Result is manufactured and no printed error is created. A host provider's
cleanup still runs; a cleanup that fails while cancellation is unwinding is
reported as a sanitized teardown invariant rather than turning the cancellation
into a write outcome.

#### When cleanup fails

Removal of the temporary is attempted on every exit. If that removal fails the
document is told — a file it did not create may be sitting next to one it did,
and that is its directory. The report names the document's own path, never the
generated temporary:

```text
cannot clean up "request.md": permission denied. The file was written.
A temporary file beside it may remain.
```

A cleanup failure never replaces the write failure it may accompany. Both are
printed rather than thrown — a destructor that threw would displace the
failure it was unwinding — and reported together, followed by the target's
outcome and then the leftover sentence. With a rename that threw and a cleanup
that failed:

```text
cannot write "notes.md": the destination is on a different filesystem.
cannot clean up "notes.md": permission denied. Whether the replacement
committed is unknown: the target holds either the complete previous content or
the complete replacement, never a partial write. A temporary file beside it may
remain.
```

"May remain" rather than "remains": the removal failing is exactly the evidence
the component would need to say which. A successful commit consumes the
temporary, so a cleanup failure after one usually means there was nothing left
to remove.

#### Threat model

Containment is the installed provider's claim, and the two providers make
different ones.

**`xmd run`** resolves document paths in the caller's own filesystem, and
judges containment against that filesystem as it observes it. That is sound
**while the host pathname namespace is stable**, and every guarantee above is
stated on that basis.

It is not a sandbox. Nothing prevents another process from replacing a
directory, symlink, junction, or reparse point between the moment a path is
observed and the moment it is used. Resolving a write's destination immediately
before writing narrows that window and closes it for the case a document
controls — its own children — but check-then-use does not become atomic by being
ordered more carefully, and no capability the shipped runtimes expose closes it
without a native dependency.

**A workflow run** resolves document paths in a logical filesystem the run
owns. A document path never becomes a host path there, so there is no host
namespace for another process to replace: lookup, symlink resolution, and
traversal are all the provider's own, and a symlink target that looks like a
host absolute path is an ordinary logical name.

Neither claim covers a native command a document runs. A subprocess receives
the contextual working directory and the caller's filesystem, and containing
what it then does is not this component's boundary.

#### Scope

The initial component is UTF-8 text only. Binary data, configurable encodings,
structured file handles, and append, patch, or streaming modes are outside it.

`<File>` performs no durable effect of its own — nothing is journaled — so what
a replay does depends on whether expansion reaches the component at all.

A journal containing the root's close is a **completed execution**. Replaying
it restores that result without expanding anything, so `<File>` does not run
and the filesystem is not touched.

A **partial** journal replays what it holds and then continues live, so
expansion does reach `<File>`. Having recorded nothing, it has nothing to
restore: the read happens again against whatever the file says now, and the
write happens again. Inside a wrapping `<TempDir>` that repetition is what the
directory's replay refusal depends on (§6.11).

---

### 6.14 Finding files: `<Glob>`

A document decides what to work on by looking at what is there. `<Glob>` is
core's own component (§5.3) and answers one question — which files under the
contextual `Env.cwd` a set of patterns selects:

```md
<Glob include={["**/AGENTS.md"]} as="instructionPaths" />
```

`include` is required and holds at least one pattern. `exclude` is optional and
defaults to empty. Both are lists of glob patterns, and both are evaluated
relative to `Env.cwd`, so `<Glob>` composes with `<TempDir>` (§6.11) and with
`<File>` (§6.13) without any of them knowing about the others — a path `<Glob>`
returns is a path `<File>` can read:

```md
<TempDir>
<File path="docs/guide.md">Guide</File>
<Glob include={["**/*.md"]} as="docs" />
</TempDir>
```

`<Glob>` declares `returns`, so it is a value component (§6.10): it renders
nothing, must be invoked with `as`, and binds one `string[]`.

#### What comes back

A **set of relative paths**, and everything about that phrase is load-bearing.

Each path is relative to `Env.cwd` and written with `/` on every platform, so a
document that branches on a listing reads the same on every host. Paths are
deduplicated, so a file several patterns all match is one result. And they are
sorted lexically by code point — not by `localeCompare`, whose answer depends on
the host's locale, and not in the order the filesystem handed entries back,
which is not an order at all.

Finding nothing is a result. An empty array succeeds and the document carries
on; it is not a failure and not a printed error.

#### Who searches

`<Glob>` validates the shape of what the document wrote — a pattern that is
empty, absolute, or begins by leaving cannot match anything a search produces —
and then makes exactly one `API.Files` call (§1.2). The provider compiles the
patterns, walks the tree, and returns the deduplicated, sorted, POSIX-relative
files. No directory path, no partial listing, and no host path crosses back.

An absolute pattern is judged by the pattern's own grammar rather than the
running platform's: patterns match POSIX-relative paths everywhere, so a
leading `/` is absolute wherever the document runs, and so is a drive-letter
prefix. Deciding it from the host would make one document mean two things.

#### The pattern dialect

Patterns are the provider's dialect, and `<Glob>` adds no syntax:

- `*` matches within one path segment;
- `**` crosses segments, and `**/` matches no directories as readily as many —
  so `**/AGENTS.md` finds the file at the top and nested at any depth;
- `?`, `[…]`, and `{a,b}` behave as that library defines them.

A **leading dot is an ordinary character**. `*` matches one like any other, so
there is no hidden-file prop: `*.md` finds `.hidden.md`, and a pattern finds a
hidden file exactly when it says so.

**Exclusions win.** A file whose path any `exclude` pattern matches is not a
result, whether an `include` pattern reached it by wildcard or named it outright.

Exclusion is decided **per file**, against that file's own relative path. A
pattern that matches a *directory* removes nothing by itself, because directories
are not results and a directory's path says nothing about the paths beneath it:

- `exclude: ["vendor"]` removes nothing at all — no file is named `vendor`.
- `exclude: ["vendor/*"]` removes the files directly inside `vendor`, and keeps
  `vendor/deep/keep.md`, because `*` may match nothing but never crosses a
  separator.
- `exclude: ["vendor/**"]` removes the whole subtree, because `**` after a
  separator matches any number of further segments.

Only the last of those lets the directory be **skipped** instead of walked. A
subtree is pruned when an exclusion provably covers every path beneath it, which
is exactly a pattern ending in `/**` whose leading part matches the directory —
so `.git/**` and `**/node_modules/**` are never walked. Every other exclusion
walks the subtree and filters its files individually.

Pruning is an optimization and never changes the answer. `**/*` excludes every
file at any depth and earns no pruning, because it ends at a single `*`; the
result is the same empty array either way.

#### Only files

Directories are never results, and neither are symbolic links. A symlink is a
link rather than a file — so a link to a file inside `Env.cwd` is not returned,
and a link to a directory is not descended into.

That last rule is what keeps a search inside `Env.cwd` without judging any
destination: traversal only ever follows real directories, so it cannot leave the
working directory and cannot cycle. Following one cannot be offered safely
without confining a resolved destination to the root and detecting a traversal
cycle, and no provider guarantees both today. A later one may.

#### Failures

Most of what fails the component is about a pattern rather than about the
filesystem:

| What | Reported as |
|---|---|
| A pattern that is absolute | `include pattern "/etc/**" is absolute; give a pattern relative to the working directory.` |
| A pattern whose first segment is `..` | `include pattern "../*.md" reaches outside the working directory.` |
| A pattern that is empty | `include holds an empty pattern, which matches nothing; give a pattern relative to the working directory.` |
| A pattern the dialect cannot compile | `one of these patterns cannot be used: "*.md", "[bad".` |
| A missing or non-directory `Env.cwd` | `the working directory does not exist.` / `the working directory is not a directory.` |
| A failed directory read | `cannot search the working directory: permission denied.` |

The first three are patterns that cannot match anything a relative search
produces. Returning `[]` for them would make a typo indistinguishable from an
empty directory, and an empty result has to keep meaning "there are no such
files". Only a whole leading `..` segment leaves: `..notes.md` is an ordinary
name, and a `..` further along — `docs/../*.md` — is a path a search never
produces, so it matches nothing for the ordinary reason.

A pattern that cannot be compiled is reported by the provider as an
`invalid-pattern` failure, and which pattern it was does not survive that
boundary. The candidates are listed rather than one being named; they are the
document's own text.

#### Printed errors

A printed error names the patterns the document wrote, and nothing else. A
traversal failure names **no path at all**: what failed is a directory under
`Env.cwd` that the document never wrote, and §1.2 keeps absolute paths out of
printed errors.

As in §6.13, nothing from a caught platform error is reproduced. The provider
returns a reason from the shared vocabulary, the reason **selects** a phrase,
and an unrecognized one selects `the filesystem operation failed`. The error's
class carries no authority either — a `GlobError` arriving from a provider call
is replaced like any other, because a class says nothing about whether a
message is safe to show.

A provider that is absent or that broke its contract is not a search failure at
all. It ends the execution on §6.13's terms, and `<Glob>` binds nothing.

#### Threat model

As with `<File>`, the guarantee is about traversal rather than about the
filesystem being stable. No provider follows a symlink, so nothing a search
reads is chosen by one. Under `xmd run` a directory that is real when it is read
could still be replaced afterwards: the host claim holds while the host pathname
namespace is stable, and this is not a sandbox. A workflow run's traversal walks
logical entries that no other process can replace.

#### Scope

`<Glob>` returns paths and nothing else: no directories, no filesystem metadata,
no sizes or times. The root is `Env.cwd` and is not configurable — a document
that wants to search elsewhere establishes that directory, which is what
`<TempDir>` is for.

It records no durable effect, so what a replay does depends on whether expansion
reaches it. A journal containing the root's close is a completed execution:
replaying it restores the captured array without expanding anything, and the
filesystem is not touched. A **partial** journal replays what it holds and then
continues live, so expansion does reach `<Glob>`. Having recorded nothing, it has
nothing to restore, and the search runs again against whatever is on disk now.

---

### 6.15 Asking a person: `<WebForm>`

Not every decision in a document is one a machine should make. `<WebForm>` stops
the run, asks a person a structured question in their browser, binds the answer,
and continues:

```md
<WebForm schema={reviewSchema} as="review">
# Review required

Read the plan above and decide.
</WebForm>
```

It ships in `@executablemd/web` rather than core, and is registered rather than
reserved (§5.3) — a repository's own `WebForm.md` or `WebForm.ts` outranks it.
The component declares `returns`, so it renders nothing and requires `as` like
any other value component (§6.10); what it produces is the answer, validated
against the author's schema by the server that received it.

Everything that can be judged without opening a port is judged first: the content
is projected, the declaration is normalized, the body is sanitized, and the schema
is compiled. Only then is anything served. A document whose content failed, or
whose schema cannot be used, binds no port, prints no URL, opens no browser, and
leaves no journal entry.

Only the validated answer is journaled, keyed by a fingerprint of the question, so
a resumed document restores the answer without asking anyone twice.

`specs/web-form-spec.md` is the full specification: the props, the preflight
boundary, the loopback protocol and its fixed security policy, the durability
fingerprint, and the provider-neutral `liveForm()` operation that `<Elicit>`
shares.

### 6.16 Asking without choosing how: `<Elicit>`

`<WebForm>` is a browser form by construction. `<Elicit>` asks the same kind of
question without saying where the asking happens:

```md
<Elicit schema={responseSchema} as="response">
Review the implementation plan and provide your decision.
</Elicit>
```

`schema` and `as` are required. `schema` is a draft-07 JSON Schema, as a
structured value or as captured JSON text. The component declares a broad JSON
return, so it renders nothing and `as` binds the validated answer. There is no
`mode`, `provider`, or `uiSchema` prop, and no built-in approve, decline, or
cancel: the schema defines every response available. An author who wants a
browser form specifically, or RJSF presentation options, writes `<WebForm>`.

Where the asking happens is the host's decision, made through the **Elicitation
Api** (§6.16.1). Documents do not select a provider, and changing the provider
changes no Markdown.

Three steps happen in a fixed order, and the order is the contract:

1. **The schema compiles.** A schema that cannot be used fails here — before the
   invocation content expands and before any provider is contacted, so an
   invalid schema produces no content effects and cannot open an interaction.
2. **The invocation content expands.** What it renders is the request message.
3. **The provider is asked, and its answer is judged.** Core validates the
   result against the same compiled schema before it binds or journals anything.

An answer that fails its schema fails once, with normalized validation
printed errors. Core does not ask again: interactive correction belongs inside a
provider, and workflow retry belongs in visible Markdown control flow. A
provider's own failure propagates as it was raised — the provider knows why it
could not reach anyone, and `<Elicit>` does not. Halting the execution halts the
provider and everything it owns; cancellation stays an Effection lifecycle
event unless the document models it as schema data.

`<Elicit>` is unmarked, so a failure fails the document (§6.8.1). There is no
useful way to continue from "the person was never asked".

Two refusals are core's rather than any provider's, so a schema's validity never
depends on which provider is installed. A schema that declares `__proto__` as a
property, definition, or dependency name is refused with its position: the
validator loses that name, so the rule would silently not apply, and the
validated answer binds into the evaluation environment. A `$ref` that leaves the
supplied schema is refused with its position; only self-contained references
resolve today (#192).

**Durability.** Only the validated answer is journaled, keyed by a fingerprint of
the compiled schema and the rendered message. Preflight is not what replay
skips: compiling and expanding the content run on every execution, replay
included, because they are how a run knows which recorded answer it is looking
for. What replay never repeats is the provider call and the interaction it
stands for. A recorded answer whose question does not match the one this run
computed is refused rather than bound.

`Elicit.test.md` is the authoring contract in Markdown.

#### 6.16.1 The Elicitation Api

The contextual provider receives the rendered request and the compiled schema,
and nothing else:

```ts
interface ElicitationRequest {
  message: string;
  schema: JsonObject;
}
```

It returns an unknown structured value through an Effection operation. It does
not receive `as`, workflow run identifiers, journal details, or component
execution identities, and it owns only its live interaction and transport
lifetime.

Core owns schema parsing and compilation, final response validation, capture and
source printed errors, durable recording and replay, and interruption through the
surrounding scope.

A host installs a provider with `Elicitation.around({ *elicit([request], next)
{ … } }, { at: "min" })`. The position matters: at the default position an outer
install answers ahead of a nested one, which is the opposite of what a provider
is. At `min` the nearest provider answers and the outer one is restored when its
scope ends.

When no provider is installed, `<Elicit>` fails immediately with a
`no elicitation provider configured` printed error. There is no fallback
interaction and no silent skip.

Provider selection happens only through this Api. `xmd run` composes the WebForm
implementation as its current provider, so an `<Elicit>` under the CLI opens the
same loopback form `<WebForm>` serves. An embedding application installs the
provider it wants. A document says what an answer is with an `<Answers>` region
(§6.16.2), which is a provider like any other and needs no host; a test that
must *observe* an elicitation — what message it carried, what schema — installs
middleware on this Api directly, because a matcher answers a question rather
than reporting it. Which *interaction* reaches a person — a browser form, a
terminal, an editor integration — is the host's alone, and replacing one with
another changes no executable Markdown. An `<Answers>` region is not one of
those: it answers rather than asks, so a document that writes one has said what
the answer is, not where the asking would have happened.

`xmd test` deliberately installs no provider. A test document that elicits
without saying what the answer is would otherwise open a browser and wait for
somebody who is not coming; with none installed it fails immediately, and an
`<Answers>` region (§6.16.2) is how a test says what the answer is.

The elicitation path is also callable by a host directly — `elicit({ message,
schema })`, or the `prepareElicitation`/`runPreparedElicitation` split when the
caller needs compilation to happen before it renders its message. That is what
lets a command elicit with no document executing.

#### 6.16.2 Supplying answers from the document: `<Answers>`

`<Answers>` and `<Answer>` are reserved structural syntax (§5.3), not
components: `<Answers>` reads its `<Answer>` children as elements before they
expand, and a registered component only ever sees `content()` — rendered text,
by which point a matcher's `value` expression and its own position are gone. A
repository file named `Answers.md` therefore never stands in for one, and could
not implement matcher semantics if it did.

A component that elicits internally asks whoever the host's provider reaches.
Sometimes the surrounding document already knows the answer — a workflow
exercising somebody else's component non-interactively, a demo, a region of a
run that should not stop for a person:

```md
<Answers>
<Answer template="Approve {?what}?" value={{ decision: "approve" }} />
<Answer value={{ decision: "reject", note: "unreviewed" }}>
Deploy {?service} to production?
</Answer>

<ReviewGate plan={plan} as="verdict" />
</Answers>
```

`<Answers>` is elicitation middleware written as a construct. It installs a
provider around its body's expansion and answers from its `<Answer>` matchers;
every other child is the body, rendered transparently. The wrapper changes who
answers, never what the body produces, and it adds nothing to what the
Elicitation Api already does — each elicitation inside it is an ordinary one,
judged by core against the *asking* component's schema before it binds, so a
supplied value that does not fit fails exactly as a live provider's answer
would. `<Answers>` validates nothing of its own beyond reading its matchers.

**`<Answer>` matchers.** A matcher carries a template and a value:

| Prop | Required | Value |
|---|---|---|
| `template` | no | A single-line template, as a **literal string** prop. Children carry a multiline one; supplying both is a configuration error |
| `value` | yes | The answer, as an expression or captured JSON text |

`template` is never an expression: `template={x}` is refused, because a template
that came from a binding could not be read and would silently become a matcher
with no template — which selection would then let shadow everything below it. A
template references bindings through `{binding}` holes inside itself, which is
what those holes are for.

`value` follows the ordinary prop convention, and the consequence is worth
stating: a prop *string* is captured JSON text, so an answer that is itself a
string is written JSON-quoted — `value='"approve"'`. An object literal written
as an expression, `value={{ decision: "approve" }}`, arrives already structured
and needs no quoting. `value="approve"` and `value={"approve"}` are the same
un-quoted string and are refused, with a printed error naming the spelling that
works.

Templates match the **whole rendered message**: literal text constrains,
`{?name}` matches any text and binds nothing, and `{binding}` interpolates an
existing binding and requires it at that position. A matcher with no template
matches any message. The engine is the one `<WhenPrompt>` uses, and `{?name}`
is a wildcard only — capturing into the value is deferred until a use case asks
for it.

**Selection is two rules.** The first declared matching `<Answer>` answers, and
a matcher is reusable — it answers every elicitation it matches for as long as
the region lasts. The consequence is deliberate: declaration order is
significant, and a broad template above a narrow one shadows it permanently. A
matcher that never fires is not an error.

**Unmatched elicitations.** `delegate` on `<Answers>` is a boolean, default
`false`. By default an elicitation no matcher answers fails, with a printed error
naming the message and every template tried — a document supplying answers is
stating what will be asked, and being wrong about that is a mistake rather than
a cue to find someone. `delegate={true}` says the other thing explicitly: the
elicitation passes to the next provider outward, which is an enclosing
`<Answers>` if there is one and the host's provider otherwise. Regions install
at `{ at: "min" }`, so the nearest answers first and the chain composes outward.

**A stray `<Answer>`** — one written outside the `<Answers>` that would have
read it — is a positioned printed error, mirroring `<Else>` outside `<If>`. It
names no component: being structural (§5.3) means the name resolves to nothing
else, wherever it is written.

**Configuration printed errors** are positioned and raised under the ambient
error mode: a misplaced `<Answer>`, an `<Answers>` with no body (self-closing, or
nothing but matchers — it could never answer anything), both template forms at
once, a template that will not parse, a missing `value`, and a `value` that is
not JSON. A region whose matchers are malformed does not expand its body: one
that cannot be trusted to answer should not run something that will ask.

Replay restores recorded answers through the ordinary durability path, so
matchers see nothing on replay and a region needs only what this run will
actually ask. `Answers.test.md` is the authoring contract in Markdown.

##### The `{binding}` asymmetry

The two template spellings are not identical for `{binding}`, in `<Answers>` and
in `<WhenPrompt>` alike. Written as the `template` prop, the string is a literal:
`{binding}` reaches the engine intact, and the engine resolves it — an unbound
name is a configuration error naming the template. Written as children, the text
is interpolated during expansion, so an in-scope binding is substituted before
the engine sees it and an out-of-scope one survives to be reported by the engine.

The matching constraint is the same either way; only which layer reports an
absent binding differs. This is documented rather than normalized — the two
paths agree on every question a document can ask about matching.


## 7. Entry point

### 8.1 `execute`

`execute(options)` executes a markdown document as a durable
workflow and returns a `DocumentExecution` handle. Options:

- the root document source — either `path`, the path to the root markdown
  document, or an inline document built with `inlineSource(text)`, which carries
  the supplied text together with its `<eval>` identity
- `target?` — a document target selector, still encoded, resolved against the
  root before its body expands (§5.4). `fileSource(reference)` builds a file
  root and its selector from one document reference
- `stream` — the durable stream that journals the run
- `props?` — JSON values supplied to the root document (default: `{}`)
- `componentDirs?` — component search directories (default:
  `["components", "."]`)
- `modifiers?` — custom modifier factories registered alongside the
  built-ins (`exec`, `silent`, `eval`, `ephemeral`, `persist`, `timeout`,
  `daemon`, `service`)
- `secretDetection?` — detect credentials before durable events persist
  (default: enabled)

#### Secret detection

Every execution refuses to persist a durable event that carries a credential.
`execute` selects its journal before the durable run starts, so the root
component import is already covered, and the same policy holds for every later
yield and close.

Detection is on unless the host supplies `secretDetection: false`. That request
belongs to the host alone: root props, frontmatter, component props, eval
bindings, and registered components named `secretDetection` mean nothing to it,
and a document has no way to reach the value the host passed.

A finding rejects that one append before the backend is invoked, and the failure
reaches the durable effect that produced the event. What happens next is
ordinary error handling: an effect inside the document prints the rejection
where it stands and the run continues, while a rejection during the root import
fails the run. Either way the offending event is absent, and a later close is a
separate append that crosses the policy on its own — so a rejection never
implies an empty journal. There is no allowlist, sanitization, repair, or
approval: a finding is a code or data-flow defect to fix.

Findings and scanner failures carry positions and rule identities, never the
matched value, the scanned content, or the detector's own error.

A host may still wrap its stream with `guardDurableStream(stream, gate)` from
`@executablemd/durable-streams` — that decorator stays generic and knows nothing
about credentials; it runs whatever gate it is given. XMD's policy is one such
gate, installed by default. See the durable-streams README for the decorator's
contract.

##### At the command line

`xmd` is a host, so the same policy reaches every document it runs. Detection is
on for `xmd run`, for the default form that omits `run`, for an inline `-e`
document, and for `xmd test` against a file or a directory.

```sh
xmd run workflow.md
xmd test workflows/adversarial-implementation
```

`--no-secret-detection` turns it off for the whole invocation:

```sh
xmd run workflow.md --no-secret-detection
xmd test workflows/adversarial-implementation --no-secret-detection
```

The option is a switch, and it is the only spelling that disables detection.
`--secret-detection=false` is refused rather than read: an option that decides
whether credentials may be persisted should not be quietly interpreted, and
that form would otherwise resolve to *enabled*.

A disabled invocation writes one line to standard error before the first
document runs:

```
WARNING: secret detection is disabled; credentials may be persisted.
```

Once per invocation, not once per document — testing a directory of fifty
documents warns once. Requests that execute nothing, `--help` and `--version`,
warn not at all.

##### Reading the policy

Two operations report what the running execution is doing, for trusted runtime
packages that must hold their own work to the same rules:

- `secretPolicy()` answers `{ enabled: true }` or `{ enabled: false }` — a
  detached description of the normalized request, carrying nothing else.
- `scanSecrets(content)` scans with the running execution's scanner and returns
  its findings.

Neither returns the scanner or anything bound to it, and `scanSecrets` resolves
the execution's policy each time it runs — an operation built during a run and
performed after it has ended finds no policy and fails. Outside an execution,
and where the policy cannot be authenticated, both fail rather than reporting
that detection is off; `scanSecrets` on a disabled execution fails for the same
reason, so a caller branches on `secretPolicy()` first. The journal never
consults either one, so what these report cannot change what the journal is held
to.

#### The root document source

A root document is named by a path or supplied as text. The two forms are one
value, `RootDocumentSource`, so inspection and execution accept the same thing
and cannot describe and run a document under different identities.

```typescript
const fromFile = { path: "hello.md" };
const inline = inlineSource("# Hello");
```

Supplied text reports the stable identity `<eval>`: `inlineSource` attaches it,
so the text and its identity cannot be separated, and printed errors and source
positions carry it — `(<eval>:5:1)` — exactly as a path would. Everything else is
unchanged. Component directories, `<File>`, `<Glob>` and every other relative
operation resolve from the contextual working directory, never from the root's
identity, and no temporary file is created: the text is captured inside the
durable root import, so the journal holds it and a replay restores it without
reading anything.

`inspectDocument(root)` loads and validates the root definition and returns
what it declares — without executing the document or creating a journal:

- `path` — the path the document was read from, or `<eval>` for supplied text.
- `props` — the declared props schema. Root input sources and validation are
  defined in [Root Document Props](./root-document-props-spec.md).
- `returns` — the effective return schema: `{ type: "string" }` for a document
  that declares none, otherwise the validated declared schema.
- `returnMode` — `"text"` or `"value"`. An explicit `returns: { type: string }`
  produces the same effective schema as the default, so the mode is what tells
  the two apart.
- `targets` — every document target the root addresses, as canonical encoded
  fragments without the document path or a leading `#`, in document order,
  duplicates retained (§5.4).
- `target` — the exact canonical target the requested selector resolved to.
  Present only when a target was requested and resolved, and never the caller's
  glob.

An invalid return schema fails inspection exactly as it fails execution: both
load the definition through the same path. So does an unresolvable target:
inspection discovers and selects targets without expanding the document,
evaluating a code block, importing a body component, or creating a journal, so
a host resolves a selector to one exact target before anything runs.

`DocumentExecution` is an `Operation<Result<Json>>`: `yield* execution`
completes with `Ok(value)` on success and `Err(error)` on document,
infrastructure, or middleware failure. The successful value is the document's
return value — its rendered Markdown for a text root, its validated JSON for a
value root (§5.4). `collect(execution)` unwraps that same value and throws on
`Err`. Once `execute` has returned a handle, completion never throws — every
later failure closes the output stream (with the complete or partial rendered
output) and resolves `Err`. A failure before a handle can be created may still
throw. Its `output` property is a replay-safe `Stream<string, string>` of the
rendered chunks emitted during execution (per-segment for streaming roots, one
chunk for buffered `<Output>` roots — §5.4); it carries body text for both
kinds of root, and for a value root it is observability rather than a second
return value. Late and repeated subscribers receive the full sequence, and the
stream closes with the full (or partial) output as its close value.

Execution runs in its own scope. Before the durable workflow starts,
`execute` installs the document's scope-local runtime providers —
the platform compiler, the Component providers for import, modifier
execution, and the root eval scope (§5.5), and the output→stream
bridge — so nothing leaks onto the caller's scope and the whole run
inherits them contextually.

`execute` is delivered through the `Execution` context Api. The default
provider runs the document; extensions decorate the execution lifecycle
with `Execution.around({ execute })` middleware — observing options,
wrapping the returned handle, or mapping its completion `Result` — without
introducing another execution function. Core itself has no knowledge of
any particular extension.

### 8.2 Usage from standalone code

```typescript
import { run } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";

await run(function* () {
  const execution = yield* execute({
    path: "./README.md",
    stream: new InMemoryStream(),
  });

  const result = yield* execution;
  if (result.ok) {
    console.log(result.value);
  } else {
    console.error(result.error.message);
  }
});
```

---

## 9. Document Output Api

### 9.1 Problem

The output pipeline has three UX issues:

1. **Fully buffered output.** `documentWorkflow` collects all expanded
   segments into a string and returns it. The CLI calls `console.log(output)`
   only after the entire workflow completes. The user sees nothing during
   long expansions — provider startup, sample calls, teardown. `--verbose`
   shows journal events on stderr, but rendered output is all-or-nothing.

2. **Whitespace accumulation.** The scanner preserves raw text with newlines.
   Component substitution adds more. `renderSegments` joins with empty string,
   producing doubled blank lines at component boundaries. `remend` does not
   fix this — it heals incomplete markdown constructs, not whitespace.

3. **No terminal formatting.** Output is raw markdown text. No ANSI colors,
   no heading emphasis, no syntax highlighting.

### 9.2 The Document Output Api

A single Effection Api named `DocumentOutput` with one operation: `output`. The Api
is the system's public surface — extensible to progress, printed errors, etc.
as needs grow.

```typescript
// src/api.ts

import type { Operation } from "effection";
import { createApi } from "./api.ts";

export interface DocumentOutputApi {
  output(text: string): Operation<void>;
}

export const DocumentOutput = createApi<DocumentOutputApi>("DocumentOutput", {
  *output(_text: string): Operation<void> {},
});

export const { output } = DocumentOutput.operations;
```

Core handler is a no-op. Behavior comes from two sources:

- **Middleware** installed via `scope.around(DocumentOutput, ...)` — intercepts and
  transforms text.
- **Channel delivery** — the terminal handler sends transformed text into
  a `createChannel`.

Call sites import `output` directly:

```typescript
import { output } from "./api.ts";

yield* ephemeral(output(text));
```

### 9.3 Architecture

Three concerns, three mechanisms:

| Concern | Mechanism | Where |
|---|---|---|
| **Transformation** | Middleware (`scope.around`) | `output/normalize.ts`, `output/terminal.ts` |
| **Delivery** | Channel (`createChannel`, internal to `execute`) | `execute.ts` |
| **Consumption** | Stream (`forEach` on `execution.output`) | Caller (`cli.ts`, tests) |

Middleware only intercepts and transforms. Buffering and streaming are not
middleware — they are natural consequences of using a channel with `forEach`.

**Middleware installation order.** `scope.around` installs follow
inner-to-outer order: the handler installed first becomes the innermost
(channel delivery), and handlers installed later wrap it. Execution flows
outer → inner: normalize → terminal format → channel send. This ordering
must be preserved — future edits must not reorder the installations.

### 9.4 Whitespace normalization middleware

**File:** `src/output/normalize.ts`

Stateful middleware that tracks trailing newlines across `output()` calls.
Collapses doubled blank lines at segment boundaries without needing the
full document.

```typescript
import type { Operation } from "effection";
import { useScope } from "effection";
import { DocumentOutput } from "../api.ts";

export function* useNormalizedOutput(): Operation<void> {
  let trailingNewlines = 0;
  const scope = yield* useScope();

  scope.around(DocumentOutput, {
    *output([text], next) {
      let normalized = text;

      // Strip trailing whitespace on each line
      normalized = normalized.replace(/[ \t]+\n/g, "\n");

      // Collapse leading newlines if previous write already ended
      // with enough to form a blank line
      if (trailingNewlines >= 2) {
        normalized = normalized.replace(/^\n+/, "\n");
      }

      // Collapse runs of 3+ newlines within a single write
      normalized = normalized.replace(/\n{3,}/g, "\n\n");

      // Track trailing newlines for next call
      const match = normalized.match(/\n+$/);
      trailingNewlines = match ? match[0].length : 0;

      yield* next(normalized);
    },
  });
}
```

Mutable closure state (`trailingNewlines`) is safe because the middleware
is scoped per `useNormalizedOutput()` call — one instance per document
run, not shared across concurrent scopes.

### 9.5 Terminal ANSI formatting middleware

**File:** `src/output/terminal.ts`

Converts markdown to ANSI-colored terminal text using `marked-terminal`.
Synchronous only — `async: false`, no promises.

```typescript
import type { Operation } from "effection";
import { useScope } from "effection";
import { Marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { DocumentOutput } from "../api.ts";

export function* useTerminalOutput(): Operation<void> {
  const marked = new Marked({ renderer: new TerminalRenderer() });
  const scope = yield* useScope();

  scope.around(DocumentOutput, {
    *output([text], next) {
      const formatted = marked.parse(text, { async: false }) as string;
      yield* next(formatted);
    },
  });
}
```

### 9.6 Host wiring

**File:** `packages/cli/src/cli.ts` (separate `cli` workspace package)

`cli.ts` makes no host-specific decision about **how this xmd is re-invoked,
how an eval block compiles, how a service process is hosted, or which runtime
it is on**. A runtime-named
entrypoint — `deno.ts`, `node.ts`, `bun.ts`, `compiled.ts` — installs its
`API.Env` providers with `{ at: "min" }` and passes the matching service
installer to `runXmd(args, installService)`:

```typescript
yield* API.Env.around(
  {
    *command([xmdArgs = []]) {
      return [process.execPath, "run", "--allow-all", ENTRYPOINT, ...xmdArgs];
    },

    *compile([source, options]) {
      return yield* compileDataUri(source, options);
    },
  },
  { at: "min" },
);
yield* runXmd(args, useDenoService);
```

The installer is invoked only for `xmd run` and `xmd test`, immediately before
`execute()`. Help, inspection and agent-worker paths never install or attach a
service. Each adapter supplies host randomness, inherited environment and
stdout/stderr writers to the shared service host; production adapters reject a
non-loopback requested host before spawning.

Each entrypoint owns its own argument order; there is no shared builder for
them to forward to. `cli.ts` still reaches the host directly for terminal and
journal I/O (`process.stdout`, `node:fs/promises`); routing those through
contextual APIs is separate work.

#### The xmd command (`API.Env.command`)

```typescript
command(args?: string[]): Operation<string[]>
```

Returns the **complete invocation** of the currently running xmd, with `args`
appended — something directly executable, not a prefix for the caller to
extend. `command()` with no arguments returns the base invocation.

Argument placement belongs to the adapter, because it differs per host:

| Entrypoint | `command(args)` | `compile` |
| --- | --- | --- |
| `deno.ts` | `[execPath, "run", "--allow-all", entry, ...args]` | `compileDataUri` |
| `node.ts` | `[execPath, ...execArgv-minus-inspect, entry, ...args]` | `compileTempFile` |
| `bun.ts` | `[execPath, entry, ...args]` | `compileDataUri` |
| `compiled.ts` | `[execPath, ...args]` | `compileDataUri` |

**There is no inferred default.** With no adapter installed the operation
fails with `xmd command not installed — a runtime-named entrypoint must
install it via API.Env.around()`. It cannot be derived: `process.execPath`
names the executable but not how it was launched — `deno run --allow-all
<entry>` is not recoverable from `deno` — and a compiled binary has no entry
script at all.

`entry` is absolute, taken from each entry module's own `import.meta.url`
rather than `process.argv[1]`. A relaunched worker is spawned with the
document's working directory, not the CLI's, so a relative path would not
resolve there.

**Resolution is lazy.** `command` is requested when `<TestAgent>` provisions a
provider — once per isolation boundary — and never when the components are
installed. A document that does not use `<TestAgent>` therefore runs to
completion even where no adapter has been installed at all.

The CLI installs output middleware (transforms only — no channel wiring
needed), calls `execute` to get a `DocumentExecution`, consumes
`execution.output` with `forEach` for streaming, and can `yield*`
the execution directly to get the full output or catch errors.

```typescript
// packages/cli/src/cli.ts
import { forEach } from "@effectionx/stream-helpers";
import { execute, useNormalizedOutput, useTerminalOutput } from "@executablemd/core";

function* run(/* ... config params ... */) {
  if (!raw) yield* useNormalizedOutput();
  if (process.stdout.isTTY && !raw) yield* useTerminalOutput();

  const execution = yield* execute({ path, stream, runtime, ... });

  const fullOutput = yield* forEach(function* (chunk: string) {
    if (process.stdout.isTTY) {
      process.stdout.write(chunk);
    }
  }, execution.output);

  if (!process.stdout.isTTY) {
    process.stdout.write(fullOutput);
  }
}
```

#### The value-root result on the command line

`xmd run` reserves stdout for the successful result of a value root (§5.4). The
CLI learns which mode the document is in from `inspectDocument().returnMode`,
which performs no document effects, and routes the channels accordingly:

- stdout carries only the final value, encoded as JSON and followed by a
  newline; a string result stays a quoted JSON string. It is written directly,
  bypassing markdown normalization and terminal formatting.
- rendered body output is observability: `--verbose` sends it, and the journal
  printed errors, to stderr; without `--verbose` it is discarded.
- every failure — structural, schema, value, body, or after `<Return>` — writes
  its printed error to stderr, exits non-zero, and writes nothing to stdout.

Text roots are unchanged: rendered Markdown goes to stdout and `--verbose` adds
printed errors on stderr. `xmd test` reports on stdout in both modes; the JSON
result contract belongs to `xmd run`.

### 9.7 Execution flows

**Interactive TTY:**

```
output(text)
  → normalize (middleware, caller-installed)
  → terminal format (middleware, caller-installed)
  → channel.send(text) (internal to execute)
  → execution.output stream (caller's forEach/collect)
```

User sees cleaned, colorized text streaming segment-by-segment.

**Piped (not TTY):**

```
output(text)
  → normalize (middleware, caller-installed)
  → channel.send(text) (internal to execute)
  → execution.output stream (caller's forEach/collect)
  → fullOutput written to stdout at end
```

User gets cleaned raw markdown dumped at end.

**`--raw` flag:**

```
output(text)
  → channel.send(text) (internal to execute, no transformation)
  → execution.output stream (caller's forEach/collect)
```

Unmodified text as emitted by the expansion engine.

### 9.8 Streaming behavior

Given a document:

```markdown
# Title

<LocalProvider command="./handshake-compatible-server">
  <AnalyzeTests />
</LocalProvider>

## Footer
```

1. `# Title\n\n` streams immediately.
2. The provider blocks for however long it takes. Nothing streams during
   this time.
3. Provider output streams when expansion completes.
4. `## Footer` streams after.

The user sees progress incrementally at root-segment granularity.

### 9.9 Recorded/ephemeral boundary

`output()` calls are wrapped in `ephemeral()` inside `documentWorkflow`:

```typescript
yield* ephemeral(output(text));
```

This bridges from the journaled `Workflow` context to plain `Operation`
context. Output emission is a derived side effect; journaling `output()` calls
would add redundant entries.

All middleware and side effects triggered by `output()` (normalization,
formatting, channel send) execute on the ephemeral side. No durable state
capture occurs in the output pipeline.

The entire workflow runs in a `spawn()` inside `execute`. The channel
and all execution state (runtime API middleware and eval scope,
DocumentOutput→channel bridge) share this spawned scope. The consumer
(`forEach`/`collect` on `execution.output`) runs in the **caller's**
scope. This cross-boundary communication is safe because scope teardown
of the spawned task cancels the producer and closes the channel, which
terminates the consumer's forEach loop. The `withResolvers` completion
signal also lives in the spawned scope — `resolve(Ok(...))` and
`resolve(Err(...))` are called from inside the spawn, and the resulting
operation is returned to the caller as part of the `DocumentExecution`
handle.

### 9.10 Known issues

#### `blockId` counter

`expandSegments` uses `result.length` as the `blockId` index. Calling
it once per root segment resets the counter, producing duplicate printed error
operation names. See §6.1 for the fix: a mutable counter threaded through the
expansion context.

#### Sub-segment streaming

If a single component takes 30 seconds, nothing streams during that
time. True sub-segment streaming requires `expandSegments` to emit
through the Api during recursive expansion with depth tracking (emit
only at root level). The architecture supports this — the emission
points just move deeper into the expansion engine.

#### Partial markdown formatting

Streaming `**bold` in one write and `text**` in another confuses the
per-write ANSI formatter. The normalize middleware could buffer until
a segment boundary (blank line) before formatting. This is a matter
of middleware granularity, not an architectural issue.

### 9.11 File layout

```
packages/core/src/
  api.ts                  Api definition, exports `output`
  collect.ts              Stream consumption helper (returns Result<string>)
  output/
    mod.ts                Barrel export
    normalize.ts          Whitespace normalization middleware
    terminal.ts           Terminal ANSI formatting middleware
  execute.ts         Document runner (owns channel, returns stream)

packages/cli/src/
  cli.ts                  CLI entrypoint with forEach stream consumption
  file-stream.ts          JSONL-backed DurableStream
```

### 9.12 Dependencies

One new external package: `marked-terminal` (and its peer `marked`).

Everything else uses existing infrastructure: `createApi`/`scope.around`
for the Api, `createChannel` from Effection, `forEach` from
`@effectionx/stream-helpers`.

---

## 10. Journal shape

### 10.1 Effect types for MDX execution

The execution boundary journals the following operation descriptions through
`@executablemd/durable-streams`. These are diagnostic journal-entry types, not a
public replay contract.

| Operation | Effect type | Effect name | Notes |
|-----------|------------|-------------|-------|
| Import component | `import_component` | `{ComponentName}` | path + content in result |
| Execute code block | `exec` | `exec:{command_preview}` | Command array in description, stdout/stderr/exitCode in result |
| Evaluate code block | `eval` | `eval:{blockId}` | language in description; serializable exports in result (§4.5) |
| Sample LLM call | `sample` | `sample:{command_preview}` | Only when `sample` modifier is used; Sample Api middleware determines behavior |
| Resolve components (glob) | `glob` | `resolve:{dir}` | Only when `useDurableGlobResolver` middleware is installed |

### 10.2 Example journal for a multi-component document

With the default directory resolver:

```
[0] yield  root  { type: "import_component", name: "__root__" }
    result: { status: "ok", value: { path: "./README.md", content: "---\ntitle: ..." } }

[1] yield  root  { type: "import_component", name: "Header" }
    result: { status: "ok", value: { path: "./components/Header.md", content: "---\n..." } }

[2] yield  root  { type: "import_component", name: "Footer" }
    result: { status: "ok", value: { path: "./components/Footer.md", content: "..." } }

[3] yield  root  { type: "exec", name: "exec:date +%Y", command: ["bash", "-c", "date +%Y"], timeout: 30000 }
    result: { status: "ok", value: { exitCode: 0, stdout: "2026\n", stderr: "" } }

[4] yield  root  { type: "eval", name: "eval:root:0", language: "js" }
    result: { status: "ok", value: { value: { port: 4321 } } }

[5] close  root  result: { status: "ok", value: "...rendered output..." }
```

### 10.3 Sequential coroutine IDs

In the basic sequential model, all effects run under the `root`
coroutine ID.

---

## 11. Rendering

### 11.1 Segment → output

With the Document Output Api (§9), segments are no longer batch-rendered
into a single string. Instead, `renderSegment` (singular) is called
per-segment in the emission loop (§5.4), and each rendered string
flows through the Output Api via `yield* ephemeral(output(text))`.

The batch function `renderSegments` remains available for contexts
that need a complete string (e.g., tests, non-streaming callers),
but the primary rendering pathway is per-segment emission.

After expansion, each segment is converted to a string:

```typescript
function renderSegments(segments: Segment[]): string {
  return segments.map(renderSegment).join("");
}

function renderSegment(segment: Segment): string {
  switch (segment.type) {
    case "text":
      return segment.content;

    case "execOutput":
      return segment.result.stdout;

    case "error":
      return `<!-- ERROR: ${segment.message} -->`;

    case "component":
      // Unexpanded component (shouldn't appear after expansion)
      return `<!-- UNEXPANDED: <${segment.name} /> -->`;

    case "codeBlock":
      // Shouldn't appear after expansion (all executable blocks are processed)
      return `\`\`\`${segment.language}\n${segment.content}\n\`\`\``;

    default:
      return "";
  }
}
```

### 11.2 Error rendering

Errors are rendered as HTML comments by default. This keeps the output
valid markdown while making errors visible. An error rendering strategy
is configurable at the host level (e.g., throw on error, render as
visible warning blocks, gather into a separate error report).

---

## 12. Test plan

### Tier A — Boundary scanner

| # | Test | Verify |
|---|------|--------|
| A1 | Self-closing component | `<Comp />` → ComponentElement, selfClosing: true |
| A2 | Block component with text children | `<Comp>text</Comp>` → children: [TextSegment] |
| A3 | Dotted component name | `<Ns.Sub />` → name: "Ns.Sub" |
| A4 | String attribute with `>` | `<Comp title="a > b" />` → props.title: "a > b" |
| A5 | Expression attribute with nested braces | `<Comp data={{ a: 1 }} />` → props.data: { a: 1 } |
| A6 | Template literal attribute | `` <Comp label={`${x}`} /> `` → scanner completes |
| A7 | Spread props | `<Comp {...props} />` → scanner completes (props merged) |
| A8 | Not a component | `a < B && c > d` → text, no component |
| A9 | Incomplete tag at end of input | `<MyComp` → buffered, not emitted |
| A10 | Code block with `exec` modifier | `` ```bash exec `` → ExecutableCodeBlock, modifiers: [{name: "exec"}] |
| A11 | Code block with `silent exec` | `` ```bash silent exec `` → ExecutableCodeBlock, modifiers: [{name: "silent"}, {name: "exec"}] |
| A12 | Code block without `exec` | `` ```bash `` → TextSegment (passthrough) |
| A13 | Code block with modifiers but no `exec` | `` ```bash silent `` → TextSegment (not executable) |
| A14 | Component inside fenced code block | `` ```jsx\n<Component />\n``` `` → TextSegment |
| A15 | Boolean prop | `<Comp verbose />` → props.verbose: true |
| A16 | Numeric expression prop | `<Comp count={42} />` → props.count: 42 |
| A17 | Modifier with params | `` ```bash timeout=30s exec `` → modifiers: [{name: "timeout", params: "30s"}, {name: "exec"}] |
| A14b | Component inside inline code span | `` Use `<Content />` for slot `` → single TextSegment |
| A14c | Component inside double-backtick span | `` Use ``<Content />`` for slot `` → single TextSegment |
| A14d | Component inside code span with other text | `` hello `see <Content />` world `` → single TextSegment |
| A14e | Exec code block inside component children | `<Section>` wrapping `` ```bash exec `` → children include ExecutableCodeBlock |
| A14f | Non-exec code block inside component children | `<Section>` wrapping `` ```yaml `` → children: TextSegment (passthrough) |
| A14g | Inline code span protects component syntax in children | `<Section>` with `` `<Content />` `` in children → no component parsed |

### Tier B — Component import and frontmatter

| # | Test | Verify |
|---|------|--------|
| B1 | `durableImportComponent` golden run | Single `import_component` entry with path + content |
| B2 | `durableImportComponent` replay | Stored result is returned without a file read |
| B3 | Runtime parsing | Current content parsed to meta/props/segments |
| B4 | Import with simple frontmatter | `meta` correctly parsed, keys except `props` and `required` |
| B5 | Import with typed meta | `meta` key with type definitions, defaults resolved |
| B6 | Import with props (schema passthrough) | A `props` carrying `type` or `$schema` is kept verbatim as the component's draft-07 JSON Schema |
| B7 | Import with props (property default) | A property's `default` fills the prop when a caller omits it |
| B8 | Import with props (required array) | `required: [name]` makes `name` a required prop |
| B9 | Import missing component | Resolve Api throws, error propagated |
| B12 | Root document as component | `__root__` import, same journal shape |
| B13 | Dotted name resolution | `Ns.Sub` → `components/Ns/Sub.md` |
| B14 | No props key | Component accepts no props; `props` is the closed empty-object schema |
| B16 | Import with a props map | `props` as a prop-name map normalizes to `{ type: object, properties, additionalProperties: false }` |
| B17 | Import with top-level `required` | `required` becomes the normalized schema's `required` and is not a meta value |
| B18 | Mixed map and full declarations | Top-level `required` beside a full schema is a configuration error; the lists are never merged |
| B15 | Default resolver middleware | Resolves via `runtime.stat` probe in search path order |
| B19 | Resolver middleware composition | Custom alias middleware + directory resolver |

### Tier C — Expansion and prop validation

| # | Test | Verify |
|---|------|--------|
| C1 | Basic expansion | `<Comp />` → body of Comp in output |
| C2 | Content slot | `<Wrap>hello</Wrap>` → hello at `<Content />` position |
| C3 | Nested expansion | `<A><B /></A>` → B expanded, then A with B's result |
| C4 | Transitive expansion | A body references B, B body references C |
| C5 | Direct cycle | `<A />` where A contains `<A />` → ErrorSegment |
| C6 | Mutual cycle | A→B→A → ErrorSegment |
| C7 | Depth limit | 65 levels deep → ErrorSegment |
| C8 | Frontmatter interpolation | `{meta.title}` → replaced with value |
| C9 | Props namespace interpolation | `{props.name}` → replaced with the validated invocation prop in text, eval, and executable block content |
| C10 | Missing interpolation key | `{meta.nonexistent}` → empty string |
| C11 | Nested key access | `{meta.config.db.host}` → deep value |
| C12 | No Content slot | Children silently discarded |
| C13 | Multiple Content slots | Each replaced with same children |
| C14 | **Undeclared prop rejected** | `<Comp foo="bar" />` where Comp's closed schema does not list `foo` → PropValidationError |
| C15 | **Required prop missing** | `<Comp />` where Comp lists `required: [name]` → PropValidationError |
| C16 | **Default applied** | `<Comp />` where `greeting` has `default: Hello` → `{props.greeting}` resolves to "Hello" |
| C17 | **Type mismatch rejected** | `<Comp count="abc" />` where `count` is `{ type: number }` → PropValidationError |
| C18 | **Enum validated** | `<Comp model="bad" />` where `model` has `enum: [a, b]` → PropValidationError |
| C19 | **Enum accepted** | `<Comp model="a" />` where `model` has `enum: [a, b]` → valid |
| C20 | **No declared props, none passed** | Component with no `props` (closed empty-object schema), invoked with no props → valid |
| C21 | **No declared props, some passed** | Component with no `props`, invoked with props → PropValidationError |
| C22 | **Optional with no default, not passed** | Prop not in validated props, `{props.key}` → empty string |
| C23 | Component `as` capture | `<Comp as="x" />` stores rendered output in `env.values.x`, invocation emits no segments |
| C24 | `<Capture>` inline capture | `<Capture as="x">text</Capture>` stores `"text"` in `env.values.x`, emits no segments |
| C24b | Capture over a failing block | A block that exits non-zero after printing leaves the binding unset in `<Capture as>` and in component `as=`; the errors are returned and what the block printed is not captured |
| C25 | `<Capture>` trailing-whitespace trim | Captured output `"hello\n"` stored as `"hello"` |
| C26 | Reserved prop `as` in props | Declaring `as` in component `props` fails frontmatter validation |
| C27 | Invalid capture names | `as=""`, `as="123bad"`, or `as={expr}` produce validation errors |
| C28 | `<Capture />` invalid | Self-closing Capture produces ErrorSegment |
| C29 | `<Capture select>` CSS extraction | `<Capture as="x" select="code[lang=json]">` with code fence child stores code block value only |
| C30 | `<Capture select>` fallback | `select="code[lang=json]"` with no matching node stores full rendered content |
| C31 | `<Capture select>` paragraph | `select="paragraph"` extracts paragraph text content |
| C32 | `<Output>` selects region | Only the `<Output>` region renders; documentation outside is suppressed |
| C33 | No `<Output>` | Whole body renders (backward compatible) |
| C34 | Documentation executes | eval/exec/`<Capture>` outside `<Output>` run; a later `<Output>` reads their bindings; documentation after a region still runs |
| C35 | Multiple `<Output>` regions | Concatenate in document order |
| C36 | Markdown preserved in `<Output>` | A `> [!WARNING]` admonition survives intact |
| C37 | Empty-tag parity | `<Output />` and `<Output></Output>` both contribute no content |
| C38 | `<Output>` props rejected | Props/expression props on `<Output>` produce an ErrorSegment |
| C39 | `<Content />` in `<Output>` | Caller content projects into a top-level `<Output>` region |
| C40 | `as=` captures selected output | A component invoked with `as=` captures only its `<Output>` regions; documentation is neither rendered nor captured |
| C41 | Structural placement | Nested/misplaced `<Output>` (including inside `<If condition={false}>` or a content-discarding component) produces one aggregate printed error and runs no body side effects |
| C42 | Caller-projected `<Output>` inert | Projecting `<Output>` through `<Content />` neither activates nor alters the callee's error mode |
| C43 | Documentation and region failures | A failure in documentation (direct, inside `<Capture>`, inside a nested component, or a transported error) throws; a modifier-handled failure continues; an error inside `<Output>` fails the run, and one under `<PrintErrors>` or in a body with no `<Output>` stays a comment |
| C44 | **Array element-type mismatch** | `files` is `{ type: array, items: { type: string } }`; passing `["a", 3]` → PropValidationError |
| C45 | **Object-shape rejected** | A nested object with `required: [symbol]` / `additionalProperties: false` rejects a missing `symbol` or an unknown key → PropValidationError |
| C46 | **Nested default filled** | A row omitting `line` (declared `{ type: number, default: 0 }`) resolves with `line` set to `0` |
| C47 | **Nested enum rejected** | A property with `enum: [a, b]` nested inside an object/array item rejects a value outside the set → PropValidationError |
| C48 | **No bare prop binding** | Declaring `name` makes `{props.name}` available but leaves `{name}` verbatim until authored code creates that binding |
| C49 | **Validated object identity** | The environment and function-component argument observe the exact defaulted object returned by validation |
| C50 | Nested `<Content />` | Caller content projects from a position inside another invocation, inside a structural construct, several levels deep, and inside an `<Output>` region; a nested named slot resolves and consumes its `slot` prop; wrapping a projection in `<Section slot="header">` reaches a nested invocation's named slot; two projections at different depths receive the same content; slot errors are still emitted once; an unclaimed `<Content />` passed through nested bodies stays the reserved-name failure |

### Tier D — Code execution and modifier middleware

| # | Test | Verify |
|---|------|--------|
| D1 | `bash exec` golden run | `execHandler` runs, stdout in output, journal has exec entry |
| D2 | Exec repeated run | Command executes again and current stdout is used |
| D3 | Non-zero exit code | ErrorSegment in output. The exit code alone decides — what the command printed does not enter into it |
| D3b | **Non-zero exit with stdout** | `execOutput` segment, then the ErrorSegment it explains; a throw under a documentation error mode, which stops the next sibling from running |
| D4 | Multi-line command | Full script passed to `-c` |
| D5 | `python exec` | `python -c` invocation |
| D6 | `bash silent exec` | Chain: silent wraps exec. Exec journals. Silent returns empty output and the inner outcome |
| D6b | **Failing `silent exec`** | Suppresses the stdout, preserves the exit code and stderr: the normal failure is reported. In documentation it aborts before the next block |
| D7 | `silent exec` repeated run | Command executes again and output remains empty |
| D7b | **Failing `silent exec` replay** | Replay reproduces the same failure from the journaled exec result rather than replaying success |
| D8 | `bash sample exec` golden run | Chain: sample wraps exec. Two journal entries (exec + sample) |
| D9 | `bash sample exec` repeated run | Command and LLM are called again |
| D10 | `bash silent sample exec` | All three handlers compose. Both journal entries written, output empty, the innermost outcome preserved |
| D11 | `sample` without Sample Api middleware | Clear error from core Api about missing middleware |
| D12 | `sample=brief` passes params to handler | SampleContext.params is "brief" |
| D13 | Sample Api middleware routes by component | Different model used for different componentName |
| D14 | Sample Api `passthrough` param | `sample=passthrough` returns raw stdout without LLM call |
| D15 | Unknown modifier in chain | Error: "Unknown modifier: foo" |
| D16 | No terminal modifier | Error: "No terminal modifier (exec/eval) in chain" |
| D17 | Custom modifier registration | `useModifier("custom", handler)` — handler runs in chain |
| D18 | Modifier override in child scope | Parent registers `sample`, child overrides with different handler |
| D19 | Modifier parsing: `timeout=30s` | Modifier has name "timeout", params "30s" |
| D20 | Info string with language only | Not executable, treated as passive text |

### Tier E — End-to-end

| # | Test | Verify |
|---|------|--------|
| E1 | Full document golden run | Root + components + exec, correct output |
| E2 | Full repeated run (no changes) | File reads and exec calls run again, same output |
| E3 | Existing journal path | CLI refuses the run and leaves the trace unchanged |
| E4 | Component file changed | Next run reads and executes the changed component |
| E5 | New component added | Next run resolves and executes the new component |
| E6 | Validated props flow through expansion | Declared props visible in component via `{props.key}`, defaults applied |
| E7 | Undeclared prop in full document | PropValidationError with component name and prop name |
| E8 | `silent exec` in full document | Command runs, result journaled, output omitted, outcome preserved |
| E9 | `sample exec` in full document | Command + LLM both journaled, LLM response in output |
| E10 | Unclosed bold across component boundary | `**text\n<Comp />\nmore` → healed bold in first segment, component expanded, `more` unaffected |
| E11 | `<Output>` component vs. root consistency | An imported component and a root document apply `<Output>` identically; documentation is suppressed in both |
| E12 | Root `<Output>` buffering | A root with `<Output>` emits once; a later documentation failure still emits what the regions selected before it; an empty selection emits no event; replay reproduces the result |
| E13 | `<If>` inside `<Output>` (smoke) | `smoke-test/OutputDemo.md` renders the conditionally-selected region (its `condition` binding computed by preceding documentation eval) while its documentation prose does not appear |

### Tier F — Markdown healing (remend)

**Healing at component boundaries:**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F1 | Unclosed bold before component | `Hello **world\n<Comp />` | Text segment healed to `Hello **world**` |
| F2 | Unclosed italic before component | `Hello *world\n<Comp />` | Text segment healed to `Hello *world*` |
| F3 | Unclosed strikethrough | `Hello ~~world\n<Comp />` | Text segment healed to `Hello ~~world~~` |
| F4 | Unclosed inline code | ``Hello `code\n<Comp />`` | Text segment healed to ``Hello `code` `` |
| F5 | Unclosed link text | `Hello [text\n<Comp />` | Text segment healed to `Hello [text]` |
| F6 | Unclosed link | `Hello [text](url\n<Comp />` | Text segment healed to `Hello [text](url)` |
| F7 | Unclosed image | `Hello ![alt](url\n<Comp />` | Text segment healed to `Hello ![alt](url)` |
| F8 | Unclosed code fence | ```` ```js\ncode\n<Comp /> ```` | Scanner: code fence suppresses JSX — component is inside fence, not a boundary |

**Healing at exec block boundaries:**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F9 | Unclosed bold before exec | `Hello **world\n` `` ```bash exec `` | Text segment healed to `Hello **world**` |
| F10 | Unclosed code span before exec | ``Hello `code\n`` `` ```bash exec `` | Text segment healed to ``Hello `code` `` |

**`htmlTags: false` — angle brackets in text:**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F11 | Less-than in text | `a < b\n<Comp />` | Text segment unchanged: `a < b` — no HTML healing |
| F12 | Greater-than in text | `a > b\n<Comp />` | Text segment unchanged: `a > b` |
| F13 | Lowercase HTML tag in text | `<div>content\n<Comp />` | Text segment unchanged — `htmlTags: false` prevents closing |
| F14 | Angle brackets inside code span | `` `a < b` `` before `<Comp />` | Already complete — no healing needed |

**Orphaned closing markers (treated as openers):**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F15 | Orphaned bold closer | Text segment starts with `world** more` | Healed to `world** more**` — remend reads the trailing `**` as an opener and appends a closer |
| F16 | Orphaned italic closer | Text segment starts with `text* more` | Healed to `text* more*` |

**Nested and multiple unclosed constructs:**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F17 | Nested bold inside italic | `*hello **world\n<Comp />` | Both healed: `*hello **world***` (or equivalent valid nesting) |
| F18 | Multiple unclosed at same boundary | ``**bold `code *italic\n<Comp />`` | All three healed independently |

**No-op cases (healing is identity):**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F19 | Complete markdown | `Hello **world** more text` | Unchanged |
| F20 | Empty text segment | `` | Unchanged (empty string) |
| F21 | Text with no markdown constructs | `Hello world` | Unchanged |
| F22 | Already escaped markers | `Hello \*world\n<Comp />` | Unchanged — `\*` is not an opener |

**Interaction with interpolation:**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F23 | Unclosed bold containing interpolation | `**{meta.title}\n<Comp />` | Bold healed first, then `{meta.title}` interpolated inside healed bold |
| F24 | Interpolation result with markers | `{meta.title}` resolves to `**bold**` | NOT double-healed — markers from interpolation are post-healing |

**Interaction with Content slot:**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F25 | Children with unclosed bold | `<Wrap>**hello</Wrap>` | Children healed to `**hello**` before substitution into Wrap's body |
| F26 | Component body segment healed independently | Wrap body has `*intro\n<Content />` | Body's text segment healed to `*intro*`, children substituted separately |

**Math blocks (if supported by remend):**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F27 | Unclosed inline math | `$formula\n<Comp />` | Healed to `$formula$` |
| F28 | Unclosed display math | `$$formula\n<Comp />` | Healed to `$$formula$$` |

### Tier G — Source transform (`eval-transform`)

| # | Test | Verify |
|---|------|--------|
| G1 | `const x = 1` exports | Transformed code appends `env.x = x;` |
| G2 | `let x = 1` exports | Transformed code appends `env.x = x;` |
| G3 | `function f() {}` exports | Transformed code appends `env.f = f;` |
| G4 | `class C {}` exports | Transformed code appends `env.C = C;` |
| G5 | Destructured `const { a, b } = expr` | Both `env.a = a; env.b = b;` appended |
| G6 | Nested declarations not exported | `if (true) { const x = 1 }` — no env write for `x` |
| G7 | Imports from env | Block referencing `port` when env has `port` → preamble: `const { port } = env;` |
| G8 | Only used free variables imported | Block has `port` in env but doesn't reference it → no preamble |
| G9 | Mode detection: `yield` | Top-level `yield*` → mode `"generator"` |
| G10 | Mode detection: `await` | Top-level `await` → mode `"async"` |
| G11 | Mode detection: neither | Plain statements → mode `"sync"` |
| G12 | Mode detection: both yield and await | Top-level yield + await → transform error |
| G13 | Nested yield not counted | `function* inner() { yield 1 }` → mode `"sync"` |
| G14 | Source map generated | `TransformResult.map` is valid V3 source map JSON |
| G15 | `sourceURL` comment appended | Transformed code ends with `//# sourceURL=eval:blockId` |
| G16 | Empty block | Empty source → valid transform with no exports/imports |

### Tier H — Module compilation (`eval-context`)

| # | Test | Verify |
|---|------|--------|
| H1 | Missing-provider printed errors | `importComponent`, `applyModifiers`, `codeBlock`, and `content` report clear missing-provider errors when no provider is installed |
| H2 | Effection globals available | `sleep`, `spawn`, `createChannel` accessible in compiled block via standard imports |
| H3 | executable.md globals available | `Sample` and `when` accessible in compiled block via `@executablemd/core` |
| H5 | `compileBlock` returns generator function | `yield* compileBlock(code, [])` returns a callable generator function |
| H6 | Distinct modules per block | Each `compileBlock` call produces a separate module — no shared state between blocks |
| H7 | `data:` URI encoding | Module source with special characters is correctly URI-encoded |
| H8 | User imports hoisted | User `import` declarations from eval block source appear in generated module |

### Tier CB — Compiler boundary (`compiler-boundary`)

| # | Test | Verify |
|---|------|--------|
| CB1 | No eval blocks, no compiler | A document with no eval blocks executes with no `compile` middleware installed |
| CB2 | Eval block, no compiler | An eval block with no middleware installed fails with `compiler not installed — install platform-specific middleware via API.Env.around()` |
| CB3 | Caller's compiler wins | A compiler installed before `execute()` receives the block source; `execute()` neither replaces nor shadows it |

### Tier TC — Temp-file compiler lifecycle (`temp-file-compiler`)

| # | Test | Verify |
|---|------|--------|
| TC1 | Success removes the generated file | The write and the removal observed through `FsApi.around()` name the same `.xmd-eval/<uuid>.ts`, and the removal has completed when `compileTempFile()` returns the block |
| TC2 | A failing import removes it first | Generated code that does not parse still propagates its import failure, and the removal has completed when that failure reaches the caller |
| TC3 | Cancellation removes it first | A compilation halted while its write is suspended has no generated file left once `halt()` settles |
| TC4 | A failing removal is not discarded | A removal that performs the real deletion and then fails leaves that exact error as the compilation's outcome, rather than a returned block or a substituted error |

### Tier I — Middleware conformance (eval modifiers)

| # | Test | Verify |
|---|------|--------|
| I1 | `eval` is terminal | `evalFactory` ignores `next` — never calls it |
| I2 | `eval` returns empty output | `result.output === ""`, `exitCode === 0` |
| I3 | `persist eval` composes | `persist` makes `persistent` answer true, `eval` reads it |
| I4 | `timeout=5s eval` composes | Timeout cancels after 5s if block hangs |
| I5 | `timeout eval` default | Default timeout is 30s |
| I6 | `persist timeout=10s eval` | Three modifiers compose: persist → timeout → eval |
| I7 | `silent eval` | Silent wraps eval — both run, output empty |

### Tier J — Eval journal-entry integration

| # | Test | Verify |
|---|------|--------|
| J1 | `js eval` golden run | Block executes in-process, journal has eval entry |
| J2 | `js eval` repeated run | Block executes again against current inputs |
| J3 | Cross-block bindings | Block 1 exports `port`, block 2 reads `port` from env |
| J4 | Non-serializable binding omitted from journal | Function in env → present in live env, absent from journal |
| J5 | Eval produces no rendered output | Document output excludes eval block content |
| J6 | Generator mode eval | Block with `yield* sleep(100)` executes as generator |
| J7 | Sync mode eval | Block with `const x = 1` executes without yield/await |

### Tier K — Binding environment

| # | Test | Verify |
|---|------|--------|
| K1 | Fresh env per Markdown component | Each root or Markdown component expansion gets its own `EvalEnv` with one `props` namespace; function components receive their argument directly |
| K2 | Env shared across blocks in same component | Block 1 and block 2 in same component share `env.values` |
| K3 | `serializeExports` filters non-JSON | Functions, symbols, circular refs excluded |
| K4 | `serializeExports` preserves JSON values | Numbers, strings, objects, arrays round-trip correctly |
| K5 | Eval merges serializable bindings | After the block, `env.values` contains current exports alongside `props`, without spreading prop fields |
| K6 | Component `as` writes to invocation env | Binding is visible to downstream siblings at call site |
| K7 | `<Capture>` is not a component boundary | Eval/exec inside `<Capture>` use parent env/scope and journal normally |

### Tier L — Persist modifier

| # | Test | Verify |
|---|------|--------|
| L1 | `persist eval` retains spawned resource | Resource spawned in block survives block completion |
| L2 | Non-persist eval tears down resource | Resource spawned in block torn down at block end |
| L3 | Persist resource lifetime matches component | Resource is observably gone once the invocation completes, while the document still runs |
| L4 | Persistent flag scoped to chain | `persistent` is `true` only during the persist-wrapped chain |
| L5 | Multiple persist blocks in one component | Each retains its own resources independently |
| L6 | Persist on repeated run | Resource is created and retained again for the current component lifetime |
| L7 | Persist flag does not leak to sibling blocks | Non-persist block after persist block → flag is false |
| L8 | Projected persist stops before the component's own | A projected `persist` resource stops ahead of one the component retained *after* projecting: `start:projected, start:own, stop:projected, stop:own` |

### Tier M — Timeout modifier

| # | Test | Verify |
|---|------|--------|
| M1 | Block completes within timeout | Result returned normally |
| M2 | Block exceeds timeout | Error thrown: "eval block timed out after 5s" |
| M3 | `parseDuration` handles `ms` | `"500ms"` → 500 |
| M4 | `parseDuration` handles `s` | `"30s"` → 30000 |
| M5 | `parseDuration` handles `m` | `"2m"` → 120000 |
| M6 | Default timeout is 30s | `timeoutFactory(undefined)` → 30000ms |

### Tier O — Eval scope hierarchy

| # | Test | Verify |
|---|------|--------|
| O1 | Eval scope created before durableRun | `resource(useEvalScope())` runs in outer scope, not inside durable execution |
| O2 | Eval scope destroyed on document completion | All retained resources cleaned up when expansion finishes |
| O3 | Invocation scope destroyed with the invocation | A resource retained by a component stops when it completes, while the document keeps running |
| O4 | Component resource live during projection | A resource a TypeScript component acquires directly is running while its projected content executes |
| O5 | Projected content stops first | `start:own, start:projected, stop:projected, stop:own` — no `ephemeral()`, `scoped()` or wrapper in the component |
| O6 | Ordering is the boundary's | Same order when the resource is acquired after the first projection: `start:projected, start:own, stop:projected, stop:own` |
| O7 | Markdown `<Content />` lifetime | A provider retaining a resource *after* projecting still releases it after the projected content stops |
| O41 | Nested `<Content />` lifetime | A projection written inside another invocation still runs in the projecting invocation's content scope: it outlives the wrapper and stops before the provider's own resource |
| O11/O12 | Propagated body error | Both component forms stop projected content before releasing their own |
| O13/O14 | Cancellation | Both forms tear down in the same order when halted mid-projection |
| O15 | TypeScript nesting | Nested invocations leaf-first; siblings isolated |
| O25 | Exports commit to shared bindings | A later block reads a declared export, including a live object the journal cannot carry |
| O26 | Snapshot isolation | A later evaluation rebinding a name does not reach the closure persistent work captured |
| O28 | `<Content />` in documentation | A projected error stops the body instead of being printed and discarded with the region |
| O29 | `<Content />` inside `<Output>` | The same error renders once and the region still emits |
| O30 | Value-component documentation | A projected error fails fast rather than being discarded |
| O27 | Explicit import | An explicitly imported `useContent` compiles without a duplicate injected declaration |
| O9 | Content teardown failure | Stages 2 and 3 still run, in order, and the failure is reported |
| O10 | Body teardown failure | Reported after every stage has run |
| O18 | Nested and sibling invocations | Nested invocations tear down leaf-first; siblings never interleave |
| O19 | No ambient eval scope required | A component expands, and projects content, with no `evalScope` provider installed |
| O21 | Boundary owns its scope | Invocation resources are gone the moment expansion returns, inside a longer-lived parent scope |
| O23 | Persistent projection in documentation | A `persist eval` block's projection settles under the throwing error mode of the block's own position, not the invocation's baseline |
| O24 | Persistent projection inside `<Output>` | The same block inside a region prints instead, and the projected error renders |
| O31 | Captured markdown projection | The same block under `as=` refuses the binding: the interpolation stays literal and the recorded error returns to the caller once |
| O32 | Caught projection error | A caught `DocumentationError` is explicit recovery: nothing is recorded, the component completes, and the capture succeeds |
| O33 | Recovery leaks nothing | Work the projected content started is torn down with its scope; catching the error lets none of it escape the invocation |
| O34 | Body failure, clean teardown | The body's failure is rethrown by identity and every stage still runs |
| O35 | Lone teardown failure | Each stage alone — content, body and eval — yields the single teardown error carrying the planted failure by identity, and every stage still runs |
| O36 | Both domains fail | One aggregate: the body failure first, then one teardown error with every stage failure in stage order, all by identity |
| O37 | Documentation failure survives teardown | A `DocumentationError` body failure stays discoverable through the aggregate |
| O38 | Durability failure survives teardown | A durability body failure plus a teardown failure is still fatal |
| O39 | Durability outranks documentation across domains | A durability teardown failure wins over a documentation body failure |
| O40 | Stages always run | Every teardown stage runs after a body failure, even when stages themselves fail |
| O22 | Durability composes | A component combining a durable effect with a directly acquired resource: across a partial replay the effect's executor runs once, output is identical, and the resource is re-established per execution |

### Tier CW — Contextual working directory

| # | Test | Verify |
|---|------|--------|
| CW1 | Inside a rebinding component | An `exec` block reports the contextual directory, from the shell rather than from the engine |
| CW2 | After the boundary | A later `exec` block reports the process's own directory again |
| CW3 | Daemon inheritance and teardown | A daemon records its own `pwd` as the contextual directory, and its pid is gone once the execution ends |
| CW5 | No override | With nothing rebinding `Env.cwd`, both `exec` and `daemon` run in the process's directory |

### Tier TD — `<TempDir>`

| # | Test | Verify |
|---|------|--------|
| TD1 | Core-default resolution | The name resolves with no component directory and no file on disk, and the journal records the registered selection |
| TD2 | Contextual working directory | An `exec` block inside reports the temporary directory, canonical on both sides |
| TD3 | Restoration | A block after the element reports the previous working directory |
| TD4 | Isolation | Nested and sibling instances are distinct, and the inner one restores the outer's |
| TD5 | Cleanup on success | The directory is gone once the content finishes |
| TD6 | Cleanup on failure | A failing block inside still leaves no directory behind |
| TD7 | Cleanup on cancellation | Halting mid-expansion removes it |
| TD8 | Daemon inheritance and ordering | A daemon runs in the directory and is stopped before the directory is removed |
| TD9 | Bare form renders its path | `<TempDir />` renders the canonical path and nothing else |
| TD10 | Captured form | `<TempDir as>` renders nothing at the site and the directory is still live for a later sibling |
| TD11 | Retention ends | A captured directory is gone once the execution that owned it finishes |
| TD12 | Prop validation | An undeclared prop is rejected by ordinary validation |
| TD13 | Partial replay ends the execution | An effect recorded under an earlier directory raises `StaleInputError`, the execution completes `Err` under a printing error mode, and the block after `</TempDir>` never runs |
| TD14 | Ordinary failures are unchanged | A failing block inside a `<TempDir>` still renders a printed error and the following sibling still runs |
| TD15 | Cancelled acquisition | Cancelling while the directory is live, and before the acquiring task runs, both leave nothing behind |
| TD16 | Replayed component import | A nested component's journaled import is the other effect a `<TempDir>` can consume; it fails the execution the same way |
| TD18 | Provider-backed acquisition | Creation, the canonical path, and removal are one provider acquisition; with no provider installed the component fails the execution before rendering anything |
| TD19 | A refused operation | A provider that denies `temporary-directory` fails the execution with the fixed diagnostic, renders no content, and lets no later sibling run |
| TD17 | Colocated document | `xmd test packages/core/src/components/TempDir.test.md` narrates the lifetime — ordinary cwd, live directory inside, removed and restored after, a captured directory live for a sibling, and the bare form's path — with no search path and no JavaScript |

### Tier PC — `<Parse>` and `<SafeParse>`

| # | Test | Verify |
|---|------|--------|
| PC1 | Required schema | Omitting `schema` fails prop validation naming the component |
| PC2 | Required capture name | A value component invoked without `as` fails before its body runs |
| PC3 | Invalid schema text | Schema text that is not JSON fails, naming the syntax error |
| PC4 | Invalid schema | A schema Ajv rejects fails at compilation |
| PC5 | Asynchronous schema | `$async: true` is rejected |
| PC6 | Non-object schema | A boolean or scalar `schema` is rejected |
| PC7 | Ordering | With an unusable schema, an `exec` child of `<Parse>` never runs |
| PC8 | Ordering under SafeParse | The same holds for `<SafeParse>` — an unusable schema is not a safe failure |
| PC9 | Child failures propagate | A failing child of `<SafeParse>` fails the document; no result is bound |
| PC10 | Failure printed errors | A `<Parse>` schema failure names the component and carries its normalized issues |
| PC11 | Malformed JSON | Content that is not JSON fails `<Parse>` as a parse failure |
| PC12 | No rendered output | Neither component contributes to the rendering |
| PC13 | External reference | An external `$ref` fails with a printed error naming the #192 limit |
| PC14 | Capture and replay | A replay reproduces the bound value and appends no journal entry |
| PC15 | Colocated documents | `xmd test packages/core/src/components` runs `Parse.test.md` and `SafeParse.test.md` beside `TempDir.test.md`, with no search path and no JavaScript: both schema forms, every JSON result kind, a local `$ref`, both `<SafeParse>` variants, the preserved input, and the three non-transformation guarantees |

### Tier FL — `<File>`

| # | Test | Verify |
|---|------|--------|
| FL1 | Relative round trip | A relative write is readable at the same relative path, against the contextual `Env.cwd` |
| FL2 | Write renders nothing | The write form contributes no output and no path |
| FL3 | Parent directories | A write creates the directories its path names |
| FL4 | Replacement | A second write replaces the content, and rewriting the same content changes nothing |
| FL5 | Missing file | Reading a missing path is a printed error, and the sibling after it still runs |
| FL6 | Directory target | Reading a directory fails naming what it is |
| FL7 | Absolute path | Rejected before the filesystem is touched; neither the target's content nor the supplied path appears in the printed error |
| FL8 | Lexical escape | `..` out of the working directory is rejected, the content it aimed at never appears, and no absolute path reaches the printed error |
| FL9 | Internal symlink | Followed for both reads and writes; the write updates the linked file and leaves the link a link |
| FL10 | Escaping file symlink | Rejected, the outside content never appears, and the destination it pointed at is not named |
| FL11 | Escaping parent symlink | Rejected for a file that does not exist yet, nothing is created outside, and no absolute path is named |
| FL12 | Failing child | The invocation fails instead of writing, carries the block's own failure, and the existing file is unchanged |
| FL13 | Failed replacement | A directory that refuses new files stops the write with the previous content in place |
| FL14 | No temporary left behind | A successful write leaves only the target |
| FL15 | Completed-root replay | A journal with the root's close restores the result without running `<File>`: the file it read is removed first and the output is unchanged |
| FL15b | Partial replay, read | Expansion reaches `<File>`, which re-reads — the file's content is changed between runs and the second output follows it |
| FL15c | Partial replay, write | Expansion reaches `<File>`, which re-writes — the target is removed between runs and is recreated |
| FL16 | Prop validation | A missing `path` and an undeclared prop are both rejected |
| FL17 | Leading dots | `..notes.md` and `..config/settings.json` are ordinary files, not escapes |
| FL18 | Destination resolved after children | A child that replaces the parent directory with an escaping symlink is caught, and nothing is created outside |
| FL18b | Absolute path decided before children | A content-form absolute path is refused with the child's marker never written, the child's own failure absent from the output, and the rejected path unnamed |
| FL18c | Lexical escape decided before children | The same for `..`, with nothing created outside |
| FL19 | Failure inside the temporary write | The temporary is removed, the existing target is unchanged, and the outcome says so |
| FL20 | Cancellation before the commit | The same, when the run is halted rather than failed |
| FL21 | Rename throws before `next` | The previous content stands, and the printed error reports the outcome as unknown rather than claiming it |
| FL21b | Rename throws after `next` | The replacement is committed, and the same printed error is still factually correct — the error twin of FL22 |
| FL22 | Cancellation after the commit | A completed replacement is not rolled back |
| FL23 | Platform errors carry no path | `realpath`, `stat`, `readTextFile`, `ensureDir`, `writeTextFile`, and `rename` each throw an error whose message names an absolute path; the document receives an allowlisted phrase and no path |
| FL23b | Cleanup failure is reported | A failing `remove` is reported against the document's own path, says the file was written, appends the leftover sentence, and names no temporary |
| FL23c | Cleanup composes with the write failure | A failing `rename` and a failing `remove` are both reported, followed by the unknown-outcome sentence and the leftover sentence, and the temporary is observably left behind |
| FL24 | Regular file as a path component | `parent/child.txt` with `parent` a file fails for both forms without naming the resolved path |
| FL25 | The working directory itself | `.` and a path normalizing to it are contained, and fail as a directory rather than as an escape |
| FL26 | Adversarial error shapes | A `code` holding an absolute path, markup and a newline, an inherited key (`toString`), a planted path in both message and code, and an externally thrown `FileAccessError` all produce the generic phrase; nothing planted reaches the document and the printed error stays one line |
| FL28 | The check authorizes nothing | A provider whose `checkFilePath` refuses expands no children and receives no second call; the sibling after the component still runs |
| FL29 | The write repeats admission | The semantic write is one call that re-admits the authored path and owns resolution, target, parents, and the commit — proven by FL18's child swapping the parent between the two |
| FL30 | Every write phase | Admission, resolution, target, parents, temporary, commit, cleanup, and a rolled-back transaction each produce their own outcome sentence, and no other combination is constructable |
| FL31 | Provider absence | With no provider installed the write fails the execution before its children, writes nothing, renders nothing, reaches no low-level `API.Fs` call, and stops the sibling after it |
| FL32 | Malformed provider data | A write failure or success whose data does not validate is a provider-contract failure that ends the execution; a malformed non-write failure is the generic printed error and the document carries on |
| FL33 | A handler that throws | An arbitrary throw becomes a fixed `protocol` invariant with no cause, message, errno text, or host value; an existing durability or Files failure beneath it is rethrown by identity instead |
| FL27 | Colocated document | `xmd test packages/core/src/components/File.test.md` covers both forms, `as` capture, nested parents, replacement, exact content for both authoring shapes, a leading-dots name, and isolation between temporary directories — with no search path and no JavaScript |

### Tier FA — Fatal error discovery

| # | Test | Verify |
|---|------|--------|
| FA1–FA4 | Cyclic cause graphs | A self-referential cause, a two-error cycle, and cyclic aggregate and teardown graphs all terminate instead of recursing |
| FA5 | Discovery through a wrapper | A fatal error is found inside a teardown aggregate, an `AggregateError`, and an ordinary `cause` |
| FA6 | Both at once | A fatal error is still found when the wrapper holding it is itself cyclic |
| FA7 | Documentation failures | A `DocumentationError` is discovered the same way |
| FA8 | Ordinary errors are unaffected | A cyclic ordinary error is printed and the next block still runs |
| FA9 | Every durability failure | `StaleInputError`, `DivergenceError`, `TerminalDivergenceError`, `EarlyReturnDivergenceError`, `ContinuePastCloseDivergenceError`, and `DurablePersistenceError` are each discovered as fatal, bare and wrapped |
| FA10 | Precedence, either order | Each durability failure outranks a `DocumentationError` in an `AggregateError`, whichever comes first |
| FA11 | Precedence through a teardown | The same holds for an `InvocationTeardownError`'s stage failures |
| FA12 | Precedence at any depth | Nesting either one deeper than the other does not change the answer |
| FA13 | No durability failure | A `DocumentationError` is reported when the graph holds none, and `durabilityFailure` finds nothing |
| FA14 | Precedence with a cycle | A mixed graph that is also cyclic still reports the durability failure |
| FA15 | A content failure hides nothing fatal | A durability failure beneath a `ContentError` — set by a subclass and by assignment — is found by both `durabilityFailure` and `fatalCause`, for every kind |
| FA16 | Wherever the content failure sits | The same holds beneath an ordinary cause, inside an `AggregateError`, inside an `InvocationTeardownError`, and through all three at once |
| FA17 | No resurrection | A `DocumentationError` a component recovered from is not reported as the outward failure, while the same one reached without crossing a content failure still is |
| FA18 | Precedence behind a content failure | A durability failure beneath a recovered content failure outranks a documentation failure, in either wrapper order |
| FA19 | Cycles through a content failure | A self-caused content failure and one whose cause points back at the wrapper holding it both terminate, and the durability failure is still found |
| FA20 | Every Files infrastructure failure | Provider-unavailable, operation-denied, and each invariant category is discovered as fatal, bare and wrapped, and none is a durability failure |
| FA21 | Discovery through every wrapper | A Files failure is found inside a teardown aggregate, an `AggregateError`, an ordinary `cause`, and all three at once |
| FA22 | Files outranks documentation | In either aggregate order and either teardown order, for every kind |
| FA23 | Durability outranks Files | In either order, for every durability kind |
| FA24 | All three at once | Every ordering of a durability, a Files, and a documentation failure reports the durability one; a graph with the last two reports the Files one; nesting changes neither |
| FA25 | A content failure hides no Files failure | Found beneath a `ContentError` set by subclass and by assignment, and preferred over a documentation failure the boundary would otherwise stop at |
| FA26 | Cycles carrying a Files failure | A cyclic teardown graph and a self-caused content failure both terminate and still find it |
| FA27 | A separately loaded runtime copy | A failure with no shared class identity is recognized by its structural tag; an object carrying a different tag is not |
| FA28 | Decided by output | Only an output-mode `DocumentationError` is; a `throw` decision, every durability kind, and every Files kind are not |

### Tier HF — The host Files provider

Driven directly rather than through a document: what these assert is the
contract a component cannot see. Every row runs on all five release targets
(`filesystem-contract` in CI), because path arithmetic and `realpath` are the
platform's.

| # | Test | Verify |
|---|------|--------|
| HF1 | The check touches nothing | Empty, absolute, and lexically escaping paths are each refused with their own reason and no filesystem call at all; an admissible one answers `Ok(undefined)` |
| HF2 | The round trip | A write commits, reports `host-committed`, reads back, and leaves no temporary beside the file |
| HF3 | The search's shape | Sorted, deduplicated, POSIX-relative regular files; a symbolic link is not a result |
| HF4 | Platform failures are Results | `realpath`, `stat`, and the read each fail with the right phase and reason, and neither the message, the code, nor the workspace path survives |
| HF5 | Every write phase | Each of the eight phases produces data whose target claim matches it, and nothing planted survives |
| HF6 | Escapes | A link out is refused at resolution for both forms, the destination is not named, and the outside file is unchanged |
| HF7 | Internal links | Followed to the file they name; the link stays a link |
| HF8 | Dangling links | Replaced rather than followed, and nothing is created where the link pointed |
| HF9 | The observer contract | The private phases are announced in order, once each, for write, read, and search |
| HF10, HF10b | Where the guarantee stops | A parent replaced synchronously between resolution and use is written through, and a target replaced between resolution and access is read through — the documented weakness, with atomicity still holding |
| HF11 | The commit is one event | A fault before and after `next()` report the same unknown outcome, and one of the two runs really did commit |
| HF12 | Cancellation | No Result is produced and no temporary is left |
| HF12b | Cleanup failing as cancellation unwinds | There is no outcome to report it beside, so a fixed teardown invariant leaves the scope instead of a manufactured Result, carrying neither the platform's error nor the generated temporary's name |
| HF13 | Temporary directories | Live and die with the acquiring scope; a halt before acquisition leaves nothing |
| HF14 | Absence | Every operation throws provider-unavailable with the fixed diagnostic and no cause, and no low-level call is made |
| HF15 | Installation | `useHostFiles()` installs beneath ordinary middleware, which can still wrap it |
| HF16 | Directory links on every platform | A junction on Windows and a directory symlink elsewhere are refused on the same terms |
| HF17 | The compiled artifact | `scripts/files-contract-probe.ts`, compiled and run on each of the five targets, asserts the contract's observable claims and prints every one it checked |

### Tier FF — Files infrastructure failure

| # | Test | Verify |
|---|------|--------|
| FF1 | Absence before children | A write with no provider fails the execution, expands no children, renders nothing, reaches no `API.Fs` call, and stops the following sibling |
| FF2 | Every other form | Read, `<Glob>`, and `<TempDir>` each stop at their first provider call, and nothing after them expands |
| FF3 | A refused operation | Denial is fatal, carries its own fixed diagnostic, and renders no content |
| FF4 | The check authorizes nothing | A refused check makes exactly one provider call; the children never run and the document carries on |
| FF5 | Malformed write data | A phase and target that contradict each other, a reason outside the vocabulary, and an undescribable success are all fatal `protocol` invariants, and the category is not interpolated |
| FF6 | Malformed non-write data | Becomes the generic printed error, leaks nothing, and the document carries on |
| FF7 | An arbitrary throw | Replaced by a fixed invariant with no cause and no host value |
| FF8 | Identity is preserved | A nested durability failure and a nested Files failure are each rethrown as the same object |
| FF9 | Precedence at the wrapper | A durability failure beneath a Files invariant is the one preserved |
| FF10 | Ordinary failures | A missing file is still a printed error and the sibling still runs |
| FF11 | Hostile-shape inspection is total | A throwing `data` accessor, fields and key enumeration that refuse, an unreadable prototype, a throwing `cause`, unreadable or non-list aggregate members, and unreadable teardown causes are each declined rather than allowed to throw — none of them is a valid structural failure — and a real failure beneath one is still found |
| FF12 | An unsafe tagged candidate is replaced, not preserved | The right tag plus a raw message, a cause chain, mutable data, an extra data field, a path-bearing `name`, an extra Error-level property, an enumerable symbol payload, or hostile enumeration each fail the identity contract; the planted value survives neither stringification nor enumeration, and the real constructors stay recognizable |
| FF13 | Cancellation cleanup is discovered as fatal | A host cleanup that fails while cancellation unwinds is selected by the engine's own fatal discovery, by identity, with nothing of the platform's failure in it |
| FF14 | A hostile outcome never reaches a component | A settlement that is absent, unreadable, or not a boolean is a provider-contract failure; so is a selected failure that is absent or unreadable, and a success value that is absent or unreadable for the operations that carry one — path admission's succeeds without a value (FF14c). A readable but invalid success payload is a contract failure too, while a readable but unrecognized non-write failure takes FF15's printable path. Where the outcome is a contract failure no child expands, no later sibling runs, and nothing planted escapes |
| FF14b | Search results are recognized and copied totally | A refusing array brand, `length` or element is a fatal protocol violation; the walk never consults the iterator; and the array a document binds is its own copy |
| FF14c | A payload-free success is accepted however it is spelled | Effection's `Unit` carries no `value` member, so an absent one is the ordinary path-admission success — while a present but unreadable one, and a present one that is not `undefined`, are fatal |
| FF15 | Readable malformed failure data stays printable | A non-write failure whose data does not validate renders the generic sentence and the document carries on, with nothing the provider put there reaching it |

### Tier OM — The `output` error mode

| # | Test | Verify |
|---|------|--------|
| OM1–OM2 | A region fails the run | A root region and a component region each emit what they rendered first, fail, and start nothing after the failure |
| OM3 | A command that printed before it failed | The stdout stays visible and the document stops there (#307/#310) |
| OM4 | Later regions and documentation | Neither the documentation after a failing region nor the region after that begins |
| OM5a–OM5f | `<PrintErrors>` | Prints once and the region continues; fails without the boundary; the same for `printErrors(fn)`; `throw` is not overridden; a root without `<Output>` still prints |
| OM6–OM6c | The live failure | The original object, a settled printed error's `DocumentationError` with its mode, and a body-plus-teardown aggregate each reach the completion intact |
| OM7 | Replay | The same partial output and failure, with no command run again |
| OM8 | The close | The root closes `ok` around a recorded `err` outcome |
| OM9/OM10 a–e | Every visible producer | `<If>`, `<Loop>`, `<Each>`, projected `<Content />` and an answered `<Answers>` body each keep their prefix on failure and render exactly once on success |
| OM11a–OM11e | Private buffers | A `<Capture as>`, an `<Each as>`, a string projection, documentation, and a failing `as=` invocation each add nothing to the output |
| OM12a–OM12j | A malformed record | Seven corrupted fields are each refused, the refusal names the situation, a pre-contract journal is named as such, and an intact record replays |
| OM13a–OM13e | What crosses the journal | Absent fields stay absent, a `"undefined"` cause is a cause, and a replay reconstructs an `Error` or an `AggregateError` from the recorded fields |
| OM14–OM16 | Transitivity | `<PrintErrors>`, `<File>`, and a printing component that does not recover each stop a callee's own region; each still prints what is raised under its own mode |
| OM17 | Chunks, not the close value | A streamed prefix arrives before the failing region's output, and both reach the stream |
| OM18–OM19 | A printed error is data | A child's printed error does not fail a parent's documentation; an uncaptured failure in the same position still propagates |

### Tier IM — Expansion metadata

| # | Test | Verify |
|---|------|--------|
| IM1 | Call site | The name, and the path, offset, line and column it was written at |
| IM2 | Runtime-scanned markdown | A position with no path, so a location is still `line:column` |
| IM2b | No position at all | An element carrying none reports none |
| IM3 | Nesting | A nested expansion covers, and the enclosing value is uncovered again |
| IM4 | Two invocations | Each reports its own site |
| IM5/IM6 | Outside an expansion | Asking before or after one is a misuse error |
| IM7 | Detached | The snapshot and its position are frozen, and reading one changes nothing |
| IM8 | Shape | Exactly `id`, `name` and `position`; the position exactly `path`, `offset`, `line`, `column` |

### Tier XP — Expansion identity

Each row names the derivation it kills.

| # | Test | Verify |
|---|------|--------|
| XP1 | Two elements | Different offsets, different identifiers — not keyed by name |
| XP18 | Nested, positionless | Two elements at the same index under different structural parents differ, and repeat reproducibly |
| XP19–XP21 | Through `execute()` | Two root documents differ; one root reproduces its identifiers; a truncated replay derives the ones recorded |
| XP2 | Twice in one process | The same source reproduces its identifiers — no clock, no randomness, no per-process seed |
| XP3 | An unrelated branch | One source and two runtime values: what ran before an element does not move it — a counter would |
| XP4/XP5 | `<Loop>` and `<Each>` | Iterations differ, and re-expansion reproduces the same ordered pair |
| XP6 | Two call sites | One component's body gets one identifier per invocation |
| XP7 | No position | Built elements are told apart by their index |
| XP8 | Opaque | Neither the name nor the path is recoverable from the identifier |
| XP9 | Authored name | The tag as written, not the name of the definition that resolved it |
| XP10 | One object | Two calls in one expansion answer with the same frozen snapshot, keyed `id`, `name`, `position` |
| XP11 | The boundary | Asking where nothing has published an expansion throws |
| XP12 | Portability | A descriptor of the same name built independently reads the engine-published expansion |
| XP13/XP14 | Repeated projections | Two `<Content />` elements, and one slot projected twice, each give two identifiers |
| XP15 | Whose projection | The same content through two components differs; two probes inside one component differ by their own positions |
| XP16 | Concurrent projections | Reversing which projection completes first does not move either identifier |
| XP17 | Lazy | A projection operation constructed and never interpreted consumes no ordinal |
| XP26 | Nested projection under iteration | One `<Content />` written inside `<Each>` gives each item its own identifier, and re-expansion reproduces the ordered pair — an identity taken from the element rather than the path it expands under would report one twice |

### Tier AF — Agent components as function components

| # | Test | Verify |
|---|------|--------|
| AF1-AF2 | Expression props | A string and a boolean expression prop resolve, which the claimed handler rejected |
| AF3-AF4 | Validation first | A wrong type or an unknown prop is the engine's printed error, and the component performs nothing |
| AF5-AF6 | Core-owned `as` | The returned string is captured once and not also emitted; an invalid `as` prevents every effect |
| AF7-AF8 | Content before effects | A failing wrapper performs no lookup, prompt or journal work; an empty wrapper still beats `text` |
| AF9-AF12 | Fatality survives nesting | A `throwOnError` prompt ends the document inside `<Agent>`, inside `<Agent><Session>`, and inside a repository component projecting it as content; the error stays the original `AgentPromptError` |
| AF13-AF15 | Registered defaults | Each name resolves to core's registration, a repository component overrides it, and a repository `Prompt` contacts no provider |
| AF16-AF20 | Prompt-failure policy | Absent by default; forces `throwOnError` when it says yes; an explicit `throwOnError` wins without consulting it; a repository `Prompt` never consults it |

### Tier CR — Component registration and resolution

| # | Test | Verify |
|---|------|--------|
| CR1 | Structural names are not registrable | Registering `Loop` fails at installation |
| CR2 | Name validation | A name a document could not write is rejected; a dotted name is accepted |
| CR3/CR4 | Schema validation | An unusable props or returns schema fails at installation, not at invocation |
| CR5 | Registration is inert | Registering runs no component and acquires no resource |
| CR6 | Rollback | A rejected batch installs nothing and leaves the collision index unchanged |
| CR7 | Same-scope duplicates | Two registrations for one name and kind at one scope fail, naming both origins |
| CR8 | Kinds coexist | A reserved and a default registration for one name may both exist; reserved resolves |
| CR9–CR13 | Scope locality | A child shadows its parent and restores it on exit; siblings and concurrent scopes are isolated |
| CR14 | Structural wins | A structural name resolves to the construct, never to a component |
| CR15 | Reserved over repository | A reserved registration outranks a file on disk |
| CR16 | Repository over default | A repository file outranks a registered default, including each of core's |
| CR17 | Defaults resolve | Core's components resolve with nothing on disk |
| CR18 | Unresolved | The printed error names the searched directories and the registered origins considered |
| CR19/CR20 | Candidate order | Markdown before TypeScript, earlier directories first, dots addressing subdirectories |
| CR21 | Order independence | Reserved beats default however the two were installed, across scopes and within one |
| CR22 | End to end | A repository component replaces one of core's in a running document |
| CR23 | Broken local component | A file that exists but cannot be used fails; it does not fall back to the default |
| CR24 | Structural is not shadowed | A file named after a construct never supplies it |
| CR25–CR29 | Inspection | Inspection agrees with execution, describes structural and unresolved names, and never imports a repository `.ts` |
| CR30 | Defaults are journaled | A core default records an `import_component` entry and replays without re-running |
| CR31 | Repository replay | The entry holds path and content, and a replay never probes the filesystem |
| CR32 | Registration replay | A reserved registration records its origin and replays |
| CR33/CR34 | Origin mismatch | A recorded origin that is missing or replaced fails explicitly rather than invoking another component |

### Tier GT — The Git capability

Defined in [Workflow runs](./workflow-spec.md) §7.

| # | Test | Verify |
|---|------|--------|
| GT1 | The command | `git rev-parse --verify --end-of-options <revision>` in the contextual working directory |
| GT2 | A non-zero exit | Fails, reporting what Git said |
| GT3 | A clean exit naming nothing | Fails rather than pinning a run to an empty object id |
| GT4 | Replacement | A nested provider reaches `revParse()` rather than being shadowed by an outer handler |

### Tier WR — Workflow runs

Defined in [Workflow runs](./workflow-spec.md).

| # | Test | Verify |
|---|------|--------|
| WR1 | Lifetime | Unreadable before the execution, readable inside it, unreadable after — while the installing scope is still alive |
| WR2 | One value | Every read in one execution answers with the same frozen object |
| WR3 | Isolation | Concurrent executions each read their own run |
| WR4 | Completed journal | The run is restored and Git is never consulted; the replayed output's middleware reads it |
| WR5 | A different base | Refused, naming both bases, before the recorded result reaches the caller |
| WR6 | A moving base | A branch that moved cannot change the recorded pinned commit |
| WR7 | Git fails | No run recorded, and the root document never expands |
| WR8 | A later failure | A document that fails after the run was recorded does not erase it |
| WR9 | No workflow | An execution without `useWorkflow()` invokes no process at all |
| WR10 | No workflow, inside | `getWorkflowRun()` throws inside an execution that installed none |
| WR11 | A malformed record | Refused, and the refusal never quotes what the journal held |
| WR12 | A slow base | Resolving one run's base does not stall a sibling execution |
| WR13/WR14 | Seeded journals | A completed and a truncated journal written by hand restore without any live run having happened |

### Tier WD — Workflow definitions and storage contracts

Provider-neutral, and portable across every runtime. Defined in
[Workflow runs](./workflow-spec.md) §9.

| # | Test | Verify |
|---|------|--------|
| WD1 | Round trip | A descriptor parses, serializes and parses back to the same value |
| WD2/WD3 | Closed shape | An undeclared member is refused, and so is anything that is not an object |
| WD4/WD5/WD6 | Object identity | Only version 1 and the git kind; an object ID of the length its format requires, in lowercase hexadecimal |
| WD7/WD8 | Root document path | Absolute, backslashed, NUL-bearing, empty, `.`, `..` and unnormalized paths are refused; ordinary nested paths are not |
| WD9 | No echo | A refusal never quotes the value it refused |
| WD10/WD11/WD12 | Stored shapes | Exactly six statuses; both stop-reason variants, and neither a mixture nor a message |
| WD13 | Canonical values | Key order does not change what a value is named |
| WD14/WD15/WD16 | Compatible reuse | Every immutable field is compared and named when it differs; status, stop reason and timestamps take no part |
| WD17 | No provider | `create` and `lookup` refuse rather than answering with an empty store |

### Tier WS — Retained workflow runs

Runs against the production Deno adapter, on real files. Defined in
[Workflow runs](./workflow-spec.md) §9.

| # | Test | Verify |
|---|------|--------|
| WS1 | One file, no registry | A run is one file named for its ID, and nothing else appears |
| WS2/WS3 | Compatible create | Creating an id twice addresses one run; props compare as values, not text |
| WS4/WS5 | Conflict | Every immutable field refuses a different value, naming the field and never the value |
| WS6 | Missing lookup | Creates no file |
| WS7 | Collision | A database holding another run is refused rather than adopted |
| WS8/WS9 | Unusable request | An unparseable request, and a storage root that is not absolute, are refused before anything is opened |
| WS8b/WS8c | Fabricated input | A request that is not an object, an undeclared member, and a run id that is not a usable id all answer rather than throwing |
| WS10–WS12 | Status and stop reason | All six statuses survive with their reasons; a journal reason names an event the run holds, and one that does not is refused; a reason is parsed on the way in |
| WS13/WS14 | Document executions | Start and every resume get a record; an execution finishes once |
| WS15–WS15c | Retrieval metadata | Replaceable and clearable without touching identity; two handles neither lose each other's revision nor carry one past a clear |
| WS16/WS17 | Restart | Identity, state, retrieval and executions restore; an unfinished execution stays unfinished |
| WS18 | Closed handle | Answers with a failure and reopens nothing |
| WS19–WS21 | Not our database | A foreign application ID, non-SQLite bytes, and older and newer schema versions are refused and left unchanged |
| WS21b | Not pristine | A file carrying a version, or somebody else's tables, is not initialized into |
| WS22 | Not shaped like version 1 | A missing table, a missing singleton row, a dropped constraint, an extra table and an extra view are each damage |
| WS23–WS26 | Values a record cannot use | A descriptor that describes nothing, an empty identity or base, a timestamp that is not an instant or names a day that never happened, a stored stop time, an empty journal identity, and props that are not an object are refused without quoting what they held |
| WS24d | A number too large to hold | A 64-bit stored value reaches a parser instead of escaping as an error quoting it |
| WS27 | Damage | A scribbled page is reported as damage, and the file stays where it is |

### Tier WJ — The retained journal and caller-owned transactions

Defined in [Workflow runs](./workflow-spec.md) §9.5–§9.6.

| # | Test | Verify |
|---|------|--------|
| WJ1/WJ2 | Order and representation | Events replay in append order, stored as the protocol wrote them |
| WJ3 | Stable identity | An event keeps its opaque ID across reads and across processes |
| WJ4 | Unreadable row | A row that is not an event is refused rather than replayed |
| WJ5–WJ5b | Filtering order | A gate that rejects leaves no row, through the standalone journal and through a transaction's |
| WJ5c/WJ5d | Insertion failure | A real SQLite refusal leaves no partial event, and an append it had already accepted in the same transaction goes away with it |
| WJ6/WJ6b | Cancelled filtering | A gate cancelled mid-scan leaves no row, through the standalone journal and through a transaction's |
| WJ7/WJ8/WJ9 | Transaction outcome | A completed body publishes; a failed or cancelled one publishes nothing and leaves the handle usable |
| WJ10/WJ11 | Nesting | A transaction inside a transaction, and an ordinary operation inside a body, are refused rather than deadlocked |
| WJ12 | Escaped handle | A transaction handle kept past its body appends nothing |
| WJ13/WJ14 | Teardown | Cleanup belonging to work the body started is inside the transaction when it commits, and rolls back with it when it fails |
| WJ15–WJ15c | Savepoint and nesting | Nested work rolls back inside a transaction that still commits; a savepoint outside any transaction is refused; a transaction on another run does not hide the one already held |
| WJ16/WJ17 | No accidental enlistment | An unrelated append waits for an open transaction, and neither joins it nor is rolled back with it |
| WJ18/WJ19 | Serialization | Operations never overlap; one cancelled while queued never reaches the database |
| WJ20/WJ21 | Two handles, one run | A second handle waits without stopping the host, and its work is not enlisted in the first's transaction |
| WJ22/WJ23 | Concurrent creation | Compatible callers converge on one run; conflicting ones produce one winner and one conflict |
| WJ24 | Two processes | Two real processes racing to create one run leave one winner and one conflict |
| WJ25 | A second process | Restores the run, preserves journal order and identity, and performs no recorded operation again |
| WJ26 | Exact routed publication | The existing secret gate completes before one exact active token delegates the already-filtered event to `transaction.journal` |
| WJ27 | Routed gate refusal | Gate rejection and cancellation reach no routed insertion |
| WJ28 | Invalid route authority | Missing, fabricated, foreign and cross-run authority is refused before insertion |
| WJ29/WJ30 | Expired route authority | Completed, closed, stale-generation and escaped authority cannot bind or append |
| WJ31 | No ambient enlistment | An unrelated concurrent append does not inherit a publication-local route and survives the routed transaction's rollback |
| WJ32 | Nested run routes | A route for another WorkflowRun delegates to the enclosing run's destination instead of hiding it, even under a colliding loaded-copy handler |
| WJ33 | Replay stays ordinary | `readAll()` never enlists and never invokes a secret gate |
| WJ34 | Terminal ordinary destination | A same-named enclosing handler cannot suppress an unbound ordinary append ahead of the provider-owned terminal destination |
| WJ35 | Terminal routed destination | A same-named enclosing handler cannot suppress a routed append or bypass provider-owned exact-token validation |

### Tier DLC — Live durable-operation coordination

Defined in [Workflow runs](./workflow-spec.md) §9.5–§9.6.

| # | Test | Verify |
|---|------|--------|
| DLC1 | Default live success | Execution and publication each occur once, and publication completes before the caller resumes |
| DLC2 | Live execution failure | The existing serialized failed protocol `Result` is published exactly once |
| DLC3 | Publication failure | One failed backing append raises `DurablePersistenceError` with the adapter error as cause, persists no Yield or Close, and never resumes the workflow past publication |
| DLC4 | Active fail-stop | Catching a failed coordinated publication cannot invoke a later coordinator or executor, cannot attempt another append, and the first durability failure escapes at termination |
| DLC5 | Complete replay | Coordinator, execution, publication continuation and live append are all bypassed |
| DLC6 | Partial replay | Only the live suffix enters coordination |
| DLC7 | Cancellation | Cancellation during execution or publication produces no late or duplicate Yield |
| DLC8 | Explicit selection | A selected coordinator affects only the operation that names it and receives non-operational journal provenance rather than stream capabilities |
| DLC9 | Callback compatibility | Callback-based durable effects retain their existing behavior |
| DLC10 | Fail-closed Workspace | A missing Workspace provider activates fail-stop before execution or publication and persists no Yield or Close |
| DLC11 | Workspace isolation | Replaceable context carries only provider routing; the selected provider directly invokes the credentialed execution-owned capability, while unrelated durable operations stay on the default coordinator |
| DLC12 | Workspace replay | Replayed Workspace operations require no live provider |
| DLC13 | Runtime-neutral boundary | No module of the shared coordination surface names a storage, connection, savepoint or transaction-token type outside its own prose, reads a host global, or loads a module only one host can resolve. Host globals (`process`, `Deno`, `Bun`, `Buffer`, `globalThis`, `navigator`, `__dirname`, `__filename`) are recognized as parsed identifier references, so a word containing one and a property of that name are not crossings, while cross-runtime Web APIs such as `crypto` are never crossings. Module loading is read from parsed syntax — static imports and re-exports, `import type`, type-position `import()`, dynamic `import()`, `import =` and `require()` — with quoted and no-substitution template specifiers decoded, so comments and strings that merely contain import syntax load nothing. A destination the surface computes cannot be shown not to be a host module and is refused. Host schemes (`node:`, `bun:`, `deno:`, `cloudflare:`, `workerd:`), whole path segments naming any runtime this repository builds an entry point for (`deno`, `node`, `bun`, `compiled`, `cloudflare`, `workerd`), vendored sources and host process modules are classified by shape rather than by an enumerated list |
| DLC14 | Provider infrastructure failure | A selected coordinator activates one first failure by identity and fences later execution and publication |
| DLC15 | One-shot Workspace invocation | A provider can use the execution-owned invocation authority only during its original call; retained execution, publication and failure operations are refused after completion |
| DLC16 | Loaded-copy Workspace selection | A provider installed by one physical package copy coordinates one operation created by another copy exactly once without sharing authority through context or a module registry; substituted selection and retained authority remain fail-closed |
| DLC17 | Forged contextual completion | A same-named invocation middleware that returns a forged successful response reaches no provider, executor or publication; fail-stop prevents Yield and Close persistence and fences later durable work |
| DLC18 | Missing-provider phase refusal | No same-named invocation middleware or execution capability is reached when provider selection is missing |
| DLC19 | Authoritative published result | Middleware that delegates and replaces the returned response cannot replace the exact Result recorded by the execution-owned publication |
| DLC20 | Post-completion isolation | Throwing, suppressing or delegating twice after authoritative completion cannot alter the result or repeat provider, execution or publication work |
| DLC21 | Retained continuation refusal | A contextual continuation retained beyond its original live invocation is stale and cannot repeat execution or publication |
| DLC22 | Minimum-priority invocation isolation | An enclosing same-named minimum-priority handler receives no invocation capability or operational phase and cannot acknowledge publication without delegation |
| DLC23 | Minimum-priority failure isolation | A minimum-priority collision cannot replace first-failure activation; the exact execution-owned failure remains authoritative and no event persists |

### Tier WAC — Atomic provider-level Workspace coordination

Defined in [Workflow runs](./workflow-spec.md) §9.5–§9.6 and [Workflow
workspaces](./workflow-workspace-spec.md) §13.

| # | Test | Verify |
|---|------|--------|
| WAC1 | Atomic success | A real DOFS mutation, immutable root, current-root pointer and filtered Yield remain invisible until their one caller-owned transaction commits; the next serialized turn sees both state and event |
| WAC2 | Supported topology | Write, overwrite, delete, rename, directory, mode, symlink and hardlink operations pass through the adapter-private proof operation |
| WAC3 | Known operation failure | A documented filesystem refusal rolls back its mutation savepoint and commits one failed Yield against the previous root |
| WAC4 | Backing insertion failure | A real journal refusal rolls back mutation, root, pointer and event, activates the exact `DurablePersistenceError`, and fences later work |
| WAC5 | Secret-filter refusal | The existing gate runs before routed insertion; rejection rolls back the outer transaction and activates no compensating event |
| WAC6 | Cancellation | Cancellation before mutation, during mutation and during child teardown publishes no state or event |
| WAC7 | Infrastructure fail-stop | A caught provider infrastructure failure retains identity, rolls back everything and prevents later Workspace and ordinary durable execution |
| WAC8 | Concurrency isolation | A second same-run handle waits cooperatively without enlisting while a different run remains usable inside the outer transaction scope |
| WAC9 | Replay | A retained Workspace Yield bypasses the Deno coordinator and mutation completely |
| WAC10 | Effect authority | Exact proof executors work; missing, symbol-forged, foreign, closed and stale authority is refused before savepoint SQL or mutation |
| WAC11 | Journal provenance | The selected raw journal and explicitly preserved trusted wrappers of it, nested, publish and commit; an in-memory stream, another run's journal, copied properties, the former symbol name, a custom look-alike, an ordinary guard and a wrapper another loaded copy tried to prove are refused before savepoint, mutation or publication |
| WAC12 | Post-publication rollback | A transaction-owner failure after the routed append rolls mutation, retained root, pointer and event back and fences later work |
| WAC13 | Pre-commit cancellation | Cancellation after routed publication but before commit retains no mutation, root, pointer, Yield or Close |
| WAC14 | DOFS continuation lifetime | The proof adapter uses only pinned synchronous byte operations; cancellation before a call performs no mutation, cancellation after it rolls back, mutation teardown precedes savepoint rollback, and the connection remains usable |
| WAC15 | Mutation teardown failure | Child-teardown failure rolls the mutation and outer transaction back, activates that infrastructure failure and fences later work |
| WAC16 | Current-root failure | A real current-root update refusal rolls the captured root, live mutation, pointer and event back |
| WAC17 | Existing fail-stop precedence | An already-active `DurablePersistenceError` retains exact identity and prevents Workspace coordination and mutation |
| WAC18 | Savepoint SQL failure | Actual savepoint create, rollback and release refusals poison the coordinated outer transaction and publish nothing |
| WAC19 | Middleware publication isolation | Enclosing default-order Workspace middleware receives only provider selection and cannot replace publication with a no-op; mutation, root, pointer and one filtered Yield still commit together |
| WAC20 | Middleware failure isolation | Enclosing Workspace middleware cannot replace failure activation; provider infrastructure failure rolls back all state, retains exact identity and fences later effects |
| WAC21 | Selection refusal | A substituted or foreign provider selection is rejected before transaction or savepoint work and leaves no mutation, retained root, pointer change, Yield or Close |
| WAC22 | Minimum-priority publication isolation | A minimum-priority same-named handler cannot observe or acknowledge publication; the real mutation, retained root, current pointer and filtered Yield commit together |
| WAC23 | Minimum-priority failure isolation | A minimum-priority same-named handler cannot replace infrastructure-failure activation; the exact first failure rolls back mutation, roots and journal and fences later work |
| WAC24 | Real host crash | A `SIGKILL` while the mutation, immutable root, current-root pointer and routed journal row are written and uncommitted leaves a second connection seeing only the baseline, and a fresh process recovers the baseline filesystem, root, retained counts and journal exactly |
| WAC25 | Committed restart | A second process reopens a run whose Workspace effects committed in a process that has ended, observes the same filesystem, current root, ordered events, event identities and event-to-root associations, and performs no recorded effect again |
| WAC26 | Historical reconstruction | A fresh process selects an older event's root through the adapter-private materializer, invalidates the authoritative negative resolution, rebuilds its exact topology, bytes, modes, hardlinks and symbolic links from that root's retained DOFS content, and resnapshots to the selected identity |

### Tier WTX — WorkflowRun savepoints and transaction authority

Defined in [Workflow runs](./workflow-spec.md) §9.6.

| # | Test | Verify |
|---|------|--------|
| WTX1 | Successful operation savepoint | Release follows child teardown and retains the savepoint's work inside the outer transaction |
| WTX2 | Nested and ordinary failure | Each failed savepoint rolls back only its own work, and the outer transaction may continue |
| WTX3 | Cleanup failure | A failure during child teardown rolls back the operation savepoint |
| WTX4 | Cancellation | Cancellation before entry, during mutation and during teardown strands no savepoint |
| WTX5 | Shared allocator | Synchronous DOFS and operation savepoints draw collision-free names from one connection-owned allocator |
| WTX6 | Savepoint SQL failure | Creation, rollback or release failure poisons the outer transaction so it cannot commit |
| WTX7 | Exact active authority | Handles and tokens authorize work only during their exact active transaction |
| WTX8 | Foreign authority | Foreign, fabricated and cross-run identities are refused before SQL |
| WTX9 | Lease and generation fences | Closed leases and stale connection generations cannot recover private authority |
| WTX10 | Savepoint rollback cache coherence | A failed mutation restores the file and both authoritative caches before the caller continues and commits the outer transaction |

### Tier WRR — Immutable retained Workspace roots

Defined in [Workflow runs](./workflow-spec.md) §9.4 and §9.6–§9.7.

| # | Test | Verify |
|---|------|--------|
| WRR1 | Canonical empty root | Fresh complete-v1 storage retains the exact root-only canonical manifest and its content-addressed identity |
| WRR2 | Complete canonical topology | Paths, metadata, symlinks and deterministic hardlinks form canonical bytes; DOFS manifests and blobs are retained exactly without copied file bytes |
| WRR3 | Mutation-derived roots | Create, overwrite, delete, rename, directory, mode, symlink and hardlink changes produce the corresponding immutable roots |
| WRR4 | Historical restoration | An older root restores exact topology and content, resnapshots to its identity and clears authoritative negative caches |
| WRR5 | Restoration rollback | A restoration failure rolls back its savepoint and preserves the prior live frontier and current-root pointer |
| WRR6 | Read-only corruption | Root, reference, content, chunk, topology and live/current corruption is refused without changing the database |
| WRR7 | Bigint-safe corruption | Maximum-width SQLite integers produce a redacted `WorkflowDatabaseCorruptError`, never a raw or value-leaking conversion failure |
| WRR8 | Teardown before validation | Child cleanup finishes before final live/current validation, and a stale capture cannot commit |
| WRR9 | No unsafe garbage collection | The production closure neither exposes nor invokes Cloudflare DOFS garbage collection |
| WRR10/WRR10b | Outer rollback cache coherence | Failure and cancellation after an uncommitted removal and negative lookup roll back and invalidate both authoritative DOFS caches |
| WRR11 | Historical file size | Every historical file entry's declared size agrees with its retained DOFS manifest during read-only recognition |

### Tier DT — Document target catalog, selectors, and projection

| # | Test | Verify |
|---|------|--------|
| DT1–DT5 | Outline | ATX and Setext headings catalog in source order; a skipped depth still nests; the outermost depth is the smallest present; a sole outermost heading is the title and several are path levels |
| DT6 | Case | Matching is case-sensitive |
| DT7–DT9 | Labels | Formatting, link destinations, inline code, image alt text and passive HTML tags reduce to statically rendered text; a heading rendering no text is unaddressable |
| DT8 | Normalization | NFC-equivalent spellings are one label and Unicode whitespace collapses |
| DT10 | Encoding | `/`, `%`, `#` and `*` in a heading encode to `%2F`, `%25`, `%23` and `%2A` and never read as syntax |
| DT11 | Duplicates | Two sections with one canonical path stay two entries and report as ambiguous |
| DT12 | Nested flow | Headings in block quotes, lists, fences, exec fences and raw HTML are not targets |
| DT13 | Component children | A component child holding blank lines and `#` lines contributes no target — the regression that kills raw Remark discovery |
| DT14–DT17 | Addressability | A heading overlapping component syntax or carrying an interpolation is unaddressable and blocks its subtree; escaped interpolation stays static; a computed sole title still leaves its sections addressable |
| DT18/DT19 | Empty catalog | A document with no heading addresses nothing, and a sole title is no target |
| DT20–DT22 | Matching | Literal levels, embedded `*`, and `**` across zero or more levels |
| DT23 | Exactly one | Zero matches and several matches both fail, reporting matches and the catalog |
| DT24–DT26 | Selector syntax | Empty, leading/trailing slash, empty level, malformed escape, NUL and non-UTF-8 are refused; `+` is a plus |
| DT27 | Termination | A wildcard-dense selector against a long label completes without exponential search |
| DT28 | Wildcard whitespace | Whitespace beside a wildcard is matched; only the level's outer edges trim |
| DT29–DT32 | References | A reference splits at the first raw `#`; a path keeps separators and decodes escapes; an unreadable reference says only `Invalid document reference`, cause-free; formatting encodes the path and validates an exact target |
| DT33/DT48 | Canonical exactness | A level is canonical only through decode, normalize and re-encode — NFD, tabs, uncollapsed or edge whitespace, lowercase escapes, empty levels and raw operators are refused |
| DT49 | Raw `#` | A raw `#` is never a literal selector character; `%23` addresses a heading containing one |
| DT50/DT51 | Formatter totality | A path that cannot encode losslessly — NUL, an unpaired surrogate — is refused, and every formatted reference parses back to what it named |
| DT34–DT39 | Projection | Preamble, ancestor direct content and the selected subtree are retained; siblings are absent; a non-leaf keeps its descendants; a sole title stays |
| DT40–DT43 | Positions | A retained element keeps its authored offset and line, CRLF included; frontmatter, props and return mode survive; the untargeted parse still scans the whole body |
| DT44–DT47 | Inspection | The catalog is reported without selecting; a glob resolves to the exact target; an unresolvable target fails inspection; the failure's data is frozen and rebuilt |
| DT52–DT55 | Recognition | A failure from a separately loaded copy is recognized; hostile, unreadable, mutable, over-populated, cause-bearing and payload-bearing candidates are all refused |

### Tier TX — Targeted execution and replay

| # | Test | Verify |
|---|------|--------|
| TX1–TX3 | Selection | Only the preamble, ancestors and subtree expand; a skipped sibling's components and code blocks never run; a non-leaf expands its descendants |
| TX4/TX5 | Identity | A retained element keeps the expansion ID it has in a full run, and two targets retaining it agree |
| TX6 | Sources | A file root and an inline root behave identically |
| TX7–TX9 | Root values | Root props, frontmatter interpolation, a declared `returns`, and `<Output>` apply to the projected body |
| TX10/TX11 | Structure | An invalid skipped sibling is irrelevant; an invalid retained range fails before any authored effect |
| TX12–TX14 | Failure timing | An unmatched or ambiguous target runs no authored effect and is structurally recognizable; inspection resolves without expanding a component |
| TX15/TX16 | Recording | The journal records the exact target, never the glob, and an untargeted run records no target member |
| TX17 | Compatibility | A different selector naming the same section replays |
| TX18–TX21 | Staleness | A different exact target, a targeted request against an untargeted journal, the reverse, and a selector the recorded content no longer resolves all fail stale before completed-Close reuse, carrying no foreign cause |
| TX22/TX23 | Recorded content | An untargeted journal replays untargeted; replay projects the recorded content, not the file on disk |
| TX24 | Failed selection | A journal from a selector that matched nothing never answers a later valid one |
| TX25–TX27 | Failed replay | The same failing selector replays its own recorded failure with no authored effect; a different failure kind or a different selector is stale; live and replayed failures are the same structural error |

### Tier SL — Own-scope context updates

| # | Test | Verify |
|---|------|--------|
| SL1/SL2 | Writing | The first write starts from empty; repeated writes at one scope accumulate |
| SL3 | Rollback | An update that throws leaves the scope unchanged and still usable |
| SL4/SL5 | Inheritance | A child starts empty, never mutates what it inherited, and leaves the parent's value intact |
| SL6/SL7 | Isolation | Sibling and concurrent scopes cannot see one another |
| SL8 | Lifetime | What a scope wrote is gone once it exits |

### Tier IS — Invocation shape

| # | Test | Verify |
|---|------|--------|
| IS1/IS2 | Paired forms have content | `<C>…</C>` and `<C></C>` both report content |
| IS3 | Self-closing has none | `<C />` reports none |
| IS4 | Asking does not project | A component that only calls `hasContent()` never expands the invocation content it reports on |
| IS5 | Compiled binary, end to end | The guide's lifetime narrative, run by `xmd test` with no JavaScript in the document |

### Tier RT — Retained resources

| # | Test | Verify |
|---|------|--------|
| RT1 | Captured value reaches a sibling | `as` binds the value and a downstream sibling resolves it while the resource is still live |
| RT2 | Outlives the child invocation | A later sibling invocation starts and stops entirely inside the window where the retained resource is alive |
| RT3 | Released on site success | `start:retained, stop:retained` when the site scope completes normally |
| RT4 | Released on site error | The failure propagates and the resource is still released |
| RT5 | Released on site cancellation | Halting the site scope while the resource is live releases it |
| RT6 | Nested sites unwind leaf-first | A resource retained inside a component's content stops before that component's own |
| RT7 | Retention is opt-in | A component that does not call `retain()` keeps invocation lifetime |
| RT8 | No invocation-site scope | `retain()` reports the missing scope instead of falling back to invocation lifetime |
| RT8b | Missing site is authoritative | An inherited `retain` provider never answers for an invocation that has no site of its own |
| RT9 | Root retention | A resource retained at the root outlives every later sibling in the document |
| RT10 | Halting mid-expansion | Halting while a later block suspends still releases what an earlier element retained |
| RT15 | Retention under partial replay | The durable effect replays while the retained resource is re-established on each execution that runs |
| RT16 | Eval cannot retain | An eval block's `retain()` is refused, and the block produces no value |
| RT17 | Compiled binary, end to end | The guide's standalone scenario: the resource is still live for a later sibling, with no JavaScript in the document |
| RT18 | Site isolation | A factory that sets a context value and installs middleware: the resource is retained, and a later sibling still observes the caller's own |

### Tier P — Eval binding interpolation

| # | Test | Verify |
|---|------|--------|
| P1 | Bare binding resolves from `env.values` | `{port}` with `env.values.port = 49821` → `"49821"` in content |
| P2 | Bare binding with no env entry left verbatim | `{port}` with no `port` in `env.values` → `"{port}"` unchanged |
| P3 | Dotted props binding resolves | `{props.release.version}` traverses `env.values.props` and missing/null intermediate paths remain verbatim |
| P4 | Multiple bindings in one content | `{host}:{port}` → both substituted |
| P5 | Non-string binding converted via `String()` | `env.values.port = 49821` (number) → `"49821"` |
| P6 | Binding interpolation runs before modifier chain | Resulting `ctx.content` in modifier contains substituted value |
| P7 | Same-run env populated before interpolation | Eval result sets `port`; subsequent block interpolates correctly |
| P8 | Non-serializable binding remains current-run only | Function is usable in the current component expansion and absent from the trace |

### Tier Q — `daemon` modifier

| # | Test | Verify |
|---|------|--------|
| Q1 | `daemon` ignores `next` | `exec` in chain never called — no `durableExec` invocation |
| Q2 | `daemon` produces no journal entry | Journal has no entry for `daemon` block |
| Q3 | `daemon` returns empty output | `result.output === ""`, `exitCode === 0` |
| Q4 | Process forked into eval scope | Process alive during `<children />` expansion |
| Q5 | Process terminated when the invocation completes | A `kill -0` probe in a block after the component, while the document is still running, reports the process gone |
| Q6 | Process terminated on component error | If child expansion throws, process still terminated |
| Q7 | Root cancellation resolves promptly | Cancelling the root resolves instead of waiting on the daemon's blocks; invocation teardown order is covered by Tier O |
| Q8 | Premature exit propagates as error | Process exits during expansion → `daemon()` throws → `ErrorSegment` in output |
| Q9 | Durable interpolation in daemon content | Binding from preceding `eval` block substituted into fixed command configuration |
| Q10 | `daemon` without eval scope | No eval scope in scope → clear error |
| Q11 | Modifier chain: `bash daemon exec` | `daemon` is outermost terminal; `exec` present but never called |
| Q12 | Repeated run: daemon starts and stops | Process is spawned and terminated again |
| Q13 | Repeated run: process restarts | Fixed daemon command is spawned on each document execution |
| Q14 | Projected daemon terminated with the invocation | A daemon the caller wrote and the component only projected is gone in a block after the component; inside `<TempDir>` it is signalled while the directory still exists |

### Tier R — VM globals and live eval

| # | Test | Verify |
|---|------|--------|
| R1 | Live overlay hidden from plain eval | A service binding is absent from the ordinary eval preamble |
| R2 | Live overlay hidden from interpolation | `{server}` remains literal rather than becoming an endpoint string |
| R3 | `ephemeral eval` executes during partial replay | Live bindings and middleware are reconstructed without a journal entry |
| R4 | Service publication collision | A durable or live binding with the requested name refuses attachment before spawn |
| R5 | Durable export collides with a service | Live execution and valid partial replay diagnose the block before constructing an eval effect; a later durable effect executes or restores in alignment, and no eval `Yield` appears |
| R6 | Ephemeral export collides with durable state | The block is rejected before execution and publishes no partial export |
| R7 | Ephemeral update of a live binding | A later ephemeral block may atomically replace an existing live name |
| R8 | Incompatible retained eval history | Genuine history from an earlier component definition fails fatally before restoring its now-incompatible eval result; effect-level mismatch and immediate root termination both append neither replacement `Yield` nor root `Close`, leave the retained prefix byte-for-byte unchanged, and permit the compatible definition to replay it |
| R9 | `when` accessible in eval block | `yield* when(fn)` retries until fn succeeds |
| R10 | `when` retries on throw | Inner function throws twice, then succeeds → `when` resolves |
| R11 | `when` propagates timeout | Inner function never succeeds → `when` throws after limit |

### Tier S — Provider component pattern (integration)

| # | Test | Verify |
|---|------|--------|
| S1 | Full provider golden run | service → persistent ephemeral middleware → children → cleanup |
| S2 | Endpoint flows to ephemeral middleware | `server` is an exact frozen loopback endpoint available only to ephemeral eval |
| S3 | Children can call sample after the handshake | `sample` calls in children reach the attached-service endpoint |
| S4 | Cancellation after handshake | The child exits and its listener can be rebound after its owning task is halted |
| S5 | Startup failures | Exit, timeout and invalid handshake records produce dedicated errors without leaking handshake data |
| S6 | Provider exits during projected content | The projected request reaches the ready process, its unexpected exit fails the document, and it is not restarted |
| S7 | Nested real providers | Outer + inner processes both start and inner teardown finishes before outer teardown |
| S8 | Nested providers, no model | Innermost provider handles sample call |
| S9 | Nested providers, explicit model matching outer | Inner passes through, outer handles |
| S10 | Nested providers, explicit model matching inner | Inner handles regardless of nesting depth |
| S11 | Unmatched model | Chain exhausted → descriptive error naming the model |
| S12 | Partial replay | Service attachment and ephemeral middleware execute again after the recorded prefix |
| S13 | Completed replay | Completed document returns without process spawn or token allocation |
| S14 | Concurrent service attachments | Two owners attach at the same time and receive distinct live endpoints |
| S15 | Incremental ordinary stdout | Unterminated and chunk-split ordinary bytes are forwarded before teardown, byte for byte |
| S16 | Incremental handshake records | A split handshake is suppressed, duplicate supervision remains active, and invalid candidates are bounded and suppressed |
| S17 | Service teardown failures | A lone observable process teardown failure becomes `ServiceTeardownError`; an active execution failure remains first in the invocation aggregate |
| S18 | Projected failure cleanup | A prompt projected-content failure tears down both retained real services and starts neither again |
| S19 | Compiled-binary attached-service ping-pong | A smoke document attaches two real services, closes both endpoints into ephemeral middleware, journals only the ordinary filtered `Sample` result and completes `ping→pong→ping` |

### Tier EO — eval output() function

| # | Test | Verify |
|---|------|--------|
| EO1 | `output()` produces eval block output | Block calling `output("text")` → rendered output contains "text" |
| EO2 | `output()` journaled in entry | `__output` is present in the current eval result |
| EO3 | eval block without `output()` produces no output | Standard eval block → empty output unchanged |
| EO4 | `output()` with multiline content | Multiline string preserved through journal round-trip |
| EO5 | `output()` converts non-string to string | `output(42)` → `"42"` via `String()` coercion |

### Tier RC — renderChildren and render closures

| # | Test | Verify |
|---|------|--------|
| RC1 | `renderChildren()` returns empty for self-closing | Self-closing component → empty string |
| RC2 | `renderChildren()` captures children text | Block component children → rendered text string |
| RC3 | `render()` expands arbitrary markdown | `render("# Hello")` → rendered heading |
| RC4 | `renderChildren(override)` visible + shadows | Override binding resolves in body text/eval; shadows caller value |
| RC5 | `renderChildren(override)` no leak | Override absent from caller env after the render |
| RC6 | `renderChildren(override)` rejects non-object | `null`/array/primitive override → printed error |

### Tier Each — `<Each>` iteration directive

| # | Test | Verify |
|---|------|--------|
| EA1 | Renders once per item | Body appears once per element; `{item.field}` dotted paths resolve |
| EA2 | Empty array | No output, no error |
| EA3 | Nested `<Each>` shadowing | Inner binding shadows; outer intact; neither leaks |
| EA4 | No binding leak | Item binding absent from sibling/parent env after the loop |
| EA5 | Body eval reads the item | Eval block in the body sees the current item |
| EA6 | Segment preservation | Uncaptured loop keeps `ErrorSegment`/`execOutput` (not stringified) |
| EA7 | `as` captures the loop | Full rendered loop stored in binding; no inline output |
| EA7b | `as` over a failing body | A body block that failed after printing leaves the binding unset and returns the errors; what it printed is not captured |
| EA8 | Prop contract | Missing/non-array `in`, missing `let`, `let={expr}`, `as={expr}`, reserved-word/unknown props rejected; `as` without env rejected |
| EA9 | Projection | `<Each>` through `<Content />` resolves `in`, the item, and other caller bindings |

### Tier IF — `<If>` / `<Else>` conditional directive

Identifiers match `packages/core/tests/if.test.ts` one to one.

| # | Test | Verify |
|---|------|--------|
| IF1 | True condition renders its children | `condition={true}` expands the children before `<Else>` |
| IF2 | False without `<Else>` | No output and no error |
| IF3 | False selects `<Else>` | The `<Else>` children render in place of the leading branch |
| IF4 | True ignores `<Else>` | Only the children before `<Else>` render |
| IF5 | Condition from a binding | `condition={ok}` resolves from the evaluation environment, both ways |
| IF6 | Computed boolean | `condition={findings.length === 0}` and `condition={!passed}` resolve |
| IF7 | Ordering | Content before and after the directive keeps its position |
| IF8 | Capture survives the block | A `<Capture>` in the selected branch is readable after `</If>` |
| IF9 | Unselected branch binds nothing | Its `<Capture>` leaves the name unset and the reference verbatim |
| IF10 | Independent nesting | An inner `<If>` selects without affecting the outer one |
| IF11 | Nested `<If>` in the unselected branch | It never runs |
| IF12 | Self-closing `<If>` | Renders nothing, with no error |
| IF13 | Missing `condition` | Rejected; the body does not render |
| IF14 | Falsy conditions | `false`, `0`, `-0`, `0n`, `NaN`, `""`, `null`, and `undefined` each select `<Else>`, with no error |
| IF15 | Truthy conditions | `true`, `1`, `"false"`, `"text"`, `[]`, and `{}` each select the leading branch, with no error |
| IF16 | Absent member versus undeclared identifier | A misspelled member is falsy and silent; an undeclared identifier is quoted in the printed error |
| IF17 | Unknown props | Literal and expression props other than `condition` are rejected |
| IF18 | `<Else>` outside `<If>` | Diagnosed; no component named `Else` is imported |
| IF19 | Duplicate `<Else>` | A second `<Else>` is rejected |
| IF20 | `<Else>` below the direct children | An `<Else>` nested inside another element is rejected |
| IF21 | `<Else>` inside `<Else>` | Rejected |
| IF22 | Self-closing `<Else>` | Rejected — `<Else>` takes content |
| IF23 | Prop-bearing `<Else>` | Literal and expression props are both rejected |
| IF24 | Structure precedes selection | A malformed `<Else>` in the unselected branch is still diagnosed |
| IF25 | Nested `<If>` owns its `<Else>` | A valid inner `<Else>` is not attributed to the outer `<If>` |
| IF26 | Whitespace after `</Else>` | Formatting between `</Else>` and `</If>` is ignored |
| IF27 | Text after `</Else>` | Substantive trailing text is rejected; neither branch renders |
| IF28 | Component after `</Else>` | Rejected, and the component is never imported |
| IF29 | Executable block after `</Else>` | Rejected, and the block never runs |
| IF30 | Trailing content with `<Else>` selected | Rejected regardless of which branch the condition picks |
| IF31 | No import from the unselected branch | `importComponent` is never called for it |
| IF32 | No code block from the unselected branch | The modifier chain is never applied |
| IF33 | Selected control | The selected branch does run its code block |
| IF34 | Unselected `<Else>` | A component in an unselected `<Else>` is never imported |
| IF35 | Local position | A printed error carries `line:column` |
| IF36 | Origin position | A scanned origin adds `path:` to the printed error |
| IF37 | `<Else>` position | A stray `<Else>` reports its own location |
| IF38 | No position | An element built without scanning diagnoses without a location |
| IF39 | Journal | Only the selected branch's eval entry reaches the journal |
| IF40 | Unselected effect | A throwing block in the unselected branch never runs |
| IF41 | Unselected import (execution) | A component in the unselected branch is never imported end to end |
| IF42 | Partial replay | From a journal prefix without the root Close, `<If>` is reached live, selects from the restored binding, and reproduces the output |
| IF43 | Projection | An `<If>` through `<Content />` resolves its condition from the caller's bindings |
| IF44 | Unselected expansion | A component in the unselected branch never expands, so its body reaches no output |
| IF45 | Filesystem | No `stat` or read happens for the unselected branch's component |
| IF46 | Process runtime | `exec` is never invoked for an unselected block |
| IF47 | Durable events | The unselected branch writes no exec or eval event |
| IF48 | Bindings (execution) | Later content sees no binding from the unselected branch |
| IF49 | Inline observation baseline | An `ErrorSegment` outside any `<If>` passes through `Component.raise` once |
| IF50 | Selected branch observed once | The same error inside a selected branch is observed once, not twice |
| IF51 | Unselected branch unobserved | An error in the unselected branch is observed zero times |
| IF52 | `<If>`-owned errors observed once | A missing `condition`, an unresolvable condition expression, and a malformed `<Else>` each report once |
| IF53 | Throwing error mode | An ambient `throw` error mode still aborts on a selected-branch error |
| IF54 | Provider boundary | An unselected branch makes zero Sample Api calls; the same probe records one when selected |

### Tier OBS — error observation

The one-observation contract of §6.9, measured with counting `Component.raise`
middleware. Identifiers match
`packages/core/tests/construct-error-observation.test.ts` one to one, and start
at OBS7: OBS1–OBS6 measured the retired extension boundary and went with it.

| # | Test | Verify |
|---|------|--------|
| OBS7 | Inline baseline | An `ErrorSegment` outside any construct is observed once |
| OBS8 | Selected `<If>` branch | Observed once |
| OBS9 | `<Each>` body | Observed once per iteration that produced one, and no more |
| OBS10 | `<Capture>` body | Observed once |
| OBS11 | Component body | Observed once |
| OBS12 | Projected `<Content />` | Observed once, through both the segment and the string-projection path |
| OBS13 | `<Loop>` body | Observed once |
| OBS14 | Construct-owned printed errors | `<Each>` and `<Capture>` prop and structure errors each report once |
| OBS15 | Refused captures | `<Capture as>`, `<Each as>` and a component `as` each report the body error once and set no binding |
| OBS16 | Throwing error mode | An ambient `throw` error mode aborts at the first error on every path above |
| OBS17 | Printing error mode | A printed error renders exactly one comment on every path above |
| OBS18 | Uncaught function content | The invocation comes back as the same segment objects `Component.raise` returned |
| OBS19 | Refused function capture | The same, with no binding made |
| OBS20 | Sibling content failures | Two failures keep source order and one observation each |
| OBS21 | Recovered content failure | The `ContentError` carries the raised segments in source order, and recovery settles nothing |
| OBS22 | Where the cause is attached | Raise middleware that catches what the chain throws already sees the thrown component failure as the `DocumentationError`'s cause, the same object leaves the expansion, and the contextual segment is observed once |
| OBS23 | Thrown `undefined` under a throwing error mode | The printed error records it as its own `cause` — an Error whose own `cause` is the `undefined` that was thrown — so "translated from undefined" stays distinguishable from "no attribution at all" |
| OBS24 | Thrown `undefined` under a printing error mode | It settles as a rendered printed error and constructs no `DocumentationError`, so there is no Error to carry a cause, and later content still renders |

Provider families carry the same contract in their own tiers: `AC20`
(`<Prompt>` prop validation), the assertion validation row in
`packages/testing/tests/assertions.test.ts`, and `TV12` (`<TestAgent>`
configuration).

### Tier LOOP / BREAK — bounded repetition directive

Identifiers match `packages/core/tests/loop.test.ts` one to one.

| # | Test | Verify |
|---|------|--------|
| LOOP1 | Exact repetition | `max={3}` expands the body three times, in order |
| LOOP2 | Bound of one | `max={1}` expands the body once |
| LOOP3 | Exhaustion | Reaching `max` completes normally; surrounding content keeps its position |
| LOOP4 | Empty body | A loop with no children renders nothing |
| LOOP5 | Self-closing `<Loop>` | Renders nothing, with no error |
| LOOP6 | Bound from a binding | `max={attempts}` resolves from the evaluation environment |
| LOOP7 | Repeated blocks | The body's code block runs once per iteration |
| LOOP8 | Repeated invocations | The body's component is imported once per iteration |
| LOOP9 | Nesting | An inner loop reruns in full for every outer iteration |
| LOOP10 | Bindings carry forward | An iteration reads what an earlier one bound |
| LOOP11 | Bindings survive the loop | The final value is readable after `</Loop>` |
| LOOP12 | Last-iteration binding | A binding made in the final iteration survives |
| LOOP13 | Body reads the shared env | An `<If>` in the body reads the string an earlier iteration bound as truthy |
| LOOP14 | Missing `max` | Rejected; the body does not render |
| LOOP15 | Non-positive and fractional bounds | `0`, `-1`, and `1.5` are rejected |
| LOOP16 | No coercion | String, boolean, `null`, array, and object bounds are rejected with their kind named |
| LOOP17 | Non-finite bounds | `Infinity` and `NaN` are rejected |
| LOOP18 | Unresolvable expression | The failing expression is quoted in the printed error |
| LOOP19 | Invalid bound runs nothing | No component in the body is imported |
| LOOP20 | Unknown props | Literal and expression props other than `max`/`name` are rejected |
| LOOP21 | `name` is inert | A named loop renders exactly what an unnamed one does |
| LOOP22 | `name` binds nothing | Neither `{name}` nor the label resolves in the body |
| LOOP23 | `name` in printed errors | The loop's own errors name it |
| LOOP24 | `name={expr}` | Rejected — `name` is a string literal |
| LOOP25 | Empty or non-string `name` | Rejected |
| BREAK1 | Immediate break | `max={5}` with a `<Break>` in the body runs one iteration |
| BREAK2 | Break before output | A leading `<Break>` produces nothing |
| BREAK3 | Break inside `<If>` | A selected `<Break>` exits the loop |
| BREAK4 | Unselected break | An unselected `<Break>` leaves the loop running |
| BREAK5 | Bindings before the break | They remain available after the loop |
| BREAK6 | Nearest loop only | An inner `<Break>` leaves the outer loop running |
| BREAK7 | Outer break after an inner loop | The outer loop exits |
| BREAK8 | Break inside `<Each>` | The enclosing loop exits and the remaining items are skipped |
| BREAK9 | Text after the break | Does not render |
| BREAK10 | Component after the break | Never imported |
| BREAK11 | Code block after the break | Never runs |
| BREAK12 | `<Capture>` after the break | Creates no binding |
| BREAK13 | After the loop | Content following `</Loop>` still runs |
| BREAK14 | Break outside a loop | Diagnosed |
| BREAK15 | Stray break resolves nothing | No component named `Break` is imported |
| BREAK16 | Props on `<Break>` | Literal and expression props are both rejected |
| BREAK17 | Content on `<Break>` | Rejected |
| BREAK18 | Malformed break performs no control action | Under a printing error mode the printed error renders and the loop still runs to its bound, with each iteration intact |
| BREAK18b | Malformed break under a throwing error mode | The printed error aborts through the ambient error mode |
| BREAK19 | Component body boundary | A `<Break>` a component writes is diagnosed and the caller's loop keeps running |
| BREAK20 | Projection through `<Content />` | A `<Break>` the caller projects exits the caller's loop; the component still finishes rendering |
| BREAK21 | Component-written break end to end | Diagnosed, and every iteration keeps its trailing content |
| BREAK22 | Projection through `content()` | The same holds for a component that renders content from a code block |
| LOOP26 | Throwing error mode | The first failing iteration aborts the loop |
| LOOP27 | Printing error mode | The printed error renders and the next iteration runs |
| LOOP28 | Cancellation | Halting mid-loop stops it where it stands |
| LOOP29 | Teardown per iteration | An iteration's resources are released before the next begins |
| LOOP30 | Teardown on break | The breaking iteration's resources are released before the loop exits |
| LOOP31 | Local position | A printed error carries `line:column` |
| LOOP32 | Origin position | A scanned origin adds `path:` to the printed error |
| LOOP33 | `<Break>` position | A stray `<Break>` reports its own location |
| LOOP34 | No position | An element built without scanning diagnoses without a location |
| LOOP35 | Body entries per iteration | Each iteration journals a distinct, deterministic eval entry |
| LOOP36 | Journal after a break | Skipped content writes no eval entry |
| LOOP37 | Accumulation | A binding grows across iterations end to end |
| LOOP38 | Repeated import (execution) | The body's component runs once per iteration end to end |
| LOOP39 | Partial replay | Truncated at the loop's second iteration entry, the journal replays exactly one iteration, runs the remaining two live onto the same identities, reproduces the output, and records `exhausted` |
| LOOP40 | Break from a binding | A condition computed in the body ends the document's loop |
| LOOP41 | Empty-body records | Three iteration entries and an `exhausted` terminal record, with no body to journal |
| LOOP42 | Immediate break records | One iteration entry and a `break` terminal record — distinct from empty exhaustion |
| LOOP43 | Final-iteration break | Identical iteration entries to an exhausted loop; only `outcome` differs |
| LOOP44 | Failure records | A throwing error mode records an `error` terminal record with the iterations entered, and the execution ends with root `Close(err)` |
| LOOP45 | Printing error mode is not failure | The printed error renders and the terminal outcome is `exhausted` |
| LOOP46 | Interrupted state | Iteration entries for the iterations entered, no terminal loop record, and no root `Close` — observably different from a completed run (`ok`) and a failed one (`err`), without saying why it stopped |
| LOOP47 | Nested identities | Each entry into a nested loop records its own distinct identity |
| LOOP48 | Identity is internal | `{iteration}` resolves to nothing in the body |
| LOOP50 | Stale terminal record — derived `break` | A journal holding `exhausted` for the same iteration count raises `StaleInputError` rather than replaying its outcome onto a run that broke |
| LOOP51 | Stale terminal record — derived `error` | The same holds for a run that fails, and the document failure is the `StaleInputError`'s cause |
| LOOP52 | Durability failure is not an outcome | A stale `<TempDir>` replay inside a loop stays a `StaleInputError`; the loop records no `error` outcome and the stored terminal entry is untouched |
| LOOP54 | Wrapped durability failure | The caller receives the exact nested failure, not the wrapper, and the loop records no outcome for it |
| LOOP55 | Body divergence | A tampered body entry reports the original `DivergenceError` at the body operation, not a later mismatch at the loop's terminal one; nothing is rendered and no outcome is recorded |
| LOOP56 | Malformed terminal record | The printed error names the loop and the derived outcome and reproduces none of the entry's content |
| LOOP57 | Mixed wrapper | A wrapper carrying a documentation failure *and* a durability failure yields the durability one, and the loop records no outcome |
| LOOP53 | Agreeing partial replay | A journal whose terminal record matches what the run derives replays cleanly and closes `ok` |
| LOOP49 | Resumption | An interrupted journal is accepted by a new execution: the recorded iteration entries replay in order, the interrupted iteration's body reruns live because it journaled nothing, the remaining iterations run live, the loop and iteration identities are unchanged, exactly one terminal record is written with `exhausted` and the right count, and the run ends with root `Close(ok)` |

### Tier SC — Sample component (integration)

| # | Test | Verify |
|---|------|--------|
| SC1 | Self-closing with prompt | `<Sample prompt="hello" />` → provider response in output |
| SC2 | With children | `<Sample>children</Sample>` → children rendered then sampled |
| SC3 | Model routing | `<Sample model="X">` → targets specific provider |
| SC4 | No provider | `<Sample>` outside provider → descriptive error |
| SC5 | Repeated run calls provider | Current provider response is used and journaled |
| SC6 | Self-closing renderChildren returns empty | `<Sample prompt="X" />` → `renderChildren()` returns empty, prompt used |

### Tier OA — Document Output Api

| # | Test | Verify |
|---|------|--------|
| OA1 | Api creation | `DocumentOutput` Api created with `output` operation |
| OA2 | Core handler is no-op | `output("text")` with no middleware installed → no error, no visible effect |
| OA3 | Middleware intercepts output | `scope.around(DocumentOutput, ...)` receives text in middleware handler |
| OA4 | Middleware transforms text | Middleware modifies text, `next()` receives modified text |
| OA5 | Channel delivery | Channel delivery handler sends text via `yield* channel.send()` |
| OA6 | Consumer collects all chunks | `forEach` consumer collects all emitted chunks in order |
| OA7 | Channel close ends consumer | `channel.close()` causes `forEach` to complete |
| OA8 | Multiple middleware compose | Normalize → terminal → channel: all three run in order |
| OA9 | `ephemeral()` wrapper | `output()` inside durable context produces no journal entry |
| OA10 | execute workflow error surfaces through execution | `execute` workflow error → completion resolves `Err(error)` — `yield* execution` returns the `Result`, never throws |

### Tier WN — Whitespace normalization

| # | Test | Verify |
|---|------|--------|
| WN1 | Trailing whitespace stripped | `"hello \n"` → `"hello\n"` |
| WN2 | Leading newlines collapsed after blank line | Previous write ended with `\n\n`, next starts with `\n\n` → collapsed to `\n` |
| WN3 | Run of 3+ newlines collapsed | `"a\n\n\nb"` → `"a\n\nb"` |
| WN4 | Cross-write tracking | Write 1: `"text\n\n"`, Write 2: `"\n\nmore"` → Write 2 leading newlines collapsed |
| WN5 | Single newline preserved | `"a\nb"` → unchanged |
| WN6 | Empty write | `""` → unchanged, trailing count preserved |
| WN7 | Tab trailing whitespace | `"text\t\n"` → `"text\n"` |

### Tier TF — Terminal ANSI formatting

| # | Test | Verify |
|---|------|--------|
| TF1 | Heading formatted | `"# Title"` → ANSI bold/colored output |
| TF2 | Bold formatted | `"**bold**"` → ANSI bold markers present |
| TF3 | Code block formatted | Fenced code block → syntax-highlighted output |
| TF4 | `async: false` | `marked.parse()` called with `{ async: false }` — no promises |
| TF5 | Middleware composes with normalize | Normalized text passes through terminal formatter |

### Tier SE — Streaming emission

| # | Test | Verify |
|---|------|--------|
| SE1 | Per-segment emission order | Segments emitted in document order |
| SE2 | blockId stability | Per-segment expansion produces same blockIds as batch expansion |
| SE3 | TTY: immediate write | TTY consumer calls `process.stdout.write()` per chunk |
| SE4 | Piped: buffered write | Non-TTY consumer collects chunks, writes at end |
| SE5 | `--raw` flag | No middleware installed — raw text passes through |
| SE6 | Channel close triggers forEach exit | `channel.close()` → consumer's `forEach` completes |
| SE7 | Cancel mid-emission | Scope cancelled between segments → consumer cancelled, no hanging |
| SE8 | Middleware crash | Middleware throws → consumer not orphaned, channel closed |
| SE9 | Cross-boundary communication | `output()` inside durable workflow → channel outside → consumer receives text |
| SE10 | Empty segment | `renderSegment` returns `""` → no `output()` call |

### Tier BC — Block ID counter

| # | Test | Verify |
|---|------|--------|
| BC1 | Counter increments across segments | Block 0 in segment 1, block 1 in segment 2 — IDs are 0, 1 |
| BC2 | Counter stable across runs | Same document structure produces the same block IDs |
| BC3 | Counter threaded through expansion | Nested component expansion uses same counter |
| BC4 | Counter not reset per root segment | Per-segment expansion does not reset counter |

### Tier RV — Component return values

| # | Test | Verify |
|---|------|--------|
| RV1 | Value kinds | String, number, boolean, array, object, and null bind through `as` |
| RV2 | Renders nothing | A value component contributes no segments to its caller |
| RV3 | Caller control flow | The captured value drives `<If>` in the caller |
| RV4 | Object-return shorthand | Normalizes with every property required and `additionalProperties: false` |
| RV5 | Full schema | An optional property is accepted when absent |
| RV6 | Declaration shape | A non-object or boolean `returns` is rejected in execution and inspection |
| RV7 | JSON boundary | `undefined`, non-finite, class instance, and cyclic values are rejected before binding |
| RV8 | Defaults | Schema defaults fill the returned clone, not the producer's object |
| RV9 | Text mode | No `returns` renders and captures a string; an explicit string schema is value mode |
| RV10 | Structure | Missing, duplicate, nested, misplaced `<Return>`, `<Output>` with `returns`, bad props, and a missing `as` fail before body effects |
| RV11 | Reservation | A projected or dynamically produced `<Return>` is diagnosed, never imported |
| RV12 | Execution order | Documentation after `<Return>` runs; the value sees only preceding bindings |
| RV13 | Function components | `export const returns` gives the same validation and capture; a text component returning a non-string errors |
| RV14 | Composition | A value component invoked inside another component's body |
| RV15 | Value roots | Completion carries the validated value; body text stays on `.output`; every failure completes `Err` |
| RV16 | Inspection | `returns` and `returnMode` report the effective schema without executing |
| RV17 | Replay | Golden run and replay produce the same value and output with no re-execution |
| RV18 | Schema caches | The same schema object compiles as a return and fails as props, in either order |
| VR1–VR6 | `xmd run` | JSON alone on stdout, `--verbose` body output on stderr, failures non-zero with empty stdout |

---

## 14. Walked example: diagnostic journal

Given a document that references `<A />`, `<B />`, and an `exec` block:

```console
$ xmd README.md --journal ./run.jsonl
```

The CLI atomically creates `run.jsonl`, executes against the current
filesystem and process environment, and appends journal entries as operations finish:

```
[0] yield root  import_component __root__  → { path, content }
[1] yield root  import_component A         → { path, content }
[2] yield root  import_component B         → { path, content }
[3] yield root  exec "exec:date +%Y"       → { exitCode: 0, stdout: "2026\n" }
[4] close root  result: { status: "ok", value: "...full rendered output..." }
```

If execution is interrupted, the file may contain a partial trace. An
invocation with the same path fails before the document executes. The user
must preserve the trace for diagnosis or remove it before starting a new run.

---

## 15. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Root document treated as a component | Uniform resolution, parsing, and error handling |
| 2 | All paths are workspace-relative | Printed error portability and no absolute-path leakage |
| 3 | Resolution is an Effection Api | Pluggable middleware (search paths, aliases, glob) — runs inside `durableImportComponent` during live execution |
| 4 | `durableImportComponent` is a single journaled operation | Resolve + read in one `createDurableOperation`; one diagnostic journal entry per component |
| 5 | Parsing is runtime | Deterministic from file content, no journal needed |
| 6 | Info string modifiers are a middleware chain | `bash silent exec` — left-to-right wrapping, composable, extensible, compatible with all renderers |
| 7 | Each modifier is a factory that returns `Middleware<[], CodeBlockWorkflow>` | Factory captures params in closure; the block context is delivered contextually via `codeBlock()`/`useCodeBlock()` (§5.5); aligns with Effection v4.1's `Middleware<TArgs, TReturn>` |
| 8 | `useModifier` registers handlers on the scope | Scope-inherited — child scopes can override parent handlers for their subtree |
| 9 | `exec`/`eval` are terminal handlers, others are wrapping | Terminal handlers ignore `next`; wrapping handlers call `next()` and transform the result |
| 10 | `sample` handler delegates to Sample Api via `durableSample` | Two layers: handler (part of modifier chain) and Api (LLM middleware) — each composable independently |
| 11 | Cycle detection via hide sets, runtime | Deterministic from component graph, no journal |
| 12 | `<Content />` is the content slot | Valid JSX, familiar (Astro/React), zero parser changes |
| 13 | `{meta.key}` / `{props.key}` for interpolation | MDX-compatible expression syntax, parsed by regex |
| 16 | Props must be declared in `props` frontmatter | Undeclared props are rejected — components are contracts |
| 17 | `props` is a canonical draft-07 JSON Schema | The declared props interface compiles to a complete draft-07 schema validated by a shared Ajv instance (strict, `useDefaults`). Markdown frontmatter also spells it as a prop-name map, which normalizes to a closed object schema before compilation; no bespoke mini-language and no compatibility layer |
| 18 | Requiredness via a `required` array | Draft-07 `required` lists the props a caller must supply — the top-level frontmatter key with the map form, the schema's own key with the full form. No per-field `required` flag, no inferred requiredness |
| 19 | No declared props = closed empty-object schema | A component with no `props` uses `{ type: object, properties: {}, additionalProperties: false }` and accepts no props |
| 20 | Meta supports optional typed definitions | `meta:` key with JSON Schema subset for components that need schema validation on their own metadata |
| 21 | Prop validation is runtime, not durable | Deterministic from component definition + caller props — no journal entry needed |
| 22 | Components are semantic boundaries for markdown constructs | Bold, italic, links, code spans cannot span across a component or exec block — each text segment is healed independently |
| 23 | Remend runs after scanning, before interpolation | Heals incomplete markdown in text segments; `htmlTags: false` required — boundary scanner owns JSX completeness, remend owns markdown completeness |
| 24 | Healing is runtime, not journaled | Pure function of current text content; no journal entry |
| 25 | `CodeBlockContext` delivered contextually, not as a handler parameter | A scope-local `codeBlock()` provider covers exactly the chain execution; handlers read via `useCodeBlock()`; keeps middleware signature clean `Middleware<[], ...>` |
| 26 | Reusable `Middleware<TArgs, TReturn>` primitive in `@effectionx/middleware` | Same type as Effection v4.1's Api middleware; `combine()` composes arrays; decoupled from modifier-specific types; originally `src/middleware.ts`, extracted to shared package |
| 27 | `blockId` format: `eval:${componentName ?? "root"}:${index}` | Unique within a document run and stable enough to compare diagnostic traces |
| 28 | Acorn + magic-string for source transform | Acorn provides reliable ES2024 parsing; magic-string preserves source positions for accurate source maps without rebuilding AST |
| 29 | Execution mode auto-detected from AST | No modifier needed — `yield` in body → generator, `await` → async, neither → sync; mixed yield+await is a transform error |
| 30 | `data:` URI module compilation for eval blocks | Eval blocks are compiled into `data:application/typescript,...` URI modules and dynamically imported via `yield* call(() => import(dataUri))`. APIs are standard `import` statements in the generated module, resolved through Deno's import map. `new Function()` is used for expression props (simpler than `data:` URI for single expressions, no module imports needed) |
| 31 | `persist` uses a contextual flag, not direct wrapping | Wrapping the full modifier chain in `evalScope.eval()` hangs because durable effects can't interact with the journal from inside the eval scope's channel processor; instead `persist` makes `persistent` answer true, and `evalFactory` routes only the compiled VM block through `evalScope.eval()` |
| 32 | `evalScope` created before the journaled workflow | The channel processor and eval sender share an ancestor scope |
| 33 | Non-serializable bindings silently omitted from journal | Functions, class instances, and live objects remain in `env.values` during the current run but are absent from the diagnostic trace |
| 34 | Eval blocks produce no rendered output by default | Eval blocks primarily exist for bindings and side effects. The `output()` function (§4.7) optionally produces rendered output; without it, result is `{ output: "", exitCode: 0, stderr: "" }` |
| 35 | `@effectionx/middleware` replaces local `src/middleware.ts` | The middleware primitive was extracted to a shared package for reuse across the monorepo; import paths updated throughout |
| 36 | `daemon` is a terminal modifier that ignores `next` | Process lifetime ≠ command result; `exec` in the chain satisfies the §3.2 detection rule without invoking `durableExec` |
| 37 | `daemon` uses `evalScope`, not the durable run scope | Lifetime matches component expansion — daemon lives for `<children />` and dies with the component, not the whole document run |
| 38 | `daemon` produces no journal entry | The process is an ephemeral resource and starts on every run |
| 39 | Eval binding interpolation uses authored binding syntax | Bare `{name}` resolves authored eval/capture/loop/return bindings; dotted `{props.name}` traverses the validated props namespace, while `{meta.key}` remains text interpolation |
| 40 | Eval binding interpolation runs in the expansion engine, not inside modifier factories | Modifiers transform execution results — they are not responsible for preparing source text; one interpolation site in `expandSegments` is consistent with how text segment interpolation already works, and keeps modifier factories free of knowledge about the binding environment |
| 41 | Service allocation belongs to a host adapter | Holding an OS-selected port across spawn is host process and networking behavior; shared runtime and document code use provider-neutral `API.Service` |
| 42 | Service endpoints are live bindings | The endpoint identifies an execution-owned process and is reconstructed during partial replay, so it cannot enter durable eval, interpolation or the journal |
| 43 | `when` (from `@effectionx/converge`) is the polling VM global | `when` is the exported name from the package; the sandbox already contains it; no rename or addition needed |
| 44 | Provider lifecycle expressed as a component, not an `ExecuteOptions` field | Scope boundary is visible in the document tree; composable — multiple providers nest naturally via structured concurrency; no framework-level lifecycle hooks required |
| 45 | The XMD service handshake protocol is authenticated stdout | The host observes from before spawn, verifies version/token/host/port exactly and supervises the attached service continuously without a close-and-rebind race |
| 46 | Provider middleware reads an endpoint from the live overlay | The current endpoint is available to `ephemeral eval` while remaining invisible to durable effects and interpolation |
| 47 | Each component gets a fresh `EvalEnv` | The component's environment is installed as a scope-local `env` provider around body expansion, so eval blocks within a component share bindings but don't leak into parent or sibling components; critical for provider isolation |
| 48 | `output()` is a plain function, not `yield*` | Output is a synchronous side effect (mutating a ref), not an Effection operation; making it a function keeps the API simple and avoids requiring generator context just to set output text |
| 49 | `__output` stored alongside exports in journal | Avoids a separate journal entry; `__output` is extracted before merging into `env.values` to prevent namespace pollution |
| 50 | `renderChildren`/`render` are closures in `env.values`, not an Api | A Render Api would require middleware installation per component; closures are simpler and capture the expansion context at the injection point; they are non-serializable and silently omitted from the journal |
| 51 | `renderChildren`/`render` install the caller's environment and `parentEvalScope` as scope-local providers | Children are caller-provided content and expand in the caller's scope context; the component's `childEvalScope` sequential channel is for its own `persist eval` blocks, not for expanding caller content; children may create resources (nested components, daemons) but their lifecycle is bound by their place in the expansion tree; installing providers inside the closure ensures the correct context is visible regardless of which task it runs in |
| 52 | `durableSample` routes through `EvalScope` | Sample Api middleware installed by provider components with `persist ephemeral eval` lives in the eval scope's task hierarchy; routing through `evalScope.eval()` ensures the middleware chain is found |
| 53 | Sample component calls `Sample.operations.sample()` directly | The enclosing eval operation journals the complete block result |
| 54 | Sample component props default to empty string, not undefined | Defaults remain part of the validated `props` object; `model \|\| undefined` and `params \|\| undefined` preserve routing semantics without creating bare prop bindings |
| 55 | `daemon()` uses `shell: true` | Matches `bash exec` block semantics — the same command string passed to `bash -c` is passed to the shell; handles shell expansions and PATH lookups correctly |
| 56 | Provider installs middleware inside its invocation | Middleware closes over the current live endpoint and remains lexically scoped to the subtree that owns the service |
| 57 | Routing key is `model`, not a separate `name` prop | Model identity is the natural key — it unifies "which server to route to" with "which model to request"; a separate `name` prop would require keeping two values in sync with no added expressiveness |
| 58 | `context.model === undefined` routes to innermost provider | Omitting a model is the common case for single-provider documents; innermost-wins matches how middleware chains work — handlers installed later sit higher in the chain and are traversed first |
| 59 | Provider components use ordinary generated-module imports | Provider-specific client functions may be imported explicitly; executable.md supplies `Sample`, `when`, `fetch` and the contextual document bindings |
| 60 | Props namespaced in `env.values` at root and Markdown-component invocation | Validation completes before the exact object is installed as `env.values.props`; text and executable content use `{props.name}`, eval blocks read `props.name`, and declared fields are not spread as bare bindings |
| 61 | Provider HTTP calls use `@effectionx/fetch` | Calls remain Effection operations under structured cancellation and the provider's lexical middleware |
| 62 | The XMD service handshake and application health are separate | The handshake record proves the attached service owns the assigned endpoint; an application may still use `when` for a later domain-specific condition |
| 63 | `stdio: "inherit"` is the default for `daemon()` | During development, seeing server logs in the terminal is valuable; production deployments can pass `stdio: "ignore"`; the executable.md `daemonFactory` passes no stdio option, defaulting to `"inherit"` |
| 64 | `DocumentOutput` Api with single `output` operation | Extensible to progress/printed errors; middleware-composable via `scope.around`; single Api surface for all output concerns |
| 65 | Whitespace normalization is middleware, not post-processing | Stateful across calls; composes with other middleware; can be disabled via `--raw`; mutable closure state scoped per `useNormalizedOutput()` call |
| 66 | Terminal formatting is middleware, not a separate renderer | Composes with normalization; conditional on TTY; disabled for piped output; uses `marked-terminal` with `async: false` |
| 67 | Channel-based delivery, not direct `process.stdout.write` | Decouples production from consumption; enables buffered collection for piped output; consumer task lifetime tied to document run scope; `channel.close()` in `finally` block guarantees consumer exits cleanly |
| 68 | Per-root-segment emission for roots without `<Output>`; full buffering for roots that declare it | Streaming UX for the common case — root segments are sequential and independent, and component-internal expansion is recursive and buffered. A root declaring top-level `<Output>` (§6.9) buffers completely and emits the selected regions only after successful expansion, so a later documentation failure yields no partial output; an empty selection emits nothing |
| 69 | `blockId` counter threaded through expansion context | Per-segment expansion resets `result.length`; mutable counter preserves unique diagnostic IDs; counter guarded by expansion scope cancellation |
| 70 | `output()` wrapped in `ephemeral()` | Output emission is a non-durable side effect; journal records durable effects only; output text is derived from journaled expansion results; all middleware/side effects execute on the ephemeral side |
| 71 | Middleware installation order: normalize outer, terminal inner, channel innermost | `scope.around` later-installed handlers wrap earlier ones; execution flows outer → inner: normalize → terminal → channel; install order is reverse of execution order; must be documented to prevent reordering |
| 72 | `channel.send()` must be `yield*`'d | Ensures backpressure and cancellation safety — no text "in flight" when scope tears down; without `yield*`, buffering issues or silent cancellation may occur |
| 73 | `DocumentExecution` with `withResolvers` | Execution is both an `Operation<Result<string>>` (`yield*` for the completion Result) and has `.output` stream for chunks; once a handle exists every failure resolves `Err(error)` — completion never throws, so middleware (e.g. testing) can map outcomes without exception control flow |
| 74 | Function components receive props directly, not wrapped | `function*(props)` not `function*({ props })` — eliminates unnecessary destructuring; props are already validated by the expansion engine before the function is called |
| 75 | Function-component content is contextual, not a function argument | Decouples function components from the expansion engine's API surface; leaf components don't need to ignore an `expandChildren` parameter; Effection-idiomatic — same contextual pattern as `env`/`evalScope`; supports named slots via `content("header")`, with `useContent()` kept as a compatibility alias |
| 76 | `.md` wins over `.ts` in resolution | Backward compatibility — existing markdown components are not shadowed by TypeScript files added later; explicit — if both exist, the human-readable markdown is preferred |
| 77 | Function component imported on every run | The current module must execute because functions are not serialized into a trace |
| 78 | Internal durable-streams package | Provides journaling for the core runtime |
| 79 | `as` is a reserved expansion prop | `as` is consumed by the expansion engine (not component props), stripped before validation, and used to bind rendered output into `env.values` |
| 80 | `<Capture>` is the inline binding directive | Captures arbitrary inline rendered content while preserving JSX ergonomics and a single binding-target syntax (`as`) |
| 81 | Component `as` writes to invocation-site env | Captured bindings must be visible to subsequent siblings/eval blocks where the invocation appears |
| 82 | `<Capture>` does not create a new env/scope | Capture is structural (like `<Content />`), not a component boundary; middleware/scope behavior remains deterministic |
| 83 | Capture trims trailing whitespace | Exec stdout commonly ends with newline; trimming avoids downstream interpolation/comparison bugs while preserving leading/interior whitespace |
| 84 | Capture assignment is not independently journaled | Captured value is derived during current expansion; no extra journal entry is needed |
| 88 | Eval binding interpolation extends to text segments | Documents should be readable prose with embedded data references, not JavaScript template literals inside eval blocks |
| 89 | Lexical props namespace and authored binding precedence | `{props.*}` uses the validated component/root namespace, projected caller content keeps the caller's props object, authored component content uses the callee's frame, and a local binding named `props` follows normal shadow/restoration rules |
| 90 | `\{` escaping applies to both passes | Consistent escaping behavior regardless of which pass would match; pre-existing gap in §6.6 fixed for both code blocks and text segments |
| 85 | Eval block `return` as rendered output | Eval blocks can produce output via `return "text"` in addition to `output("text")`; `output()` wins if both used; null/undefined returns produce no output; lets a component's whole body be one conditional expression |
| 86 | `sample` modifier removed | All LLM calls go through the `<Sample>` component; provider-specific call helpers are not built-in modifier behavior |
| 87 | `SampleContext` simplified to content-centric shape | Changed from exec-centric `{stdout, stderr, exitCode, command, language}` to content-centric `{content, model?, params?, system?, componentName?}`; providers build their own messages directly instead of relying on `buildDefaultMessages` |
| 91 | Projected children preserve caller props without changing ordinary lookup | Children substituted via `<Content />` preserve the caller's metadata, validated props object, hide set, and counter. Structural projection keeps the existing ordinary-binding layering of the authored/current frame; `renderChildren()` and `useContent()` retain the caller's ordinary environment. Authored content keeps the component frame. |
| 92 | Multi-level projection preserves caller props | When `expandComponent` receives `projectedEnv`, it layers ordinary bindings while retaining the lexical caller's `props` object. Nested projections never replace caller props with the callee's initial namespace. |
| 93 | AST-based user import extraction in eval blocks | `ImportDeclaration` nodes in eval blocks are extracted via acorn's `allowImportExportEverywhere` and hoisted to module top level by `compileBlock`. TypeScript `import type` normalized to spaces before parse, extracted from original source. |
| 94 | `<Capture select>` uses CSS selectors via remark + `unist-util-select` | Standard CSS selector syntax on markdown AST (mdast); reuses existing remark dependency; supports attribute selectors, combinators, pseudo-classes; matches Web platform conventions for querying tree structures |
| 95 | `select` falls back to full content on no match | Non-destructive — authors can add `select` to existing Captures without breaking behavior if the selector doesn't match; avoids silent data loss |
| 96 | Literal nodes use `.value`, parent nodes use `mdast-util-to-string` | Code blocks store text in `.value` (no child nodes); paragraphs/headings have child Text nodes requiring recursive extraction; two extraction strategies cover all mdast node types |
