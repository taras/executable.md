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
that document:

```console
xmd run hello.md --help
xmd run --help hello.md
xmd hello.md --help
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

Generating help loads and validates the document's declarative metadata. It
does not expand the document, execute code blocks, import body components,
start agents, or create a journal.

## Argument Order

Document-derived options follow the document path:

```console
xmd run hello.md --props-name Ada
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

- `{props.name}` interpolates the property explicitly.
- Root eval blocks receive each property as a binding.
- Bare binding interpolation such as `{name}` reads the root evaluation
  environment.

The core validation boundary applies to every host. Command-line parsing may
report an error earlier, but it does not replace whole-object validation.

Missing required properties, invalid values, malformed aggregate JSON, unknown
properties in a closed schema, and generated-name collisions fail with a
non-zero status before document effects or output.

## Programmatic API

`inspectDocument({ path })` loads the root Markdown definition and returns its
props schema without executing the document:

```typescript
const description = yield* inspectDocument({ path: "hello.md" });
const schema = description.props;
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

- `path` — path to the root Markdown document, resolved from the contextual
  working directory.
- `stream` — durable stream that journals the run.
- `props?` — JSON values supplied to the root document; defaults to `{}`.
- `componentDirs?` — component search directories.
- `modifiers?` — custom modifier factories.

`path` is the only document-path field; there is no compatibility alias.

## Command Scope

Root document props belong to `xmd run`. `xmd test` does not accept
`--props`, `--props-*`, `XMD_PROPS`, or `XMD_PROPS_*`.

## Essential Acceptance Tests

Core acceptance tests prove that inspection has no body effects, programmatic
props receive schema validation and defaults, resolved values reach root
interpolation and eval bindings, and invalid props prevent body effects.

CLI acceptance tests prove the individual and aggregate sources, precedence,
boolean and array forms, invalid-source failure, document-specific help without
execution, the document-first ordering rule, and unchanged behavior for a
document without props.
