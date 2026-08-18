# Root Document Props

An executable Markdown document can declare the values it needs and receive
them when it runs. The declaration is the same one imported components use
(§5.1.1); `xmd run` turns its top-level properties into command-line options
and environment-variable sources.

```markdown
---
required: [name]

props:
  name:
    type: string
    description: Person to greet
  loud:
    type: boolean
    default: false
---

Hello, {props.name}!
```

The equivalent full draft-07 schema declares the same document and behaves
identically; the map form only makes the enclosing closed object implicit.
Sources are generated from the normalized schema, so both spellings produce
the same options and variables.

The document runs with individual values:

```console
$ xmd run hello.md --props-name Ada --props-loud
Hello, Ada!
```

Environment variables provide the same values:

```console
$ XMD_PROPS_NAME=Ada xmd run hello.md
Hello, Ada!
```

## Configuration Sources

Each property is resolved independently. When more than one source supplies a
property, the first applicable source in this list wins:

1. An individual command-line option such as `--props-name`.
2. The aggregate `--props` command-line option.
3. An individual environment variable such as `XMD_PROPS_NAME`.
4. The aggregate `XMD_PROPS` environment variable.
5. The property's JSON Schema default.

A higher-priority source affects only the properties it supplies. For example:

```console
$ XMD_PROPS='{"name":"Ada","loud":false}' \
    xmd run hello.md --props-loud
```

resolves to `{ "name": "Ada", "loud": true }`.

An invalid supplied value is a configuration failure. It does not disappear in
favor of a lower-priority valid value.

## Individual Properties

A declared property with a scalar command-line representation receives a
namespaced option and environment variable. Property names use the CLI's
standard kebab-case and upper-snake-case normalization:

| Property | Command line | Environment |
| --- | --- | --- |
| `name` | `--props-name` | `XMD_PROPS_NAME` |
| `firstName` | `--props-first-name` | `XMD_PROPS_FIRST_NAME` |
| `json` | `--props-json` | `XMD_PROPS_JSON` |

The `props` namespace separates document props from `xmd run` options. A
collision between two normalized property names is a configuration failure.

Values are parsed according to the property's schema. A boolean accepts a bare
option or an explicit value:

```console
xmd run hello.md --props-loud
xmd run hello.md --props-loud=true
xmd run hello.md --props-loud=false
```

There is no generated `--no-props-loud` option.

An array of scalar values uses a repeated command-line option:

```console
xmd run hello.md --props-tag alpha --props-tag beta
```

Its environment value is a JSON array:

```console
XMD_PROPS_TAG='["alpha","beta"]' xmd run hello.md
```

Text is decoded against the property's schema. The original string wins when
both the string and its JSON scalar interpretation are valid. Otherwise the
valid interpretation wins. For example, `12` becomes a number for a
number-only property and remains a string for a `string | number` property.
Aggregate input selects an exact JSON type when the text is ambiguous.

Objects, nested arrays, and other structured properties use aggregate input.
The CLI does not create dotted options such as `--props-user.name`.

## Aggregate Properties

`--props` and `XMD_PROPS` contain a JSON object:

```console
xmd run hello.md \
  --props='{"user":{"name":"Ada"},"tags":["alpha","beta"]}'
```

```console
XMD_PROPS='{"user":{"name":"Ada"},"tags":["alpha","beta"]}' \
  xmd run hello.md
```

The aggregate source is named `props`, not `props-json`, so a property named
`json` retains the individual bindings `--props-json` and
`XMD_PROPS_JSON`.

The root schema validates the combined object. Unknown properties are accepted
or rejected according to `additionalProperties`. A malformed aggregate JSON
value fails configuration before the document runs. Source parsing preserves
the complete object so whole-object validation can diagnose unknown properties
rather than silently removing them.

`additionalProperties` describes complete objects. Individual bindings exist
only for names the schema declares, so an undeclared option such as
`--props-extra` fails even when `additionalProperties` is `true`, and its
message directs the user to `--props`. Undeclared `XMD_PROPS_*` variables are
never read. Additional properties reach the document through `--props`,
`XMD_PROPS`, and programmatic `props`.

## Command-Line Help

Help without a document describes `xmd run` itself:

```console
xmd run --help
```

When a document is present, help also describes the properties declared by
that document. An inline document declares properties the same way, and reports
them under its `<eval>` identity:

```console
xmd run hello.md --help
xmd run --help hello.md
xmd hello.md --help
xmd -e '<markdown>' --help
```

The document section identifies its origin and every available binding:

```text
Properties declared by hello.md

  --props-name <string>
      Person to greet
      Environment: XMD_PROPS_NAME
      Required

  --props-loud[=<boolean>]
      Environment: XMD_PROPS_LOUD
      Default: false

  --props <json>
      Set document properties as a JSON object
      Environment: XMD_PROPS
```

Help reports accepted sources, descriptions, requiredness, defaults, and value
forms without printing current command-line or environment values. A document
with no declared properties has no document-property section.

A file-backed document is described in one response: the run help and source
grammar, then the property section when it has one, then the sections it
addresses (Executable MDX §5.4). The property section keeps its position, and a
required property with no value supplied is still only described — help resolves
no value and checks no requirement.

```text
Targets in hello.md

  hello.md#Greeting
      Greet the person this run names, once.

  hello.md#Farewell
```

An inline document is not a selectable document reference, so it has no target
section however many headings its text holds. Neither has a file that addresses
nothing.

Generating help loads and validates the document's declarative metadata. It
does not expand the document, execute code blocks, import body components,
start agents, or create a journal.

