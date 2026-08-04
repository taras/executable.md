---
required: [handoff, handoffCheckpoint, instructions, planner, implementor]

props:
  handoff: { type: string }
  handoffCheckpoint: { type: string }
  instructions: { type: string }
  planner: { type: string }
  implementor: { type: string }
---

# Planning

The implementor and planner are equally capable of analysis. The implementor
tests the handoff's theory; the planner tests the resulting plan. Evidence
resolves factual disagreement, while the user resolves material choices.

## Target shape

<Capture as="verdictSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "passed": { "type": "boolean" },
    "review": { "type": "string" },
    "revisionPrompt": { "type": "string" }
  },
  "required": ["passed", "review", "revisionPrompt"],
  "additionalProperties": false
}
```
</Capture>

<Loop name="planning" max={5}>
  <Prompt
    agent={implementor}
    session="implementor"
    as="plan"
    throwOnError
  >
    Repository instructions:

    {props.instructions}

    Planner handoff:

    {props.handoff}

    User involvement record:

    {props.handoffCheckpoint}

    Investigate the current working directory. Confirm, refute, or amend the
    implementation theory with evidence. Do not modify the repository. Return a
    concrete implementation plan with the evidence, validation, effects, and
    pull-request boundaries described by this workflow.
  </Prompt>

  <Agent name={planner}>
    <Session name="planner">
      <Prompt as="verdictCandidate" throwOnError>
        Repository instructions:

        {props.instructions}

        Planner handoff:

        {props.handoff}

        User involvement record:

        {props.handoffCheckpoint}

        Implementation plan:

        {plan}

        Result contract:

        {verdictSchema}

        Review the plan against the handoff, recorded user response, and
        repository evidence. Include a focused revision prompt on failure.
        Return only JSON matching the supplied result contract.
      </Prompt>

      <Loop max={2}>
        <SafeParse schema={verdictSchema} as="parsedVerdict">
          {verdictCandidate}
        </SafeParse>

        <If condition={parsedVerdict.ok}>
          <Break />
          <Else>
            <Prompt as="verdictCandidate" throwOnError>
              Correct your previous response without changing its meaning.
              Do not use tools or perform additional analysis.

              Previous response:

              {verdictCandidate}

              Validation errors:

              <Each in={parsedVerdict.errors} let="error">
              - {error.instancePath}: {error.message}
              </Each>

              Result contract:

              {verdictSchema}

              Return only corrected JSON.
            </Prompt>
          </Else>
        </If>
      </Loop>

      <Parse schema={verdictSchema} as="verdict">
        {verdictCandidate}
      </Parse>
    </Session>
  </Agent>

  <UserCheckpoint
    purpose="resolve the plan review"
    agent={planner}
    as="planCheckpoint"
  >
    ## Implementation plan

    {plan}

    ## Planner review

    Passed: {verdict.passed}

    {verdict.review}

    Revision prompt:

    {verdict.revisionPrompt}
  </UserCheckpoint>
  <If condition={verdict.passed}>
    <Break />
    <Else>
      <Prompt agent={implementor} session="implementor">
        Revise the implementation plan using this review:

        {verdict.review}

        Focused revision prompt:

        {verdict.revisionPrompt}

        User involvement record:

        {planCheckpoint}
      </Prompt>
    </Else>
  </If>
</Loop>

<Output>
  # Implementation plan

  {plan}

  ## Planner review

  Passed: {verdict.passed}

  {verdict.review}
</Output>

The loop is bounded and records why it stopped. `<Loop>` journals every
iteration it enters and one terminal record whose outcome is `break` — the
passing verdict above — `exhausted`, or `error`, and it refuses a replay whose
stored outcome or iteration count disagrees with what this run reached.
`<Loop>` opens no binding scope, so `plan`, `verdict`, and `planCheckpoint`
hold their final values in the `<Output>` region above.

The body outside `<Output>` runs under the `throw` error mode, which is what
makes the bounded repair turns a real gate: `<SafeParse>` absorbs a malformed
verdict so the document can show the correction prompt, and the final `<Parse>`
ends the stage if the candidate is still invalid. `throwOnError` on each
`<Prompt>` is required for the same reason — a failed prompt without it records
its failure and returns its text, raising nothing.

**Outstanding gap: exhaustion is unhandled.** Reaching `max` completes the loop
normally — exhaustion is not a failure and produces no diagnostic — so whether
an exhausted planning loop counts as converged is this document's policy to
state, and this document does not yet state it. The body has no branch after
`</Loop>`, so a plan that never passed review falls straight into the same
`<Output>` as a plan that did. The output above therefore reports
`verdict.passed` rather than titling itself converged, but reporting the flag is
not deciding what should happen. What the workflow does when five rounds end
without a passing verdict — return the failing plan, fail the stage, or return
to the user — is an unresolved product decision recorded against
[issue #290](https://github.com/taras/executable.md/issues/290), whose
acceptance pins the behavior. This synchronization slice does not choose it.

The surrounding workflow will record every `plan`, `verdict`, and
`planCheckpoint` as an artifact version under its loop-iteration identity. That
artifact ledger does not exist yet (#291), and neither does a `cancelled` loop
outcome — workflow-level cancellation and stop reasons belong to `<Workflow>`
(#289). The component does not create handoff files either way.

`agent={implementor}` and `<Agent name={planner}>` read the bare binding, which
is the expression-prop spelling current main supports, while the prompt bodies
interpolate `{props.instructions}` and `{props.handoff}`; #305 unifies the two.

Everything in this component's body runs today.
