# executable.md

**executable.md** treats markdown documents as executable workflows. A document can expand markdown components, execute annotated code blocks, and evaluate in-process [Effection](https://frontside.com/effection) operations while staying a valid, readable markdown file in any viewer.

The command-line tool is called **`xmd`** (eXecutable MarkDown).

This project is an implementation of the draft spec in [`specs/executable-mdx-spec.md`](specs/executable-mdx-spec.md).

## What it does

- Expands JSX-style component invocations like `<Greeting name="world" />` from markdown files.
- Executes fenced code blocks marked with `exec` or `eval`.
- Optionally journals component imports and command results to a diagnostic JSONL trace.
- Shares bindings across `eval` blocks inside a component.
- Supports long-lived background processes with `daemon` and provider-style components for LLM-backed workflows.

## Example

`README.md`

````md
---
title: My Project
---

# {meta.title}

<Greeting name="world" />

```bash exec
ls ./src
```
````

`components/Greeting.md`

```md
---
emoji: Hello
props:
  type: object
  properties:
    name:
      type: string
  required: [name]
  additionalProperties: false
---

{meta.emoji}, {props.name}!
```

Rendered output:

```md
# My Project

Hello, world!

main.ts
utils.ts
```

## Install

Install the `xmd` binary (macOS/Linux):

```bash
curl -fsSL https://executable.md/install.sh | sh
```

Prebuilt binaries for each platform are published on the [releases page](https://github.com/taras/executable.md/releases). The binary is self-contained — no Node or Deno required to run it.

### From npm

`xmd` is also published to npm as [`@executablemd/cli`](https://www.npmjs.com/package/@executablemd/cli):

```bash
npm install -g @executablemd/cli
```

No registry configuration is needed — every `@executablemd` package resolves from the default npm registry.

### Platform notes

- **Size:** binaries are self-contained and fairly large (roughly 90–125 MB depending on platform) — the embedded Deno runtime dominates. Trimming this further is tracked in [#66](https://github.com/taras/executable.md/issues/66).
- **Alpine / musl:** no musl build is published. On Alpine, run via `deno` or use the glibc binary under `gcompat`.
- **macOS:** binaries are currently unsigned. The install script clears the Gatekeeper quarantine automatically; if you download a binary manually, run `xattr -d com.apple.quarantine ./xmd` before first use. Signing/notarization is tracked in [#68](https://github.com/taras/executable.md/issues/68).
- **Windows:** the binary runs, but `exec` blocks that invoke shell commands need a shell (e.g. Git Bash or WSL) on `PATH`. Provider and `eval` documents work without one.

## Run a document

```bash
xmd run packages/core/examples/hello-world.md
```

Run a document without writing one, for a quick experiment:

```bash
xmd -e '# Hello'
xmd -e '<File path="README.md" />'
```

Write a diagnostic trace for one run:

```bash
xmd run packages/core/examples/hello-world.md --journal .xmd/events.jsonl
```

Useful flags:

- `--eval`, `-e` - execute the given markdown as the root document instead of a path. Exactly one of the two is required; printed errors report the source as `<eval>` and relative paths resolve from the current directory.
- `--journal`, `-j` - write current-run journal entries to a new JSONL file for debugging. The path must not exist and is never replayed.
- `--verbose`, `-V` - print durable journal entries to stderr while running.
- `--component-dir` - add component search directories. Defaults to `components` and `.`.

## Coding agents

Run ACP-compatible coding agents directly from a document with `<Agent>`,
`<Session>`, and `<Prompt>`. The [coding-agent guide](https://executable.md/docs/agents)
explains provider selection, permissions, timeouts, sessions, and deterministic
tests with the bundled test agent.

For the deterministic test-agent walkthrough and its scenario format, see
[`packages/test-agent/README.md`](packages/test-agent/README.md).

## Document model

executable.md treats the root document like a component:

- Frontmatter becomes `meta`.
- JSX tags with capitalized names become component invocations.
- `<Content />` acts as a slot for child content.
- Text segments support `{meta.key}` and `{props.key}` interpolation.
- `<If condition={...}>`, with an optional `<Else>` block, is a structural directive rather than a component.
- Markdown is healed at execution boundaries with `remend` so formatting does not bleed across components or executable blocks.

## Control flow

`<If>` expands one branch and only one. `condition` must be a boolean — there is no truthy or falsy coercion — and the branch that is not selected never expands, so nothing in it imports a component, runs a block, or creates a binding.

```md
<If condition={hasFailures}>
## Test failures

<FailureReport />
<Else>
All checks passed.
</Else>
</If>
```

`<Else>` is optional and, when present, is the final substantive child of its `<If>`. See the [control-flow guide](https://executable.md/docs/control-flow) for nesting and binding examples.

## Executable code blocks

The first word in a fence info string is the language. The remaining words form a modifier chain. Standard renderers only read the first word, so the modifiers stay invisible everywhere else.

````md
```bash silent timeout=30s exec
git diff --stat
```
````

Built-in modifiers:

- `exec` - run the block as a subprocess and render stdout.
- `eval` - run JavaScript/TypeScript in-process as an Effection operation.
- `silent` - execute but suppress rendered output.
- `persist` - keep resources created by an eval block alive for the component lifetime.
- `timeout=30s` - cancel a long-running block.
- `daemon` - start an arbitrary fixed-configuration subprocess tied to the component scope.
- `service=name` - start a cooperative service and publish its live loopback endpoint.
- `ephemeral` - reconstruct live eval state without writing a journal event.

LLM sampling is not a fence modifier — it happens through the `<Sample>` component installed by provider middleware (see [Provider components](#provider-components)).

## Eval blocks

Plain `eval` blocks run in a shared durable binding environment for the current component.

````md
```bash service=server exec
node cooperative-server.js
```

```ts persist ephemeral eval
import { callService } from "./client.ts";

const endpoint = server;
yield* Sample.around({
  *sample([request]) {
    return yield* callService(endpoint, request);
  },
});
```
````

Highlights:

- Top-level bindings are exported automatically for later blocks.
- Bare `{name}` interpolation inside executable block content reads from eval bindings.
- `output("...")` lets an eval block render text into the document.
- `renderChildren()` and `render(markdown)` let eval blocks render nested content intentionally.
- `ephemeral eval` reruns during live execution and partial replay, exports only invocation-local live bindings, and cannot render output.
- Live service endpoints are available only to `ephemeral eval`; they never enter interpolation, durable effect descriptions, or the journal.

## Provider components

The repo includes reusable markdown components (in `packages/core/components/`) that demonstrate the provider pattern:

- `AnthropicProvider.md`
- `OllamaProvider.md`
- `Sample.md`
- `Instruction.md`

These components combine eval and `Sample` middleware so a document can talk to a cloud or already-running local model server without custom runtime wiring. A local process provider uses authenticated cooperative startup through `service=<binding>`.

[`packages/core/examples/hello-world.md`](packages/core/examples/hello-world.md) shows the pattern combining a cloud model (Claude) and a local model (Ollama). Provider docs currently need the built-in components on the search path:

```bash
xmd run packages/core/examples/hello-world.md --component-dir packages/core/components
```

## Diagnostic journals

`--journal` writes internal workflow journal entries for troubleshooting. A trace can include component source, command output, evaluated values, and errors, so treat it as potentially sensitive data.

Each invocation requires a new path. If the path already exists, `xmd` exits without executing the document or modifying the file. An interrupted process may leave a partial trace; the CLI preserves it for inspection and does not use it as recovery input.

## Project layout

- `packages/core/src/execute.ts` - document entrypoint and durable import pipeline.
- `packages/core/src/scanner.ts` - boundary scanner for components and executable fences.
- `packages/core/src/` - component expansion, eval/exec handling, modifiers, and sampling helpers.
- `packages/core/components/` - reusable provider and demo components.
- `packages/cli/src/cli.ts` - the `xmd` command, runtime-neutral.
- `packages/cli/src/{deno,node,bun,compiled}.ts` - entrypoints; each installs the
  host adapters that command and compiler resolution need.
- `packages/core/examples/hello-world.md` - end-to-end example.
- `specs/executable-mdx-spec.md` - design and behavior spec.

## Development

This is a Deno-first project. Prepare a checkout once, then run the tool from
source and the checks with `deno`:

```bash
deno task setup                                  # install both dependency layouts, build the browser bundle
deno task xmd run packages/core/examples/hello-world.md   # run a document from source
deno task build                                  # compile the standalone xmd binary
deno task lint                                   # oxlint + oxfmt
deno task check                                  # typecheck
deno task test                                   # run the test suite
deno task verify                                 # the whole applicable battery, concurrently
```

`deno task setup` is the only thing that installs. Builds and checks read what
it prepared and leave what this repository owns — tracked files, `node_modules`,
`deno.lock` — exactly as they found it, so they compose instead of undoing one
another. A build is cache-pure on top of that; verification may add to the
runtime's own module cache, which is why it resolves graphs no build walks.
`deno task verify` starts the entire applicable battery at once and fails if any
of it leaves a tracked file changed, and `deno task verify:clean` runs that
claim end to end against a clean clone (AGENTS.md).

## Status

This is an early, first public release and a draft spec, optimized for experimentation around executable markdown workflows, Effection-based evaluation, and provider-driven AI documents. Feedback, issues, and contributions are very welcome — please [open an issue](https://github.com/taras/executable.md/issues).

## License

[MIT](LICENSE)
