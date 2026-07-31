# WebForm: Specification

`<WebForm>` asks a person a structured question and binds their answer.

```md
<WebForm schema={reviewSchema} uiSchema={reviewUi} as="response">
# Review required

Read the plan and decide.
</WebForm>
```

The document opens a form in a browser, waits for one validated answer, binds it
to `response`, and continues. The component renders nothing: what it produces is
the answer, not a form.

## Props

| Prop | Required | Value |
|---|---|---|
| `schema` | yes | A draft-07 JSON Schema, as a structured value or as captured JSON text |
| `uiSchema` | no | RJSF UI configuration, in either spelling |

`uiSchema` is never validated as a JSON Schema. It is RJSF configuration —
`ui:widget`, `ui:order`, `ui:options` — which a strict draft-07 validator would
reject, so it is normalized and carried to the page untouched.

The component declares a broad JSON return, because the author's `schema` is the
real contract and the server enforces it. `as` is therefore required, and core
requires it: a component that declares `returns` renders nothing and must be
invoked with a binding.

## The preflight boundary

Everything that can be judged without opening a port is judged first:

1. the content is projected;
2. `schema` and `uiSchema` are parsed and normalized;
3. the content is rendered to sanitized HTML;
4. the schema is compiled for the server and for the browser.

Only then does the durable operation begin, and only inside it does anything
observable happen. A document whose content failed, or whose schema cannot be
used, reads no assets, binds no port, prints no URL, opens no browser, invokes no
responder, and leaves no journal entry — not even a failed one.

Compilation is the last of the four and belongs there rather than inside the run,
because a schema can survive meta-schema validation and still fail to compile: a
same-document `$ref` that resolves to nothing is valid draft-07 and unusable. Had
compilation happened during the run, that schema would have read the browser
assets, begun a durable operation, and recorded its failure.

## The live form

`liveForm()` is the browser interaction without the component around it, so
`<Elicit>` (#197) can ask a person a question without owning a server. It takes a
normalized schema, an optional normalized UI schema, and sanitized content — and
nothing about where those came from.

It compiles the schema, then starts the loopback server, prints the URL, opens it,
invokes the contextual responder with that URL, waits for the server-validated
answer, and returns it. `<WebForm>` uses the two halves separately so its
compilation lands outside its journal entry; a caller with no durability of its
own can use `liveForm` and get both at once.
The listener, its sockets, the launch, and the responder all live in one scope, so
returning or failing dismantles every part of it. The server sends and observes
its 204 before the answer resolves, so the browser is told its submission was
accepted before anything is torn down.

Launch failure is a warning: the printed URL still works, and the form stays open.

## Registration

`installWebComponents()` registers `WebForm` as an ordinary, non-reserved function
component. A repository's own `WebForm.md` or `WebForm.ts` outranks it — nothing
about a schema-backed form is an invariant a package should keep for itself.

`as`, expression props, props and return validation, binding, invocation
lifetime, and settlement are core's. The component performs none of them.

It is unmarked, so a failure fails the document: there is no useful way to
continue from "the person was never asked".

## The bundled client

The page is entirely self-contained: React, RJSF, the Shadcn theme, the Ajv 8
validator, and every style it needs are bundled into two assets the form server
delivers itself. The page makes no request off the machine.

`deno task build:web` produces them into `packages/web/generated/client-bundle.ts`,
which is gitignored and built at packaging time rather than committed — see
`specs/release-process-spec.md` §8 for which jobs build it and why. Two clean runs under the pinned Deno produce byte-identical output.

At the time of writing:

| Asset | UTF-8 bytes |
|---|---|
| `clientJs` | 620,803 |
| `themeCss` | 37,258 |

The stylesheet is the Shadcn theme's own pre-compiled Tailwind output, which
carries no `url()` reference and no `@font-face` rule — so no font or icon file
is fetched, and none needs embedding. Icons are React components inside the
bundle.

The generator and the reader agree on the export names by test, not by
convention: everything else substitutes the asset seam, so a rename would
otherwise only surface when a real form tried to serve a real page.

## Durability

Only the validated response is journaled. Ports, tokens, URLs, opener state, and
responder state belong to the run that served the form, and restoring any of them
would describe a listener that no longer exists.

The durable description carries the invocation's location and a SHA-256
fingerprint of what was asked: the normalized schema, the normalized UI schema,
and the sanitized content, serialized with object keys sorted so that two
spellings of one question fingerprint alike.

A replay returns the recorded answer without starting a listener, printing a URL,
opening a browser, or invoking the responder. A changed question changes the
fingerprint, and the repository's ordinary durability semantics decide what that
means — `<WebForm>` adds no replay policy of its own.
