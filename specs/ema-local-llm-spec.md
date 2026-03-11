# EMA Local LLM Integration: Specification

**Status:** Draft
**Audience:** Implementing agent
**Inputs:** `executable-mdx-spec.md` (§3.3, §4.2, §6.7, §8.1), `@effectionx/durable-streams`,
`@effectionx/durable-effects`, `@effectionx/middleware`, `background-process-management.md`

---

## 1. Overview

This spec covers four deliverables needed to run local LLM inference inside EMA
durable workflows. They form a layered stack:

```
LlamafileProvider.md        — user-facing: a standard library component
  └─ daemon modifier        — EMA modifier: forks a long-running process
       └─ @effectionx/process — platform primitive: spawn-and-suspend
  └─ callLlamafile()        — HTTP utility: sends one inference request
       └─ @effectionx/fetch  — Operation-native HTTP
```

**Deliverable 1: `@effectionx/process`** — a new monorepo package exposing
`daemon(command)`, a generator that spawns a subprocess and suspends indefinitely.
Cancellation terminates the subprocess. Premature exit throws `DaemonExitError`.

**Deliverable 2: `daemonFactory`** — the terminal modifier registered as `"daemon"`
in the EMA modifier registry. Reads the interpolated command from `CodeBlockCtx`,
forks it into the component's eval scope via `@effectionx/process`, and immediately
returns empty output.

**Deliverable 3: `LlamafileProvider.md`** — a standard library markdown component
that composes `eval` + `daemon` + `eval` (readiness) + `eval` (middleware install)
+ `<children />` into a reusable provider. Exposes a `model` prop that both
identifies the server and acts as the routing key for `sample` calls.

**Deliverable 4: `callLlamafile()`** — a plain HTTP utility function, not
user-facing middleware. Called directly from `LlamafileProvider.md`'s eval block
with `baseUrl` and `model` closed over at install time. Sends one
`/v1/chat/completions` request via `@effectionx/fetch` and returns the response
content as a string.

---

## 2. `@effectionx/process`

### 2.1 Package layout

```
packages/process/
  src/
    daemon.ts           — daemon() generator + DaemonExitError
    mod.ts              — public API barrel
  package.json
  tsconfig.json
  README.md
```

**`package.json` name:** `@effectionx/process`
**Dependencies:** `effection@4.1.0-alpha.7` (pnpm override), `@effectionx/node`
**Dev dependencies:** `@effectionx/bdd`, `@std/expect`, `node --test`

The EMA package additionally depends on `@effectionx/fetch` for all HTTP
requests — both the Sample Api middleware installed by `LlamafileProvider.md`
and the eval VM sandbox's `fetch` global.

### 2.2 `DaemonExitError`

```typescript
export class DaemonExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly command: string;

  constructor(opts: {
    command: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) {
    const reason = opts.signal
      ? `killed by signal ${opts.signal}`
      : `exited with code ${opts.exitCode}`;
    super(`Daemon process exited prematurely (${reason}): ${opts.command}`);
    this.name = "DaemonExitError";
    this.exitCode = opts.exitCode;
    this.signal = opts.signal;
    this.command = opts.command;
  }
}
```

### 2.3 `daemon(command)`

Spawns a subprocess from a shell command string and suspends until the calling
scope is cancelled. If the process exits before cancellation, throws
`DaemonExitError`.

