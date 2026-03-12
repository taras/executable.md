# Executable Markdown Agents

Executable Markdown Agents (EMA) treats markdown documents as durable workflows. A document can expand markdown components, execute annotated code blocks, evaluate in-process Effection operations, and replay prior work from a journal after a crash or restart.

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

```bash
pnpm install
```

## Run a document

Use the CLI directly:

```bash
pnpm ema examples/hello-world.md
```

Or keep a persistent journal for replay:

```bash
pnpm ema examples/hello-world.md --journal .ema/events.jsonl
```

Useful flags:

- `--journal`, `-j` - persist JSONL journal events and replay from them on rerun.
- `--verbose`, `-V` - print durable journal events to stderr while running.
- `--component-dir` - add component search directories. Defaults to `components` and `.`.

## Document model

EMA treats the root document like a component:

- Frontmatter becomes `meta`.
- JSX tags with capitalized names become component invocations.
- `<Content />` acts as a slot for child content.
- Text segments support `{meta.key}` and `{props.key}` interpolation.
- Markdown is healed at execution boundaries with `remend` so formatting does not bleed across components or executable blocks.

## Executable code blocks

The first word in a fence info string is the language. The remaining words form a modifier chain.

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

The repo includes reusable markdown components that demonstrate the provider pattern:

- `components/OllamaProvider.md`
- `components/LlamafileProvider.md`
- `components/Sample.md`

These components combine `eval`, `daemon`, readiness checks, and `Sample` middleware so a document can talk to a local model server without custom runtime wiring.

`examples/hello-world.md` shows the pattern with Ollama.

## Durable replay

EMA stores workflow events in a durable stream. On rerun with the same journal:

- component imports replay from stored content,
- completed `exec` and `eval` operations replay from stored results,
- replay guards can detect stale component inputs,
- execution resumes from the last successful durable step.

Journals store workspace-relative paths so they remain portable across machines with the same repo structure.

## Project layout

- `src/run-document.ts` - document entrypoint and durable import pipeline.
- `src/scanner.ts` - boundary scanner for components and executable fences.
- `src/expand.ts` - component expansion and executable block handling.
- `src/eval-handler.ts` - `eval` execution and binding restoration.
- `src/modifiers/` - built-in modifier factories.
- `src/sample/` - sampling helpers and local model adapters.
- `src/cli.ts` - `ema` command.
- `examples/hello-world.md` - end-to-end example.
- `specs/executable-mdx-spec.md` - design and behavior spec.

## Development

```bash
pnpm test
pnpm lint
pnpm typecheck
```

## Status

This project is currently a draft implementation of the Executable MDX spec and is optimized for experimentation around durable markdown workflows, Effection-based evaluation, and provider-driven local AI documents.
