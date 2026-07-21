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

inputs:
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
paths relative to cwd. Runtime helpers never see
absolute paths. Component search directories
(`["./components", "./"]`) are relative. Resolved paths in the
journal (`"components/Greeting.md"`) are relative. Code block `exec`
commands run with cwd as the working directory.

---

## 2. Segment IR

The boundary scanner (from prior research — 12-state JSX state machine)
parses raw markdown text into a flat sequence of segments. Segments are
the intermediate representation between parsing and expansion.

### 2.1 Segment types

```typescript
type Segment =
  | TextSegment
  | ComponentInvocation
  | ExecutableCodeBlock
  | ExecOutputSegment
  | ErrorSegment;

interface TextSegment {
  type: "text";
  content: string;
}

interface ComponentInvocation {
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
single `ComponentInvocation` with no children. Block tags
(`<Comp>...</Comp>`) produce a `ComponentInvocation` whose `children`
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

**`daemon`** — spawns a long-running subprocess and immediately
returns control to the document. The process is alive for the
duration of component expansion and killed when the component scope
closes. Unlike `exec`, it produces no journal entry and never waits
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

| Property | `exec` | `daemon` |
|---|---|---|
| Waits for exit | Yes | No |
| Journal entry | Yes — stdout/stderr/exitCode | No |
| Crash detection | Via non-zero exit code in result | Via `daemon()` from `@effectionx/process` throwing |
| Lifetime | Until command exits | Until component scope closes |
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
indefinitely. When the eval scope closes (component expansion
completes), the forked task is cancelled, which tears down the daemon
and terminates the subprocess. No explicit teardown, no finalizer
registration, no lifecycle hooks are required — Effection's structured
concurrency handles it.

**Crash propagation.** If the process exits prematurely, `daemon()`
throws with a descriptive error. This error propagates to the
`evalScope`, which tears it down. The eval scope teardown propagates
to the component expansion, failing it before any child blocks are
attempted. The error surfaces as an `ErrorSegment`.

**Repeated-run behavior.** `daemon` runs on every document execution. The
process starts, runs for the duration of expansion, and is terminated when
the component scope closes.

#### Built-in wrapping handlers

**`silent`** — calls `next()` (the inner chain runs, effects are
journaled), then returns empty output:

```typescript
const silentFactory: ModifierFactory = (_params) =>
  (_args, next) => function* () {
    yield* next();   // inner chain runs — exec journals its result
    return { output: "", exitCode: 0, stderr: "" };
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
the block if it overruns. The silent handler discards the output.

#### Overriding per-scope

Because factories are stored in a registry that can be extended,
custom modifiers can be provided via `ExecuteOptions`:

```typescript
yield* execute({
  docPath: "README.md",
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
installed by `persist eval` blocks (e.g., `LlamafileProvider`'s
`Sample.around()`) is visible — `evalScope.eval()` runs the operation in
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

**`silent exec`** — `exec` runs the command and journals the
result as usual. `silent` calls `next()` (so exec runs), then
returns empty output. No extra journal entry from `silent`.

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

### 4.2 Module compilation via data: URI

Eval blocks are compiled into `data:` URI TypeScript modules and
dynamically imported (`compileBlock` in `src/eval-context.ts`,
delegating to the platform compiler middleware). Eval blocks can use
standard `import` statements, resolved through Deno's import map.

#### Standard imports

Every generated eval module is prepended with standard imports:

```typescript
import { sleep, spawn, call, resource, useScope, createChannel, each, suspend, createSignal } from "effection";
import { when } from "@effectionx/converge";
import { fetch } from "@effectionx/fetch";
import { useContent, Sample } from "@executablemd/core";
import { findFreePort } from "@executablemd/runtime";
```

These imports resolve through Deno's import map (`deno.json`).
`@executablemd/core` re-exports executable.md-specific APIs from its root
barrel (`core/mod.ts`); `findFreePort` comes from `@executablemd/runtime`
(and is also re-exported by `core/mod.ts`).

The exact list lives in the `STANDARD_IMPORTS` constant, which both
compilers share (`src/deno-compiler.ts`, `src/temp-file-compiler.ts`).

#### `findFreePort`

`findFreePort` is available in eval blocks as a standard import
(`@executablemd/runtime`). It is an Effection
`Operation<number>`. It binds a `node:net` TCP server to
port 0 (OS-assigned), reads the port number, and closes the server.
It uses Effection's structured concurrency primitives (`once` from
`@effectionx/node` for event bridging, `race` for error handling):

```typescript
import { race } from "effection";
import { once } from "@effectionx/node";
import { createServer } from "node:net";

export function* findFreePort(): Operation<number> {
  const server = createServer();

  const listening = once(server, "listening");
  const error = once<[Error]>(server, "error");

  server.listen(0);

  try {
    const rethrowError: Operation<never> = {
      *[Symbol.iterator]() {
        const [err] = yield* error;
        throw err;
      },
    } as Operation<never>;

    yield* race([listening, rethrowError]);

    const addr = server.address();
    if (!addr || typeof addr !== "object") {
      throw new Error("findFreePort: unexpected address format");
    }
    return addr.port;
  } finally {
    server.close();
  }
}
```

The returned port number is a JSON-serializable primitive. When used in an
eval block, it is exported to `env.values` and included in that block's
diagnostic result. Each new run calls `findFreePort()` again.

There is a small race window between closing the server and the
caller binding the port — acceptable in practice, since daemon
processes are expected to bind immediately after allocation.

#### `when`

`when` from `@effectionx/converge` retries an inner operation with
backoff until it completes without throwing. It is the idiomatic way
to poll a readiness endpoint:

```typescript
yield* when(function* () {
  yield* fetch(`http://127.0.0.1:${port}/health`).expect();
});
```

`fetch().expect()` from `@effectionx/fetch` throws `HttpError` on
non-2xx responses. Network-level errors (connection refused before the
daemon is listening) throw natively. `when` catches both and retries
until the assertion passes or the timeout expires.

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

### 4.3 Binding environment

```typescript
// src/types.ts
export interface EvalEnv {
  values: Record<string, unknown>;
}
```

Created fresh at the start of component expansion. Each eval block reads
bindings from `values` (via env preamble) and writes new bindings back
(via env-write transforms). The current environment is read contextually
via the `env` value (§5.5); the expansion engine provides it
scope-locally around each component body, so eval blocks within a
component share bindings without leaking into parent or sibling
components.

### 4.4 Eval scope and resource lifetime

Each document gets a dedicated **eval scope** — an Effection scope whose
lifetime matches the document's expansion. Resources spawned by `persist`
blocks are retained in this scope until expansion completes. The current
eval scope is read contextually via the `evalScope` value (§5.5).

The eval scope is created in `execute()` (§8.1) **before**
`durableRun` via `resource(useEvalScope())`. This is critical:
`evalScope.eval()` sends to a channel whose processor must be
reachable by the Effection scheduler — this only works when both sender
and processor share an ancestor scope outside the durable execution
boundary.

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
   eval scope is destroyed (when component expansion completes)

### 4.5 Eval journal entries

#### What is journaled

`evalFactory` wraps execution in `createDurableOperation`. Diagnostic journal
shape:

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
| `src/eval-context.ts` | `compileBlock()` (data: URI) |
| `src/deno-compiler.ts` | `useDenoCompiler()` — data: URI compiler middleware for Deno; owns `STANDARD_IMPORTS` |
| `src/temp-file-compiler.ts` | `useTempFileCompiler()` — temp-file compiler middleware for Node/Bun; owns `STANDARD_IMPORTS` |
| `src/content-context.ts` | `useContent()` — content slot access for function components |
| `test-support/bdd.ts` | Deno-native BDD shim — wraps `@std/testing/bdd` with Effection test adapter |
| `src/eval-handler.ts` | `evalFactory` |
| `src/eval-interpolate.ts` | `interpolateEvalBindings()` — bare `{name}` substitution |
| `src/modifiers/persist.ts` | `persistFactory` |
| `src/modifiers/timeout.ts` | `timeoutFactory`, `parseDuration()` |
| `src/modifiers/daemon.ts` | `daemonFactory` — long-running subprocess terminal modifier |
| `src/sample-api.ts` | `Sample` Api definition (§3.4) — LLM middleware surface |
| `runtime/find-free-port.ts` | `findFreePort()` — OS port allocation via `node:net` (separate `runtime` workspace package) |
| `src/api.ts` | Document Output Api definition, exports `output` (§9.2) |
| `src/collect.ts` | `collect()` — stream consumption helper, returns `Result<string>` |
| `src/output/mod.ts` | Barrel export for output middleware |
| `src/output/normalize.ts` | `useNormalizedOutput()` — whitespace normalization middleware (§9.4) |
| `src/output/terminal.ts` | `useTerminalOutput()` — terminal ANSI formatting middleware (§9.5) |
| `cli/src/cli.ts` | CLI entrypoint (separate `cli` workspace package) with `--verbose`, `--journal`, and `--raw` flags; Output Api stream consumption (§9.6) |
| `cli/src/file-stream.ts` | `FileStream` — JSONL-backed `DurableStream` implementation |

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
a plain object — `null`, arrays, and primitives are rejected with a diagnostic
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
processes the component body. They capture the expansion context
(meta, validated props, hide set, eval scope) at injection time.

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

Both install the caller's binding environment and eval scope as
scope-local Component providers (§5.5) around their `expandSegments`
calls, so the full expansion context is available regardless of which
task the closure runs in (e.g., inside `evalScope.eval()`).

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
both the component's own metadata and its input interface.

```markdown
<!-- components/Greeting.md -->
---
emoji: 👋

inputs:
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

Frontmatter has two sections: **meta** (the component's own data) and
**inputs** (the declared input interface).

**Meta** — every frontmatter key except `inputs` is a meta value.
Meta values are the component's own constants, accessible via
`{meta.key}` in the body. They can be any YAML value: strings,
numbers, booleans, arrays, objects.

**Inputs** — the reserved `inputs` key declares the props callers can
pass. Its value is a complete JSON Schema (draft-07) describing the
props object.

#### Input definitions

`inputs` is a canonical JSON Schema (draft-07) whose root is an object
schema. `properties` names the accepted props, and each property value
is an ordinary draft-07 subschema. Requiredness is expressed by the
parent-level `required` array — never a per-field flag. An object that
rejects unknown keys sets `additionalProperties: false`.

```yaml
inputs:
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
- **No declared inputs.** A component that declares no `inputs` uses the
  closed empty-object schema
  `{ type: object, properties: {}, additionalProperties: false }` and so
  accepts no props.
- **Defaults.** A subschema's `default` fills the prop when the caller
  omits it (§6.5). Object-property defaults fill missing properties
  recursively.
- **Enums and the rest of draft-07.** `enum`, `items`, nested
  `properties`, and every other draft-07 keyword apply. `format` is an
  annotation only, never an assertion.

**Project contract.** The root schema MUST declare `type: "object"`. The
reserved prop names `slot` and `as` (§6.3.5) cannot be declared as
properties. Schemas are self-contained: only local `$ref`s are allowed
(no remote references), and asynchronous schemas (`$async: true`) are
rejected. These rules are enforced when the component definition loads.

There is no shorthand, no per-field `required`, no inferred
requiredness, and no `type: any`. The earlier mini-language has been
replaced wholesale with canonical JSON Schema, with no compatibility
layer.

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

inputs:
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
`inputs` are meta values (the simple case).

This convention is independent of `inputs`, which is always a canonical
draft-07 JSON Schema — it lets a component's own metadata range from
minimal (plain key-value pairs) to typed defaults.

#### 5.1.2 Function components

Function components are TypeScript files (`.ts`) that export an
Effection generator function as their default export. They receive
validated props directly and return rendered output as a string.

```typescript
// components/Greeting.ts
import type { Json } from "@executablemd/core";

export const inputs = {
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
export interface FunctionComponent {
  (props: Record<string, Json>): Operation<string>;
}

export interface FunctionComponentDefinition {
  kind: "function";
  name: string;
  path: string;
  inputs: InputSchema;   // canonical draft-07 JSON Schema (§5.1.1)
  fn: FunctionComponent;
}
```

**Input declaration.** Function components declare their inputs via
a named `export const inputs = { ... }` holding a canonical draft-07
JSON Schema (§5.1.1), enforced by the same project contract as Markdown
components at load time. This is equivalent to the `inputs:` key in
markdown component frontmatter. If no `inputs`
export exists, the component accepts no props.

**Children via `useContent()`.** Function components access children
contextually, not from props. The expansion engine installs a
scope-local content provider (§5.5) around each function component
invocation. Components that need rendered children call
`yield* useContent()`:

```typescript
// components/Card.ts
import { useContent } from "@executablemd/core";

export default function*(props: Record<string, Json>) {
  const content = yield* useContent();
  return `<div class="card">\n${content}\n</div>`;
}
```

Named slots are supported — `useContent("header")` returns the
content for a specific slot, matching `<Content slot="header" />`
in markdown components:

```typescript
const header = yield* useContent("header");
const body = yield* useContent();  // default slot
```

Calling `useContent()` outside a function component invocation reports
a clear missing-provider error. The provider is removed when the
invocation completes, so content never leaks into sibling expansions.

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

```typescript
interface ImportResult {
  path: string;           // Workspace-relative, from Resolve Api
  content: string;        // Raw file content
}

function* durableImportComponent(
  name: string,
): Workflow<ComponentDefinition> {
  // Single durable effect: resolve + read
  const result = (yield createDurableOperation<ImportResult>(
    { type: "import_component", name },
    function* () {
      // Resolve via Api — middleware runs here during live execution
      const { path } = yield* Resolve.operations.resolve(name);

      // Read file via runtime
      const readTextFile = API.Fs.operations.readTextFile;
      const content = yield* readTextFile(path);

      return { path, content } as ImportResult;
    },
  )) as ImportResult;

  // Function component: .ts file — import() the module
  if (result.path.endsWith(".ts")) {
    const absolutePath = `${process.cwd()}/${result.path}`;
    const mod = yield* call(() => import(`file://${absolutePath}`));
    return {
      kind: "function" as const,
      name,
      path: result.path,
      inputs: mod.inputs === undefined
        ? { type: "object", properties: {}, additionalProperties: false }
        : parseJsonObject(mod.inputs),
      fn: mod.default,
    };
  }

  // Markdown component: parse at runtime — deterministic from content
  const { data: frontmatter, content: body } = grayMatter(result.content);
  const { meta, inputs } = parseFrontmatter(frontmatter);
  const bodySegments = scanSegments(body);

  return {
    name,
    path: result.path,
    meta,
    inputs,
    bodySegments,
  };
}
```

**Journal shape:**

```json
{ "type": "import_component", "name": "Greeting" }
{ "status": "ok", "value": {
    "path": "components/Greeting.md",
    "content": "---\nemoji: 👋\n..." } }
```

One journal entry per component. The entry captures both *which file was found*
(path) and *what was in it* (content) for current-run diagnostics.

```typescript
// A component's declared input interface is a canonical draft-07 JSON
// Schema object (§5.1.1). Held as a plain JSON object so it doubles as a
// stable key for the compiled-validator cache.
type InputSchema = JsonObject;

interface ComponentDefinition {
  name: string;
  path: string;
  meta: Record<string, unknown>;   // Resolved meta values
  inputs: InputSchema;             // Declared input interface (draft-07 schema)
  bodySegments: Segment[];         // Parsed body (after frontmatter)
}
```

#### Frontmatter parsing

The frontmatter root is narrowed from `unknown` through the shared JSON
parser (§5.1.1), so a non-JSON value anywhere rejects the frontmatter
before Ajv sees it. `inputs` is passed through as the component's JSON
Schema; parsing does not rewrite it into any other shape. The project
contract (root `type: "object"`, reserved `slot`/`as`, local refs only,
no `$async`) is enforced later, when the schema is compiled to a validator
(§6.5). Meta is everything except `inputs`; a `meta` entry written as a
typed definition (an object with a `type` key) resolves to its `default`.

```typescript
function parseFrontmatter(raw: unknown): {
  meta: Record<string, unknown>;
  inputs: InputSchema;
} {
  const root: JsonObject = raw === null || raw === undefined ? {} : parseJsonObject(raw);

  // `inputs` is the component's JSON Schema. Absent → the closed
  // empty-object schema. A fresh object per component keeps the
  // compiled-validator cache from sharing state across definitions.
  const inputs: InputSchema = root.inputs === undefined
    ? { type: "object", properties: {}, additionalProperties: false }
    : parseJsonObject(root.inputs);

  const meta: Record<string, unknown> = {};
  const rawMeta = root.meta;
  if (isPlainObject(rawMeta)) {
    for (const [key, value] of Object.entries(rawMeta)) {
      meta[key] = isTypedDefinition(value) ? value.default : value;
    }
  } else {
    for (const [key, value] of Object.entries(root)) {
      if (key !== "inputs") {
        meta[key] = value;
      }
    }
  }

  return { meta, inputs };
}

/** A typed `meta` definition — an object with a `type` key. Used only to
 *  resolve typed-meta defaults; unrelated to the `inputs` schema. */
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

### 5.5 The Component Api

Expansion's context-dependent operations are exposed through one public
Effection Api. `Component` is the Api value, `ComponentApi` its
interface, and each operation is also exported directly:

| Operation | Meaning | Without a provider |
|---|---|---|
| `importComponent(name)` | Resolve and import a component; `"__root__"` is the root document | throws a missing-provider error |
| `applyModifiers(modifiers, block)` | Execute a code block through its modifier chain | throws a missing-provider error |
| `raise(error)` | Report an `ErrorSegment` under the ambient error policy (§6.9) | returns the supplied segment |
| `env` | The current binding environment (§4.3) | `undefined` |
| `evalScope` | The current eval scope (§4.4) | `undefined` |
| `codeBlock()` | The code block executing through the modifier chain (§3.3) | throws a missing-provider error |
| `persistent` | Whether the current block runs with persistent lifetime (§4.4) | `false` |
| `content(slot?)` | Render the invoking component's children (§5.1, §6.3) | throws a missing-provider error |

`env`, `evalScope`, and `persistent` are value operations — read without
invocation (`yield* env`); a provider is middleware returning the value.
`useCodeBlock()` and `useContent()` remain as ergonomic aliases backed
by `codeBlock()` and `content(slot?)`.

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
  props are validated against the declared inputs (§6.3.5, §6.5).
- **Body expansion.** The caller's children are substituted into `<Content />`
  positions (§6.3), and the body is expanded in a fresh binding environment
  seeded with the validated props, exposing `renderChildren()` / `render()`
  (§4.8) to eval blocks. Expression props resolve in the caller's scope. When
  the component declares `<Output>`, its placement is validated before any body
  content executes and only its declared regions render (§6.9).
- **Capture (`as=`).** With `as="binding"`, the rendered result is written to
  that binding in the caller's environment and nothing is emitted at the call
  site — capturing only the selected output when the component declares
  `<Output>`.

Cycle detection and depth limiting are runtime operations — no journal
entries. They are deterministic from the component dependency graph read in
the current run.

### 6.3 Content slots: `<Content />` and `<Content slot="name" />`

When the boundary scanner encounters `<Content />` inside a component
body, it produces a `ComponentInvocation` with `name: "Content"`.
During expansion, this is a special case — it is not resolved from the
file system. Instead, it is replaced by the caller's children,
partitioned by slot assignment.

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
if and only if it is a `ComponentInvocation` segment with a `slot`
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

#### 6.3.4 Updated `substituteContent`

```typescript
function substituteContent(
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
): Segment[] {
  const slots = partitionBySlot(children);
  return bodySegments.flatMap((segment) => {
    if (segment.type === "component" && segment.name === "Content") {
      const targetSlot = segment.props.slot as string | undefined;
      if (targetSlot !== undefined) {
        // Named slot projection — strip slot prop from each child
        return (slots.named.get(targetSlot) ?? []).map(stripSlotProp);
      }
      // Default slot projection
      return slots.default;
    }
    if (segment.type === "text") {
      return [{
        ...segment,
        content: interpolate(segment.content, meta, props),
      }];
    }
    return [segment];
  });
}
```

#### 6.3.5 Reserved prop names

The names `slot` and `as` are reserved. Declaring either in a
component's `inputs` frontmatter is a validation error.

- `slot` is consumed during slot partitioning and stripped before prop
  validation.
- `as` is consumed by binding capture and stripped before prop
  validation.

In both cases, the child component never sees the reserved prop in its
`validatedProps`.

#### 6.3.6 Interaction with `renderChildren()`

`renderChildren()` renders **all** children (all slots combined), not
just the default slot. This preserves backward compatibility — existing
components that use `renderChildren()` continue to receive all content.

#### 6.3.7 Multiple projections

If the component body does not contain `<Content />`, children from the
invocation site are silently discarded. If the component body contains
multiple `<Content />` or multiple `<Content slot="X" />`, each is
replaced independently (all receive the same children for that slot).

### 6.4 Frontmatter interpolation: `{meta.key}` and `{props.key}`

Inside component text segments, `{meta.key}` references resolve against
the component's own frontmatter. `{props.key}` references resolve
against the JSX props passed from the invocation site.

```typescript
function interpolate(
  text: string,
  meta: Record<string, unknown>,
  props: Record<string, Json>,
): string {
  return text.replace(/\{(meta|props)\.([^}]+)\}/g, (match, namespace, keyPath) => {
    const source = namespace === "meta" ? meta : props;
    const value = getNestedValue(source, keyPath);
    if (value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce(
    (current, key) => (current as Record<string, unknown>)?.[key],
    obj as unknown,
  );
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
  → interpolate {meta.key}, {props.key}         ← first pass
  → interpolateEvalBindings {name}              ← second pass
  → output
```

The second pass (`interpolateEvalBindings`) runs on text segments
when an `EvalEnv` is present on the scope. It resolves bare `{name}`
references from `env.values`. This allows eval block exports to flow
into surrounding prose naturally:

````markdown
```ts eval
const port = yield* findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
```

Server running at {baseUrl} on port {port}.
````

Renders: `Server running at http://127.0.0.1:49821 on port 49821.`

**Precedence:** `{meta.*}` and `{props.*}` resolve first because they
are the component's declared interface. If a component declares
`inputs: { title: ... }` and an eval block also exports `title`, the
prop wins (accessed via `{props.title}`). Bare `{title}` resolves via
the second pass against `env.values`. There is no actual collision
because the two passes match different syntax: dotted (`{ns.key}`) vs
bare (`{identifier}`).

**Escaping:** `\{name}` is left as literal `{name}` in the output.
Both passes respect `\{` escaping — the backslash is consumed and
the brace is preserved as a literal character.

**No EvalEnv:** If no `EvalEnv` is on the scope (e.g., text outside
component expansion), the second pass is skipped and bare `{name}`
references are left verbatim.

### 6.5 Prop validation

Components only accept props described by their `inputs` schema. When
the root object is closed (`additionalProperties: false`), undeclared
props are rejected; missing required props are rejected; and default
values fill in for omitted props. Validation is by [Ajv](https://ajv.js.org).

```typescript
function validateProps(
  componentName: string,
  callerProps: Record<string, Json>,
  schema: InputSchema,
): Record<string, Json> {
  const validate = compileInputSchema(schema);   // cached per schema
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

- the root input schema MUST declare `type: "object"`;
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

Behavior:

1. Expand children in the **current env/scope** (no new `EvalEnv`, no
   new `EvalScope`).
2. Render children to string.
3. Trim trailing whitespace (`/\s+$/`).
4. If `select` prop is present, apply CSS selector extraction (see below).
5. Store the resulting string in `env.values[as]`.
6. Produce no output segment.

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

The `ComponentInvocation` segment has an `expressions` field that
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

The `expressions` field is always present on `ComponentInvocation`
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
`inputs` schema are applied before interpolation, so `{props.greeting}`
resolves to `"Hello"` even if the caller wrote `<Greeting name="world" />`
(assuming the `greeting` property declares `default: "Hello"`).

Props also affect expansion when passed through to child components:

```markdown
<!-- Wrapper.md -->
---
inputs:
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
construction. Only JSON-serializable values are supported; function props are
outside the component contract.

#### Components with no inputs

A component with no `inputs` key in its frontmatter accepts no props.
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
survive and the ambient raise policy applies to them exactly as elsewhere. The
loop is rendered to a string only when `as` captures it (transported errors
are re-raised before capture so a captured loop never hides an error).

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

### 6.6 Eval binding interpolation

Bare `{name}` references (no namespace prefix) resolve against
`env.values` — the eval binding environment populated by preceding
`eval` blocks within the same component. This applies to both
**code block content** and **text segments** (see §6.4 for the text
segment interpolation pipeline).

````markdown
```ts eval
const port = yield* findFreePort();
```

```bash daemon exec
./server --port {port}
```
````

`{port}` resolves to the number exported by the first block. The
substituted content is used to build the subprocess command.

#### Interpolation syntax and precedence

Bare `{name}` references use JavaScript identifier syntax:

```
\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}
```

Namespaced references (`{meta.*}`, `{props.*}`) contain a `.` and
are excluded — they are handled by the existing interpolation pass
for text segments. Bare references only match against `env.values`.
If `env.values` has no key `name`, the reference `{name}` is left
verbatim. Non-string values are converted via `String()`.

Note: `{meta.*}` and `{props.*}` interpolation applies only to
**text segments**, not to code block content. Code blocks receive
only eval binding interpolation (`{name}`). To use a prop value in a
code block, capture it into a binding via an `eval` block first.
Text segments receive both passes: `{meta.*}`/`{props.*}` first,
then bare `{name}` from `env.values`.

#### Where interpolation runs

Eval binding interpolation runs in `expandSegments` in two places:

1. **Code blocks** — immediately before the modifier chain is composed
   for a `codeBlock` segment. By the time any modifier factory receives
   `ctx.content`, the content is already fully interpolated — modifiers
   are not responsible for text preparation.

2. **Text segments** — after `{meta.*}`/`{props.*}` interpolation
   (§6.4). The second pass resolves bare `{name}` references from
   `env.values` when an `EvalEnv` is present on the scope.

Eval blocks skip interpolation entirely — they access bindings directly
via the env preamble (`const { name } = env;`). Interpolating would
mangle JS template literals like `` `${name}` `` into `$<value>`.

```typescript
function interpolateEvalBindings(
  content: string,
  bindings: Record<string, unknown>,
): string {
  // Protect escaped braces: \{ → placeholder
  const escaped = content.replaceAll("\\{", PLACEHOLDER);
  const interpolated = escaped.replace(
    /\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g,
    (match, key) => key in bindings ? String(bindings[key]) : match,
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

A **provider component** is a regular markdown component whose body
follows a structured pattern that manages background process lifecycle
for its subtree. It composes `eval` + `daemon` + `eval` (readiness)
+ `eval` (middleware install) + `<children />` into a reusable
component — no framework-level configuration, no `ExecuteOptions`
changes.

#### Structure

1. An `eval` block that allocates resources and exports bindings
   (port, URLs).
2. A `daemon` block that starts the background process using those
   bindings.
3. An `eval` block that polls for readiness using `when`.
4. An `eval` block that installs Sample Api middleware, closing over
   `baseUrl` and `model`.
5. `<children />` — the subtree that uses the running process.

#### `LlamafileProvider.md` — standard library component

**File:** `components/LlamafileProvider.md`

This file is part of the executable.md standard library and is distributed
alongside the executable.md package. It is a regular markdown component — no
code changes to the executable.md runtime are required to add it.

````markdown
---
inputs:
  type: object
  properties:
    model:
      type: string
      description: >
        Model identifier. Serves two purposes: it is passed as the `model` field
        in every /v1/chat/completions request, and it is the routing key that
        sample calls use to target this provider. Must be unique among all
        LlamafileProvider instances active simultaneously in the same document run.
        Example: "phi3-mini", "qwen3-0.6b"
    command:
      type: string
      description: >
        Shell command to start the llamafile or llama.cpp server.
        {port} is substituted with the allocated port number before execution.
        Example: "./phi3-mini.llamafile --nobrowser"
  required: [model, command]
  additionalProperties: false
---

```ts eval
const port = yield* findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
```

```bash daemon exec
{command} --port {port}
```

```ts eval
yield* when(function* () {
  yield* (yield* fetch(`${baseUrl}/health`)).expect();
});
```

```ts eval
// Install Sample Api middleware on the current component scope.
// baseUrl and model are closed over here — no context lookup at call time.
// Routing: if context.model matches our model (or is unspecified), handle it.
// Otherwise pass through to the next handler (an outer provider or the default).
const scope = yield* useScope();
scope.around(Sample, function* ([context], next) {
  if (context.model !== undefined && context.model !== model) {
    return yield* next(context);
  }

  const messages = [];
  if (context.system) {
    messages.push({ role: "system", content: context.system });
  }
  messages.push({ role: "user", content: context.content });

  const result = yield* fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048 }),
  })
    .expect()
    .json();

  return result.choices[0].message.content;
});
```

<children />
````

#### Prop-to-binding requirement (DEC-EX-09)

Code block content uses bare `{name}` binding interpolation from
`env.values` (§6.6). `{command}` in the daemon block and `model` in
the middleware eval block must be present in `env.values` when those
blocks run.

Both are declared props, not eval results — so they are not
automatically in `env.values`. The expansion engine must pre-populate
`env.values` with all declared prop values at component invocation
time, before any block executes:

```typescript
// In expandComponent(), before block execution:
const componentEnv: EvalEnv = { values: { ...validatedProps } };
```

This makes all props available as bare bindings without any explicit
capture step in the component body. It is consistent with how
`findFreePort()` results enter `env.values`.

#### Execution sequence

**Block 1 — resource allocation:**
`findFreePort()` is available as a VM global. The eval block exports
`port` and `baseUrl` to `env.values`. The eval operation journals the result.

**Block 2 — daemon spawn:**
`{port}` is substituted from `env.values` into the command content
before `buildCommand` runs. `{command}` is also substituted from
`env.values` (populated from props via DEC-EX-09). The resulting
command is forked into the eval scope. Control returns immediately.
No journal entry.

**Block 3 — readiness:**
`when` polls with retries until the server responds. The eval operation
journals the result.

**Block 4 — middleware install:**
`Sample` and `fetch` are standard imports in the generated
eval module (via `@executablemd/core` and `@effectionx/fetch`, §4.2). The
middleware closes over `baseUrl` and `model` at install time and issues the
`/v1/chat/completions` request inline. Routing:
if `context.model` matches the provider's model (or is unspecified),
handle it; otherwise pass through via `next()`.

**`<children />`:**
Child expansion runs with the server alive and ready. `sample` calls
in children reach the server at `baseUrl`.

**Component scope closes:**
The eval scope closes. The daemon task is cancelled. The subprocess
is terminated.

#### Usage examples

**Single provider:**

```markdown
<LlamafileProvider model="phi3-mini" command="./phi3-mini.llamafile --nobrowser">
  <AnalyzeTestFailures />
