---
inputs:
  type: object
  properties:
    instructions:
      type: string
    planner:
      type: string
  required:
    - instructions
    - planner
  additionalProperties: false
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

The component renders the handoff content. Its caller supplies the request as
content and decides whether and where to persist the result. The handoff is a
theory for investigation, not an implementation plan that the implementor
follows unquestioningly.
