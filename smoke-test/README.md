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

<Section title="Expression Props">

Expression props pass runtime values from eval blocks to child
components. Unlike string attributes, expression props resolve
at expansion time against the eval binding environment.

```js eval
const dynamicGreeting = "Howdy";
const dynamicSubject = "expression props";
const itemCount = 3;
```

The values computed above flow into PropDemo via expression props:

<PropDemo greeting={dynamicGreeting} subject={dynamicSubject} />

JSON literals resolve at scan time — no eval block needed:

<Note message="JSON props: count={42}, verbose={true}" />

</Section>

<Section title="Binding Capture">

Binding capture routes rendered output into the eval binding environment
instead of writing it at the invocation site.

Component-level capture uses `as="name"`:

<Fragment as="capturedFromComponent">component binding from Fragment</Fragment>

Inline capture uses the built-in `<Capture>` directive:

<Capture as="capturedInline">inline binding from Capture
</Capture>

Captured bindings are available to later executable blocks:

```bash exec
echo "Capture values: {capturedFromComponent} | {capturedInline}"
```

Capture with CSS selector extracts specific content from rendered output:

<Capture as="capturedJson" select="code[lang=json]">
Some prose before the data.

```json
["alpha","bravo",42]
```

More prose after.
</Capture>

```bash exec
printf 'Selected JSON: %s\n' '{capturedJson}'
```

This Note is captured but intentionally not rendered inline:

<Note as="hiddenCapturedNote" message="Hidden capture should not render inline." />

</Section>

<Section title="Markdown Healing">

Components and executable code blocks are **semantic boundaries**.
Markdown constructs cannot span them. Each text segment is healed
independently using remend.

For example, if bold is opened before a component but not closed,
remend closes it before expansion proceeds. This prevents unclosed
markers from bleeding into component output.

The text below opens \*\*bold before the component
<Badge />
and continues after. Each segment is independently valid markdown.

</Section>

<Section title="In-Process Evaluation">

Eval blocks run JavaScript **in-process** as Effection generator operations.
Unlike `exec` blocks (which run shell commands in a subprocess), `eval`
blocks execute in the same process, sharing a binding environment across
blocks within a component.

Bindings declared in one eval block are available in subsequent blocks:

```js eval
const greeting = "Hello from eval";
const numbers = [1, 2, 3];
```

The bindings from the previous block are available here:

```js eval
const message = `${greeting} with ${numbers.length} numbers`;
```

Eval blocks produce **no rendered output** — they exist for bindings
and side effects. The output from eval blocks is empty, so nothing
appears between this text and the next section.

The `persist` modifier extends a block's resource lifetime from the
block scope to the component scope. Without `persist`, spawned tasks
and resources are torn down when the eval block completes. With it,
they survive for all subsequent blocks in the component.

The block below spawns a background task that sets `status.ready`
after a short delay. Because it uses `persist`, the task stays alive:

```js persist eval
const status = { ready: false };
yield *
  spawn(function* () {
    yield* sleep(10);
    status.ready = true;
  });
```

The next block converges on the spawned task using `when()`. This
only works because `persist` kept the task alive across the block
boundary — without it, the task would have been torn down:

```js eval
yield *
  when(function* () {
    if (!status.ready) throw new Error("not ready");
  });
const serverReady = status.ready;
```

The `timeout` modifier cancels the block if it does not complete within
the specified duration. Accepted units: `ms`, `s`, `m`. If the block
times out, an error is recorded in the output and execution halts.

```js timeout=30s eval
const startedAt = Date.now();
```

The `findFreePort` VM global finds an available TCP port using the OS:

```js eval
const port = yield * findFreePort();
```

Eval binding interpolation substitutes bare `{name}` references in code
block content with values from the eval binding environment. The port
allocated above flows into subsequent blocks via `{port}`:

```bash exec
echo "Server would start on port {port}"
```

Eval and exec blocks coexist independently in the same document:

```bash exec
echo "Exec blocks are independent of eval bindings"
```

</Section>

<Section title="Text Interpolation">

Eval bindings also resolve in **prose text**, not just code blocks. Values
computed in eval blocks flow naturally into surrounding text without
needing a template literal inside an eval block.

```js eval
const textPort = 49821;
const textHost = "127.0.0.1";
```

The server is running at {textHost}:{textPort}.

Both `{meta.*}` / `{props.*}` and bare `{name}` work in the same text.
Meta values resolve first, then eval bindings fill in remaining references.
The document title is {meta.title} and the text port is {textPort}.

Escaped braces produce literal output: \{textPort} stays as-is.

If a bare reference has no matching binding, it passes through verbatim:
{undefinedBinding} is not resolved.

Non-string values are coerced via `String()`. The count from the
Expression Props section is {itemCount}.

</Section>

<Section title="Background Processes">

The `daemon` modifier starts a long-running process that survives across
subsequent blocks. Combined with `when()` for readiness polling, this
implements the provider pattern: start a service, wait until it's ready,
then run children against it.

The eval block below allocates a port, the daemon block starts a Node
HTTP server on it, and the readiness block polls until the server
responds:

```js eval
const daemonPort = yield * findFreePort();
const daemonUrl = "http://127.0.0.1:" + daemonPort;
```

```bash daemon exec
node -e "require('http').createServer((q,s)=>{s.writeHead(200);s.end('daemon-ok')}).listen({daemonPort},'127.0.0.1')"
```

```js eval
yield *
  when(
    function* () {
      yield* fetch(daemonUrl + "/health").expect();
    },
    { timeout: 5000, interval: 50 },
  );
```