</LlamafileProvider>
```

**Multiple models, sequential:**

```markdown
<LlamafileProvider model="qwen3-0.6b" command="./qwen3-0.6b.llamafile --nobrowser">
  <ClassifyLogLevel />
  <ExtractStructuredData />
</LlamafileProvider>

<LlamafileProvider model="phi3-mini" command="./phi3-mini.llamafile --nobrowser">
  <InterpretTestFailures />
</LlamafileProvider>
```

Each provider spawns its own process on its own port and executes
sequentially — the second provider's process is not started until the
first provider's scope closes.

**Multiple models, simultaneous (nested):**

```markdown
<LlamafileProvider model="qwen3-0.6b" command="./qwen3-0.6b.llamafile --nobrowser">
  <LlamafileProvider model="phi3-mini" command="./phi3-mini.llamafile --nobrowser">
    <HybridAnalysis />
  </LlamafileProvider>
</LlamafileProvider>
```

Both processes are alive simultaneously during `<HybridAnalysis />`
expansion. Sample calls route by `model`:

````markdown
<!-- inside HybridAnalysis.md -->

```bash sample exec
classify this output
```
<!-- no model → innermost provider wins (phi3-mini) -->

```bash sample[model=phi3-mini] exec
summarize this
```
<!-- explicit model → always phi3-mini regardless of nesting depth -->

```bash sample[model=qwen3-0.6b] exec
extract entities
```
<!-- explicit model → passes through phi3-mini handler, handled by qwen3-0.6b -->
````

Routing works because the inner provider's middleware is installed
later and therefore sits higher in the middleware chain (traversed
first). When `context.model` is `"phi3-mini"`, the inner handler
accepts it. When `context.model` is `"qwen3-0.6b"`, the inner handler
calls `next()` and the outer handler accepts it. When `context.model`
is undefined, the innermost accepting handler wins.

#### Nesting providers

Provider components nest naturally — each establishes its own eval
scope boundary:

```markdown
<LlamafileProvider command="./phi3-mini.llamafile">
  <DatabaseProvider command="./db-server">
    <MyReport />
  </DatabaseProvider>
