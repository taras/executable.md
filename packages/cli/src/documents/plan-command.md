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

## Hand the request to the standard workflow

How a Plan is written — the Prompt the coding agent receives, the checking and
repair loop, the review you are shown, the revisions, and every way this can end
without a Plan — is `<Plan>`, which an ordinary document can write too. This
command adds the command line and the delivery, and nothing else: there is one
policy, and this is not a second copy of it.

<Plan session={props.session} as="approved">{props.request}</Plan>

<Return value={approved} />
