# Executable MDX: Specification

**Status:** Draft
**Audience:** Implementing agent
**Inputs:** Prior streaming MDX research, `@effectionx/durable-streams` (protocol-specification, effection-integration, DECISIONS), `@effectionx/durable-effects` (effect-types, guards), Divergence API (`lib/divergence.ts`)

---

## 1. Overview

An executable MDX document is a markdown file containing embedded JSX
component invocations and annotated code blocks. The system treats each
document as a durable workflow: text is emitted immediately, component
references are resolved from the file system and expanded recursively,
and code blocks marked as executable are run via `durableExec`. The
journal records every I/O operation so that execution survives crashes
and replays from the journal on restart.

The system is built entirely on the existing durable execution
infrastructure — `createDurableOperation`, `durableExec`,
`durableGlob`, replay guards, and the Divergence API. The main
addition is `durableImportComponent`, a new durable effect that wraps
the Resolve Api and `DurableRuntime` file read into a single journaled
operation, with a custom `useImportComponentGuard` for staleness
detection.

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
are the recursively scanned segments between the tags.

**Executable code blocks.** A fenced code block whose info string
contains `exec` after the language identifier is executable. Everything
else in the document — paragraphs, headings, lists, links, images,
standard code fences — is passive text.

Parsing is a runtime operation. It is deterministic from its input text
and produces no journal entries.

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
as one of the words after the language (case-sensitive). The first word
is always the language. All subsequent words are the middleware chain.

A code block with no `exec` anywhere in the chain is passive text —
not executable, not processed.

### 3.3 Modifier handlers and registration

Each modifier in the info string is a **middleware handler** that
wraps the next handler in the chain. The rightmost modifier (`exec`
or `eval`) is the terminal — it performs the actual I/O. Every other
modifier calls `next()` to invoke the inner chain, then transforms
the result.

#### Handler signature

```typescript
interface CodeBlockContext {
  language: string;       // "bash", "python", etc.
  content: string;        // The code inside the fence
  componentName?: string; // Component this block is inside (if any)
}

interface CodeBlockResult {
  output: string;         // What gets rendered in the document
  exitCode: number;
  stderr: string;
}

/**
 * Modifier handler — same shape as Effection middleware.
 *
 * - `context`: the code block being processed
 * - `params`: modifier params (e.g. "brief" from sample=brief), or undefined
 * - `next`: calls the next handler in the chain (the inner modifier)
 *
 * Terminal handlers (exec, eval) ignore `next`.
 * Wrapping handlers (silent, sample) call `next()` and transform the result.
 */
type ModifierHandler = (
  context: CodeBlockContext,
  params: string | undefined,
  next: () => Workflow<CodeBlockResult>,
) => Workflow<CodeBlockResult>;
```

#### Registration via `useModifier`

Modifier handlers are registered on the scope via `useModifier`.
Child scopes inherit parent registrations. A child scope can override
a modifier by registering a new handler for the same name.

```typescript
function* useModifier(
  name: string,
  handler: ModifierHandler,
): Operation<void> {
  const scope = yield* useScope();
  const registry = getOrCreateRegistry(scope);
  registry.set(name, handler);
}
```

This follows the same scope-inheritance pattern as Effection's
`scope.around()` — a handler registered on a parent scope is visible
to all children, and a child can override it for its subtree.

#### Built-in terminal handlers

**`exec`** — executes the code block as a shell command via
`durableExec`. This is a terminal handler — it does not call `next()`.

```typescript
const execHandler: ModifierHandler = function* (context, params, _next) {
  const result = yield* durableExec(
    `exec:${truncate(context.content, 40)}`,
    {
      command: buildCommand(context.language, context.content),
      timeout: 30_000,
      throwOnError: false,
    },
  );
  return {
    output: result.stdout,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
};
```

**`eval`** (future) — evaluates the code block in-process via
`durableEval`. Also a terminal handler. For scripting languages
where subprocess execution is unnecessary.