</LlamafileProvider>
```

Both providers' scopes are nested — the inner provider is torn down
before the outer, in standard structured concurrency order.

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

inputs:
  type: object
  properties:
    prompt: { type: string, default: "" }
    model: { type: string, default: "" }
    params: { type: string, default: "" }
  additionalProperties: false
---

```js persist eval
const childrenOutput = yield* renderChildren();
const content = childrenOutput || prompt || '';

const sampleResult = yield* Sample.operations.sample({
  stdout: content,
  stderr: '',
  exitCode: 0,
  command: content,
  language: 'markdown',
  params: params || undefined,
  componentName: 'Sample',
  model: model || undefined,
});

output(sampleResult);
```
````

#### How it works

1. `renderChildren()` expands and renders the component's children.
   For self-closing invocations, this returns an empty string.
2. `content` falls back to the `prompt` prop if children are empty.
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

Every run allocates a current free port, starts the daemon, performs readiness
polling and child operations, then terminates the daemon when the component
closes. A previous diagnostic trace does not suppress any of these actions.

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

<Show when={releaseChanged.length > 0}>

> [!WARNING]
> Release configuration changed — update the release spec.

</Show>

</Output>
````

#### Placement

Only a **direct top-level** `<Output>` is a valid declaration. Placement is
checked against the component's (or root's) source structure, including regions
that never render — content inside `<Show when={false}>`, content passed to a
component that has no `<Content />`, an `<Output>` nested inside another
`<Output>`, or the children of any component that declines to render them. An
`<Output>` anywhere other than the top level is misplaced; all misplaced
occurrences in a single component are reported together as one diagnostic that
advises `<Output>` must be a direct top-level declaration and that conditional
rendering uses `<Show>` inside `<Output>`.

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
  nested components and produces only the diagnostic.
- Documentation and output regions execute in document order.
- The first error produced while executing documentation stops that body's
  execution immediately and propagates to the caller.
- An error produced while rendering an output region — or anywhere in a body
  that declares no `<Output>` — retains normal `ErrorSegment` rendering (an
  `<!-- ERROR -->` comment).
- A root containing `<Output>` emits its selected output only after the whole
  body completes successfully; a documentation failure yields no partial
  output, and an empty selection emits nothing.

An error a nested component renders inside its own output region is a normal
comment when that component renders normally; but when that component is
executed as a parent's documentation, the parent's documentation fail-fast
applies and the error propagates rather than being hidden.

#### Root and component consistency

A root document obeys exactly the same rules as an imported component (§5.4).
Because selecting output requires the whole body, a root that declares
`<Output>` is buffered — executed to completion, then emitted once on success —
while a root without `<Output>` keeps per-segment streaming. Buffering defers
only when output is emitted, not what executes, so replay is deterministic.

---

## 7. Entry point

### 8.1 `execute`

`execute(options)` executes a markdown document as a durable
workflow and returns a `DocumentExecution` handle. Options:

- `docPath` — path to the root markdown document
- `stream` — the durable stream that journals the run
- `componentDirs?` — component search directories (default:
  `["components", "."]`)
- `modifiers?` — custom modifier factories registered alongside the
  built-ins (`exec`, `silent`, `eval`, `persist`, `timeout`, `daemon`)

`DocumentExecution` is an `Operation<Result<string>>`: `yield* execution`
completes with `Ok(output)` on success and `Err(error)` on document,
infrastructure, or policy failure. Once `execute` has returned a handle,
completion never throws — every later failure closes the output stream
(with the complete or partial rendered output) and resolves `Err`. A
failure before a handle can be created may still throw. Its `output`
property is a replay-safe `Stream<string, string>` of the chunks emitted
during execution (per-segment for streaming roots, one chunk for buffered
`<Output>` roots — §5.4); late and repeated subscribers receive the full
sequence, and the stream closes with the full (or partial) output as its
close value.

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
    docPath: "./README.md",
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
is the system's public surface — extensible to progress, diagnostics, etc.
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

**File:** `cli/src/cli.ts` (separate `cli` workspace package)

The CLI installs output middleware (transforms only — no channel wiring
needed), calls `execute` to get a `DocumentExecution`, consumes
`execution.output` with `forEach` for streaming, and can `yield*`
the execution directly to get the full output or catch errors.

```typescript
// cli/src/cli.ts
import { forEach } from "@effectionx/stream-helpers";
import { execute, useNormalizedOutput, useTerminalOutput } from "@executablemd/core";

