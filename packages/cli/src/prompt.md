---
description: Write an executable Markdown document with an Agent, and return the source you approved.
as: The approved document source, exactly as the Agent wrote it.
required: [request, syntax, session]
props:
  request:
    type: string
    description: What the generated document should accomplish
  syntax:
    type: string
    description: The Markdown catalog `xmd syntax` produced for the target environment
  session:
    type: string
    description: A fresh session name, so this authorship keeps its own conversation
returns:
  type: string
---

# Writing a document with an Agent

You describe what you want a document to do. An Agent writes it. You read what
it wrote and either take it or say what is wrong, and it tries again with your
words in the same conversation. When you take it, this returns that source
exactly as the Agent wrote it — nothing here reformats, unwraps or repairs a
reply.

The Agent is told what this environment can do by being handed the `syntax`
catalog you passed in. That catalog is the output of `xmd syntax`, so the Agent
is writing against the constructs and components you actually have rather than
against a remembered dialect.

Nothing is written to disk and nothing is run. The approved source comes back as
this document's value, and what happens to it next is yours to decide.

<Let as="reviewSchema" value={{
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "revise"],
      description: "approve to take this source, revise to ask for another draft"
    },
    feedback: {
      type: "string",
      minLength: 1,
      description: "What is wrong with this draft, and what you want instead"
    }
  },
  required: ["decision"],
  additionalProperties: false,
  if: { properties: { decision: { const: "revise" } }, required: ["decision"] },
  then: { properties: { feedback: {} }, required: ["feedback"] }
}} />

<Session name={props.session}>

## Asking for the first draft

The whole exchange happens in one named session, so every revision below
continues this conversation rather than starting a new one — the Agent still
has the request, the catalog, and everything you have already said about the
drafts it wrote.

<Prompt as="candidate">
Write an executable Markdown document that does this:

{props.request}

Executable Markdown is Markdown with components and control flow in it. These
are the constructs and components available in the environment this document
will run in. Use only what is listed here:

{props.syntax}

Reply with the complete document source and nothing else. No commentary before
or after it, and no enclosing code fence — your entire reply is written to a
file and run as it stands.
</Prompt>

## Reading it, and saying what is wrong

Up to ten rounds. Each one shows you the current draft and asks for a decision:
take it, or say what to change. Saying what to change sends your words back to
the same session, and the next draft replaces this one.

If you spend all ten rounds without approving anything, this document ends
without a value. That is deliberate — a draft you did not approve is not a
result, and returning one because the rounds ran out would be worse than
returning nothing.

<Loop max={10}>

<Elicit schema={reviewSchema} as="review">
Here is the current draft.

````md
{candidate}
````

Approve it to take this source as it stands. Choose revise instead, and say what
is wrong, to send that back and read the next draft.
</Elicit>

<If condition={review.decision === "approve"}>
<Return value={candidate} />
<Break />
</If>

<Prompt as="candidate">
That draft is not right yet:

{review.feedback}

Write the whole document again with that addressed. Reply with the complete
document source and nothing else — no commentary, no enclosing fence.
</Prompt>

</Loop>

</Session>
