# Executable MDX: Specification

**Status:** Draft
**Audience:** Implementing agent
**Inputs:** Prior streaming MDX research, `@effectionx/durable-streams` (protocol-specification, effection-integration, DECISIONS), `@effectionx/durable-effects` (effect-types, guards), Divergence API (`lib/divergence.ts`), `@effectionx/process` (`daemon`), `@effectionx/converge` (`when`)

---

## 1. Overview

An executable MDX document is a markdown file containing embedded JSX
component invocations and annotated code blocks. The system treats each
document as a durable workflow: text is emitted immediately, component
references are resolved from the file system and expanded recursively,
and code blocks marked as executable are either run as subprocess
commands via `durableExec`, evaluated in-process as Effection
generator operations via `durableEval`, or spawned as long-running
background processes via the `daemon` modifier. The journal records
every I/O operation so that execution survives crashes and replays
from the journal on restart.

The system is built entirely on the existing durable execution
infrastructure — `createDurableOperation`, `durableExec`, `durableEval`,
`durableGlob`, replay guards, and the Divergence API. The main
additions are `durableImportComponent` (a durable effect that wraps
the Resolve Api and `DurableRuntime` file read into a single journaled
operation, with a custom `useImportComponentGuard` for staleness
detection), the in-process evaluation system (source transform,
shared VM context, binding environment, and eval scope for resource
lifetime management — see §4), and daemon process management (the
`daemon` terminal modifier, eval binding interpolation, and the
provider component pattern — see §3.3 and §6.6–6.7).

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
  name:
    type: string
    required: true
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
    result: { status: "ok", value: { path: "README.md", content: "---\ntitle: ...", contentHash: "sha256:..." } }
[1] yield root  { type: "import_component", name: "Greeting" }
    result: { status: "ok", value: { path: "components/Greeting.md", content: "---\nemoji: ...", contentHash: "sha256:..." } }
[2] yield root  { type: "exec", name: "exec:ls ./src", command: ["bash", "-c", "ls ./src"] }
    result: { status: "ok", value: { exitCode: 0, stdout: "main.ts\nutils.ts\n", stderr: "" } }
[3] close root  result: { status: "ok", value: "# My Project\n\n👋 Hello, world!\n\n..." }
```

### 1.2 Workspace-relative paths

All paths stored in the journal are **relative to the workspace root**
(the current working directory when `runDocument` is called). This
makes journals portable across machines and environments — a journal
produced on one developer's machine replays correctly on another as
long as the workspace structure is the same.

The `DurableRuntime`'s I/O methods (`readTextFile`, `stat`, `exec`,
`glob`) all resolve paths relative to cwd. The runtime never sees
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
  props: Record<string, Json>;           // JSX props from the invocation site
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

#### What remend does NOT heal

- **Orphaned closing markers.** `more** text` (closing `**` without
  opener) — remend doesn't strip these. They render as literal text
  in most markdown engines, which is acceptable.
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
from its input. No journal entry. Runs on every execution (live and
replay) because it operates on the text content, which is either
fresh (live) or stored (replay, fed from journal).

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

The code block context is delivered via Effection's `Context` — set
on the scope via `CodeBlockCtx.with()` before the modifier chain
runs. Handlers that need it read via `useCodeBlock()`:

```typescript
const CodeBlockCtx = createContext<CodeBlockContext>("codeBlock");

function useCodeBlock(): Workflow<CodeBlockContext> {
  return ephemeral(CodeBlockCtx.expect());
}
```

This follows the Effection convention: shared execution context
lives on the scope and is accessed via context accessors, not
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
registry.set("sample", sampleFactory);
registry.set("eval", evalFactory);
registry.set("persist", persistFactory);
registry.set("timeout", timeoutFactory);
registry.set("daemon", daemonFactory);
```

Custom factories can be provided via `RunDocumentOptions.modifiers`.

#### Built-in terminal handlers

**`exec`** — executes the code block as a shell command via
`durableExec`. This is a terminal handler — it does not call `next()`.
It reads the code block info from the Effection context via
`useCodeBlock()`:

```typescript
function createExecFactory(runtime: DurableRuntime): ModifierFactory {
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

**`eval`** — evaluates the code block in-process as an Effection
generator operation via `durableEval`. Also a terminal handler. Unlike
`exec` (subprocess), `eval` executes code in the same Effection
process, enabling direct access to live in-memory objects, native
`yield*` of Effection operations, and shared state across blocks
within a component via a binding environment (see §4).

Eval blocks produce **no rendered output** — they exist for bindings
and side effects.

```typescript
export const evalFactory: ModifierFactory = (_params) =>
  (_args, _next) => (function* () {
    const ctx = yield* useCodeBlock();
    const env = yield* ephemeral(EvalEnvCtx.expect());
    const evalCtx = yield* ephemeral(EvalCtxKey.expect());
    const persist = yield* ephemeral(PersistFlagCtx.get()) ?? false;

    const transformed = transformBlock(
      ctx.content,
      ctx.blockId,
      Object.keys(env.values),
    );

    const result = yield* durableEval(
      `eval:${ctx.blockId}`,
      function* (source, bindings) {
        Object.assign(env.values, bindings);
        const fn = compileBlock(source, evalCtx.vmContext);

        if (persist) {
          // Run inside evalScope.eval() to retain spawned resources
          const evalScope = yield* EvalScopeCtx.expect();
          const blockResult = yield* evalScope.eval(
            () => fn(env.values) as unknown as Operation<void>,
          );
          unbox(blockResult);
        } else {
          yield* fn(env.values) as unknown as Operation<void>;
        }

        return serializeExports(env.values, transformed.exports);
      },
      {
        source: transformed.code,
        language: ctx.language,
        bindings: serializeExports(env.values, transformed.imports),
      },
    );

    // On replay, restore serializable exports from the journal
    if (result.value && typeof result.value === "object") {
      Object.assign(env.values, result.value);
    }

    return { output: "", exitCode: 0, stderr: "" };
  })();
```

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
| Replay behavior | Returns stored result, no subprocess | Spawns fresh subprocess every run |

```typescript
import { daemon } from "@effectionx/process";

export const daemonFactory: ModifierFactory = (_params) =>
  (_args, _next) => (function* () {
    const ctx = yield* useCodeBlock();

    // Bridge from Workflow (durable) to Operation (ephemeral) —
    // daemon produces no journal entry, so all its effects are ephemeral.
    const launchDaemon = {
      *[Symbol.iterator]() {
        const evalScope = yield* EvalScopeCtx.expect();

        // ctx.content is already interpolated by the expansion engine
        // before the modifier chain runs — no interpolation needed here.
        const commandParts = buildCommand(ctx.language, ctx.content);
        const commandStr = commandParts.join(" ");

        // Fork into eval scope — lifetime tied to component expansion.
        // daemon() never resolves. If the process exits prematurely,
        // daemon() throws DaemonExitError, propagating to the eval scope.
        yield* evalScope.eval(function* () {
          yield* daemon(commandStr);
        });
      },
    };
    yield* ephemeral(launchDaemon);

    // Control returns here immediately after the fork.
    return { output: "", exitCode: 0, stderr: "" };
  })();
```

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

**Replay behavior.** `daemon` is not durable. It runs on every
document execution, including full replay runs. On a full replay,
all `sample` journal entries are present and returned directly — the
daemon's endpoint is never called. The process starts, runs for the
duration of expansion, and is terminated when the component scope
closes — without serving a single request. This is harmless overhead;
the alternative (conditional daemon startup based on journal state)
would couple the modifier to the durable protocol.

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

**`sample`** — calls `next()`, then sends the inner result's output
to an LLM via `durableSample`, which wraps the Sample Api (§3.4) in
a durable effect:

```typescript
const sampleFactory: ModifierFactory = (params) =>
  (_args, next) => function* () {
    const context = yield* useCodeBlock();
    const inner = yield* next();
    const sampled = yield* durableSample(context.content, {
      stdout: inner.output,
      stderr: inner.stderr,
      exitCode: inner.exitCode,
      command: context.content,
      language: context.language,
      params,
      componentName: context.componentName,
    });
    return { ...inner, output: sampled };
  }();
```

**`persist`** — extends resource lifetime from block scope to the
component's eval scope. Without `persist`, resources spawned inside an
eval block are torn down when the block completes. With `persist`, the
block's compiled code runs via `evalScope.eval()`, retaining spawned
resources for the lifetime of the component expansion. See §4.5 for
the context flag pattern.

`persist` itself does not call `evalScope.eval()` — it sets a context
flag (`PersistFlagCtx`) that `evalFactory` reads to decide whether to
route through the eval scope:

```typescript
export const persistFactory: ModifierFactory = (_params) =>
  (_args, next) => (function* () {
    return yield* ephemeral(
      PersistFlagCtx.with(true, function* () {
        return yield* next() as unknown as Operation<CodeBlockResult>;
      }),
    );
  })();
