---
required: [instructions, planner, request]

props:
  instructions: { type: string }
  planner: { type: string }
  request: { type: string }
---

# Discovery

The workflow enters through design discovery or a bounded deferred issue.
Discovery includes a user-planner interview. A sufficiently specified deferred
issue may enter directly at implementor planning.

## Target shape

<Agent name={props.planner}>
  <Session name="planner">
    <Prompt as="handoff" throwOnError>
      Repository instructions:

      {props.instructions}

      User request:

      {props.request}

      Produce a user-validated design handoff and a falsifiable implementation
      theory. Distinguish user decisions from hypotheses the implementor must
      test.
    </Prompt>
  </Session>
</Agent>

<Output>{handoff}</Output>

## Handoff contents

- Purpose and observable behavior
- User decisions, constraints, non-goals, and accepted risks
- Repository and architectural context
- Falsifiable implementation theory
- Assumptions to confirm or refute
- Required evidence and validation
- Likely pull-request topology
- Decisions that remain with the user

The component declares no `returns`, so its `<Output>` region is its return
value and a caller's `as` binds that rendered text. `<Agent name={props.planner}>`
selects the agent from a validated prop rather than a literal: the agent
components take their props from a literal or from an expression that resolves
to a string, and props are namespaced in expression props and text alike (#305).
Its caller supplies the request as the `request` prop and decides whether and
where to persist the result. The handoff is a theory for investigation, not an
implementation plan that the implementor follows unquestioningly.

The planner never reads the repository. A workflow Agent gets no checkout, no
materialization of one, no Workspace or host path as its working directory, and
no directory registered with its session — that ceiling is the host's, and
[#302](https://github.com/taras/executable.md/issues/302) is what settles it.
What the planner reasons over is what this prompt renders, and nothing else.

`instructions` is the concrete case. Host-authored XMD file effects produced the
exact repository-relative paths and contents, `InstructionFiles` captured that
result, and the caller passes the captured text in as a prop — so the planner
sees the instruction files as data it was handed rather than as a directory it
was let into. General repository observation is the bounded request/result loop
#302 and #369 still owe; until it exists, a stage that needs more evidence must
be given it as a value.

The prompt sits outside `<Output>`, so it runs under the `throw` error mode:
`throwOnError` turns a failed prompt into a failure the mode then ends the
stage on. Without it a failed prompt records its failure and returns its text,
and the stage would hand its caller an empty handoff.

Everything here runs today.
