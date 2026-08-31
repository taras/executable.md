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

# `xmd plan` turns steps into a program

This document is a workflow that generates an executable Plan from a sequence of
steps. It combines the original Prompt, which describes those steps, with the XMD
components available to carry them out. A coding agent turns both into one
document that explains and executes the sequence.

The result is the XMD version of a coding agent’s plan. A conventional Markdown
plan must be interpreted again before its steps can happen. An XMD Plan already
contains those executable steps, so running it simply executes them.

A draft remains text while this workflow reviews it. Nothing in it runs before
you approve it. After approval, `xmd plan` validates the exact source again. By
default it prints the approved XMD source. `--output` writes that source to a
file instead, and `--run` executes the Plan. With both options, the command
writes the source before running it.

<Let as="round" value={0} />
<Let as="approved" value={null} />

<Session name={props.session}>

## Create the first draft

<Prompt as="draft">
Create one complete XMD Plan from this Prompt:

{props.request}

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

{props.syntax}

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

## Review the draft

The workflow shows you the complete draft after its repair attempts.

- Choose **Approve** to accept a draft that passed its check.
- Choose **Request changes** to send feedback to the coding agent and create a
  new draft.
- Choose **Stop** to end without outputting or running anything.

A draft with remaining problems cannot be approved. You may review at most ten
drafts, and the tenth cannot be revised. If the tenth draft still has problems,
you may ask the coding agent to explain what went wrong or stop.

<Elicit
  as="review"
  schema={{
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: check.valid
          ? (round === 10 ? ["Approve", "Stop"] : ["Approve", "Request changes", "Stop"])
          : (round === 10
            ? ["Explain what went wrong", "Stop"]
            : ["Request changes", "Stop"]),
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

{props.request}

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
feedback to the coding agent and starts a new draft. Stop ends here. On a tenth
draft that still has problems there is nothing left to revise into, so the two
remaining choices are to ask the coding agent what went wrong, or to stop.

<If condition={review.decision === "Approve"}>
<Let as="approved" value={draft} />
<Break />
</If>

<If condition={review.decision === "Stop"}>
<If condition={round === 10 && !check.valid}>
<Fail message="xmd plan reviewed ten drafts without an approved Plan. Nothing was output or run." />
<Else>
<Fail message="xmd plan stopped at your request. Nothing was output or run." />
</Else>
</If>
</If>

<If condition={review.decision === "Explain what went wrong"}>
<Prompt as="explanation">
The final Plan still has these problems:

<Json value={check.diagnostics} as="problems" />
<CodeBlock value={problems} language="json" />

Explain briefly why the attempts did not resolve them and what the person should
clarify in their next Prompt. Do not create another Plan.
</Prompt>

<Fail
  message={`xmd plan reviewed ten drafts without an approved Plan. The coding agent explained why:\n\n${explanation}\n\nNothing was output or run.`}
/>
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

## Return the approved Plan

Only an approved Plan can leave this workflow. Its source is returned exactly as
the coding agent wrote it.

<If condition={approved !== null}>
<Return value={approved} />
<Else>
<Fail message="xmd plan ended without an approved Plan. Nothing was output or run." />
</Else>
</If>
