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
validator, and every style and font it needs are bundled into two assets the
form server delivers itself. The page makes no request off the machine.

`deno task build:web` produces them into `packages/web/generated/client-bundle.ts`,
which is gitignored and built at packaging time rather than committed — see
`specs/release-process-spec.md` §8 for which jobs build it and why. Two clean runs under the pinned Deno produce byte-identical output.

At the time of writing:

| Asset | UTF-8 bytes |
|---|---|
| `clientJs` | 621,345 |
| `themeCss` | 193,649 |

The stylesheet is three parts joined in a fixed order: the Shadcn theme's own
pre-compiled Tailwind output verbatim, six generated `@font-face` rules, and
`packages/web/client/theme/mx-brutalist.css`. The override wins by source order
alone — the vendored palette blocks are unlayered and sit near the end of the
compiled output, so an unlayered `:root` placed after them takes precedence
without `!important`.

That override carries the whole visual design, not only the palette: the
centered column, the card that wraps the document body and the form, the status
banner, and the treatment of every control — square corners, 2px foreground
borders, and hard offset shadows graded by weight. It reaches all of that
through the page shell's three ids and the classes RJSF already renders, so
`PAGE_SHELL` stays static and class-free. Two of those ids have to read as one
card, which no single element covers, so `body` is the grid and `body::before`
is the card.

Colours are never written directly: every rule binds to a theme variable, which
is what makes dark mode a palette swap rather than a second stylesheet. It
follows the reader's OS preference, with no toggle and no script — the compiled
`dark:*` utilities already resolve through `@media (prefers-color-scheme: dark)`,
so the override switches on the same media query and the theme's `.dark` class
stays inert.

Two things the stylesheet cannot derive are stamped by the client instead.
`#status` carries `data-outcome`, because whether an answer landed is not in the
DOM; without it there is no banner, which is what keeps an unanswered form from
showing an empty box. And a required field carries `rjsf-field-required`,
because the theme renders its marker as a bare text node that no selector
reaches — spending `required` suppresses it and the stylesheet draws the same
marker back on as `::after`.

Fonts are the reason `themeCss` is five times the vendored stylesheet. Montserrat
(400, 500, 600, 700) and Space Mono (400, 700) are read from pinned `@fontsource`
packages at build time and inlined as `data:` URIs — the six faces the compiled
stylesheet can actually reach. Lora is named by `--font-serif`, which no rule
reads, so it ships no bytes. Embedding is what keeps "no request off the
machine" true, and it is the one thing the page's fixed policy relaxes: it gains
`font-src data:`, which names no origin and admits fonts only. Every `url()` in
the stylesheet is one of those six faces; icons are React components inside the
bundle.

The extra ~150 KB is deliberate. The assets are served over loopback to one
reader, so the cost is a build-output number rather than a transfer one.

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