```typescript
import { once } from "@effectionx/node";
import { race, suspend } from "effection";
import { spawn as nodeSpawn } from "node:child_process";
import type { Operation } from "effection";

/**
 * Spawn a long-running subprocess and suspend until the caller's scope closes.
 *
 * - The command is passed to the system shell (`/bin/sh -c` on Unix,
 *   `cmd /c` on Windows). This matches bash exec block semantics.
 * - If the process exits before the scope closes, throws DaemonExitError.
 * - When the scope closes (cancelled), SIGTERM is sent to the process group.
 *   If the process does not exit within 5 seconds, SIGKILL is sent.
 * - stdout and stderr are inherited from the parent process by default,
 *   allowing log output to appear in the terminal during development.
 *   Pass `stdio: "ignore"` in opts to suppress.
 */
export function* daemon(
  command: string,
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    stdio?: "inherit" | "ignore" | "pipe";
  } = {},
): Operation<never> {
  const proc = nodeSpawn(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: opts.stdio ?? "inherit",
    // Spawn in a new process group so SIGTERM reaches all children
    detached: false,
  });

  // exitSignal resolves when the process exits for any reason
  const exitSignal: Operation<never> = {
    *[Symbol.iterator]() {
      const [code, signal] = yield* once<[number | null, NodeJS.Signals | null]>(
        proc,
        "exit",
      );
      throw new DaemonExitError({ command, exitCode: code, signal });
    },
  } as Operation<never>;

  try {
    // Race between: process exits early (error) vs scope cancelled (normal)
    yield* race([
      exitSignal,
      suspend(),    // suspends until scope is cancelled
    ]);
  } finally {
    // Scope is closing — terminate the process.
    // Try SIGTERM first, escalate to SIGKILL after 5 seconds.
    if (!proc.killed) {
      proc.kill("SIGTERM");
      const termDeadline = Date.now() + 5_000;
      // Busy-poll for exit — this runs in the finalizer which is synchronous-ish
      // in structured concurrency terms. In practice proc.kill() is fast.
      while (!proc.killed && Date.now() < termDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }
  }
}
```

**Implementation note on `once`:** `once` from `@effectionx/node` bridges a
Node.js `EventEmitter` event into an Effection `Operation`. When the `"exit"`
event fires, the operation resolves with its arguments. When the operation is
cancelled (scope torn down), the listener is removed.

**Implementation note on `suspend()`:** Effection's `suspend()` suspends
indefinitely until the calling scope is cancelled. Using `race([exitSignal,
suspend()])` means: "if the process exits, throw; if the scope cancels, fall
through to the `finally` block."

**Windows:** `proc.kill("SIGTERM")` on Windows sends `SIGKILL` (there is no
SIGTERM on Windows). The 5-second escalation still runs but is a no-op on
Windows. This is acceptable for the current target environments.

### 2.4 Public API

```typescript
// mod.ts
export { daemon } from "./src/daemon.ts";
export { DaemonExitError } from "./src/daemon.ts";
```

### 2.5 Tests

**File:** `daemon.test.ts`

| # | Test | Verify |
|---|------|--------|
| P1 | Process runs while scope is alive | Daemon starts; process is running; scope closes; process is not running |
| P2 | SIGTERM sent on scope close | Process receives SIGTERM when scope cancels |
| P3 | DaemonExitError on premature exit | Process exits with code 1 before scope closes → DaemonExitError thrown with exitCode: 1 |
| P4 | DaemonExitError on signal kill | Process killed with SIGKILL before scope closes → DaemonExitError.signal is "SIGKILL" |
| P5 | Error propagates to parent scope | DaemonExitError propagates out of the spawning scope |
| P6 | cwd option passed to process | Process inherits specified working directory |
| P7 | env option merges with process.env | Extra env vars are visible to subprocess |
| P8 | stdio: "ignore" suppresses output | No stdout/stderr written to parent process |
| P9 | Nested daemon scopes close in order | Inner scope's daemon terminated before outer |
| P10 | SIGKILL escalation on stubborn process | Process ignores SIGTERM → receives SIGKILL after 5s |

---

## 3. `daemonFactory` — the `daemon` EMA modifier

### 3.1 Location

**File:** `src/modifiers/daemon.ts` (in the EMA package, alongside
`src/modifiers/persist.ts` and `src/modifiers/timeout.ts`)

### 3.2 Role in the modifier chain

`daemon` is a **terminal modifier** — it ignores `next()` and does not call
`exec`. The `exec` word in the info string satisfies the §3.2 detection rule
and is purely syntactic:

````markdown
```bash daemon exec
./server --port {port} --nobrowser
```
````

The `daemon` factory is registered before `exec` in the chain composition:

```
chain = combine([daemonMiddleware, execMiddleware])
```

`combine()` calls `daemonMiddleware([], next)`. `daemon` ignores `next` —
`execMiddleware` is never invoked.