function* run(/* ... config params ... */) {
  if (!raw) yield* useNormalizedOutput();
  if (process.stdout.isTTY && !raw) yield* useTerminalOutput();

  const execution = yield* execute({ docPath, stream, runtime, ... });

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

<LlamafileProvider ...>
  <AnalyzeTests />
</LlamafileProvider>

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
it once per root segment resets the counter, producing duplicate diagnostic
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
core/src/
  api.ts                  Api definition, exports `output`
  collect.ts              Stream consumption helper (returns Result<string>)
  output/
    mod.ts                Barrel export
    normalize.ts          Whitespace normalization middleware
    terminal.ts           Terminal ANSI formatting middleware
  execute.ts         Document runner (owns channel, returns stream)

cli/src/
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

### 10.1 Effect vocabulary for MDX execution

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
visible warning blocks, collect into a separate error report).

---

## 12. Test plan

### Tier A — Boundary scanner

| # | Test | Verify |
|---|------|--------|
| A1 | Self-closing component | `<Comp />` → ComponentInvocation, selfClosing: true |
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
| B3 | Runtime parsing | Current content parsed to meta/inputs/segments |
| B4 | Import with simple frontmatter | `meta` correctly parsed, keys except `inputs` |
| B5 | Import with typed meta | `meta` key with type definitions, defaults resolved |
| B6 | Import with inputs (schema passthrough) | `inputs` is kept verbatim as the component's draft-07 JSON Schema |
| B7 | Import with inputs (property default) | A property's `default` fills the prop when a caller omits it |
| B8 | Import with inputs (required array) | `required: [name]` makes `name` a required prop |
| B9 | Import missing component | Resolve Api throws, error propagated |
| B12 | Root document as component | `__root__` import, same journal shape |
| B13 | Dotted name resolution | `Ns.Sub` → `components/Ns/Sub.md` |
| B14 | No inputs key | Component accepts no props; `inputs` is the closed empty-object schema |
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
| C9 | Props interpolation | `{props.name}` → replaced with invocation prop |
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
| C20 | **No inputs, no props** | Component with no `inputs` (closed empty-object schema), invoked with no props → valid |
| C21 | **No inputs, some props** | Component with no `inputs`, invoked with props → PropValidationError |
| C22 | **Optional with no default, not passed** | Input not in validated props, `{props.key}` → empty string |
| C23 | Component `as` capture | `<Comp as="x" />` stores rendered output in `env.values.x`, invocation emits no segments |
| C24 | `<Capture>` inline capture | `<Capture as="x">text</Capture>` stores `"text"` in `env.values.x`, emits no segments |
| C25 | `<Capture>` trailing-whitespace trim | Captured output `"hello\n"` stored as `"hello"` |
| C26 | Reserved prop `as` in inputs | Declaring `as` in component `inputs` fails frontmatter validation |
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
| C41 | Structural placement | Nested/misplaced `<Output>` (including inside `<Show when={false}>` or a content-discarding component) produces one aggregate diagnostic and runs no body side effects |
| C42 | Caller-projected `<Output>` inert | Projecting `<Output>` through `<Content />` neither activates nor alters the callee's policy |
| C43 | Documentation fail-fast | A failure in documentation (direct, inside `<Capture>`, inside a nested component, or a transported error) throws; a modifier-handled failure continues; errors inside `<Output>` or with no `<Output>` remain comments |
| C44 | **Array element-type mismatch** | `files` is `{ type: array, items: { type: string } }`; passing `["a", 3]` → PropValidationError |
| C45 | **Object-shape rejected** | A nested object with `required: [symbol]` / `additionalProperties: false` rejects a missing `symbol` or an unknown key → PropValidationError |
| C46 | **Nested default filled** | A row omitting `line` (declared `{ type: number, default: 0 }`) resolves with `line` set to `0` |
| C47 | **Nested enum rejected** | A property with `enum: [a, b]` nested inside an object/array item rejects a value outside the set → PropValidationError |