```

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
middlewares are combined into a single chain. `CodeBlockCtx.with()`
sets the context on the scope for the duration of the chain:

```typescript
function composeModifierChain(
  modifiers: Modifier[],
  context: CodeBlockContext,
  registry: ModifierRegistry,
): () => CodeBlockWorkflow {
  const terminal = function* () {
    throw new Error("No terminal modifier (exec/eval) in chain");
  };

  const middlewares = modifiers.map((mod) => {
    const factory = registry.get(mod.name);
    if (!factory) throw new Error(`Unknown modifier: ${mod.name}`);
    return factory(mod.params);
  });

  const composed = combine(middlewares);

  return function* () {
    return yield* ephemeral(
      CodeBlockCtx.with(context, function* () {
        return yield* composed([], terminal);
      }),
    );
  };
}
```

For ```` ```bash silent sample exec ````:

```
exec    = execFactory(undefined)       // terminal middleware
sample  = sampleFactory("brief")       // wraps exec
silent  = silentFactory(undefined)     // wraps sample
composed = combine([silent, sample, exec])
```

Calling `composed([], terminal)` runs silent → sample → exec. The
exec handler journals the command result. The sample handler journals
the LLM response. The silent handler discards the output.

#### Overriding per-scope

Because factories are stored in a registry that can be extended,
custom modifiers can be provided via `RunDocumentOptions`:

```typescript
yield* runDocument({
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

The `sample` modifier handler delegates LLM access to the
**Sample Api** — an Effection Api with middleware that determines
which model is called, what prompt is constructed, and how the
response is post-processed.

```typescript
interface SampleContext {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  language: string;
  params?: string;
  componentName?: string;
}

interface SampleApi {
  sample(context: SampleContext): Operation<string>;
}

const Sample = createApi<SampleApi>("Sample", {
  *sample(context: SampleContext): Operation<string> {
    throw new Error(
      "sample modifier requires Sample Api middleware — " +
      "install via scope.around(Sample, ...) before calling runDocument"
    );
  },
});
```

**`durableSample`** wraps the Api call in `createDurableOperation`:

```typescript
function* durableSample(
  command: string,
  context: SampleContext,
): Workflow<string> {
  return (yield createDurableOperation<string>(
    { type: "sample", name: `sample:${truncate(command, 30)}` },
    function* () {
      return yield* Sample.operations.sample(context);
    },
  )) as string;
}
```

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
    if (context.params === "passthrough") return context.stdout;
    return yield* next(context);
  },
});

// Testing stub
scope.around(Sample, {
  *sample([context], next): Operation<string> {
    return `[stub] sampled ${context.stdout.length} bytes`;
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

**`sample exec`** — `exec` runs the command and journals the
result (first journal entry). `sample` calls `next()` (so exec
runs), then passes stdout to `durableSample` which journals the
LLM response (second journal entry). The LLM's response becomes
the output.

**`silent sample exec`** — `exec` journals the command result.
`sample` journals the LLM response. `silent` discards the output.
Both journal entries are written; the document gets nothing. The
LLM call still happens because `silent` wraps `sample` — it calls
`next()` which runs the entire inner chain before discarding.

**`daemon exec`** — `daemon` is the outermost terminal modifier. It
ignores `next` entirely — `exec` is never invoked. `daemon` forks the
command as a background process into the eval scope. No journal entry.
The process lives until the component scope closes.

Future modifiers (not yet specified):

| Modifier | Type | Behavior |
|----------|------|----------|
| `capture=varname` | Wrapping | Stores output into a named binding |
| `stderr` | Wrapping | Includes stderr in output |
| `ignore-error` | Wrapping | Converts non-zero exit codes to success |

---

## 4. In-process evaluation

Eval blocks run JavaScript **in-process** as Effection generator operations.
Unlike `exec` blocks (which run shell commands in a subprocess), `eval`
blocks execute in the same Effection process. This section describes the
architecture: source transform, VM context, binding environment, eval
scope, and durable replay.

### 4.1 Source transform

Top-level `const`/`let`/`function`/`class` declarations are scoped to the
block invocation. The source transform rewrites them so their values are
also written to `env`, making them available to subsequent blocks and to
the journal system.

**Implementation:** `src/eval-transform.ts` using **acorn** for parsing
and **magic-string** for string mutations.

```typescript
interface TransformResult {
  code: string;       // transformed body, without the generator wrapper
  map: string;        // V3 source map JSON
  exports: string[];  // top-level names written to env
  imports: string[];  // names read from env (free variables present in env)
  mode: "generator" | "async" | "sync";
}

function transformBlock(
  source: string,
  blockId: string,
  currentEnvKeys: string[],
): TransformResult;
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
    // but are absent from the journal and not restored on replay.
  }
  return result;
}
```

### 4.2 VM context

A single `vm.Context` is created at document run start and reused for all
eval blocks across the entire document. Context creation is expensive
(~7–21ms).

```typescript
// src/eval-context.ts
import { createContext as createEffectionContext } from "effection";
import { createContext as vmCreateContext } from "node:vm";

export interface EvalContext {
  vmContext: object;
}

export const EvalCtxKey = createEffectionContext<EvalContext>("evalContext");

export function createEvalContext(
  globals: Record<string, unknown> = {},
): EvalContext {
  const sandbox = {
    // Effection APIs available in blocks without import
    sleep, spawn, call, resource, useScope,
    createChannel, each, suspend, createSignal,
    // Convergence — poll and wait for conditions
    when,
    // Port allocation — find available TCP port
    findFreePort,
    // Standard globals
    console,
    // Host-provided extras
    ...globals,
  };
  return { vmContext: vmCreateContext(sandbox) };
}
```

Set on the root document scope so all eval blocks share the same VM
context. Handlers access it via `ephemeral(EvalCtxKey.expect())`.

#### `findFreePort`

`findFreePort` is exposed in the eval VM sandbox as a standalone
Effection `Operation<number>`. It binds a `node:net` TCP server to
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

The returned port number is a JSON-serializable primitive. When used
in an eval block, it is exported to `env.values` and journaled as
part of the `durableEval` result. On replay, the stored value is
restored to `env.values` without calling `findFreePort()` again.

There is a small race window between closing the server and the
caller binding the port — acceptable in practice, since daemon
processes are expected to bind immediately after allocation.

#### `when`

`when` from `@effectionx/converge` retries an inner operation with
backoff until it completes without throwing. It is the idiomatic way
to poll a readiness endpoint:

```typescript
yield* when(function* () {
  const response = yield* fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`Not ready: ${response.status}`);
});
```

`when` handles the retry loop, backoff, and timeout internally.

#### Compiling blocks

```typescript
import { runInContext } from "node:vm";

function compileBlock(
  transformedBodyCode: string,
  vmContext: object,
): (env: Record<string, unknown>) => Generator<unknown, void, unknown> {
  return runInContext(
    `(function*(env) {\n${transformedBodyCode}\n})`,
    vmContext,
  );
}
```

The trailing newline before `})` is critical — the transformed code ends
with a `//# sourceURL` comment, and without the newline the closing `})`
would be swallowed by the comment.

### 4.3 Binding environment

```typescript
// src/eval-env.ts
export interface EvalEnv {
  values: Record<string, unknown>;
}

export const EvalEnvCtx = createContext<EvalEnv>("evalEnv");
```

Created fresh at the start of component expansion. Each eval block reads
bindings from `values` (via env preamble) and writes new bindings back
(via env-write transforms). Handlers access it via
`ephemeral(EvalEnvCtx.expect())`.

The binding environment is scoped to the document expansion lifetime via
`EvalEnvCtx.with()` — matching the same `Context.with()` pattern as
`CodeBlockCtx.with()` in `composeModifierChain`.

### 4.4 Eval scope and resource lifetime

Each document gets a dedicated **eval scope** — an Effection scope whose
lifetime matches the document's expansion. Resources spawned by `persist`
blocks are retained in this scope until expansion completes.

```typescript
// src/eval-env.ts
export const EvalScopeCtx = createContext<EvalScope>("evalScope");
export const PersistFlagCtx = createContext<boolean>("persistFlag");
```

The eval scope is created in `runDocument()` (§8.1) **before**
`durableRun` via `resource(useEvalScope())`. This is critical:
`evalScope.eval()` sends to a channel whose processor must be
reachable by the Effection scheduler — this only works when both sender
and processor share an ancestor scope outside the durable execution
boundary.

#### The context flag pattern

`persist` does not wrap the entire modifier chain in `evalScope.eval()`.
That would hang because the durable effects in the workflow can't
interact with the journal from within the eval scope's channel
processor. Instead:

1. `persist` sets `PersistFlagCtx = true` via `Context.with()`
2. `evalFactory` reads `PersistFlagCtx` after compiling the block
3. When true, only the **compiled VM block** (`fn(env.values)`) runs
   inside `evalScope.eval()` — not the entire modifier chain
4. Resources spawned during that execution are retained until the
   eval scope is destroyed (when component expansion completes)

### 4.5 Durable replay

#### What is journaled

`evalFactory` wraps execution in `durableEval`. Journal entry shape:

```json
{ "type": "eval", "name": "eval:root:0", "language": "js" }

{ "status": "ok", "value": {
    "value": { "port": 4321, "config": { "debug": true } },
    "sourceHash": "sha256:abc123...",
    "bindingsHash": "sha256:def456..."
  }
}
```

`value.value` contains only the JSON-serializable subset of exports.
Non-serializable bindings (functions, class instances, live objects) are
omitted — they remain in `env.values` as live references during the
current run but are absent from the journal and not restored on replay.

#### Staleness detection

The code freshness guard detects when source or bindings have changed
since the last run. If a hash mismatch is found, `StaleInputError` is
raised before replay of that block begins.

#### `persist` during replay

On replay, `durableEval` returns the stored result directly — the
block's generator body is never entered. `persist` is a transparent
no-op: no `evalScope.eval()` call is made, no resources are retained.

### 4.6 File locations

| File | Contents |
|---|---|
| `src/eval-transform.ts` | `transformBlock()`, `serializeExports()`, `isJson()`, `TransformResult` |
| `src/eval-context.ts` | `createEvalContext()`, `compileBlock()`, `EvalCtxKey`, `EvalContext` |
| `src/eval-env.ts` | `EvalEnv`, `EvalEnvCtx`, `EvalScopeCtx`, `PersistFlagCtx` |
| `src/eval-handler.ts` | `evalFactory` |
| `src/eval-interpolate.ts` | `interpolateEvalBindings()` — bare `{name}` substitution |
| `src/modifiers/persist.ts` | `persistFactory` |
| `src/modifiers/timeout.ts` | `timeoutFactory`, `parseDuration()` |
| `src/modifiers/daemon.ts` | `daemonFactory` — long-running subprocess terminal modifier |
| `src/find-free-port.ts` | `findFreePort()` — OS port allocation via `node:net` |

Dependencies: `@effectionx/scope-eval`, `@effectionx/timebox`,
`@effectionx/converge`, `@effectionx/process`, `@effectionx/node`,
`acorn`, `magic-string`.

---

## 5. Component model

### 5.1 Components are markdown files with a declared interface

A component is a markdown file with YAML frontmatter that declares
both the component's own metadata and its input interface. The file
name (without extension) is the component name. PascalCase naming is
a convention, not enforced.

```markdown
<!-- components/Greeting.md -->
---
emoji: 👋

inputs:
  name:
    type: string
    required: true
  greeting:
    type: string
    default: Hello
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

**Inputs** — the reserved `inputs` key declares what props callers
can pass. Each input has a name and a definition that specifies its
type and optionally a default value.

#### Input definitions

An input definition is either a **shorthand** (just a default value)
or a **full definition** (type, default, required, description):

```yaml
inputs:
  # Shorthand — type inferred from default value
  greeting: Hello              # string, default "Hello"
  count: 0                     # number, default 0
  verbose: false               # boolean, default false
  tags: [alpha, beta]          # array, default ["alpha", "beta"]

  # Full definition — JSON Schema subset
  name:
    type: string
    required: true
  temperature:
    type: number
    default: 0.7
    description: LLM temperature parameter
  model:
    type: string
    enum: [gpt-4, claude-3, llama-3]
    default: gpt-4
  config:
    type: object
    default: { retries: 3 }
```

**Shorthand rule:** If an input's value is not an object with a `type`
key, it is treated as a default value. The type is inferred:

| YAML value | Inferred type |
|-----------|---------------|
| `greeting: Hello` | `string` |
| `count: 42` | `number` |
| `verbose: true` | `boolean` |
| `tags: [a, b]` | `array` |
| `config: { k: v }` | `object` |
| `name: null` | `any` (required, no default) |

When the value is `null`, the input is required (no default).

**Full definition fields** (JSON Schema subset):

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | One of: `string`, `number`, `boolean`, `array`, `object`, `any` |
| `default` | any | Default value when prop is not passed by caller |
| `required` | `boolean` | If `true`, caller must provide this prop (default: `false` unless no `default`) |
| `enum` | `array` | Allowed values (only for `string` and `number`) |
| `description` | `string` | Human-readable description (documentation only) |

**Implied required:** An input is required when it has no `default`
value and `required` is not explicitly `false`. An input with a
`default` is never required unless `required: true` is set explicitly.

#### Meta with type constraints (optional)

Meta values are normally plain YAML values. For components that want
schema validation on their own metadata (e.g., when meta values are
overridden by a parent component's frontmatter), meta entries can
use the same full definition syntax by placing them under a `meta`
key:

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
  prompt:
    type: string
    required: true
---
```

When `meta` is a mapping of definitions (objects with `type` keys),
the values are resolved to their defaults. When `meta` is absent,
all top-level keys except `inputs` are meta values (the simple case).

This dual syntax allows components to range from minimal (just
key-value pairs) to fully typed (every field constrained).

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
2. `./components/{Name}/index.md`
3. `./{Name}.md`

For dotted names like `Ns.Sub`, the dot maps to a directory separator:
`./components/Ns/Sub.md`.

```typescript
function* useDirectoryResolver(
  searchPaths: string[],
): Operation<void> {
  const scope = yield* useScope();
  const runtime = scope.expect<DurableRuntime>(DurableRuntimeCtx);

  scope.around(Resolve, {
    *resolve([name], next): Operation<ResolveResult> {
      const fileName = name.replace(/\./g, "/") + ".md";
      for (const dir of searchPaths) {
        const candidate = join(dir, fileName);
        const stat = yield* runtime.stat(candidate);
        if (stat.exists && stat.isFile) {
          return { path: candidate };
        }

        const indexCandidate = join(dir, name.replace(/\./g, "/"), "index.md");
        const indexStat = yield* runtime.stat(indexCandidate);
        if (indexStat.exists && indexStat.isFile) {
          return { path: indexCandidate };
        }
      }
      return yield* next(name);
    },
  });
}
```

#### Durable glob resolver middleware

For large component trees, middleware can pre-scan directories with
`durableGlob` so that the scan itself is journaled. Individual
`resolve()` calls become pure map lookups:

```typescript
function* useDurableGlobResolver(
  componentDirs: string[],
): Operation<void> {
  const allComponents = new Map<string, string>();
  for (const dir of componentDirs) {
    const globResult = yield* durableGlob(`resolve:${dir}`, {
      baseDir: dir,
      include: ["**/*.md"],
    });
    for (const match of globResult.matches) {
      const name = match.path
        .replace(/\.md$/, "")
        .replace(/\/index$/, "")
        .replace(/\//g, ".");
      allComponents.set(name, join(dir, match.path));
    }
  }

  const scope = yield* useScope();
  scope.around(Resolve, {
    *resolve([name], next): Operation<ResolveResult> {
      const path = allComponents.get(name);
      if (path) return { path };
      return yield* next(name);
    },
  });
}
```

With `useGlobContentGuard` installed, replay detects when files are
added or removed from component directories.

### 5.3 Import: `durableImportComponent`

Import is a single durable effect that resolves a component name,
reads the file, and computes its content hash. The Resolve Api runs
inside the operation body during live execution. On replay, the
entire stored result is returned — neither the Api nor the filesystem
is touched.

Parsing the stored content into frontmatter and segments is a
**runtime operation** that runs after the durable effect returns,
both live and on replay. It's deterministic from the content, so it
doesn't need to be in the journal.

```typescript
interface ImportResult {
  path: string;           // Workspace-relative, from Resolve Api
  content: string;        // Raw file content
  contentHash: string;    // SHA-256 of content
}

function* durableImportComponent(
  name: string,
): Workflow<ComponentDefinition> {
  // Single durable effect: resolve + read + hash
  const result = (yield createDurableOperation<ImportResult>(
    { type: "import_component", name },
    function* () {
      // Resolve via Api — middleware runs here during live execution
      const { path } = yield* Resolve.operations.resolve(name);

      // Read file via runtime
      const scope = yield* useScope();
      const runtime = scope.expect<DurableRuntime>(DurableRuntimeCtx);
      const content = yield* runtime.readTextFile(path);
      const contentHash = yield* computeSHA256(content);

      return { path, content, contentHash } as ImportResult;
    },
  )) as ImportResult;

  // Parse at runtime — deterministic from content, not journaled
  const { data: frontmatter, content: body } = grayMatter(result.content);
  const { meta, inputs } = parseFrontmatter(frontmatter);
  const bodySegments = scanSegments(body);

  return {
    name,
    path: result.path,
    meta,
    inputs,
    bodySegments,
    contentHash: result.contentHash,
  };
}
```

**Journal shape:**

```json
{ "type": "import_component", "name": "Greeting" }
{ "status": "ok", "value": {
    "path": "components/Greeting.md",
    "content": "---\nemoji: 👋\n...",
    "contentHash": "sha256:abc..." } }
```

One journal entry per component. The entry captures both *which file
was found* (path) and *what was in it* (content + hash). On replay,
the stored content is parsed at runtime to produce the same
`ComponentDefinition`.

Staleness is detected by a custom `useImportComponentGuard` (not
the generic `useFileContentGuard`, which expects a `path` field in
the description — `import_component` descriptions only have `name`
because the path isn't known until the Resolve Api runs inside the
operation).