### 3.3 Implementation

```typescript
// src/modifiers/daemon.ts
import { daemon, DaemonExitError } from "@effectionx/process";
import { ephemeral } from "@effectionx/durable-streams";
import type { ModifierFactory } from "../modifier-registry.ts";
import { useCodeBlock } from "../code-block-ctx.ts";
import { EvalScopeCtx } from "../eval-env.ts";

export const daemonFactory: ModifierFactory = (_params) =>
  (_args, _next) =>
    (function* () {
      const ctx = yield* useCodeBlock();
      // ctx.content is already interpolated by expandSegments before the
      // modifier chain runs — {port} has been substituted with the actual port.
      // buildCommand() wraps it for shell execution.
      const commandParts = buildCommand(ctx.language, ctx.content);
      const commandStr = commandParts.join(" ");

      yield* ephemeral(function* () {
        const evalScope = yield* EvalScopeCtx.expect();

        // Fork into the eval scope. The forked task calls daemon() which
        // suspends indefinitely. When the eval scope closes (component
        // expansion completes), the forked task is cancelled, which runs
        // daemon()'s finally block and terminates the subprocess.
        //
        // If the process exits prematurely, daemon() throws DaemonExitError,
        // which propagates to the eval scope and tears it down. The error
        // surfaces as an ErrorSegment in the document output.
        yield* evalScope.eval(function* () {
          yield* daemon(commandStr);
        });

        // Control returns here immediately after the fork — evalScope.eval()
        // sends the task to a channel and returns without waiting for it.
      }());

      return { output: "", exitCode: 0, stderr: "" };
    })();
```

**Why `ephemeral()`:** `daemonFactory` returns a `CodeBlockWorkflow`
(`Workflow<CodeBlockResult>`), which yields `DurableEffect` values. The
`evalScope.eval()` call and `daemon()` are `Operation` yields — they live in
the Operation world, not the Workflow world. `ephemeral()` is the bridge
(DEC-001): it wraps an `Operation` so it can be called inside a `Workflow`
without producing a journal entry.

**Why `evalScope.eval()`:** The daemon task must survive the modifier chain
returning. Simply `yield* daemon(commandStr)` inside the factory would suspend
the factory forever — the modifier chain would never complete, blocking the
document. `evalScope.eval()` forks the task into a long-lived channel processor
that outlives the current modifier chain execution. The task's lifetime is
bounded by the eval scope, which closes when the component expansion completes.

### 3.4 Registration

In `src/run-document.ts`, alongside other built-in modifier registrations:

```typescript
import { daemonFactory } from "./modifiers/daemon.ts";

// Inside runDocument(), after other registry.set() calls:
registry.set("daemon", daemonFactory);
```

### 3.5 Detection rule reminder

The §3.2 detection rule requires `exec` or `eval` in the info string. A block
with only `daemon` in the chain is **not executable** and will be treated as
passive text. Document authors must write:

```markdown
```bash daemon exec    ← correct: exec satisfies detection rule
```bash daemon         ← wrong: not detected as executable
```

This is intentional — `exec` is the reader-visible signal that the block runs a
command. The `daemon exec` combination communicates "this starts a background
command" without inventing new syntax.

---

## 4. `LlamafileProvider.md` — standard library component

### 4.1 Location

**File:** `components/LlamafileProvider.md`

This file is part of the EMA standard library and is distributed alongside the
EMA package. It is a regular markdown component — no code changes to the EMA
runtime are required to add it.

### 4.2 Component file

