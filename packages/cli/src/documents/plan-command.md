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

A draft remains text while this workflow reviews it, and nothing in it ever runs
here. After approval, `xmd plan` validates the exact source again and hands it
over: by default it prints the approved XMD source, and `--output` writes that
source to a file instead. Running the program is a separate command, so you
decide whether and when it happens.

<Plan session={props.session} as="approved">{props.request}</Plan>

<Return value={approved} />
