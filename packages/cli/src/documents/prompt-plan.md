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

# The plan `xmd prompt` follows

This is the policy behind `xmd prompt`, and it is a program rather than a
setting: what the agent is asked, how many times a draft may be repaired, what a
person is shown, and what happens when nobody approves anything are all written
here, in the open, where they can be read and argued with.

The command supplies three things — the request as the person typed it, the
syntax catalog for this working directory, and the name of the session every
turn belongs to. Nothing here runs the document being written. A candidate is
text until a person approves it and the command runs it separately.

<Let as="round" value={0} />
<Let as="approvedCandidate" value={null} />

<Session name={props.session}>

<Prompt as="candidate">
Write one complete Executable Markdown root document that accomplishes this:

{props.request}

Reply with the document source and nothing else. No enclosing code fence, no
explanation before or after it, no commentary about what you did.

Write it as a document a person would want to read, not as a script with
comments bolted on. State what it does and why in ordinary prose, and let the
components appear where that prose leads to them. The person asked for the
outcome above; the document should still read as though it is about that
outcome.

Everything you may use is described below. Use nothing that is not here.

{props.syntax}
</Prompt>

<Loop max={10}>
<Let as="round" value={round + 1} />

Each draft gets one validation and up to three chances to fix what validation
found. A revision the person asked for is a new draft, so it gets its own three.

<ValidateCandidate source={candidate} as="assessment" />

<Loop max={3}>
<If condition={assessment.valid}>
<Break />
</If>

<Prompt as="candidate">
That document does not validate. These are the exact findings:

<Let as="findings"><Json value={assessment.diagnostics} /></Let>
<CodeBlock value={findings} language="json" />

Return one complete replacement root document that resolves every finding above.
Source only, no enclosing fence, no explanation. Keep the narrative that explains
what the document is for.
</Prompt>

<ValidateCandidate source={candidate} as="assessment" />
</Loop>

The person decides. A valid draft can be approved; one that is still invalid
after three repairs is shown with its findings and can only be sent back or
abandoned. On the tenth and last presentation there is nothing left to revise
into, so revision is not offered.

<Elicit
  as="review"
  schema={{
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: assessment.valid
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

<CodeBlock value={candidate} language="markdown" />

<If condition={!assessment.valid}>
It still does not validate after three attempts to repair it. These are the
remaining findings:

<Let as="findings"><Json value={assessment.diagnostics} /></Let>
<CodeBlock value={findings} language="json" />
</If>
</Elicit>

<If condition={review.decision === "approve"}>
<Let as="approvedCandidate" value={candidate} />
<Break />
</If>

<If condition={review.decision === "abort"}>
<Fail message="xmd prompt: you ended the review, so nothing was saved and nothing ran." />
</If>

<Prompt as="candidate">
The person read that document and asked for this to change:

{review.feedback}

Return one complete replacement root document. Source only, no enclosing fence,
no explanation. Keep the narrative that explains what the document is for.
</Prompt>
</Loop>

</Session>

A `<Return>` selects the value this document publishes; it does not end the
document. So approval and exhaustion are written as the two arms of one branch,
and only the arm taken runs — an approved candidate is returned with no later
failure to overtake it, and a review that approved nothing fails instead.

<If condition={approvedCandidate !== null}>
<Return value={approvedCandidate} />
<Else>
<Fail message="xmd prompt: ten drafts were reviewed and none was approved, so nothing was saved and nothing ran. Try again with a more specific request." />
</Else>
</If>