````markdown
---
inputs:
  model:
    type: string
    required: true
    description: >
      Model identifier. Serves two purposes: it is passed as the `model` field
      in every /v1/chat/completions request, and it is the routing key that
      sample calls use to target this provider. Must be unique among all
      LlamafileProvider instances active simultaneously in the same document run.
      Example: "phi3-mini", "qwen3-0.6b"
  command:
    type: string
    required: true
    description: >
      Shell command to start the llamafile or llama.cpp server.
      {port} is substituted with the allocated port number before execution.
      Example: "./phi3-mini.llamafile --nobrowser"
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
  return yield* callLlamafile(baseUrl, model, context);
});
```

<children />
````

### 4.3 Prop-to-binding requirement

Code block content uses bare `{name}` binding interpolation from `env.values`
(EMA spec §6.6). `{command}` in the daemon block and `model` in the middleware
eval block must be present in `env.values` when those blocks run.

Both are declared props, not eval results — so they are not automatically in
`env.values`. The expansion engine must pre-populate `env.values` with all
declared prop values at component invocation time, before any block executes.

**Required spec extension (DEC-EX-09):** At component invocation, the expansion
engine sets `env.values[key] = resolvedPropValue` for every declared input.
This makes all props available as bare bindings without any explicit capture
step in the component body. It is consistent with how `findFreePort()` results
enter `env.values` — `env.values` is already the shared state store for a
component's eval context.

### 4.4 Usage

Single provider:

```markdown
<LlamafileProvider model="phi3-mini" command="./phi3-mini.llamafile --nobrowser">
  <AnalyzeTestFailures />
</LlamafileProvider>
```

Multiple models, sequential:

```markdown
<LlamafileProvider model="qwen3-0.6b" command="./qwen3-0.6b.llamafile --nobrowser">
  <ClassifyLogLevel />
  <ExtractStructuredData />
</LlamafileProvider>

<LlamafileProvider model="phi3-mini" command="./phi3-mini.llamafile --nobrowser">
  <InterpretTestFailures />
</LlamafileProvider>
```

Each provider spawns its own process on its own port and executes sequentially —
the second provider's process is not started until the first provider's scope closes.

Multiple models, simultaneous (nested):

```markdown
<LlamafileProvider model="qwen3-0.6b" command="./qwen3-0.6b.llamafile --nobrowser">
  <LlamafileProvider model="phi3-mini" command="./phi3-mini.llamafile --nobrowser">
    <HybridAnalysis />
  </LlamafileProvider>
</LlamafileProvider>
```

Both processes are alive simultaneously during `<HybridAnalysis />` expansion.
Sample calls route by `model`:

```markdown
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
```

Routing works because the inner provider's middleware is installed later and
therefore sits higher in the middleware chain (traversed first). When
`context.model` is `"phi3-mini"`, the inner handler accepts it. When
`context.model` is `"qwen3-0.6b"`, the inner handler calls `next()` and the
outer handler accepts it. When `context.model` is undefined, the innermost
accepting handler wins.

---

## 5. `callLlamafile()` — inference HTTP utility

### 5.1 Location

**File:** `src/sample/llamafile.ts`

### 5.2 Role

`callLlamafile` is a plain utility function — not user-facing middleware. It is
called from `LlamafileProvider.md`'s final eval block, with `baseUrl` and
`model` closed over at middleware install time. It makes a single
`/v1/chat/completions` request and returns the response content as a string.

It must be available as a VM sandbox global so that eval blocks in
`LlamafileProvider.md` can reference it without imports. Add it to the eval
sandbox globals map alongside `Sample`, `useScope`, `findFreePort`, `when`,
and `fetch`.

### 5.3 Signature

```typescript
import type { Operation } from "effection";
import type { SampleContext } from "../sample-api.ts";

export interface LlamafileOptions {
  /**
   * Temperature for generation. 0 maximizes greedy decoding consistency.
   * True cross-hardware determinism requires CPU-only inference.
   * Default: 0
   */
  temperature?: number;

  /**
   * Maximum tokens to generate.
   * Default: 2048
   */
  maxTokens?: number;

