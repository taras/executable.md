Long-form documentation for the components canonical core owns.

Each level-two heading below is the exact name of one component. The compact
catalog — `xmd syntax`, or a bare `<Syntax />` — lists every component with its
forms, props and one-line description. This file holds the part that does not
belong in a list: when to reach for a component, what it does at run time, and
what it will refuse.

A component with no section here is still ordinary and still usable. Selecting
it by name reports that no long-form documentation is available for it yet.

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