The daemon is alive — let's verify by hitting it:

```bash exec
curl -s http://127.0.0.1:{daemonPort}
```

When this section ends, the daemon process is terminated by structured
concurrency — no manual cleanup needed.

</Section>

<Section title="Sample Component">

The `<Sample>` component captures its children's rendered output (or
accepts a `prompt` prop) and routes it through the Sample Api for LLM
processing. It uses `output()` to produce rendered output and
`renderChildren()` to capture children.

Self-closing mode — prompt sent directly to the provider:

<StubProvider model="sample-stub">

<Sample prompt="summarize this" model="sample-stub" />

With children — children are rendered first, then sampled:

<Sample model="sample-stub">
This is child content to be processed.
</Sample>

</StubProvider>

</Section>

<Section title="Named Slots">

Components can render caller-provided content in multiple distinct
regions using named slots. The `slot` prop on child components directs
content to matching `<Content slot="name" />` positions in the
component body.

<TwoColumn>
  <Fragment slot="left">
    **Left column** content via named slot.
  </Fragment>
  <Fragment slot="right">
    **Right column** content via named slot.
  </Fragment>
</TwoColumn>

Named slots compose with the existing content slot. Children without
a `slot` prop go to the default slot:

<TwoColumn>
  <Note slot="left" message="This note is in the left column." />
  <Note slot="right" message="This note is in the right column." />
</TwoColumn>

</Section>

<Section title="Instruction Component">

The `<Instruction>` component surfaces the system prompt as visible,
composable document content. Instead of hiding the LLM's instructions
inside provider internals, authors wrap Sample calls with
`<Instruction system="...">` to define what the LLM is told.

Without an instruction, the provider uses a hardcoded default system
prompt. With `<Instruction>`, the author's text replaces that default:

<StubProvider model="instruction-stub">

<Instruction system="You are a helpful pirate.">
<Sample prompt="ahoy" model="instruction-stub" />
</Instruction>

</StubProvider>

Instructions accumulate through nesting. Agent components install
instruction middleware via `persist eval` blocks that enrich the
`SampleContext.system` field. When present, the system prompt is
passed through to the provider.

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

<Section title="Component-declared Output">

A component can declare which region of its body renders using `<Output>`.
Everything outside the region is documentation that executes (its eval blocks
run, its captures populate bindings) but never renders into the consumer.
`OutputDemo` computes a binding in documentation, then renders a `<Show>`
inside `<Output>` that depends on it.

<OutputDemo />

</Section>

<Section title="Smoke Test Summary">

This document exercises every feature of the system:

```bash exec
cat <<'EOF'
| Feature                   | Exercised by                            |
|---------------------------|-----------------------------------------|
| Root frontmatter          | Title and version in opening paragraph  |
| Component with props      | <Section title>, <Note message>         |
| Required props            | <Note message> (message is required)    |
| Default props             | <Note> uses level=info by default       |
| Content slot              | <Section> wraps children via <Content/> |
| Nested expansion          | Section > Feature > Note (3 levels)     |
| Dotted component name     | <Tips.Formatting />                     |
| exec modifier             | Multiple bash exec blocks               |
| silent modifier           | bash silent exec block                  |
| Non-executable code       | yaml block (passthrough)                |
| Markdown healing          | Unclosed bold before <Badge />          |
| No-inputs component       | <Badge /> accepts zero props            |
| meta interpolation        | {meta.emoji} in Section and Note        |
| props interpolation       | {props.title}, {props.message}, etc.    |
| Props passthrough         | <PropDemo greeting="Hey" subject="w">  |
| Expression props          | <PropDemo greeting={dynamic} subject={dynamic}> |
| component as capture      | <Fragment as="capturedFromComponent">...       |
| Capture directive         | <Capture as="capturedInline">...               |
| Capture select            | <Capture select="code[lang=json]">...          |
| Durability                | Timestamp stable across reruns          |
| eval modifier             | js eval blocks with shared bindings     |
| persist modifier          | js persist eval block, resource lifetime|
| persist resource survival | spawn in persist eval + when() converge |
| timeout modifier          | js timeout=30s eval block               |
| eval + exec coexistence   | Both modifier types in same document    |
| findFreePort VM global    | yield* findFreePort() in eval block     |
| eval binding interpolation| {port} in exec block from eval binding  |
| daemon modifier           | bash daemon exec starts background proc |
| daemon + when readiness   | Daemon server polled until ready        |
| provider pattern          | StubProvider installs Sample middleware  |
| per-component eval scope  | Each provider gets isolated middleware   |
| props in env.values       | model prop available in eval blocks     |
| Sample component          | <Sample prompt>, <Sample> with children |
| output() function         | Sample component calls output()         |
| renderChildren() closure  | Sample component captures children      |
| Named slots               | <TwoColumn> with slot="left"/slot="right" |
| Fragment passthrough      | <Fragment slot="..."> wraps raw text       |
| Instruction component     | <Instruction system> wraps Sample calls |
| composable instructions   | Instructions enrich SampleContext.system |
| Text interpolation        | {textHost}:{textPort} in prose text     |
| Text + meta coexistence   | {meta.title} and {textPort} in same text|
| Escaped text bindings     | \{textPort} produces literal braces     |
| Verbatim unresolved       | {undefinedBinding} left as-is           |
| Non-string text coercion  | {itemCount} coerced via String()        |
EOF
```

If you can read this table, every feature worked.

</Section>