  /**
   * Build the message array sent to /v1/chat/completions from the
   * SampleContext. Override to customize system prompt, few-shot examples,
   * or structured output instructions.
   * Default: buildDefaultMessages
   */
  buildMessages?: (context: SampleContext) => ChatMessage[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Send one inference request to a running llamafile or llama.cpp server.
 *
 * @param baseUrl  - HTTP origin of the server, e.g. "http://127.0.0.1:8080"
 * @param model    - Model identifier, passed as the `model` field in the request body
 * @param context  - SampleContext from the Sample Api call
 * @param opts     - Optional generation parameters and message builder
 */
export function* callLlamafile(
  baseUrl: string,
  model: string,
  context: SampleContext,
  opts: LlamafileOptions = {},
): Operation<string>;
```

### 5.4 Implementation

```typescript
// src/sample/llamafile.ts
import { fetch } from "@effectionx/fetch";
import type { Operation } from "effection";
import type { SampleContext } from "../sample-api.ts";

export function* callLlamafile(
  baseUrl: string,
  model: string,
  context: SampleContext,
  opts: LlamafileOptions = {},
): Operation<string> {
  const {
    temperature = 0,
    maxTokens = 2048,
    buildMessages = buildDefaultMessages,
  } = opts;

  const messages = buildMessages(context);

  const response = yield* (yield* fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
  })).expect();

  const result = (yield* response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = result.choices[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Llamafile server returned unexpected response shape: ` +
      JSON.stringify(result),
    );
  }

  return content;
}
```

**Why `@effectionx/fetch`:** `fetch` from `@effectionx/fetch` is a generator
returning an Effection-native `Response` — `response.text()` and
`response.json()` are `Operation<T>`, not `Promise<T>`. The entire
request/response chain composes with `yield*` and cancellation flows through
Effection's structured concurrency automatically.

**Why not `durableFetch`:** `durableFetch` journals its result. The HTTP
request to the inference server must not be journaled — `durableSample` already
journals the complete LLM response. Double-journaling would cause divergence on
replay.

### 5.5 Default message builder

```typescript
function buildDefaultMessages(context: SampleContext): ChatMessage[] {
  const systemLines: string[] = [
    "You are a precise technical assistant embedded in a durable document workflow.",
    "Analyze the provided command output and respond according to the instructions.",
    "Be concise. Output only what is requested — no preamble, no explanation unless asked.",
  ];

  if (context.componentName) {
    systemLines.push(`Context: you are assisting the ${context.componentName} component.`);
  }

  if (context.params) {
    systemLines.push(`Instruction: ${context.params}`);
  }

  const userLines: string[] = [];

  if (context.command) {
    userLines.push(`Command: \`${context.language} -c '${context.command}'\``);
  }

  if (context.exitCode !== 0) {
    userLines.push(`Exit code: ${context.exitCode}`);
  }

  if (context.stderr) {
    userLines.push(`Stderr:\n\`\`\`\n${context.stderr}\n\`\`\``);
  }

  if (context.stdout) {
    userLines.push(`Output:\n\`\`\`\n${context.stdout}\n\`\`\``);
  }

