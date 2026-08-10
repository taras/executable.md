---
required: [instructions, planner, request, worktree]

props:
  instructions: { type: string }
  planner: { type: string }
  request: { type: string }
  worktree: { type: string }
---

# Discovery

The workflow enters through design discovery or a bounded deferred issue.
Discovery includes a user-planner interview. A sufficiently specified deferred
issue may enter directly at implementor planning.

## Target shape

<Agent name={props.planner}>
  <Session name="planner">
    <Agent.AddDir path={props.worktree} />

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

`<Agent.AddDir>` is what gives the planner read access to the checkout, and it
is the only thing that does. Lexical cwd — established here by the enclosing
`<Worktree>` — governs where XMD's own file operations resolve; it registers
nothing with an Agent. The two are separate operations
([#302](https://github.com/taras/executable.md/issues/302), unbuilt), and the
planner's access is read-only either way: the workflow host enforces that
ceiling and no prop in this document can raise it. Registration belongs to the
enclosing Agent session, which is why it sits inside `<Session>`; the exact
placement rule is #302's to settle.

The prompt sits outside `<Output>`, so it runs under the `throw` error mode:
`throwOnError` turns a failed prompt into a failure the mode then ends the
stage on. Without it a failed prompt records its failure and returns its text,
and the stage would hand its caller an empty handoff.

Everything here except `<Agent.AddDir>` runs today.
