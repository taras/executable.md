---
inputs:
  type: object
  properties:
    handoff:
      type: string
    handoffGate:
      type: string
    instructions:
      type: string
    planner:
      type: string
    implementor:
      type: string
  required:
    - handoff
    - handoffGate
    - instructions
    - planner
    - implementor
  additionalProperties: false
---

# Plan Convergence

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

<Loop name="plan-convergence" max={5}>
  <Prompt
    agent={props.implementor}
    session="implementor"
    as="plan"
    throwOnError
  >
    Repository instructions:

    {props.instructions}

    Planner handoff:

    {props.handoff}

    User involvement record:

    {props.handoffGate}

    Investigate the current working directory. Confirm, refute, or amend the
    implementation theory with evidence. Do not modify the repository. Return a
    concrete implementation plan with the evidence, validation, effects, and
    pull-request boundaries described by this workflow.
  </Prompt>

  <Agent name={props.planner}>
    <Session name="planner">
      <Prompt as="verdictCandidate" throwOnError>
        Repository instructions:

        {props.instructions}

        Planner handoff:

        {props.handoff}

        User involvement record:

        {props.handoffGate}

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

  <UserGate
    purpose="resolve the plan review"
    agent={props.planner}
    as="planGate"
  >
    ## Implementation plan

    {plan}

    ## Planner review

    Passed: {verdict.passed}

    {verdict.review}

    Revision prompt:

    {verdict.revisionPrompt}
  </UserGate>
  <If condition={verdict.passed}>
    <Break />
    <Else>
      <Prompt agent={props.implementor} session="implementor">
        Revise the implementation plan using this review:

        {verdict.review}

        Focused revision prompt:

        {verdict.revisionPrompt}

        User involvement record:

        {planGate}
      </Prompt>
    </Else>
  </If>
</Loop>

<Output>
  # Converged implementation plan

  {plan}

  ## Planner review

  Passed: {verdict.passed}

  {verdict.review}
</Output>

The loop is bounded and reports why it stopped: passed, user stopped, failed,
cancelled, or retry limit reached. `RunHistory` records every `plan`,
`verdict`, and `planGate` version under its loop iteration; the component does
not create handoff files.