### Tier D — Code execution and modifier middleware

| # | Test | Verify |
|---|------|--------|
| D1 | `bash exec` golden run | `execHandler` runs, stdout in output, journal has exec entry |
| D2 | Exec repeated run | Command executes again and current stdout is used |
| D3 | Non-zero exit code | ErrorSegment in output |
| D4 | Multi-line command | Full script passed to `-c` |
| D5 | `python exec` | `python -c` invocation |
| D6 | `bash silent exec` | Chain: silent wraps exec. Exec journals. Silent returns empty output |
| D7 | `silent exec` repeated run | Command executes again and output remains empty |
| D8 | `bash sample exec` golden run | Chain: sample wraps exec. Two journal entries (exec + sample) |
| D9 | `bash sample exec` repeated run | Command and LLM are called again |
| D10 | `bash silent sample exec` | All three handlers compose. Both journal entries written, output empty |
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
| E8 | `silent exec` in full document | Command runs, result journaled, output omitted |
| E9 | `sample exec` in full document | Command + LLM both journaled, LLM response in output |
| E10 | Unclosed bold across component boundary | `**text\n<Comp />\nmore` → healed bold in first segment, component expanded, `more` unaffected |
| E11 | `<Output>` component vs. root consistency | An imported component and a root document apply `<Output>` identically; documentation is suppressed in both |
| E12 | Root `<Output>` buffering | A root with `<Output>` emits once after success; a later documentation failure yields no partial output; an empty selection emits no event; replay reproduces the result |
| E13 | `<Show>` inside `<Output>` (smoke) | `smoke-test/OutputDemo.md` renders the conditionally-selected region (its `when` binding computed by preceding documentation eval) while its documentation prose does not appear |

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
| H1 | Missing-provider diagnostics | `importComponent`, `applyModifiers`, `codeBlock`, and `content` report clear missing-provider errors when no provider is installed |
| H2 | Effection globals available | `sleep`, `spawn`, `createChannel` accessible in compiled block via standard imports |
| H3 | executable.md globals available | `findFreePort`, `Sample`, `when` accessible in compiled block via `@executablemd/core` |
| H5 | `compileBlock` returns generator function | `yield* compileBlock(code, [])` returns a callable generator function |
| H6 | Distinct modules per block | Each `compileBlock` call produces a separate module — no shared state between blocks |
| H7 | `data:` URI encoding | Module source with special characters is correctly URI-encoded |
| H8 | User imports hoisted | User `import` declarations from eval block source appear in generated module |

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
| K1 | Fresh env per component | Each component expansion gets its own `EvalEnv` |
| K2 | Env shared across blocks in same component | Block 1 and block 2 in same component share `env.values` |
| K3 | `serializeExports` filters non-JSON | Functions, symbols, circular refs excluded |
| K4 | `serializeExports` preserves JSON values | Numbers, strings, objects, arrays round-trip correctly |
| K5 | Eval merges serializable bindings | After the block, `env.values` contains current exports |
| K6 | Component `as` writes to invocation env | Binding is visible to downstream siblings at call site |
| K7 | `<Capture>` is not a component boundary | Eval/exec inside `<Capture>` use parent env/scope and journal normally |

