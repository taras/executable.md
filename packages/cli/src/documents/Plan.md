---
props:
  type: object
  properties:
    session: { type: string, minLength: 1 }
  additionalProperties: false
description: >-
  Create an XMD program from a prompt. `<Plan>Ask for the user's age.</Plan>`
  emits the approved program source.
as: Binds the exact approved program source and emits nothing. Omitted, that source is emitted where the component is written.
context: The complete prompt, expanded once before authorship.
---

# Turning a Prompt into a Plan

This is the standard workflow that turns a Prompt into an executable Plan. It
combines the Prompt, which describes a sequence of steps, with the XMD components
available to carry them out. A coding agent turns both into one document that
explains and executes the sequence.

A draft remains text while this workflow reviews it. Nothing in it runs before
you approve it, and nothing runs it afterwards either: what this workflow
produces is the approved program's source, byte for byte, for you to keep,
read, or hand to something that runs it.

## Read the Prompt

The Prompt is whatever the caller wrote between the tags, rendered once with the
capabilities the calling document already has. It is captured here, before any
authorship input is prepared, so a Prompt that failed to render or rendered to
nothing reaches no catalog, no session, no agent and no review.

<Let as="prompt"><Content /></Let>

<If condition={prompt.trim().length === 0}>
<Fail message="<Plan> requires its body to render a non-empty Prompt." />
</If>

<PlanInputs session={props.session} instruction={prompt} as="inputs" />

## Say what this surface calls things

The two surfaces that reach this workflow end it in different words, because
they hand a person a different thing at the end. Each ending is written once,
here, so the branch that chooses between them is not repeated at every place one
of them is raised.

<If condition={inputs.surface === "command"}>
<Let as="stopped" value="xmd plan stopped at your request. Nothing was output or run." />
<Let as="unresolved" value="xmd plan ended without an approved Plan. Nothing was output or run." />
<Let as="explained" value="xmd plan reviewed ten drafts without an approved Plan. The coding agent explained why:" />
<Let as="closing" value="Nothing was output or run." />
<Else>
<Let as="stopped" value="Plan authorship stopped at your request. No Plan was returned." />
<Let as="unresolved" value="Plan authorship ended without an approved Plan. No Plan was returned." />
<Let as="explained" value="Plan authorship reviewed ten drafts without an approved Plan. The coding agent explained why:" />
<Let as="closing" value="No Plan was returned." />
</Else>
</If>

<Let as="round" value={0} />
<Let as="approved" value={null} />

<PlanAuthorship
  session={inputs.session}
  durable={inputs.durable}
  authoredSession={inputs.authoredSession}
>
<Session name={inputs.session}>

## Create the first draft

<Prompt as="draft">
Create one complete XMD Plan from this Prompt:

{prompt}

Every Plan is complete on its own:

- optional frontmatter, and then one descriptive level-one Markdown heading as
  the first body content;
- the Prompt's complete sequence, written as readable steps;
- every outcome the Prompt asked for;
- those steps in an order that makes sense; and
- each XMD component beside the prose describing the action it performs.

The prose is part of the program and appears when the Plan runs, so its source
and its execution tell the same story.

For the Prompt "ask me for my age and write it to a file", the shape is:

```markdown
# Ask for and save your age

Ask me for my age.

<Elicit as="answer" schema={{ type: "object", properties: { age: { type: "number" } } }} />

Write it to a file.

<File path="age.txt">{answer.age}</File>
```

You do not have to repeat the Prompt word for word. Divide it, clarify it and
rewrite it into natural prose — but keep every outcome it asked for, keep them in
an order that makes sense, and keep each one beside the component that carries it
out.

Everything you may use is described below. Use nothing that is not here.

{inputs.syntax}

Reply with the Plan source and nothing else. No enclosing code fence, no
explanation before or after it.
</Prompt>

<Loop max={10}>
<Let as="round" value={round + 1} />

## Check and repair the draft

Each new draft is checked before it is shown to you. If the check finds problems,
the coding agent gets up to three repair attempts to replace it with a corrected
Plan. A revision you request later is a new draft and receives three repair
attempts of its own.

<CheckDraft source={draft} as="check" />

<Loop max={3}>
<If condition={check.valid}>
<Break />
</If>

<Prompt as="draft">
That Plan has problems. These are the exact ones:

<Json value={check.diagnostics} as="problems" />
<CodeBlock value={problems} language="json" />

Send one complete replacement Plan that resolves every problem above.

Every Plan is complete on its own:

- optional frontmatter, and then one descriptive level-one Markdown heading as
  the first body content;
- the Prompt's complete sequence, written as readable steps;
- every outcome the Prompt asked for;
- those steps in an order that makes sense; and
- each XMD component beside the prose describing the action it performs.

Write the title the Plan needs rather than the one the last draft had: add it if
it was missing, move it if it was not the first body content, and replace it if
it did not describe the Plan.

Reply with the Plan source and nothing else. No enclosing code fence, no
explanation before or after it.
</Prompt>

<CheckDraft source={draft} as="check" />
</Loop>

## Explain a tenth draft that could not be repaired

Ten drafts is the limit, and the tenth cannot be revised into an eleventh. So a
tenth draft that still has problems after its repair attempts leaves nothing to
approve and nothing to ask for — there is no decision left for you to make, and
this workflow does not ask you to make one.

Instead the coding agent is asked once, automatically, why the attempts did not
work and what would make a future prompt more likely to succeed. That answer is
explanation and nothing else: it creates no new draft, extends no limit, and
ends this Plan without a program.

<If condition={round === 10 && !check.valid}>
<Prompt as="explanation">
The final Plan still has these problems:

<Json value={check.diagnostics} as="problems" />
<CodeBlock value={problems} language="json" />

Explain briefly why the attempts did not resolve them and what the person should
clarify in their next Prompt. Do not create another Plan.
</Prompt>

<Fail message={`${explained}\n\n${explanation}\n\n${closing}`} />
</If>

## Review the draft

Every draft you are shown has a decision left in it. The workflow shows you the
complete draft after its repair attempts.

- Choose **Approve** to accept a draft that passed its check.
- Choose **Request changes** to send feedback to the coding agent and create a
  new draft.
- Choose **Stop** to end without returning anything.

A draft with remaining problems cannot be approved, and the tenth draft cannot
be revised, so on either of those the choices you are offered are narrower.

<Elicit
  as="review"
  schema={{
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: check.valid
          ? (round === 10 ? ["Approve", "Stop"] : ["Approve", "Request changes", "Stop"])
          : ["Request changes", "Stop"],
      },
      feedback: { type: "string" },
    },
    required: ["decision"],
    additionalProperties: false,
    if: {
      type: "object",
      properties: { decision: { const: "Request changes" } },
      required: ["decision"],
    },
    then: {
      type: "object",
      required: ["feedback"],
      properties: { feedback: { type: "string", minLength: 1 } },
    },
  }}
>
### Original Prompt

{prompt}

### Draft Plan

<CodeBlock value={draft} language="markdown" />

<If condition={!check.valid}>
### Problems that remain

The coding agent used all three repair attempts, but the draft still has these
problems:

<Json value={check.diagnostics} as="problems" />
<CodeBlock value={problems} language="json" />
</If>
</Elicit>

## Continue from your decision

Approve keeps this exact draft and leaves the review. Request changes sends your
feedback to the coding agent and starts a new draft. Stop ends here.

<If condition={review.decision === "Approve"}>
<Let as="approved" value={draft} />
<Break />
</If>

<If condition={review.decision === "Stop"}>
<Fail message={stopped} />
</If>

<Prompt as="draft">
You read that Plan and asked for this to change:

{review.feedback}

Send one complete replacement Plan.

Every Plan is complete on its own:

- optional frontmatter, and then one descriptive level-one Markdown heading as
  the first body content;
- the Prompt's complete sequence, written as readable steps;
- every outcome the Prompt asked for;
- those steps in an order that makes sense; and
- each XMD component beside the prose describing the action it performs.

Write the title the Plan needs rather than the one the last draft had: add it if
it was missing, move it if it was not the first body content, and replace it if
it did not describe the Plan.

Reply with the Plan source and nothing else. No enclosing code fence, no
explanation before or after it.
</Prompt>
</Loop>

</Session>
</PlanAuthorship>

## Produce the approved Plan source

Only an approved Plan leaves this workflow, and only after the whole authorship
frame above has been taken down. Its exact source is checked once more as
structure — every declaration, resolution and form it uses — and retained
together with the prompt it was written for, so asking again restores these
exact bytes instead of writing a second Plan.

<If condition={approved !== null}>
<AdmitPlan source={approved} instruction={prompt} as="admitted" />
<Else>
<Fail message={unresolved} />
</Else>
</If>

The source is what this workflow produces, byte for byte. Nothing here runs it.

<Output>{admitted}</Output>