#### Built-in wrapping handlers

**`silent`** — calls `next()` (the inner chain runs, effects are
journaled), then returns empty output:

```typescript
const silentHandler: ModifierHandler = function* (context, params, next) {
  yield* next();   // inner chain runs — exec journals its result
  return { output: "", exitCode: 0, stderr: "" };
};
```

**`sample`** — calls `next()`, then sends the inner result's output
to an LLM via `durableSample`, which wraps the Sample Api (§3.4) in
a durable effect:

```typescript
const sampleHandler: ModifierHandler = function* (context, params, next) {
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
};
```

#### Chain composition

When a code block is encountered during expansion, the modifier chain
is composed from the info string **right-to-left** (innermost first):

```typescript
function composeModifierChain(
  modifiers: Modifier[],
  context: CodeBlockContext,
  registry: ModifierRegistry,
): () => Workflow<CodeBlockResult> {
  let chain: () => Workflow<CodeBlockResult> = function* () {
    throw new Error("No terminal modifier (exec/eval) in chain");
  };

  // Build right-to-left: rightmost modifier is innermost
  for (let i = modifiers.length - 1; i >= 0; i--) {
    const mod = modifiers[i];
    const handler = registry.get(mod.name);
    if (!handler) {
      throw new Error(`Unknown modifier: ${mod.name}`);
    }
    const inner = chain;
    chain = function* () {
      return yield* handler(context, mod.params, function* () {
        return yield* inner();
      });
    };
  }

  return chain;
}
```

For ```` ```bash silent sample exec ````:

```
chain = execHandler(ctx, _, _)                    // terminal
chain = sampleHandler(ctx, _, () => execHandler)  // wraps exec
chain = silentHandler(ctx, _, () => sampleHandler) // wraps sample
```

Calling `chain()` runs silent → sample → exec. The exec handler
journals the command result. The sample handler journals the LLM
response. The silent handler discards the output.

#### Default registration

The host installs the built-in handlers before `durableRun`:

```typescript
function* useBuiltinModifiers(): Operation<void> {
  yield* useModifier("exec", execHandler);
  yield* useModifier("silent", silentHandler);
  yield* useModifier("sample", sampleHandler);
}
```

#### Overriding per-scope

Because handlers are scope-inherited, a component's expansion can
override modifier behavior for its subtree:

```typescript
// In a custom expansion middleware:
yield* useModifier("sample", function* (context, params, next) {
  // Use a different model for this component's code blocks
  const inner = yield* next();
  return { ...inner, output: yield* myExpensiveModel(inner.output) };
});
```

This follows the same mental model as `scope.around(Divergence, ...)`
or `scope.around(Resolve, ...)` — scope-scoped behavioral override
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

Future modifiers (not yet specified):

| Modifier | Type | Behavior |
|----------|------|----------|
| `timeout=30s` | Wrapping | Wraps `next()` with a deadline |
| `capture=varname` | Wrapping | Stores output into a named binding |
| `stderr` | Wrapping | Includes stderr in output |
| `ignore-error` | Wrapping | Converts non-zero exit codes to success |

---

## 4. Component model

### 4.1 Components are markdown files with a declared interface

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

### 4.2 Resolution (Resolve Api)

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

### 4.3 Import: `durableImportComponent`

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

### 4.4 The root document is a component

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

## 5. Expansion

### 5.1 The expansion algorithm

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
        // Interpolate {meta.key} and {props.key} — runtime, no journal
        const interpolated = interpolate(segment.content, parentMeta, parentProps);
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
        // Compose modifier chain from info string and run it
        const context: CodeBlockContext = {
          language: segment.language,
          content: segment.content,
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

### 5.2 Component expansion with cycle detection

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

  // Recurse with augmented hide set
  const newHideSet = new Set([...hideSet, name]);
  return yield* expandSegments(
    substituted,
    definition.meta,
    validatedProps,
    newHideSet,
  );
}
```

