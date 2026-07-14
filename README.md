# executable.md

**executable.md** treats markdown documents as durable, executable workflows. A document can expand markdown components, execute annotated code blocks, evaluate in-process [Effection](https://frontside.com/effection) operations, and replay prior work from a journal after a crash or restart — while staying a valid, readable markdown file in any viewer.

The command-line tool is called **`xmd`** (eXecutable MarkDown).

This project is an implementation of the draft spec in [`specs/executable-mdx-spec.md`](specs/executable-mdx-spec.md).

## What it does

- Expands JSX-style component invocations like `<Greeting name="world" />` from markdown files.
- Executes fenced code blocks marked with `exec` or `eval`.
- Journals component imports and command results so reruns can replay instead of redoing work.
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
inputs:
  name:
    type: string
    required: true
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

### Platform notes

- **Size:** binaries are self-contained and fairly large (roughly 90–125 MB depending on platform) — the embedded Deno runtime dominates. Trimming this further is tracked in [#66](https://github.com/taras/executable.md/issues/66).
- **Alpine / musl:** no musl build is published. On Alpine, run via `deno` or use the glibc binary under `gcompat`.
- **macOS:** binaries are currently unsigned. The install script clears the Gatekeeper quarantine automatically; if you download a binary manually, run `xattr -d com.apple.quarantine ./xmd` before first use. Signing/notarization is tracked in [#68](https://github.com/taras/executable.md/issues/68).
- **Windows:** the binary runs, but `exec` blocks that invoke shell commands need a shell (e.g. Git Bash or WSL) on `PATH`. Provider and `eval` documents work without one.

## Run a document

```bash
xmd run core/examples/hello-world.md
```

Keep a persistent journal for replay:

```bash
xmd run core/examples/hello-world.md --journal .xmd/events.jsonl
```

Useful flags:

- `--journal`, `-j` - persist JSONL journal events and replay from them on rerun.
- `--verbose`, `-V` - print durable journal events to stderr while running.
- `--component-dir` - add component search directories. Defaults to `components` and `.`.

## Document model

executable.md treats the root document like a component:

- Frontmatter becomes `meta`.
- JSX tags with capitalized names become component invocations.
- `<Content />` acts as a slot for child content.
- Text segments support `{meta.key}` and `{props.key}` interpolation.
- Markdown is healed at execution boundaries with `remend` so formatting does not bleed across components or executable blocks.

## Executable code blocks

The first word in a fence info string is the language. The remaining words form a modifier chain. Standard renderers only read the first word, so the modifiers stay invisible everywhere else.

````md
```bash silent sample exec
git diff --stat
```
````

Built-in modifiers:

- `exec` - run the block as a subprocess and render stdout.
- `eval` - run JavaScript/TypeScript in-process as an Effection operation.
- `silent` - execute but suppress rendered output.
- `sample` - send inner output through the Sample API.
- `persist` - keep resources created by an eval block alive for the component lifetime.
- `timeout=30s` - cancel a long-running block.
- `daemon` - start a long-running subprocess tied to the component scope.

## Eval blocks

`eval` blocks run in a shared VM context and binding environment for the current component.

````md
```ts eval
const port = yield* findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
```

```bash daemon exec
./server --port {port}
```
````

Highlights:

- Top-level bindings are exported automatically for later blocks.
- Bare `{name}` interpolation inside executable block content reads from eval bindings.
- `output("...")` lets an eval block render text into the document.
- `renderChildren()` and `render(markdown)` let eval blocks render nested content intentionally.

## Provider components

The repo includes reusable markdown components (in `core/components/`) that demonstrate the provider pattern:

- `AnthropicProvider.md`
- `OllamaProvider.md`
- `LlamafileProvider.md`
- `Sample.md`
- `Instruction.md`

These components combine `eval`, `daemon`, readiness checks, and `Sample` middleware so a document can talk to a cloud or local model server without custom runtime wiring.

[`core/examples/hello-world.md`](core/examples/hello-world.md) shows the pattern combining a cloud model (Claude) and a local model (Ollama). Provider docs currently need the built-in components on the search path:

```bash
xmd run core/examples/hello-world.md --component-dir core/components
```

## Durable replay

executable.md stores workflow events in a durable stream. On rerun with the same journal:

- component imports replay from stored content,
- completed `exec` and `eval` operations replay from stored results,
- replay guards can detect stale component inputs,
- execution resumes from the last successful durable step.

Journals store workspace-relative paths so they remain portable across machines with the same repo structure.

## Project layout

- `core/src/run-document.ts` - document entrypoint and durable import pipeline.
- `core/src/scanner.ts` - boundary scanner for components and executable fences.
- `core/src/` - component expansion, eval/exec handling, modifiers, and sampling helpers.
- `core/components/` - reusable provider and demo components.
- `cli/src/cli.ts` - the `xmd` command.
- `core/examples/hello-world.md` - end-to-end example.
- `specs/executable-mdx-spec.md` - design and behavior spec.

## Development

This is a Deno-first project. Run the tool from source and the checks with `deno`:

```bash
deno task xmd run core/examples/hello-world.md   # run a document from source
deno task build                                  # compile the standalone xmd binary
deno task lint                                   # oxlint + oxfmt
deno check core/mod.ts                            # typecheck
deno task test                                   # run the test suite
```

## Status

This is an early, first public release and a draft spec, optimized for experimentation around durable markdown workflows, Effection-based evaluation, and provider-driven AI documents. Feedback, issues, and contributions are very welcome — please [open an issue](https://github.com/taras/executable.md/issues).

## License

[MIT](LICENSE)