### Tier L — Persist modifier

| # | Test | Verify |
|---|------|--------|
| L1 | `persist eval` retains spawned resource | Resource spawned in block survives block completion |
| L2 | Non-persist eval tears down resource | Resource spawned in block torn down at block end |
| L3 | Persist resource lifetime matches component | Resource torn down when component expansion completes |
| L4 | Persistent flag scoped to chain | `persistent` is `true` only during the persist-wrapped chain |
| L5 | Multiple persist blocks in one component | Each retains its own resources independently |
| L6 | Persist on repeated run | Resource is created and retained again for the current component lifetime |
| L7 | Persist flag does not leak to sibling blocks | Non-persist block after persist block → flag is false |

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

### Tier P — Eval binding interpolation

| # | Test | Verify |
|---|------|--------|
| P1 | Bare binding resolves from `env.values` | `{port}` with `env.values.port = 49821` → `"49821"` in content |
| P2 | Bare binding with no env entry left verbatim | `{port}` with no `port` in `env.values` → `"{port}"` unchanged |
| P3 | Bare binding does not match namespaced refs | `{meta.title}` and `{props.name}` not affected by eval binding pass |
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
| Q5 | Process terminated when component scope closes | After expansion, process is not running |
| Q6 | Process terminated on component error | If child expansion throws, process still terminated |
| Q7 | Process terminated on parent cancellation | If parent scope cancelled, process terminated |
| Q8 | Premature exit propagates as error | Process exits during expansion → `daemon()` throws → `ErrorSegment` in output |
| Q9 | `{port}` interpolation in daemon content | Binding from preceding `eval` block substituted into command |
| Q10 | `daemon` without eval scope | No eval scope in scope → clear error |
| Q11 | Modifier chain: `bash daemon exec` | `daemon` is outermost terminal; `exec` present but never called |
| Q12 | Repeated run: daemon starts and stops | Process is spawned and terminated again |
| Q13 | Repeated run: current port used | Eval allocates a current port; daemon binds it |

