---
required: [instructions, planner]

props:
  instructions: { type: string }
  planner: { type: string }
---

# Discovery

The workflow enters through design discovery or a bounded deferred issue.
Discovery includes a user-planner interview. A sufficiently specified deferred
issue may enter directly at implementor planning.

## Target shape

<Agent name={planner}>
  <Session name="planner">
    <Prompt as="handoff" throwOnError>
      Repository instructions:

      {props.instructions}

      User request:

      <Content />

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
value and a caller's `as` binds that rendered text. `<Agent name={planner}>`
selects the agent from a validated prop rather than a literal: the agent
components take their props from a literal or from an expression that resolves
to a string. An expression prop reads the bare binding, while the prompt body
above interpolates `{props.instructions}` — the two spellings that #305 will
unify. Its caller supplies the request as content and decides whether and where
to persist the result. The handoff is a theory for investigation, not an
implementation plan that the implementor follows unquestioningly.

The prompt sits outside `<Output>`, so it runs under the `throw` error mode:
`throwOnError` turns a failed prompt into a failure the mode then ends the
stage on. Without it a failed prompt records its failure and returns its text,
and the stage would hand its caller an empty handoff.

This component runs today.