Cycle detection and depth limiting are runtime operations — no journal
entries. They are deterministic from the component dependency graph,
which is reconstructed identically during replay because the same
components are imported in the same order.

### 5.3 Content slot: `<Content />`

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

### 5.4 Frontmatter interpolation: `{meta.key}` and `{props.key}`

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
- Inside backtick code spans and fenced code blocks: never interpolated
- Escaped braces: `\{not interpolated\}` → literal `{not interpolated}`

Interpolation is a runtime operation — deterministic from its inputs,
no journal entry.

### 5.5 Prop validation

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

---

## 6. Staleness and replay

### 6.1 File staleness via `useImportComponentGuard`

The custom `useImportComponentGuard` (defined in §4.3) handles
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

### 6.2 Staleness policy via middleware

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

### 6.3 What happens when a file changes

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

## 7. Entry point

### 7.1 `runDocument`

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
}

function* runDocument(options: RunDocumentOptions): Operation<string> {
  const {
    docPath,
    stream,
    runtime,
    componentDirs = ["./components", "./"],
    freshness = true,
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

  // Install built-in modifier handlers (exec, silent, sample)
  yield* useBuiltinModifiers();

  // Run the durable workflow
  return yield* durableRun(
    () => documentWorkflow(docPath),
    { stream },
  );
}
```

### 7.2 Usage from standalone code

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

## 8. Journal shape

### 8.1 Effect vocabulary for MDX execution

All effects use existing durable effect types from
`@effectionx/durable-effects` except `import_component`, which is
new to the MDX execution layer.

| Operation | Effect type | Effect name | Notes |
|-----------|------------|-------------|-------|
| Import component | `import_component` | `{ComponentName}` | path + content + contentHash in result |
| Execute code block | `exec` | `exec:{command_preview}` | Command array in description, stdout/stderr/exitCode in result |
| Sample LLM call | `sample` | `sample:{command_preview}` | Only when `sample` modifier is used; Sample Api middleware determines behavior |
| Resolve components (glob) | `glob` | `resolve:{dir}` | Only when `useDurableGlobResolver` middleware is installed |

### 8.2 Example journal for a multi-component document

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

[4] close  root  result: { status: "ok", value: "...rendered output..." }
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

### 8.3 Sequential coroutine IDs

In the basic sequential model, all effects run under the `root`
coroutine ID. When parallel expansion is introduced (via `durableAll`
for independent sibling components), child coroutine IDs follow the
standard scheme: `root.0`, `root.1`, etc.

---

## 9. Rendering

### 9.1 Segment → output

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

### 9.2 Error rendering

Errors are rendered as HTML comments by default. This keeps the output
valid markdown while making errors visible. An error rendering strategy
is configurable at the host level (e.g., throw on error, render as
visible warning blocks, collect into a separate error report).

---

## 10. Parallel expansion (future)

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

## 11. Test plan

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

---

## 12. Walked example: crash recovery

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

## 13. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Root document treated as a component | Uniform hash tracking and staleness detection |
| 2 | All paths are workspace-relative | Journal portability — no absolute paths, everything relative to cwd |
| 3 | Resolution is an Effection Api | Pluggable middleware (search paths, aliases, glob) — runs inside `durableImportComponent` during live execution |
| 4 | `durableImportComponent` is a single durable effect | Resolve + read + hash in one `createDurableOperation` — one journal entry per component, Api and filesystem untouched on replay |
| 5 | Parsing is runtime | Deterministic from file content, no journal needed |
| 6 | Info string modifiers are a middleware chain | `bash silent exec` — left-to-right wrapping, composable, extensible, compatible with all renderers |
| 7 | Each modifier is a registered handler with middleware signature | `(context, params, next) => Workflow<CodeBlockResult>` — same shape as Effection middleware |
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