  return [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n\n") },
  ];
}
```

### 5.6 `SampleContext.model`

`SampleContext` must include a `model` field for routing:

```typescript
interface SampleContext {
  // ... existing fields ...
  /**
   * Model identifier requested by the sample call. Undefined if the author
   * did not specify a model — in which case the innermost active provider wins.
   * Set from the sample modifier's bracket params: ```bash sample[model=phi3-mini] exec
   */
  model?: string;
}
```

The `sample` modifier parser extracts `model` from the bracket params and sets
it on `SampleContext` before invoking the Sample Api.

### 5.7 Sandbox globals

`callLlamafile` and `Sample` must be provided as VM sandbox globals so that
`LlamafileProvider.md`'s eval blocks can reference them without imports. Add to
the eval sandbox globals map in `src/run-document.ts`:

```typescript
{
  // ... existing globals: findFreePort, when, fetch, useScope ...
  Sample,
  callLlamafile,
}
```

---

## 6. File locations (EMA package)

| File | Contents |
|---|---|
| `src/modifiers/daemon.ts` | `daemonFactory` — terminal modifier for long-running subprocesses |
| `src/sample/llamafile.ts` | `callLlamafile()`, `LlamafileOptions`, `buildDefaultMessages()` |
| `components/LlamafileProvider.md` | Standard library provider component |
| `packages/process/src/daemon.ts` | `daemon()` generator, `DaemonExitError` |
| `packages/process/src/mod.ts` | Public API barrel for `@effectionx/process` |

---

## 7. Test plan

### Tier Q — `daemon` modifier (from EMA spec §12, extended)

| # | Test | Verify |
|---|------|--------|
| Q1 | `daemon` ignores `next` | `exec` in chain never called — no `durableExec` invocation |
| Q2 | `daemon` produces no journal entry | Journal has no entry for `daemon` block |
| Q3 | `daemon` returns empty output | `result.output === ""`, `exitCode === 0`, `stderr === ""` |
| Q4 | Process forked into eval scope | Process alive during `<children />` expansion; PID observable |
| Q5 | Process terminated when component scope closes | After expansion, `proc.killed` is true |
| Q6 | Process terminated on component error | If child expansion throws, process still terminated |
| Q7 | Process terminated on parent cancellation | If parent scope cancelled, process terminated |
| Q8 | Premature exit propagates as ErrorSegment | Process exits during expansion → DaemonExitError → ErrorSegment in output |
| Q9 | `{port}` interpolation in daemon content | Binding from preceding eval block substituted before `buildCommand()` |
| Q10 | `daemon` without eval scope | Missing `EvalScopeCtx` → descriptive error, not panic |
| Q11 | Modifier chain: `bash daemon exec` | `daemon` is outermost terminal; `exec` present but never called |
| Q12 | Replay: daemon starts and stops | On full replay, process spawned and terminated; no live `sample` calls |
| Q13 | Replay: stored port used | `env.values.port` restored from journal; daemon binds same port |
| Q14 | `daemonFactory` registered in built-in registry | `registry.get("daemon")` returns the factory after `useBuiltinModifiers()` |

### Tier P — `@effectionx/process` daemon() function

| # | Test | Verify |
|---|------|--------|
| P1 | Process runs while scope is alive | Daemon starts; process is running; scope closes; process is not running |
| P2 | SIGTERM sent on scope close | Process receives SIGTERM when scope cancels |
| P3 | DaemonExitError on premature exit | Process exits code 1 before scope closes → DaemonExitError.exitCode === 1 |
| P4 | DaemonExitError message includes command | Error.message contains the command string |
| P5 | DaemonExitError propagates to parent scope | Error escapes the scope that called daemon() |
| P6 | cwd option | Process working directory matches opt.cwd |
| P7 | env option merges with process.env | Extra env vars visible to subprocess |
| P8 | stdio: "ignore" suppresses output | No stdout/stderr written to parent |
| P9 | SIGKILL escalation on stubborn process | Process ignores SIGTERM → killed after 5s |

### Tier S — Provider component pattern (integration)

| # | Test | Verify |
|---|------|--------|
| S1 | Full provider golden run | eval → daemon → when → middleware install → children → cleanup, output correct |
| S2 | Port flows from eval to daemon | `{port}` in daemon content matches `findFreePort()` result |
| S3 | model prop flows into request body | `/v1/chat/completions` request body `model` field matches prop |
| S4 | Children can call sample after daemon ready | `sample` calls in children reach daemon endpoint |
| S5 | Daemon terminated after children expand | After `runDocument` completes, process not running |
| S6 | Provider crash during `when` | Daemon exits before ready → `when` fails → ErrorSegment |
| S7 | Provider crash during children | Daemon exits mid-child-expansion → error propagated |
| S8 | Nested providers, no model specified | Innermost provider handles sample call |
| S9 | Nested providers, explicit model matching outer | Inner passes through via `next()`, outer handles |
| S10 | Nested providers, explicit model matching inner | Inner handles regardless of nesting depth |
| S11 | Unmatched model → descriptive error | `context.model === "unknown"` → chain exhausted → error names the model |
| S12 | Full replay of provider component | All eval and sample entries replayed; daemon starts and stops; no live HTTP calls |
| S13 | Partial replay (children not yet journaled) | eval+daemon+when replayed; children run live against daemon |
| S14 | Multiple sequential provider instances | Second provider not started until first scope closes |

### Tier U — `callLlamafile()` utility

| # | Test | Verify |
|---|------|--------|
| U1 | Request sent to correct URL | `POST ${baseUrl}/v1/chat/completions` |
| U2 | model in request body | Request JSON `model` field matches argument |
| U3 | temperature and maxTokens in request body | Request JSON matches opts |
| U4 | Default temperature is 0 | No opts → request body has `temperature: 0` |
| U5 | Custom buildMessages used | Custom function's output appears in request messages |
| U6 | Non-ok response throws via expect() | 500 from server → `response.expect()` throws with status in message |
| U7 | Unexpected response shape throws | Missing `choices[0].message.content` → descriptive error |
| U8 | Response content returned as string | Return value matches `choices[0].message.content` |
| U9 | buildDefaultMessages includes command | Context.command appears in user message |
| U10 | buildDefaultMessages includes stderr | Context.stderr appears in user message when non-empty |
| U11 | buildDefaultMessages includes params | Context.params appears as "Instruction:" in system prompt |
| U12 | buildDefaultMessages includes componentName | Context.componentName appears in system prompt |

---

## 8. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| DEC-EX-01 | `daemon()` uses `race([exitSignal, suspend()])` not `spawn()` | `race()` is the idiomatic Effection pattern for "run until cancelled or condition met". `suspend()` suspends until the caller's scope closes, at which point the race is cancelled and the finally block runs. |
| DEC-EX-02 | `daemon()` sends SIGTERM then escalates to SIGKILL | SIGTERM gives the process a chance to flush buffers and clean up. 5-second escalation is long enough for most servers but short enough to not block CI pipelines. |
| DEC-EX-03 | `daemon()` uses `shell: true` | Matches `bash exec` block semantics — the same command string that would be passed to `bash -c` is passed to the shell. Handles shell expansions and PATH lookups correctly. |
| DEC-EX-04 | `daemonFactory` uses `ephemeral()` to cross the Workflow/Operation boundary | `daemonFactory` returns a `CodeBlockWorkflow` (Workflow context). `evalScope.eval()` is an Operation. `ephemeral()` is the spec-documented bridge (DEC-001, executable-mdx-spec §3.3). |
| DEC-EX-05 | `LlamafileProvider.md` installs its own middleware, not a global `useLlamafileSample()` | A single global handler installed before `runDocument()` would execute in the outer scope at call time, where `EvalEnvCtx` has no `baseUrl`. Middleware must close over `baseUrl` and `model` at the moment the provider becomes active. Installing inside the component's eval block is the correct point. |
| DEC-EX-06 | Routing key is `model`, not a separate `name` prop | Model identity is the natural key — it unifies "which server to route to" with "which model to request". A separate `name` prop would require authors to keep two values in sync and adds no expressiveness. |
| DEC-EX-07 | `context.model === undefined` routes to innermost provider | Omitting a model is the common case for simple single-provider documents. Innermost-wins matches how Effection's middleware chain works — handlers installed later sit higher in the chain and are traversed first. |
| DEC-EX-08 | `callLlamafile()` is a sandbox global, not imported | `LlamafileProvider.md` is a markdown file — it cannot have TypeScript imports. All code in eval blocks runs in the VM sandbox. Functions needed by provider components must be provided as sandbox globals alongside `findFreePort`, `when`, and `fetch`. |
| DEC-EX-09 | Props pre-populated into `env.values` at component invocation | Code block content uses bare `{name}` binding interpolation from `env.values`. Props must enter `env.values` at invocation time to be accessible in code blocks. This is a spec extension but consistent with how eval bindings work — `env.values` is already the shared state store for a component's eval context. |
| DEC-EX-10 | `callLlamafile()` uses `@effectionx/fetch` not `durableFetch` | `durableFetch` journals its result. The HTTP call to the inference server must not be journaled — `durableSample` already journals the complete LLM response. Double-journaling would cause divergence on replay. |
| DEC-EX-11 | `LlamafileProvider.md` hardcodes `/health` endpoint | All major llamafile/llama.cpp-compatible servers use `/health`. Configurability would require a `healthPath` prop which is accessible in code blocks only after DEC-EX-09 is implemented. Deferred — the hardcoded path covers all current targets. |
| DEC-EX-12 | `stdio: "inherit"` is the default for `daemon()` | During development, seeing server logs in the terminal is valuable. Production deployments can pass `stdio: "ignore"`. The EMA `daemonFactory` passes no stdio option, defaulting to `"inherit"`. |