The guard reads the path and contentHash from the stored *result*:

```typescript
function* useImportComponentGuard(): Operation<void> {
  const scope = yield* useScope();
  const runtime = scope.expect<DurableRuntime>(DurableRuntimeCtx);
  const cache = new Map<string, string>();

  scope.around(ReplayGuard, {
    *check([event], next) {
      if (event.description.type === "import_component") {
        const storedPath = (event.result.status === "ok"
          ? (event.result.value as ImportResult)?.path
          : undefined) as string | undefined;
        if (storedPath && !cache.has(storedPath)) {
          const content = yield* runtime.readTextFile(storedPath);
          const currentHash = yield* computeSHA256(content);
          cache.set(storedPath, currentHash);
        }
      }
      return yield* next(event);
    },
    decide([event], next) {
      if (event.description.type === "import_component") {
        const result = event.result.status === "ok"
          ? event.result.value as ImportResult
          : undefined;
        if (result) {
          const currentHash = cache.get(result.path);
          if (currentHash && currentHash !== result.contentHash) {
            return {
              outcome: "error",
              error: new StaleInputError(
                `Component changed: ${event.description.name} ` +
                `at ${result.path}`
              ),
            };
          }
        }
      }
      return next(event);
    },
  });
}
```

This guard follows the same two-phase pattern as `useFileContentGuard`
but reads from `result.value.path` and `result.value.contentHash`
instead of `description.path`. It composes with other guards via the
standard middleware chain.

```typescript
interface InputDefinition {
  type: "string" | "number" | "boolean" | "array" | "object" | "any";
  default?: Json;
  required?: boolean;
  enum?: Json[];
  description?: string;
}

interface ComponentDefinition {
  name: string;
  path: string;
  meta: Record<string, unknown>;            // Resolved meta values
  inputs: Record<string, InputDefinition>;  // Declared input interface
  bodySegments: Segment[];                  // Parsed body (after frontmatter)
  contentHash: string;                      // From import result
}
```

#### Frontmatter parsing

```typescript
function parseFrontmatter(raw: Record<string, unknown>): {
  meta: Record<string, unknown>;
  inputs: Record<string, InputDefinition>;
} {
  const rawInputs = (raw.inputs ?? {}) as Record<string, unknown>;
  const inputs: Record<string, InputDefinition> = {};

  for (const [key, value] of Object.entries(rawInputs)) {
    inputs[key] = normalizeInputDef(value);
  }

  // Meta: everything except 'inputs'
  // If 'meta' key exists and contains typed definitions, resolve defaults
  const meta: Record<string, unknown> = {};
  if (raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)) {
    for (const [key, value] of Object.entries(raw.meta as Record<string, unknown>)) {
      if (isTypedDefinition(value)) {
        meta[key] = (value as { default?: unknown }).default;
      } else {
        meta[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "inputs") {
        meta[key] = value;
      }
    }
  }

  return { meta, inputs };
}

/** Convert shorthand or full definition to InputDefinition. */
function normalizeInputDef(value: unknown): InputDefinition {
  // Full definition: object with a 'type' key
  if (isTypedDefinition(value)) {
    const def = value as Record<string, unknown>;
    const hasDefault = "default" in def;
    return {
      type: (def.type as InputDefinition["type"]) ?? "any",
      ...(hasDefault ? { default: def.default as Json } : {}),
      required: def.required === true || (!hasDefault && def.required !== false),
      ...(def.enum ? { enum: def.enum as Json[] } : {}),
      ...(def.description ? { description: def.description as string } : {}),
    };
  }

  // Shorthand: null means required with no default
  if (value === null) {
    return { type: "any", required: true };
  }

  // Shorthand: value is the default, type inferred
  return {
    type: inferType(value),
    default: value as Json,
    required: false,
  };
}

function isTypedDefinition(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && !Array.isArray(value) && "type" in (value as Record<string, unknown>);
}

function inferType(value: unknown): InputDefinition["type"] {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) return "object";
  return "any";
}
```

On replay, `durableImportComponent` feeds the stored content from
the journal. Parsing re-runs at runtime on the stored content,
producing the same segments deterministically. If
`useImportComponentGuard` is installed, it re-reads the file and
compares hashes before replay starts — if the file changed,
`StaleInputError` halts replay.

### 5.4 The root document is a component

The entry point treats the root document through the same import
pipeline as any component. This gives it hash tracking, replay guard
staleness detection, and uniform error handling for free.

```typescript
function* documentWorkflow(docPath: string): Workflow<string> {
  // Import root — same pipeline as any component.
  // The host installs Resolve middleware that maps "__root__" → docPath
  const root = yield* durableImportComponent("__root__");

  // Expand all segments
  const expanded = yield* expandSegments(
    root.bodySegments,
    root.meta,
    {},              // No props for root
    new Set(),       // Empty hide set
  );

  // Render to output string
  return renderSegments(expanded);
}
```

---

## 6. Expansion

### 6.1 The expansion algorithm

Expansion is a term-rewriting process. Each component invocation is
replaced by the component's body, with `<Content />` substituted by
the invocation's children and `{meta.key}` / `{props.key}` resolved.

Expansion is **top-down with bottom-up child processing**: children
are expanded first, then substituted into the component body, then the
substituted body is expanded recursively.

```typescript
function* expandSegments(
  segments: Segment[],
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
): Workflow<Segment[]> {
  const result: Segment[] = [];

  for (const segment of segments) {
    switch (segment.type) {
      case "text": {
        // Heal incomplete markdown constructs at segment boundaries
        const healed = healSegment(segment.content);
        // Interpolate {meta.key} and {props.key} — runtime, no journal
        const interpolated = interpolate(healed, parentMeta, parentProps);
        result.push({ type: "text", content: interpolated });
        break;
      }

      case "component": {
        const expanded = yield* expandComponent(
          segment.name,
          segment.props,
          segment.children,
          hideSet,
        );
        result.push(...expanded);
        break;
      }

      case "codeBlock": {
        // Interpolate eval bindings into content before the modifier chain.
        // EvalEnvCtx may not be set (e.g., blocks outside component expansion),
        // so we use .get() and fall back to the original content.
        const evalEnv = yield* EvalEnvCtx.get();
        const interpolatedContent = evalEnv
          ? interpolateEvalBindings(segment.content, evalEnv.values)
          : segment.content;

        // Compose modifier chain from info string and run it
        const context: CodeBlockContext = {
          language: segment.language,
          content: interpolatedContent,
          // componentName threaded from expansion context
        };
        const chain = composeModifierChain(
          segment.modifiers, context, registry,
        );
        const codeResult = yield* chain();

        if (codeResult.exitCode !== 0 && codeResult.output === "") {
          result.push({
            type: "error",
            message: `Command failed (exit ${codeResult.exitCode}): ${codeResult.stderr}`,
            source: segment.content,
          });
        } else if (codeResult.output !== "") {
          result.push({
            type: "execOutput",
            command: segment.content,
            result: {
              exitCode: codeResult.exitCode,
              stdout: codeResult.output,
              stderr: codeResult.stderr,
            },
          });
        }
        break;
      }

      default:
        result.push(segment);
    }
  }

  return result;
}
```

The modifier chain composition, handler registration, and
`durableSample` are defined in §3.3–3.4. The expansion code above
composes the chain from the info string and runs it via
`composeModifierChain`.

### 6.2 Component expansion with cycle detection

```typescript
const MAX_EXPANSION_DEPTH = 64;

function* expandComponent(
  name: string,
  props: Record<string, Json>,
  children: Segment[],
  hideSet: Set<string>,
): Workflow<Segment[]> {
  // Cycle detection — Prosser's algorithm
  if (hideSet.has(name)) {
    return [{
      type: "error",
      message: `Cycle detected: ${name} is already being expanded (hide set: ${[...hideSet].join(" → ")})`,
      source: name,
    }];
  }

  if (hideSet.size >= MAX_EXPANSION_DEPTH) {
    return [{
      type: "error",
      message: `Maximum expansion depth (${MAX_EXPANSION_DEPTH}) exceeded`,
      source: name,
    }];
  }

  // Import — single durable effect (resolve + read + hash)
  const definition = yield* durableImportComponent(name);

  // Validate props against declared inputs
  const validatedProps = validateProps(name, props, definition.inputs);

  // Expand children first (bottom-up)
  const expandedChildren = yield* expandSegments(
    children,
    definition.meta,
    validatedProps,
    hideSet,
  );

  // Substitute <Content /> and interpolate {meta.key} / {props.key}
  const substituted = substituteContent(
    definition.bodySegments,
    expandedChildren,
    definition.meta,
    validatedProps,
  );

  // Recurse with augmented hide set.
  // Each component gets its own fresh binding environment so that
  // eval blocks within a component share bindings but don't leak
  // into parent or sibling components. This is critical for the
  // provider pattern (§6.6) where each provider has isolated
  // port/URL bindings.
  const newHideSet = new Set([...hideSet, name]);
  const componentEnv: EvalEnv = { values: {} };
  return yield* EvalEnvCtx.with(
    componentEnv,
    function* () {
      return yield* expandSegments(
        substituted,
        definition.meta,
        validatedProps,
        newHideSet,
      );
    },
  );
}
```