### Tier R — VM globals

| # | Test | Verify |
|---|------|--------|
| R1 | `findFreePort` accessible in eval block | `yield* findFreePort()` succeeds, returns a number |
| R2 | `findFreePort` returns usable port | Returned port is bindable (no EADDRINUSE) |
| R3 | `findFreePort` called on each run | No port is restored from an earlier trace |
| R4 | `when` accessible in eval block | `yield* when(fn)` retries until fn succeeds |
| R5 | `when` retries on throw | Inner function throws twice, then succeeds → `when` resolves |
| R6 | `when` propagates timeout | Inner function never succeeds → `when` throws after limit |

### Tier S — Provider component pattern (integration)

| # | Test | Verify |
|---|------|--------|
| S1 | Full provider golden run | eval → daemon → when → children → cleanup |
| S2 | Port flows from eval to daemon | `{port}` in daemon content matches `findFreePort()` result |
| S3 | Children can call sample after daemon ready | `sample` calls in children reach daemon endpoint |
| S4 | Daemon terminated after children expand | After `execute` completes, process not running |
| S5 | Provider crash during `when` | Daemon exits before ready → `when` fails → `ErrorSegment` |
| S6 | Provider crash during children | Daemon exits mid-child-expansion → error propagated |
| S7 | Nested providers | Outer + inner provider → both start, inner tears down first |
| S8 | Nested providers, no model | Innermost provider handles sample call |
| S9 | Nested providers, explicit model matching outer | Inner passes through, outer handles |
| S10 | Nested providers, explicit model matching inner | Inner handles regardless of nesting depth |
| S11 | Unmatched model | Chain exhausted → descriptive error naming the model |
| S12 | Repeated provider run | Eval, daemon, readiness, and HTTP calls execute again |
| S13 | Interrupted provider run | Partial diagnostic trace is not accepted as resume input |
| S14 | Multiple provider instances | Two provider siblings → two processes, different ports |

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
| RC6 | `renderChildren(override)` rejects non-object | `null`/array/primitive override → diagnostic |

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
| EA8 | Prop contract | Missing/non-array `in`, missing `let`, `let={expr}`, `as={expr}`, reserved-word/unknown props rejected; `as` without env rejected |
| EA9 | Projection | `<Each>` through `<Content />` resolves `in`, the item, and other caller bindings |

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
| 2 | All paths are workspace-relative | Diagnostic portability and no absolute-path leakage |
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
| 16 | Props must be declared in `inputs` frontmatter | Undeclared props are rejected — components are contracts |
| 17 | `inputs` is a canonical draft-07 JSON Schema | The declared input interface is a complete draft-07 schema validated by a shared Ajv instance (strict, `useDefaults`); no bespoke mini-language and no compatibility layer |
| 18 | Requiredness via a parent `required` array | Draft-07 `required` lists the props a caller must supply — no per-field `required` flag, no inferred requiredness |
| 19 | No declared inputs = closed empty-object schema | A component with no `inputs` uses `{ type: object, properties: {}, additionalProperties: false }` and accepts no props |
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
| 39 | Eval binding interpolation uses bare `{name}` syntax | Distinct from `{meta.key}` and `{props.key}` namespaces; local eval bindings are local variables, not namespaced data; regex excludes names containing `.` to avoid conflicts |
| 40 | Eval binding interpolation runs in the expansion engine, not inside modifier factories | Modifiers transform execution results — they are not responsible for preparing source text; one interpolation site in `expandSegments` is consistent with how text segment interpolation already works, and keeps modifier factories free of knowledge about the binding environment |
| 41 | `findFreePort` is a standalone VM global using `node:net` | Port allocation is platform I/O; the function uses Effection's `once` + `race` for event handling and `try/finally` for guaranteed cleanup; exposed in the eval sandbox alongside other Effection globals |
| 42 | `findFreePort` result journaled with its eval block | The port number is a scalar export; no separate journal-entry type is needed |
| 43 | `when` (from `@effectionx/converge`) is the polling VM global | `when` is the exported name from the package; the sandbox already contains it; no rename or addition needed |
| 44 | Provider lifecycle expressed as a component, not an `ExecuteOptions` field | Scope boundary is visible in the document tree; composable — multiple providers nest naturally via structured concurrency; no framework-level lifecycle hooks required |
| 45 | Readiness check is a separate `eval` block, not internal to `daemon` | Auditable — strategy visible in the document; replaceable — different daemons have different readiness signals; composable with `when`'s configurable backoff |
| 46 | Sample middleware reads `baseUrl` from `env.values` | Avoids a dedicated inference server context key; the binding environment is already the shared state carrier for within-component coordination; scope-correct because a fresh environment is provided per component expansion |
| 47 | Each component gets a fresh `EvalEnv` | The component's environment is installed as a scope-local `env` provider around body expansion, so eval blocks within a component share bindings but don't leak into parent or sibling components; critical for provider isolation |
| 48 | `output()` is a plain function, not `yield*` | Output is a synchronous side effect (mutating a ref), not an Effection operation; making it a function keeps the API simple and avoids requiring generator context just to set output text |
| 49 | `__output` stored alongside exports in journal | Avoids a separate journal entry; `__output` is extracted before merging into `env.values` to prevent namespace pollution |
| 50 | `renderChildren`/`render` are closures in `env.values`, not an Api | A Render Api would require middleware installation per component; closures are simpler and capture the expansion context at the injection point; they are non-serializable and silently omitted from the journal |
| 51 | `renderChildren`/`render` install the caller's environment and `parentEvalScope` as scope-local providers | Children are caller-provided content and expand in the caller's scope context; the component's `childEvalScope` sequential channel is for its own `persist eval` blocks, not for expanding caller content; children may create resources (nested components, daemons) but their lifecycle is bound by their place in the expansion tree; installing providers inside the closure ensures the correct context is visible regardless of which task it runs in |
| 52 | `durableSample` routes through `EvalScope` | Sample Api middleware installed by `persist eval` blocks (e.g., `LlamafileProvider`'s `Sample.around()`) lives in the eval scope's task hierarchy; routing through `evalScope.eval()` ensures the middleware chain is found |
| 53 | Sample component calls `Sample.operations.sample()` directly | The enclosing eval operation journals the complete block result |
| 54 | Sample component props default to empty string, not undefined | `validateProps` omits optional props with no default from `env.values`, causing `ReferenceError` in eval blocks; empty-string defaults ensure the variables exist; `model \|\| undefined` converts empty to undefined for routing semantics |
| 55 | `daemon()` uses `shell: true` | Matches `bash exec` block semantics — the same command string passed to `bash -c` is passed to the shell; handles shell expansions and PATH lookups correctly |
| 56 | Provider installs its own middleware, not a global `useLlamafileSample()` | A single global handler installed before `execute()` would execute in the outer scope at call time, where the binding environment has no `baseUrl`; middleware must close over `baseUrl` and `model` at the moment the provider becomes active |
| 57 | Routing key is `model`, not a separate `name` prop | Model identity is the natural key — it unifies "which server to route to" with "which model to request"; a separate `name` prop would require keeping two values in sync with no added expressiveness |
| 58 | `context.model === undefined` routes to innermost provider | Omitting a model is the common case for single-provider documents; innermost-wins matches how middleware chains work — handlers installed later sit higher in the chain and are traversed first |
| 59 | `callLlamafile()` is a standard import in generated eval modules | Provider components are markdown files — eval blocks are compiled into `data:` URI modules that import executable.md globals from `@executablemd/core`; functions like `callLlamafile`, `callOllama`, `callAnthropic`, `Sample`, `findFreePort`, and `useContent` are available via this import |
| 60 | Props pre-populated into `env.values` at component invocation | Code block content uses bare `{name}` binding interpolation from `env.values`; props must enter `env.values` at invocation time to be accessible in code blocks; consistent with how eval bindings work |
| 61 | `callLlamafile()` uses `@effectionx/fetch` | The HTTP call is an Effection operation executed once per document run |
| 62 | `LlamafileProvider.md` hardcodes `/health` endpoint | All major llamafile/llama.cpp-compatible servers use `/health`; the hardcoded path covers the supported targets |
| 63 | `stdio: "inherit"` is the default for `daemon()` | During development, seeing server logs in the terminal is valuable; production deployments can pass `stdio: "ignore"`; the executable.md `daemonFactory` passes no stdio option, defaulting to `"inherit"` |
| 64 | `DocumentOutput` Api with single `output` operation | Extensible to progress/diagnostics; middleware-composable via `scope.around`; single Api surface for all output concerns |
| 65 | Whitespace normalization is middleware, not post-processing | Stateful across calls; composes with other middleware; can be disabled via `--raw`; mutable closure state scoped per `useNormalizedOutput()` call |
| 66 | Terminal formatting is middleware, not a separate renderer | Composes with normalization; conditional on TTY; disabled for piped output; uses `marked-terminal` with `async: false` |
| 67 | Channel-based delivery, not direct `process.stdout.write` | Decouples production from consumption; enables buffered collection for piped output; consumer task lifetime tied to document run scope; `channel.close()` in `finally` block guarantees consumer exits cleanly |
| 68 | Per-root-segment emission for roots without `<Output>`; full buffering for roots that declare it | Streaming UX for the common case — root segments are sequential and independent, and component-internal expansion is recursive and buffered. A root declaring top-level `<Output>` (§6.9) buffers completely and emits the selected regions only after successful expansion, so a later documentation failure yields no partial output; an empty selection emits nothing |
| 69 | `blockId` counter threaded through expansion context | Per-segment expansion resets `result.length`; mutable counter preserves unique diagnostic IDs; counter guarded by expansion scope cancellation |
| 70 | `output()` wrapped in `ephemeral()` | Output emission is a non-durable side effect; journal records durable effects only; output text is derived from journaled expansion results; all middleware/side effects execute on the ephemeral side |
| 71 | Middleware installation order: normalize outer, terminal inner, channel innermost | `scope.around` later-installed handlers wrap earlier ones; execution flows outer → inner: normalize → terminal → channel; install order is reverse of execution order; must be documented to prevent reordering |
| 72 | `channel.send()` must be `yield*`'d | Ensures backpressure and cancellation safety — no text "in flight" when scope tears down; without `yield*`, buffering issues or silent cancellation may occur |
| 73 | `DocumentExecution` with `withResolvers` | Execution is both an `Operation<Result<string>>` (`yield*` for the completion Result) and has `.output` stream for chunks; once a handle exists every failure resolves `Err(error)` — completion never throws, so policy middleware (e.g. testing) can map outcomes without exception control flow |
| 74 | Function components receive props directly, not wrapped | `function*(props)` not `function*({ props })` — eliminates unnecessary destructuring; props are already validated by the expansion engine before the function is called |
| 75 | `useContent()` is contextual, not a function argument | Decouples function components from the expansion engine's API surface; leaf components don't need to ignore an `expandChildren` parameter; Effection-idiomatic — same contextual pattern as `env`/`evalScope`; supports named slots via `useContent("header")` |
| 76 | `.md` wins over `.ts` in resolution | Backward compatibility — existing markdown components are not shadowed by TypeScript files added later; explicit — if both exist, the human-readable markdown is preferred |
| 77 | Function component imported on every run | The current module must execute because functions are not serialized into a trace |
| 78 | Internal durable-streams package | Provides journaling for the core runtime |
| 79 | `as` is a reserved expansion prop | `as` is consumed by the expansion engine (not component inputs), stripped before validation, and used to bind rendered output into `env.values` |
| 80 | `<Capture>` is the inline binding directive | Captures arbitrary inline rendered content while preserving JSX ergonomics and a single binding-target syntax (`as`) |
| 81 | Component `as` writes to invocation-site env | Captured bindings must be visible to subsequent siblings/eval blocks where the invocation appears |
| 82 | `<Capture>` does not create a new env/scope | Capture is structural (like `<Content />`), not a component boundary; middleware/scope behavior remains deterministic |
| 83 | Capture trims trailing whitespace | Exec stdout commonly ends with newline; trimming avoids downstream interpolation/comparison bugs while preserving leading/interior whitespace |
| 84 | Capture assignment is not independently journaled | Captured value is derived during current expansion; no extra journal entry is needed |
| 88 | Eval binding interpolation extends to text segments | Documents should be readable prose with embedded data references, not JavaScript template literals inside eval blocks |
| 89 | `{meta.*}` / `{props.*}` resolve before bare `{name}` | Component contract (frontmatter) takes precedence over internal eval state; dotted vs bare syntax prevents actual collisions |
| 90 | `\{` escaping applies to both passes | Consistent escaping behavior regardless of which pass would match; pre-existing gap in §6.6 fixed for both code blocks and text segments |
| 85 | Eval block `return` as rendered output | Eval blocks can produce output via `return "text"` in addition to `output("text")`; `output()` wins if both used; null/undefined returns produce no output; enables components like `<Show>` where the entire block is conditional rendering |
| 86 | `sample` modifier removed | All LLM calls go through the `<Sample>` component; removes `sampleFactory`, `durableSample`, `callLlamafile`, `callOllama`, `callAnthropic`; simplifies the modifier chain to pure exec/eval concerns |
| 87 | `SampleContext` simplified to content-centric shape | Changed from exec-centric `{stdout, stderr, exitCode, command, language}` to content-centric `{content, model?, params?, system?, componentName?}`; providers build their own messages directly instead of relying on `buildDefaultMessages` |
| 91 | Projected children carry caller's eval env | Children substituted via `<Content />` are tagged with `projectedEnv`. Expression props on projected children resolve against merged env (caller + component), with component bindings taking precedence. Follows React's lexical scoping model. |
| 92 | Multi-level projection env propagation | When `expandComponent` receives `projectedEnv`, it merges it with the current context env before tagging the next level's children. Creates a cumulative chain: Root → Provider → Instruction → ReviewBody all carry root bindings. Innermost-wins on collision. |
| 93 | AST-based user import extraction in eval blocks | `ImportDeclaration` nodes in eval blocks are extracted via acorn's `allowImportExportEverywhere` and hoisted to module top level by `compileBlock`. TypeScript `import type` normalized to spaces before parse, extracted from original source. |
| 94 | `<Capture select>` uses CSS selectors via remark + `unist-util-select` | Standard CSS selector syntax on markdown AST (mdast); reuses existing remark dependency; supports attribute selectors, combinators, pseudo-classes; matches Web platform conventions for querying tree structures |
| 95 | `select` falls back to full content on no match | Non-destructive — authors can add `select` to existing Captures without breaking behavior if the selector doesn't match; avoids silent data loss |
| 96 | Literal nodes use `.value`, parent nodes use `mdast-util-to-string` | Code blocks store text in `.value` (no child nodes); paragraphs/headings have child Text nodes requiring recursive extraction; two extraction strategies cover all mdast node types |