## Argument Order

Document-derived options follow the document path:

```console
xmd run hello.md --props-name Ada
```

An inline document supplies the same schema, so its options may be written
wherever they read best:

```console
xmd -e '<markdown>' --props-name Ada
```

They are not recognized before the path because the document supplies their
schema:

```console
xmd run --props-name Ada hello.md
```

This form fails with a diagnostic that places document-derived options after
the document. Built-in options, including `--help`, retain their documented
ordering.

## Validation and Execution

Normal execution resolves all sources, then validates the complete props object
against the root schema before any document body content runs. Validation
applies schema defaults recursively and enforces required properties, unions,
local references, and `additionalProperties`.

Resolved properties have the same behavior at the root as props passed to an
imported Markdown component:

- The validated, defaulted object is installed under one `props` binding.
- `{props.name}` interpolates the property explicitly in text and executable
  block content.
- Root eval blocks read `props.name` directly.
- A declaration does not create a bare `{name}` binding. Bare references read
  only bindings authored by eval, capture, loop, or component-return behavior.

The object under `props` is the exact object returned by validation. Defaults
are present before the first body effect, and nested properties remain live
references for the duration of the component invocation.

For example, a root can use the namespace in every execution surface:

````markdown
---
props:
  type: object
  properties:
    name: { type: string }
    release:
      type: object
      properties: { version: { type: string } }
  required: [name, release]
---

Hello {props.name}, release {props.release.version}.

```ts eval
const greeting = `Hi ${props.name}`;
```

```bash exec
echo {props.release.version}
```
````

The declaration does not make `{name}` available. An authored `const name =
...` or capture may create that independent bare binding. When content is
projected through nested Markdown components, the caller's `props` object stays
lexical for projected content while the component's own body and
`render(markdown)` use the callee's namespace.

Text, direct eval, and executable-block interpolation all use the current
`props` binding. An authored binding literally named `props` shadows the
validated namespace in its scope and the validated binding is restored when
that scope ends. This rule changes only the props root; existing ordinary
binding lookup during projection remains unchanged.

The core validation boundary applies to every host. Command-line parsing may
report an error earlier, but it does not replace whole-object validation.

Missing required properties, invalid values, malformed aggregate JSON, unknown
properties in a closed schema, and generated-name collisions fail with a
non-zero status before document effects or output.

## Programmatic API

`inspectDocument(root)` loads the root Markdown definition and returns its
props schema without executing the document. The root is a path or supplied
text:

```typescript
const description = yield* inspectDocument({ path: "hello.md" });
const schema = description.props;

const inline = yield* inspectDocument(inlineSource("---\nprops:\n  name: { type: string }\n---\n"));
```

The same result describes what the document addresses. `targets` is the
canonical identity surface, and the additive `targetInfo` carries the same
fragments, in the same order and with the same duplicates, each as a
`DocumentTargetInfo` — its `target`, and its `description` when the section
states one:

```typescript
const { targets, targetInfo } = yield* inspectDocument({ path: "hello.md" });
targetInfo.map(({ target }) => target); // exactly `targets`
```

Inspection resolves relative paths against the contextual working directory.
It performs the same frontmatter and schema validation as execution, but does
not create a journal or enter the component expansion lifecycle.

`execute()` accepts root properties directly:

```typescript
const execution = yield* execute({
  path: "hello.md",
  stream,
  props: {
    name: "Ada",
    loud: true,
  },
});
```

Its relevant options are:

- the root document source — `path`, resolved from the contextual working
  directory, or `inlineSource(text)`, which carries supplied text under the
  `<eval>` identity.
- `stream` — durable stream that journals the run.
- `props?` — JSON values supplied to the root document; defaults to `{}`.
- `componentDirs?` — component search directories.
- `modifiers?` — custom modifier factories.

`path` is the only document-path field; there is no compatibility alias.
Supplied text is the one alternative to it, and is a different field rather
than another spelling of the same one.

## Command Scope

Root document props belong to `xmd run`, and so does the inline root document.
`xmd test` accepts neither `--props`, `--props-*`, `XMD_PROPS`, `XMD_PROPS_*`,
nor `--eval`/`-e`.

## Targeted roots

A file path given to `xmd run` is a document reference (§5.4): everything after
its first raw `#` selects one section of the document to run. A filename that
really contains `#` is written `%23`, and every literal `%` is written `%25` —
a raw `%` begins escape syntax wherever it appears, so `pct%zz.md` is refused as
a malformed reference and written `pct%25zz.md` instead.

Props are unaffected by the selection, because they are the document's. The
frontmatter that declares them is retained by every projection, so the same
options, environment variables, defaults, requirements, and `--help` section
apply — the declaring document is named by its path, and interpolation resolves
against the projected body. A required property is still required when only one
section runs.

Selection happens before props are extracted, so a selector that names no single
section is reported instead of a property complaint about a section that does
not exist.

`xmd test` does not adopt this grammar. A test path containing a literal `#` or
`%` continues to name that file, and `xmd test` gains no target selection.

## Essential Acceptance Tests

Core acceptance tests prove that inspection has no body effects, programmatic
props receive schema validation and defaults, resolved values reach root
interpolation and eval bindings, and invalid props prevent body effects.

CLI acceptance tests prove the individual and aggregate sources, precedence,
boolean and array forms, invalid-source failure, document-specific help without
execution, the document-first ordering rule, and unchanged behavior for a
document without props. They also prove that a projected root keeps the whole
document's declared properties, its property help, and its requirements, and
that every documented argument position answers with the property section and
the full target section together, resolving no value.
