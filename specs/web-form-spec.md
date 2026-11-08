# WebForm: Specification

The WebForm component asks a person a structured question in a browser and
binds their validated answer.

```md
<WebForm schema={reviewSchema} uiSchema={reviewUi} as="response">
# Review required

Read the plan and decide.
</WebForm>
```

The document opens a form in a browser, waits for one validated answer, binds
it to `response`, and continues. The component renders nothing: what it
produces is the answer, not a form.

## Props

| Prop | Required | Value |
|---|---|---|
| `schema` | yes | A draft-07 JSON Schema, as a structured value or as captured JSON text |
| `uiSchema` | no | RJSF UI configuration, in either spelling |

`uiSchema` is never validated as a JSON Schema. It is RJSF configuration —
`ui:widget`, `ui:order`, `ui:options` — which a strict draft-07 validator would
reject, so it is normalized and carried to the page untouched.

The component declares a broad JSON return, because the author's `schema` is
the real contract and the server enforces it. `as` is therefore required, and
core requires it: a component that declares `returns` renders nothing and must
be invoked with a binding.

## The preflight boundary

Everything that can be judged without opening a port is judged first, in this
order:

1. the content is projected;
2. `schema` and `uiSchema` are parsed and normalized;
3. the content is rendered to sanitized HTML;
4. the schema is compiled for the server and for the browser.

Only then does the durable operation begin, and only inside it does anything
observable happen. A document whose content failed, or whose schema cannot be
used, reads no assets, binds no port, prints no URL, opens no browser, invokes
no responder, and leaves no journal entry — not even a failed one.

Compilation is the last of the four and belongs there rather than inside the
run, because a schema can survive meta-schema validation and still fail to
compile: a same-document `$ref` that resolves to nothing is valid draft-07 and
unusable. Had compilation happened during the run, that schema would have read
the browser assets, begun a durable operation, and recorded its failure.

The bundled browser validator is Ajv 8, running in strict mode. Compiling for the browser
takes the schema apart: `if`, `then`, `else` and the other subschema keywords
are extracted and compiled as schemas of their own. A branch therefore declares
its own `type` — one that reached `required` through its parent's type is a
typeless schema by the time it is compiled, and strict mode refuses it. The
server, compiling the whole schema in one piece, accepts that same branch, so
this is the one shape the two sides read differently and the refusal names
which side produced it.

## The live form

`liveForm()` is the browser interaction without the component around it, so
other askers (such as Elicit, #197) can ask a person a question without owning
a server. It takes a normalized schema, an optional normalized UI schema, and
sanitized content — and nothing about where those came from.

It compiles the schema, starts the loopback server, prints the URL, opens it,
invokes the contextual responder with that URL, waits for the server-validated
answer, and returns it. WebForm uses the two halves separately so its
compilation lands outside its journal entry; a caller with no durability of its
own gets both at once.

The listener, its sockets, the launch, and the responder all live in one
scope: returning or failing dismantles every part of it. The server sends and
observes its 204 before the answer resolves, so the browser is told its
submission was accepted before anything is torn down.

Launch failure is a warning: the printed URL still works, and the form stays
open.

## Registration

`installWebComponents()` registers WebForm as an ordinary, non-reserved
function component. A repository's own WebForm.md or WebForm.ts outranks it —
nothing about a schema-backed form is an invariant a package should keep for
itself.

`as`, expression props, props and return validation, binding, invocation
lifetime, and settlement are core's. The component performs none of them.

It is unmarked, so a failure fails the document: there is no useful way to
continue from "the person was never asked".

## The page

The page is entirely self-contained — React, RJSF and the Ajv 8 validator are
bundled into two assets, one script and one stylesheet, which the form server
itself delivers over loopback, to one reader. The page makes no request off the
machine. Fonts are embedded in the stylesheet as `data:` URIs; the page's fixed
content-security policy relaxes exactly one thing for them, `font-src data:`,
which names no origin and admits only fonts.

The page shows the document content, the generated form, and a marker on every
required field. No status banner exists until an answer's outcome does; once an outcome exists, the banner reflects it — which is what keeps an unanswered form
from showing an empty box. Dark mode follows the reader's OS preference through
`prefers-color-scheme`, with no toggle and no script; a `.dark` class on the
page stays inert.

The two bundled assets are produced by `deno task build:web` at packaging time
and are deterministic: two clean runs under the pinned Deno produce
byte-identical output. Which release jobs build them, and why, is owned by
[the release process spec](release-process-spec.md). The generator and the
reader agree on the asset export names by test, not by convention.

Visual design, theming mechanics and asset composition are implementation,
owned by `packages/web`; this contract requires only the behavior above.

## Durability

Only the validated response is journaled. Ports, tokens, URLs, opener state,
and responder state belong to the run that served the form; restoring any of
them would describe a listener that no longer exists.

The durable description carries the invocation's location and a SHA-256
fingerprint of what was asked: the normalized schema, the normalized UI
schema, and the sanitized content, serialized with object keys sorted, so two
spellings of one question fingerprint alike.

A replay returns the recorded answer without starting a listener, printing a
URL, opening a browser, or invoking the responder.

The fingerprint is enforced, not merely recorded. Only an effect's type and
name decide whether a journal entry matches, and the name is a source
position — so a journal describing a different question would otherwise bind
its answer here. WebForm installs a replay guard that compares the recorded
fingerprint with the one this run computed and fails with a `StaleInputError`
when they differ, before anything is served. Binding an answer to a question
nobody was asked is the failure a human-decision component must not have.

It refuses rather than asking again. A replay guard decides between replaying
and erroring; re-execution is named in the durable protocol as a future
outcome, and asking again where the question changed belongs with it. Elicit
enforces its own fingerprint the same way.