Cycle detection and depth limiting are runtime operations — no journal
entries. They are deterministic from the component dependency graph,
which is reconstructed identically during replay because the same
components are imported in the same order.

### 6.3 Content slot: `<Content />`

When the boundary scanner encounters `<Content />` inside a component
body, it produces a `ComponentInvocation` with `name: "Content"`.
During expansion, this is a special case — it is not resolved from the
file system. Instead, it is replaced by the expanded children passed
from the invocation site.

```typescript
function substituteContent(
  bodySegments: Segment[],
  expandedChildren: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
): Segment[] {
  return bodySegments.flatMap((segment) => {
    if (segment.type === "component" && segment.name === "Content") {
      // Replace <Content /> with the caller's expanded children
      return expandedChildren;
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

If the component body does not contain `<Content />`, children from the
invocation site are silently discarded. If the component body contains
multiple `<Content />`, each is replaced independently (all receive the
same children).

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

### 6.5 Prop validation

Components only accept props declared in their `inputs` frontmatter.
Undeclared props are rejected at expansion time. Missing required props
produce errors. Default values fill in for omitted optional props.

```typescript
function validateProps(
  componentName: string,
  callerProps: Record<string, Json>,
  inputs: Record<string, InputDefinition>,
): Record<string, Json> {
  const validated: Record<string, Json> = {};
  const errors: string[] = [];

  // Check for undeclared props
  for (const key of Object.keys(callerProps)) {
    if (!(key in inputs)) {
      errors.push(
        `Unknown prop "${key}" passed to <${componentName} />. ` +
        `Declared inputs: ${Object.keys(inputs).join(", ") || "(none)"}`
      );
    }
  }

  // Validate and fill defaults for each declared input
  for (const [key, def] of Object.entries(inputs)) {
    if (key in callerProps) {
      const value = callerProps[key];

      // Type check
      if (def.type !== "any" && !checkType(value, def.type)) {
        errors.push(
          `Prop "${key}" on <${componentName} /> expected ${def.type}, ` +
          `got ${typeof value}`
        );
      }

      // Enum check
      if (def.enum && !def.enum.includes(value)) {
        errors.push(
          `Prop "${key}" on <${componentName} /> must be one of: ` +
          `${def.enum.join(", ")}. Got: ${JSON.stringify(value)}`
        );
      }

      validated[key] = value;
    } else if ("default" in def && def.default !== undefined) {
      // Apply default
      validated[key] = def.default;
    } else if (def.required) {
      errors.push(
        `Required prop "${key}" missing on <${componentName} />`
      );
    }
    // Optional with no default and not provided → not in validated
  }

  if (errors.length > 0) {
    throw new PropValidationError(componentName, errors);
  }

  return validated;
}

function checkType(value: Json, type: InputDefinition["type"]): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "any": return true;
  }
}
```

Validation is a runtime operation — deterministic from the component
definition and the caller's props. It runs after import but before
expansion. Errors are thrown immediately, not deferred.

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
input definition are applied before interpolation, so `{props.greeting}`
resolves to `"Hello"` even if the caller wrote `<Greeting name="world" />`
(assuming `greeting` has default `"Hello"`).

Props also affect expansion when passed through to child components:

```markdown
<!-- Wrapper.md -->
---
inputs:
  label:
    type: string
    required: true
---
<Inner label={props.label} />
<Content />
```

Expression props (`count={42}`, `data={{ key: "value" }}`) are parsed
by the JSX boundary scanner's expression state tracking (brace depth
counting). The scanner extracts the raw expression string; evaluation
of the expression to a JSON value is handled during segment
construction. Only JSON-serializable values are supported — function
props are not (they can't survive replay).

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

### 6.6 Eval binding interpolation

Inside any executable code block's **content**, bare `{name}`
references (no namespace prefix) resolve against `env.values` — the
eval binding environment populated by preceding `eval` blocks within
the same component:

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
only eval binding interpolation. To use a prop value in a code block,
capture it into a binding via an `eval` block first.

#### Where interpolation runs

Eval binding interpolation runs **once in the expansion engine**, in
`expandSegments`, immediately before the modifier chain is composed
for a `codeBlock` segment. By the time any modifier factory receives
`ctx.content`, the content is already fully interpolated — modifiers
are not responsible for text preparation and do not need to know
interpolation exists.

```typescript
function interpolateEvalBindings(
  content: string,
  bindings: Record<string, unknown>,
): string {
  return content.replace(
    /\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g,
    (match, key) => key in bindings ? String(bindings[key]) : match,
  );
}
```

This is a runtime operation — deterministic from `env.values` and
the block source. It produces no journal entry. On replay,
`env.values` is populated from the stored `durableEval` result (§4.5)
before any subsequent blocks execute, so interpolation produces the
same substitutions as the original run.

#### Serialization constraint

Only JSON-serializable values in `env.values` are stored in the
journal (§4.1). Non-serializable values (functions, class instances)
remain in `env.values` as live references during the current run but
are absent on replay. For eval binding interpolation purposes this is
acceptable: values used in `{name}` substitutions are almost always
primitives (port numbers, URLs, strings) which are JSON-serializable
and round-trip correctly through the journal.

### 6.7 Provider component pattern

A **provider component** is a regular markdown component whose body
follows a structured pattern that manages background process lifecycle
for its subtree. It composes `eval` + `daemon` + `eval` (readiness)
+ `<children />` into a reusable component — no framework-level
configuration, no `RunDocumentOptions` changes.

#### Structure

1. An `eval` block that allocates resources and exports bindings
   (port, URLs).
2. A `daemon` block that starts the background process using those
   bindings.
3. An `eval` block that polls for readiness using `when`.
4. `<children />` — the subtree that uses the running process.

````markdown
---
inputs:
  command:
    type: string
    required: true
---

```ts eval
const port = yield* findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
```

```bash daemon exec
./server --port {port} --nobrowser
```

```ts eval
yield* when(function* () {
  const response = yield* fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error(`Not ready: ${response.status}`);
});
```

<children />
````

#### Execution sequence

**Block 1 — resource allocation:**
`findFreePort()` is available as a VM global. The eval block exports
`port` and `baseUrl` to `env.values`. `durableEval` journals the
result.

**Block 2 — daemon spawn:**
`{port}` is substituted from `env.values` into the command content
before `buildCommand` runs. The resulting command is forked into the
eval scope. Control returns immediately. No journal entry.

**Block 3 — readiness:**
`when` polls with retries until the server responds. `durableEval`
journals the result.

**`<children />`:**
Child expansion runs with the server alive and ready. `sample` calls
in children reach the server at `baseUrl`.

**Component scope closes:**
The eval scope closes. The daemon task is cancelled. The subprocess
is terminated.

#### How `sample` middleware accesses the server

The `sample` modifier delegates to the Sample Api (§3.4). A
middleware layer reads the server URL from `env.values`, which is on
the scope and accessible to all middleware running within the
component's expansion:

```typescript
scope.around(Sample, {
  *sample([context], next): Operation<string> {
    const env = yield* ephemeral(EvalEnvCtx.expect());
    const baseUrl = env.values.baseUrl as string;
    return yield* callLLM(baseUrl, context);
  },
});
```

Because `EvalEnvCtx` is set on the component's scope via
`Context.with()`, this middleware correctly reads the `baseUrl` that
belongs to the enclosing provider component — not a sibling or
parent provider's value.

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

#### Replay behavior of the provider pattern

On full replay (all `eval` and `sample` journal entries present):

- Block 1 (`findFreePort`): `durableEval` returns the stored result.
  `port` and `baseUrl` are restored to `env.values`.
  `findFreePort()` is not called.
- Block 2 (`daemon exec`): `daemon` runs regardless — the process
  starts and binds to the stored port. No journal entry.
- Block 3 (`when`): `durableEval` returns the stored result
  immediately. No polling.
- `<children />`: all durable effects replay from the journal.
- Component closes: daemon terminated.

Total overhead on full replay: one daemon process started and
terminated after children finish replaying.

---

## 7. Staleness and replay

### 7.1 File staleness via `useImportComponentGuard`

The custom `useImportComponentGuard` (defined in §5.3) handles
staleness detection for `import_component` effects. It reads
`result.value.path` and `result.value.contentHash` from stored
journal entries, re-reads those files, and compares hashes.

When installed before `durableRun`, it:

1. **Check phase** (before replay): For each `import_component` event
   in the journal, re-reads the file at the stored path and computes
   its current SHA-256 hash. Caches the result.

2. **Decide phase** (during replay): Compares the cached current hash
   against the stored `contentHash`. If they differ, returns
   `{ outcome: "error", error: StaleInputError(...) }`.

If any component file changed since the last run, replay halts with
`StaleInputError` before the workflow even starts executing.

### 7.2 Staleness policy via middleware

The default behavior (halt on any stale file) is correct for
production. For development workflows, users may want different
policies. These compose via existing middleware:

**Re-execute from stale point.** Install Divergence middleware that
responds to `StaleInputError` by switching to live execution:

```typescript
function* devMode(): Operation<void> {
  yield* useImportComponentGuard();

  const scope = yield* useScope();
  scope.around(Divergence, {
    decide([info], next) {
      if (info.kind === "description-mismatch") {
        return { type: "run-live" };
      }
      return next(info);
    },
  });

  yield* durableRun(() => documentWorkflow(docPath), { stream });
}
```

**Skip staleness checks entirely.** Don't install the guard. Replay
uses stored content regardless of current file state. Useful for
"show me what this produced last time."

**Selective staleness.** Install a custom guard that only checks
certain component names or paths.

### 7.3 What happens when a file changes

**Scenario: component file changed, `useImportComponentGuard` installed.**

1. `durableRun` reads events from the journal.
2. Guard's check phase re-reads files at stored paths, computes hashes.
3. Guard's decide phase finds hash mismatch for the changed component.
4. `StaleInputError` raised — replay halts.
5. Caller catches the error and starts a new execution (new stream).

**Scenario: component file changed, no guard installed.**

1. Replay proceeds using stored file content from the journal.
2. Expansion produces the same output as the previous run.
3. The changed file is invisible — the stored content is authoritative.

**Scenario: new component added to document, file doesn't exist in journal.**

1. Replay proceeds normally through existing journal entries.
2. When the new `<NewComponent />` is encountered, there is no journal
   entry for its `durableImportComponent`. This is the replay-to-live
   transition — the effect executes live (resolves, reads, hashes),
   records a new journal entry.
3. Execution continues with the new component expanded.

---

## 8. Entry point

### 8.1 `runDocument`

```typescript
interface RunDocumentOptions {
  /** Path to the root markdown document. */
  docPath: string;

