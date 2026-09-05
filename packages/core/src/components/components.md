Long-form documentation for the components canonical core owns.

Each level-two heading below is the exact name of one component. The compact
catalog — `xmd syntax`, or a bare `<Syntax />` — lists every component with its
forms, props and one-line description. This file holds the part that does not
belong in a list: when to reach for a component, what it does at run time, and
what it will refuse.

Every component this package supplies has a section here. A build in which one
does not refuses rather than serving a reference with a silent hole in it: a
reader cannot tell "nobody has written this yet" from "this component has
nothing to say". The no-documentation sentence is for *custom* components, which
no package governs.

## Syntax

Renders the catalog of components and control-flow constructs available where
the element is written.

```mdx
<Syntax />
```

The bare form renders the compact catalog: every name a document may write at
that site, with its forms, props and description. It is the same text
`xmd syntax` prints, built by the same code, so an operator reading a terminal
and an agent reading a document are never told different things about one
profile.

```mdx
<Syntax names={["Elicit", "File"]} />
```

The named form renders the selected components' catalog metadata followed by the
long-form documentation on this page. Use it when something needs to know how to
use a few specific components rather than what exists — a prompt that has to
explain `<Elicit>` does not need the other seventy entries. Entries render once
each, in catalog order, whatever order they were asked for in.

`as` captures the rendered text instead of emitting it, in either form:

```mdx
<Syntax names={["Elicit"]} as="reference" />
```

### What the catalog describes

The site, not the product. It reflects the host profile the execution is running
under, its working directory and includes, the workflow bundle or declared
components it is closed over, and any narrowing a trusted evaluation boundary
applied. Two sites in one document can therefore answer differently, and that is
the point: the answer is what *this* element may write.

Inside an evaluation that narrows what may execute, the bare form reports the
narrowed vocabulary, while the named form still explains components from the
enclosing authoring catalog and states for each whether it is available in the
current evaluation. Reference material and execution authority are different
questions, and conflating them would either hide documentation an author needs
or imply an authority they do not have.

### What it refuses

An empty `names` list, a duplicate name, a member that is not a string, and a
name no catalog entry matches are each refused before anything is observed, so a
refusal produces no partial catalog and no retained result. A paired spelling
and any prop other than `names` and `as` are refused the same way.

### What it does not do

Seeing a component in a catalog is not permission to run it. The catalog and
this documentation are text; what a name means is still resolution's decision,
and what may run is still the execution's.

## Elicit

Asks a person a structured question and returns their answer.

```mdx
<Elicit schema={decision} as="answer">
Which release should ship first?
</Elicit>
```

The content is the request shown to the person. `schema` is a JSON Schema the
answer is validated against, so what comes back is the shape the document said
it needed rather than free text a later step has to interpret. The answer binds
through `as`.

The question is asked once and retained. A run that resumes after the answer was
given restores it rather than asking again, which is what makes a document with
an elicitation in it safe to interrupt.

How the question reaches a person is the host's: a terminal prompts, and another
host may route it somewhere else entirely. The document states what it needs to
know, not how to ask.

## File

Reads or writes a file, relative to the working directory.

```mdx
<File path="notes.md" />

<File path="notes.md">
The content to write.
</File>
```

The self-closing form reads the file and renders its content. The paired form
writes its content to the path. Both are ordinary durable effects: a write that
already happened is not repeated on a continuation, and a read restores what it
read rather than re-reading a file that has since changed.

A read of a path that does not exist fails. The write form creates the file and
the directories above it as needed.

## File.Delete

Deletes a file, relative to the working directory.

```mdx
<File.Delete path="scratch/notes.md" />
```

Self-closing, and it renders nothing. Deleting a path that does not exist
succeeds: the component's promise is that the file is gone afterwards, not that
it was there first, which is what makes it safe to write in a cleanup step that
may run more than once.

Like `<File>`, it is an ordinary durable effect — a deletion that already
happened is not repeated on a continuation.

## TempDir

Runs work in a temporary working directory.

```mdx
<TempDir>
<File path="scratch.txt">working notes</File>
</TempDir>
```

The paired form expands its content with the temporary directory as the working
directory, so a `<File>` or a command inside writes there rather than in the
directory the run started in. The self-closing form renders the path instead,
which is what you want when something outside the region needs to know where it
is:

```mdx
<TempDir as="workspace" />
```

Use it to keep intermediate work out of the user's tree, and to make a document
that writes files safe to run from anywhere.

## Fail

Stops authored work with an actionable failure.

```mdx
<Fail message="No acceptable candidate was approved." />
```

Raises the message where it is written. It is the authored counterpart of an
error a component raises on its own: the document has decided that what it found
is not something it can proceed from, and says so in its own words rather than
letting a later step fail obscurely.

The message is the whole point — write what a reader would need in order to act,
not that something went wrong.

## Fetch

Reads over HTTP.

```mdx
<Fetch url="https://example.com/status" as="response" />
```

Only GET and HEAD are currently supported. Without `as`, a non-2xx status fails
the document. With `as`, the response binds instead — status included — which is
what makes a status something to branch on rather than an error:

```mdx
<Fetch url="https://example.com/status" as="response" />

<If condition={response.status === 404}>
Nothing published yet.
</If>
```

The request is journaled, so a continuation restores what the first run received
rather than asking the network again.

## Glob

Lists the files matching a pattern, relative to the working directory.

```mdx
<Glob pattern="docs/**/*.md" as="documents" />
```

`as` is required: the component's result is the list, and there is no useful
text to render. The list is sorted, so a document that iterates it produces the
same output for the same tree. Directories and symbolic links are never results
— only files.

## CodeBlock

Shows arbitrary text as a fenced Markdown code block.

```mdx
<CodeBlock language="json">{payload}</CodeBlock>
```

Use it when a value is going into a document that will be read as Markdown and
must not be interpreted as Markdown: a fragment containing backticks, a diff, or
anything an agent might otherwise read as instructions. It renders the fence for
you, with a delimiter long enough to survive whatever the content contains.

## Json

Renders a value as JSON text.

```mdx
<Json value={config} />
```

Writes the JSON where the element is written, or binds it with `as`. The
counterpart of `<Parse>`: this turns a value into text, that turns text into a
value.

## Parse

Parses JSON text against a schema, and errors on invalid content.

```mdx
<Parse schema={settings} as="config">{raw}</Parse>
```

The content is the JSON text. `as` is required, because the parsed value is the
result. Invalid content — malformed JSON, or JSON the schema rejects — fails the
document, which is what you want when there is nothing sensible to do without
the value.

Use `<SafeParse>` instead when the document should decide what to do about
invalid input.

## SafeParse

Parses JSON text against a schema, and returns a result object instead of
failing.

```mdx
<SafeParse schema={settings} as="attempt">{raw}</SafeParse>
```

The bound result is either the validated value or the issues that rejected it,
so the document can branch on which it got. Reach for this when invalid input is
an expected case — reading something a person typed, or a response from a
service that may be having a bad day — rather than a reason to stop.

## Test

Declares a test case.

```mdx
<Test name="the plan names every input">
…
</Test>
```

It runs only inside a `<Testing>` region; elsewhere it is skipped, so a document
carrying its own tests stays runnable as an ordinary document. A failing command
or assertion inside the case fails that case rather than the whole run, which is
what lets one run report every failure rather than only the first.
