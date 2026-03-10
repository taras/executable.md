---
title: Executable MDX
version: 0.1.0
repo: https://github.com/thefrontside/effectionx
---

# {meta.title}

This document is both a guide and a smoke test. Every feature described
here is exercised by the document itself — if it renders correctly,
the system works. This is version **{meta.version}** of {meta.title},
built from the source at [{meta.repo}]({meta.repo}).

<Section title="What is Executable MDX?">

Executable MDX treats markdown files as **durable workflows**. A document
can contain component invocations that expand other markdown files, and
code blocks that execute shell commands. Every I/O operation is recorded
in a journal so that execution survives crashes and replays from where
it left off.

</Section>

<Section title="Components">

A component is a markdown file with a declared interface. The component's
frontmatter defines its own metadata and the props it accepts
via `inputs`. Here's the frontmatter from the Note component used below:

```yaml
# components/Note.md frontmatter
emoji: 📝
inputs:
  level: info
  message:
    type: string
    required: true
```

Components are invoked with JSX syntax. Props must match the declared
inputs — undeclared props are rejected, required props must be provided,
and defaults fill in for omitted optional props.

<Note message="This note uses the default level (info)." />

<Note level="warning" message="This note overrides the level to warning." />

Components can wrap content using the `<Content />` slot. The Section
component wrapping this text works exactly that way — it receives a
title prop and renders its children inside a headed section.

</Section>

<Section title="Nested Components">

Components can reference other components. When a component's body
contains another component invocation, the system resolves, imports, and
expands it recursively — with cycle detection to prevent infinite loops.

<Feature
  title="Recursive Expansion"
  description="Components expand bottom-up: children first, then the parent body."
/>

Dotted names map to directory paths. The component below lives at
`components/Tips/Formatting.md`:

<Tips.Formatting />

</Section>

<Section title="Executable Code Blocks">

Code blocks with `exec` in the info string are executed as shell
commands. The output replaces the code block in the rendered document.

How many markdown files are in the smoke-test directory?

```bash exec
find smoke-test -name '*.md' | wc -l | tr -d ' '
```

The info string is a **middleware chain** read left-to-right. Each
word after the language is a modifier handler that wraps the next.

`exec` alone — runs the command, shows stdout:

```bash exec
echo "Hello from a durable workflow"
```

`silent exec` — runs and journals the command, but suppresses
output. Useful for setup steps:

```bash silent exec
echo "This output is journaled but not shown in the document"
```

Non-executable code blocks are passed through as regular markdown.
This block has no `exec` modifier, so it's just syntax-highlighted text:

```yaml
# This is just a code block — not executed
inputs:
  name:
    type: string
```

</Section>

<Section title="Props and Interpolation">

Every component has access to two namespaces for interpolation:

- `{meta.key}` — the component's own frontmatter values
- `{props.key}` — values passed by the caller via JSX props

The Section component's frontmatter defines `emoji: §` which it
prepends to each title via `{meta.emoji}`. The Note component
uses `{meta.emoji}` for its 📝 prefix and `{props.message}` for
the caller-provided text.

<PropDemo greeting="Hey" subject="world" />

</Section>

<Section title="Markdown Healing">

Components and executable code blocks are **semantic boundaries**.
Markdown constructs cannot span them. Each text segment is healed
independently using remend.

For example, if bold is opened before a component but not closed,
remend closes it before expansion proceeds. This prevents unclosed
markers from bleeding into component output.

The text below opens **bold before the component
<Badge />
and continues after. Each segment is independently valid markdown.

</Section>

<Section title="Durability">

Every component import and code execution is recorded in a journal.
If this document's execution crashes mid-way, re-running it replays
completed operations from the journal and continues from where it
left off — no command is re-executed, no file is re-read.

```bash exec
echo "Run at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Run this document twice. The timestamp above will be the same both
times — it was journaled on the first run and replayed on the second.

If a component file changes between runs, the replay guard detects
the stale content hash and halts replay, forcing a fresh execution.

</Section>

<Section title="Smoke Test Summary">

This document exercises every feature of the system:

```bash exec
cat <<'EOF'
| Feature                  | Exercised by                            |
|--------------------------|-----------------------------------------|
| Root frontmatter         | Title and version in opening paragraph  |
| Component with props     | <Section title>, <Note message>         |
| Required props           | <Note message> (message is required)    |
| Default props            | <Note> uses level=info by default       |
| Content slot             | <Section> wraps children via <Content/> |
| Nested expansion         | Section > Feature > Note (3 levels)     |
| Dotted component name    | <Tips.Formatting />                     |
| exec modifier            | Multiple bash exec blocks               |
| silent modifier          | bash silent exec block                  |
| Non-executable code      | yaml block (passthrough)                |
| Markdown healing         | Unclosed bold before <Badge />          |
| No-inputs component      | <Badge /> accepts zero props            |
| meta interpolation       | {meta.emoji} in Section and Note        |
| props interpolation      | {props.title}, {props.message}, etc.    |
| Props passthrough        | <PropDemo greeting="Hey" subject="w">  |
| Durability               | Timestamp stable across reruns          |
EOF
```

If you can read this table, every feature worked.

</Section>