  /** Durable stream for journaling. */
  stream: DurableStream;

  /** Runtime for I/O operations. */
  runtime: DurableRuntime;

  /** Component search directories (default: ["./components", "./"]) */
  componentDirs?: string[];

  /** Install file content guard (default: true) */
  freshness?: boolean;

  /** Custom modifier factories to register alongside built-ins. */
  modifiers?: Record<string, ModifierFactory>;

  /** Sample Api middleware for the `sample` modifier. */
  sampleHandler?: SampleApi;
}

function* runDocument(options: RunDocumentOptions): Operation<string> {
  const {
    docPath,
    stream,
    runtime,
    componentDirs = ["./components", "./"],
    freshness = true,
    modifiers: customModifiers = {},
  } = options;

  // Install runtime
  yield* DurableRuntimeCtx.set(runtime);

  // Install replay guard
  if (freshness) {
    yield* useImportComponentGuard();
  }

  // Install resolver middleware — maps __root__ to docPath,
  // then falls through to directory resolver for components
  const scope = yield* useScope();
  scope.around(Resolve, {
    *resolve([name], next): Operation<ResolveResult> {
      if (name === "__root__") {
        return { path: docPath };
      }
      return yield* next(name);
    },
  });
  yield* useDirectoryResolver(componentDirs);

  // Create shared VM context for all eval blocks (§4.2)
  const evalCtx = createEvalContext();
  yield* EvalCtxKey.set(evalCtx);

  // Create eval scope — MUST be created before durableRun (§4.4).
  // The channel processor task and the sender inside durableEval
  // must share an ancestor scope outside the durable execution boundary.
  const evalScope = yield* resource(useEvalScope());
  yield* EvalScopeCtx.set(evalScope);

  // Install built-in modifier handlers (exec, silent, sample, eval, persist, timeout)
  yield* useBuiltinModifiers();

  // Install custom modifier handlers
  for (const [name, factory] of Object.entries(customModifiers)) {
    registry.set(name, factory);
  }

  // Run the durable workflow
  return yield* durableRun(
    () => documentWorkflow(docPath),
    { stream },
  );
}
```

### 8.2 Usage from standalone code

```typescript
import { run } from "effection";
import { InMemoryStream } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";

await run(function* () {
  const result = yield* runDocument({
    docPath: "./README.md",
    stream: new InMemoryStream(),
    runtime: nodeRuntime(),
  });

  console.log(result);
});
```

---

## 9. Journal shape

### 9.1 Effect vocabulary for MDX execution

All effects use existing durable effect types from
`@effectionx/durable-effects` except `import_component`, which is
new to the MDX execution layer.

| Operation | Effect type | Effect name | Notes |
|-----------|------------|-------------|-------|
| Import component | `import_component` | `{ComponentName}` | path + content + contentHash in result |
| Execute code block | `exec` | `exec:{command_preview}` | Command array in description, stdout/stderr/exitCode in result |
| Evaluate code block | `eval` | `eval:{blockId}` | source + language + bindings in description; serializable exports + hashes in result (§4.5) |
| Sample LLM call | `sample` | `sample:{command_preview}` | Only when `sample` modifier is used; Sample Api middleware determines behavior |
| Resolve components (glob) | `glob` | `resolve:{dir}` | Only when `useDurableGlobResolver` middleware is installed |

### 9.2 Example journal for a multi-component document

With the default directory resolver:

```
[0] yield  root  { type: "import_component", name: "__root__" }
    result: { status: "ok", value: { path: "./README.md", content: "---\ntitle: ...", contentHash: "sha256:aaa..." } }

[1] yield  root  { type: "import_component", name: "Header" }
    result: { status: "ok", value: { path: "./components/Header.md", content: "---\n...", contentHash: "sha256:bbb..." } }

[2] yield  root  { type: "import_component", name: "Footer" }
    result: { status: "ok", value: { path: "./components/Footer.md", content: "...", contentHash: "sha256:ccc..." } }

[3] yield  root  { type: "exec", name: "exec:date +%Y", command: ["bash", "-c", "date +%Y"], timeout: 30000 }
    result: { status: "ok", value: { exitCode: 0, stdout: "2026\n", stderr: "" } }

[4] yield  root  { type: "eval", name: "eval:root:0", language: "js" }
    result: { status: "ok", value: { value: { port: 4321 }, sourceHash: "sha256:ddd...", bindingsHash: "sha256:eee..." } }

[5] close  root  result: { status: "ok", value: "...rendered output..." }
```

With the durable glob resolver middleware (`useDurableGlobResolver`),
the journal also includes glob entries before the first import:

```
[0] yield  root  { type: "glob", name: "resolve:./components", baseDir: "./components", include: ["**/*.md"] }
    result: { status: "ok", value: { matches: [...], scanHash: "sha256:..." } }

[1] yield  root  { type: "import_component", name: "__root__" }
    ...
