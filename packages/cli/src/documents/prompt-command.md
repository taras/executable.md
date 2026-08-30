---
props:
  type: object
  properties:
    request: { type: string }
    syntax: { type: string }
    session: { type: string }
  required: [request, syntax, session]
  additionalProperties: false
returns:
  type: string
---

# What `xmd prompt` does

`xmd prompt` turns your request into a Plan: an Executable Markdown document
that states what you asked for in ordinary language and places the components
that perform the work alongside those words.

This document is how that happens. It is a program rather than a setting: what
the assistant is asked for, how many times a draft may be fixed, what you are
shown, and what happens when you approve nothing are all written here, in the
open, where you can read them and argue with them.

The command gives it three things — your request as you typed it, the components
available in this directory, and the name of the assistant session every turn
belongs to. Nothing here runs the document being written. A draft is text until
you approve it, and the command runs it separately afterwards.

<Let as="round" value={0} />
<Let as="approved" value={null} />

<Session name={props.session}>

<Prompt as="draft">
Write one complete Executable Markdown document that does this:

{props.request}

The document you write is a Plan. A Plan is not a script with comments: it says
what is being done in ordinary reader-facing prose, and places each component
immediately after the sentences describing the action that component performs.
The prose is part of the program and part of what the document prints when it
runs, so somebody watching it run follows the same words somebody reading the
source did.

For the request "ask me for my age and write it to a file", the shape is:

```markdown
Ask me for my age.

<Elicit as="answer" schema={{ type: "object", properties: { age: { type: "number" } } }} />

Write it to a file.

<File path="age.txt">{answer.age}</File>
```

You do not have to repeat the request word for word. Divide it, clarify it and
rewrite it into natural prose — but keep every outcome it asked for, keep them in
an order that makes sense, and keep each one next to the component that carries
it out. Somebody should be able to audit the source and follow the execution by
the same narrative.

Everything you may use is described below. Use nothing that is not here.

{props.syntax}

Reply with the document source and nothing else. No enclosing code fence, no
explanation before or after it, no commentary about what you did.
</Prompt>

<Loop max={10}>
<Let as="round" value={round + 1} />

Each draft is checked once, and gets up to three chances to fix what the check
found. A change you ask for produces a new draft, so it gets its own three.

<ValidateCandidate source={draft} as="check" />

<Loop max={3}>
<If condition={check.valid}>
<Break />
</If>

<Prompt as="draft">
That document has problems. These are the exact ones:

<Let as="problems"><Json value={check.diagnostics} /></Let>
<CodeBlock value={problems} language="json" />

Send one complete replacement document that resolves every problem above. Keep
the reader-facing prose that says what the document is for, and keep each
component immediately after the sentences describing what it does. Source only,
no enclosing fence, no explanation.
</Prompt>

<ValidateCandidate source={draft} as="check" />
</Loop>

You decide what happens next. A draft that passed its check can be approved; one
that still has problems after three attempts is shown with them, and can only be
sent back or abandoned. On the tenth and last time you are asked there is
nothing left to change it into, so asking for a change is not offered.

<Elicit
  as="review"
  schema={{
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: check.valid
          ? (round === 10 ? ["approve", "abort"] : ["approve", "revise", "abort"])
          : (round === 10 ? ["abort"] : ["revise", "abort"]),
      },
      feedback: { type: "string" },
    },
    required: ["decision"],
    additionalProperties: false,
    if: { properties: { decision: { const: "revise" } }, required: ["decision"] },
    then: { required: ["feedback"], properties: { feedback: { type: "string", minLength: 1 } } },
  }}
>
This document was written for: {props.request}

<CodeBlock value={draft} language="markdown" />

<If condition={!check.valid}>
Three attempts to fix it did not clear everything. These problems remain:

<Let as="problems"><Json value={check.diagnostics} /></Let>
<CodeBlock value={problems} language="json" />
</If>
</Elicit>

<If condition={review.decision === "approve"}>
<Let as="approved" value={draft} />
<Break />
</If>

Stopping says two different things depending on where you are. On the tenth
draft, when it still has problems, `abort` is the only choice left and there was
never a Plan to approve — so that ending says so. Everywhere else, including a
tenth draft you could have approved, stopping is your decision and is reported
as one.

<If condition={review.decision === "abort"}>
<If condition={round === 10 && !check.valid}>
<Fail message="xmd prompt: ten drafts were reviewed and none was approved, so nothing was saved and nothing ran. Try again with a more specific request." />
<Else>
<Fail message="xmd prompt: you ended the review, so nothing was saved and nothing ran." />
</Else>
</If>
</If>

<Prompt as="draft">
The person who asked for this document read it and wants this changed:

{review.feedback}

Send one complete replacement document. Keep the reader-facing prose that says
what the document is for, and keep each component immediately after the
sentences describing what it does. Source only, no enclosing fence, no
explanation.
</Prompt>
</Loop>

</Session>

If you approved a document, return its source unchanged. Nothing should reach
this point without approving or stopping first, so the other branch says what it
would mean if anything did.

<If condition={approved !== null}>
<Return value={approved} />
<Else>
<Fail message="xmd prompt: ten drafts were reviewed and none was approved, so nothing was saved and nothing ran. Try again with a more specific request." />
</Else>
</If>