```

The glob entry is protected by `useGlobContentGuard` — if files are
added to or removed from the components directory between runs,
replay halts with `StaleInputError`.

### 9.3 Sequential coroutine IDs

In the basic sequential model, all effects run under the `root`
coroutine ID. When parallel expansion is introduced (via `durableAll`
for independent sibling components), child coroutine IDs follow the
standard scheme: `root.0`, `root.1`, etc.

---

## 10. Rendering

### 10.1 Segment → output

After expansion, the segment stream is flattened into a string:

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

### 10.2 Error rendering

Errors are rendered as HTML comments by default. This keeps the output
valid markdown while making errors visible. An error rendering strategy
is configurable at the host level (e.g., throw on error, render as
visible warning blocks, collect into a separate error report).

---

## 11. Parallel expansion (future)

When a document contains multiple independent component invocations at
the same level, they can be expanded concurrently via `durableAll`:

```typescript
// Future: parallel expansion of independent siblings
function* expandSegmentsParallel(
  segments: Segment[],
  ...
): Workflow<Segment[]> {
  // Group consecutive components that don't depend on each other
  const groups = groupIndependentComponents(segments);

  const results: Segment[] = [];
  for (const group of groups) {
    if (group.type === "parallel") {
      const expanded = yield* durableAll(
        group.components.map((comp) =>
          function* () {
            return yield* expandComponent(comp.name, comp.props, ...);
          }
        ),
      );
      results.push(...expanded.flat());
    } else {
      results.push(...yield* expandSegments([group.segment], ...));
    }
  }
  return results;
}
```

This is additive — the sequential model is correct and complete. The
parallel model is an optimization that produces the same output (the
journal records the same effects, just with child coroutine IDs
instead of all under `root`).

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
| B1 | `durableImportComponent` golden run | Single `import_component` entry with path + content + contentHash |
| B2 | `durableImportComponent` replay | Stored result returned, no Api call, no file read |
| B3 | Replay + runtime parsing | Stored content parsed to same meta/inputs/segments |
| B4 | Import with simple frontmatter | `meta` correctly parsed, keys except `inputs` |
| B5 | Import with typed meta | `meta` key with type definitions, defaults resolved |
| B6 | Import with inputs (shorthand) | `greeting: Hello` → InputDefinition with type string, default "Hello" |
| B7 | Import with inputs (full) | `name: { type: string, required: true }` → InputDefinition |
| B8 | Import with inputs (null shorthand) | `name: null` → required, type any, no default |
| B9 | Import missing component | Resolve Api throws, error propagated |
| B10 | Stale import (guard installed) | File changed → StaleInputError from `useImportComponentGuard` |
| B11 | Stale import (no guard) | Replay uses stored content silently |
| B12 | Root document as component | `__root__` import, same journal shape |
| B13 | Dotted name resolution | `Ns.Sub` → `components/Ns/Sub.md` |
| B14 | No inputs key | Component accepts no props, `inputs` is empty record |
| B15 | Default resolver middleware | Resolves via `runtime.stat` probe in search path order |
| B16 | Durable glob resolver middleware | `durableGlob` journals directory scan, resolve is a map lookup |
| B17 | Durable glob resolver replay | Glob replayed from journal, no filesystem scan |
| B18 | Durable glob resolver + `useGlobContentGuard` | File added to components dir → StaleInputError |
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
| C14 | **Undeclared prop rejected** | `<Comp foo="bar" />` where Comp has no input `foo` → PropValidationError |
| C15 | **Required prop missing** | `<Comp />` where Comp declares `name: { required: true }` → PropValidationError |
| C16 | **Default applied** | `<Comp />` where Comp declares `greeting: Hello` → `{props.greeting}` resolves to "Hello" |
| C17 | **Type mismatch rejected** | `<Comp count="abc" />` where count is `type: number` → PropValidationError |
| C18 | **Enum validated** | `<Comp model="bad" />` where model has `enum: [a, b]` → PropValidationError |
| C19 | **Enum accepted** | `<Comp model="a" />` where model has `enum: [a, b]` → valid |
| C20 | **No inputs, no props** | Component with no `inputs`, invoked with no props → valid |
| C21 | **No inputs, some props** | Component with no `inputs`, invoked with props → PropValidationError |
| C22 | **Optional with no default, not passed** | Input not in validated props, `{props.key}` → empty string |

### Tier D — Code execution and modifier middleware

| # | Test | Verify |
|---|------|--------|
| D1 | `bash exec` golden run | `execHandler` runs, stdout in output, journal has exec entry |
| D2 | Exec replay | Command not re-executed, stored stdout used |
| D3 | Non-zero exit code | ErrorSegment in output |
| D4 | Multi-line command | Full script passed to `-c` |
| D5 | `python exec` | `python -c` invocation |
| D6 | `bash silent exec` | Chain: silent wraps exec. Exec journals. Silent returns empty output |
| D7 | `silent exec` replay | Still produces empty output from stored result |
| D8 | `bash sample exec` golden run | Chain: sample wraps exec. Two journal entries (exec + sample) |
| D9 | `bash sample exec` replay | Neither command nor LLM called, stored LLM response in output |
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
| E2 | Full replay (no changes) | Zero file reads, zero exec calls, same output |
| E3 | Crash mid-expansion, resume | Partial replay, then live for remaining |
| E4 | Component file changed, guard on | StaleInputError before replay |
| E5 | New component added | Replay existing, live for new component |
| E6 | Validated props flow through expansion | Declared props visible in component via `{props.key}`, defaults applied |
| E7 | Undeclared prop in full document | PropValidationError with component name and prop name |
| E8 | `silent exec` in full document | Command runs, result journaled, output omitted |
| E9 | `sample exec` in full document | Command + LLM both journaled, LLM response in output |
| E10 | Unclosed bold across component boundary | `**text\n<Comp />\nmore` → healed bold in first segment, component expanded, `more` unaffected |

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

**Orphaned closing markers (NOT healed):**

| # | Test | Input | Verify |
|---|------|-------|--------|
| F15 | Orphaned bold closer | Text segment starts with `world** more` | Unchanged — remend does not strip orphaned closers |
| F16 | Orphaned italic closer | Text segment starts with `text* more` | Unchanged |

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

### Tier H — VM context (`eval-context`)

| # | Test | Verify |
|---|------|--------|
| H1 | VM context creation | `createEvalContext()` returns `EvalContext` with `vmContext` |
| H2 | Effection globals available | `sleep`, `spawn`, `createChannel` accessible in compiled block |
| H3 | `console` available | `console.log` callable without error |
| H4 | Custom globals | `createEvalContext({ fetch })` → `fetch` accessible in block |
| H5 | `compileBlock` returns generator function | Return value is callable, returns a generator |
| H6 | Context reuse across blocks | Same `vmContext` used for two blocks — shared globals |
| H7 | Trailing newline in `compileBlock` | `//# sourceURL` comment doesn't swallow closing `})` |
| H8 | Isolation from host | Block cannot access host module scope (e.g., `require`) |

### Tier I — Middleware conformance (eval modifiers)

| # | Test | Verify |
|---|------|--------|
| I1 | `eval` is terminal | `evalFactory` ignores `next` — never calls it |
| I2 | `eval` returns empty output | `result.output === ""`, `exitCode === 0` |
| I3 | `persist eval` composes | `persist` sets `PersistFlagCtx`, `eval` reads it |
| I4 | `timeout=5s eval` composes | Timeout cancels after 5s if block hangs |
| I5 | `timeout eval` default | Default timeout is 30s |
| I6 | `persist timeout=10s eval` | Three modifiers compose: persist → timeout → eval |
| I7 | `silent eval` | Silent wraps eval — both run, output empty |

### Tier J — Eval and durableEval integration

| # | Test | Verify |
|---|------|--------|
| J1 | `js eval` golden run | Block executes in-process, journal has eval entry |
| J2 | `js eval` replay | Block not re-executed, stored exports restored to env |
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
| K5 | Replay restores serializable bindings | After replay, `env.values` contains stored exports |

### Tier L — Persist modifier

| # | Test | Verify |
|---|------|--------|
| L1 | `persist eval` retains spawned resource | Resource spawned in block survives block completion |
| L2 | Non-persist eval tears down resource | Resource spawned in block torn down at block end |
| L3 | Persist resource lifetime matches component | Resource torn down when component expansion completes |
| L4 | PersistFlagCtx scoped to chain | Flag is `true` only during the persist-wrapped chain |
| L5 | Multiple persist blocks in one component | Each retains its own resources independently |
| L6 | Persist during replay is no-op | On replay, no `evalScope.eval()` call, no resources retained |
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

### Tier N — Staleness (eval blocks)

| # | Test | Verify |
|---|------|--------|
| N1 | Source hash mismatch triggers StaleInputError | Block source changed since last run → replay halts |
| N2 | Bindings hash mismatch triggers StaleInputError | Input bindings changed → replay halts |
| N3 | Unchanged source and bindings replay normally | Hashes match → stored result returned |
| N4 | sourceHash computed from transformed code | Hash is of the post-transform source, not the raw block |
| N5 | bindingsHash computed from serialized imports | Hash covers the JSON of imported env bindings |

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
| P7 | On replay, env restored before interpolation | `durableEval` result restores `port`; subsequent block interpolates correctly |
| P8 | Non-serializable binding not restored on replay | Function in `env.values` not present after replay; bare `{fn}` left verbatim |

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
| Q10 | `daemon` without eval scope | Missing `EvalScopeCtx` → clear error |
| Q11 | Modifier chain: `bash daemon exec` | `daemon` is outermost terminal; `exec` present but never called |
| Q12 | Replay: daemon starts and stops | On full replay, process spawned and terminated; no live `sample` calls made |
| Q13 | Replay: stored port used | `env.values.port` restored from journal; daemon binds same port |

### Tier R — VM globals

| # | Test | Verify |
|---|------|--------|
| R1 | `findFreePort` accessible in eval block | `yield* findFreePort()` succeeds, returns a number |
| R2 | `findFreePort` returns usable port | Returned port is bindable (no EADDRINUSE) |
| R3 | `findFreePort` not called on replay | `durableEval` returns stored port; function not invoked |
| R4 | `when` accessible in eval block | `yield* when(fn)` retries until fn succeeds |
| R5 | `when` retries on throw | Inner function throws twice, then succeeds → `when` resolves |
| R6 | `when` propagates timeout | Inner function never succeeds → `when` throws after limit |

### Tier S — Provider component pattern (integration)

| # | Test | Verify |
|---|------|--------|
| S1 | Full provider golden run | eval → daemon → when → children → cleanup |
| S2 | Port flows from eval to daemon | `{port}` in daemon content matches `findFreePort()` result |
| S3 | Children can call sample after daemon ready | `sample` calls in children reach daemon endpoint |
| S4 | Daemon terminated after children expand | After `runDocument` completes, process not running |
| S5 | Provider crash during `when` | Daemon exits before ready → `when` fails → `ErrorSegment` |
| S6 | Provider crash during children | Daemon exits mid-child-expansion → error propagated |
| S7 | Nested providers | Outer + inner provider → both start, inner tears down first |
| S8 | Full replay of provider component | All eval and sample entries replayed; daemon starts and stops; no live HTTP calls |
| S9 | Partial replay (children not yet journaled) | eval+daemon+when replayed; children run live with daemon available |
| S10 | Multiple provider instances in parallel | Two provider siblings → two processes, different ports |

---

## 13. Walked example: crash recovery

### Initial state

```
README.md references <A />, <B />, and a ```bash exec``` block.
A.md references <C />.
```

### First run — crashes after importing B

```
[0] yield root  import_component __root__  → { path, content, contentHash }
[1] yield root  import_component A         → { path, content, contentHash }
[2] yield root  import_component C         → { path, content, contentHash } (C referenced by A)
[3] yield root  import_component B         → { path, content, contentHash }
    ← CRASH HERE
```

### Second run — resumes

1. `durableRun` reads journal: 4 Yield events, no Close for root.
2. `useImportComponentGuard` re-reads all 4 files, compares hashes — all match.
3. Replay feeds stored results for events [0]–[3]. Parsing re-runs at
   runtime on stored content.
4. Execution transitions to live after event [3].
5. The `exec` block runs live:

```
[4] yield root  exec "exec:date +%Y"      → { exitCode: 0, stdout: "2026\n" }
[5] close root  result: { status: "ok", value: "...full rendered output..." }
```

6. Output returned to caller.

### Third run — full replay

1. Journal has events [0]–[5] + Close.
2. `durableRun` sees Close for root → short-circuits, returns stored output.
3. Zero imports, zero command executions.

---

## 14. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Root document treated as a component | Uniform hash tracking and staleness detection |
| 2 | All paths are workspace-relative | Journal portability — no absolute paths, everything relative to cwd |
| 3 | Resolution is an Effection Api | Pluggable middleware (search paths, aliases, glob) — runs inside `durableImportComponent` during live execution |
| 4 | `durableImportComponent` is a single durable effect | Resolve + read + hash in one `createDurableOperation` — one journal entry per component, Api and filesystem untouched on replay |
| 5 | Parsing is runtime | Deterministic from file content, no journal needed |
| 6 | Info string modifiers are a middleware chain | `bash silent exec` — left-to-right wrapping, composable, extensible, compatible with all renderers |
| 7 | Each modifier is a factory that returns `Middleware<[], CodeBlockWorkflow>` | Factory captures params in closure; context on Effection scope via `CodeBlockCtx.with()` + `useCodeBlock()`; aligns with Effection v4.1's `Middleware<TArgs, TReturn>` |
| 8 | `useModifier` registers handlers on the scope | Scope-inherited — child scopes can override parent handlers for their subtree |
| 9 | `exec`/`eval` are terminal handlers, others are wrapping | Terminal handlers ignore `next`; wrapping handlers call `next()` and transform the result |
| 10 | `sample` handler delegates to Sample Api via `durableSample` | Two layers: handler (part of modifier chain) and Api (LLM middleware) — each composable independently |
| 11 | Cycle detection via hide sets, runtime | Deterministic from component graph, no journal |
| 12 | `<Content />` is the content slot | Valid JSX, familiar (Astro/React), zero parser changes |
| 13 | `{meta.key}` / `{props.key}` for interpolation | MDX-compatible expression syntax, parsed by regex |
| 14 | Custom `useImportComponentGuard` for staleness | Reads path and contentHash from `result.value` (not `description.path`) since path isn't known until resolve runs |
| 15 | Default staleness policy: halt | Safe default; middleware overrides for dev workflows |
| 16 | Props must be declared in `inputs` frontmatter | Undeclared props are rejected — components are contracts |
| 17 | Input definitions support JSON Schema subset | `type`, `default`, `required`, `enum`, `description` — enough for validation without full JSON Schema complexity |
| 18 | Shorthand input syntax: value-as-default | `greeting: Hello` is equivalent to `greeting: { type: string, default: Hello }` — ergonomic for simple cases |
| 19 | `null` shorthand means required, no default | `name: null` declares a required input with no default — the minimal way to say "caller must provide this" |
| 20 | Meta supports optional typed definitions | `meta:` key with JSON Schema subset for components that need schema validation on their own metadata |
| 21 | Prop validation is runtime, not durable | Deterministic from component definition + caller props — no journal entry needed |
| 22 | Components are semantic boundaries for markdown constructs | Bold, italic, links, code spans cannot span across a component or exec block — each text segment is healed independently |
| 23 | Remend runs after scanning, before interpolation | Heals incomplete markdown in text segments; `htmlTags: false` required — boundary scanner owns JSX completeness, remend owns markdown completeness |
| 24 | Healing is runtime, not durable | Pure function of text content — runs on both live and replay, no journal entry |
| 25 | `CodeBlockContext` delivered via Effection Context, not handler parameter | `CodeBlockCtx.with()` scopes the context to the chain execution; handlers read via `useCodeBlock()`; keeps middleware signature clean `Middleware<[], ...>` |
| 26 | Reusable `Middleware<TArgs, TReturn>` primitive in `@effectionx/middleware` | Same type as Effection v4.1's Api middleware; `combine()` composes arrays; decoupled from modifier-specific types; originally `src/middleware.ts`, extracted to shared package |
| 27 | `blockId` format: `eval:${componentName ?? "root"}:${index}` | Unique within a document run; component-scoped index ensures deterministic IDs for journal matching on replay |
| 28 | Acorn + magic-string for source transform | Acorn provides reliable ES2024 parsing; magic-string preserves source positions for accurate source maps without rebuilding AST |
| 29 | Execution mode auto-detected from AST | No modifier needed — `yield` in body → generator, `await` → async, neither → sync; mixed yield+await is a transform error |
| 30 | Single shared VM context per document | `vm.createContext()` costs ~7–21ms; reusing one context across all eval blocks amortizes this; globals (Effection APIs, `console`) are set once |
| 31 | `persist` uses a context flag, not direct wrapping | Wrapping the full modifier chain in `evalScope.eval()` hangs because durable effects can't interact with the journal from inside the eval scope's channel processor; instead `persist` sets `PersistFlagCtx`, and `evalFactory` routes only the compiled VM block through `evalScope.eval()` |
| 32 | `evalScope` created before `durableRun` | The channel processor task and the sender inside `durableEval` must share an ancestor scope outside the durable execution boundary; creating inside `durableRun` would isolate the processor |
| 33 | Non-serializable bindings silently omitted from journal | Functions, class instances, and live objects remain in `env.values` during the current run but are absent from the journal; on replay they are not restored — this is by design, since non-serializable state can't survive process restart |
| 34 | Eval blocks produce no rendered output | Eval blocks exist for bindings and side effects; their result is `{ output: "", exitCode: 0, stderr: "" }` — any user-facing output should come from interpolation of the bindings they create |
| 35 | `@effectionx/middleware` replaces local `src/middleware.ts` | The middleware primitive was extracted to a shared package for reuse across the monorepo; import paths updated throughout |
| 36 | `daemon` is a terminal modifier that ignores `next` | Process lifetime ≠ command result; `exec` in the chain satisfies the §3.2 detection rule without invoking `durableExec` |
| 37 | `daemon` uses `evalScope`, not the durable run scope | Lifetime matches component expansion — daemon lives for `<children />` and dies with the component, not the whole document run |
| 38 | `daemon` produces no journal entry | The process is an ephemeral resource; restarting it on every run including replay is correct since replayed `sample` calls never reach the server |
| 39 | Eval binding interpolation uses bare `{name}` syntax | Distinct from `{meta.key}` and `{props.key}` namespaces; local eval bindings are local variables, not namespaced data; regex excludes names containing `.` to avoid conflicts |
| 40 | Eval binding interpolation runs in the expansion engine, not inside modifier factories | Modifiers transform execution results — they are not responsible for preparing source text; one interpolation site in `expandSegments` is consistent with how text segment interpolation already works, and keeps modifier factories free of knowledge about the binding environment |
| 41 | `findFreePort` is a standalone VM global using `node:net` | Port allocation is platform I/O; the function uses Effection's `once` + `race` for event handling and `try/finally` for guaranteed cleanup; exposed in the eval sandbox alongside other Effection globals |
| 42 | `findFreePort` result journaled via `durableEval`, not as its own durable effect | The port number is a scalar export from the eval block; it round-trips through the journal as part of `durableEval`'s `value.value`; no separate effect type or journal entry needed |
| 43 | `when` (from `@effectionx/converge`) is the polling VM global | `when` is the exported name from the package; the sandbox already contains it; no rename or addition needed |
| 44 | Provider lifecycle expressed as a component, not a `RunDocumentOptions` field | Scope boundary is visible in the document tree; composable — multiple providers nest naturally via structured concurrency; no framework-level lifecycle hooks required |
| 45 | Readiness check is a separate `eval` block, not internal to `daemon` | Auditable — strategy visible in the document; replaceable — different daemons have different readiness signals; composable with `when`'s configurable backoff |
| 46 | Sample middleware reads `baseUrl` from `env.values` | Avoids a dedicated inference server context key; `EvalEnvCtx` is already the shared state carrier for within-component coordination; scope-correct because `EvalEnvCtx` is set per component expansion |
| 47 | Each component gets a fresh `EvalEnv` | `EvalEnvCtx.with()` wraps component expansion so eval blocks within a component share bindings but don't leak into parent or sibling components; critical for provider isolation |
