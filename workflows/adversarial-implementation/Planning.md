---
required: [handoff, handoffCheckpoint, instructions, planner, implementor]

props:
  handoff: { type: string }
  handoffCheckpoint:
    type: object
    properties:
      proceed: { type: boolean }
      assessment: { type: string }
      response: { type: string }
      rationale: { type: string }
    required: [proceed, assessment, response, rationale]
  instructions: { type: string }
  planner: { type: string }
  implementor: { type: string }

returns:
  plan: { type: string }
  verdictPassed: { type: boolean }
  review: { type: string }
  revisionPrompt: { type: string }
  decision:
    type: object
    properties:
      requiresUser: { type: boolean }
      proceed: { type: boolean }
      assessment: { type: string }
      recommendation: { type: string }
      question: { type: string }
      options:
        type: array
        items:
          type: string
      response: { type: string }
      rationale: { type: string }
    required:
      [requiresUser, proceed, assessment, recommendation, question, options, response, rationale]
    additionalProperties: false
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

    {props.handoffCheckpoint.assessment}
    User response: {props.handoffCheckpoint.response}
    Rationale: {props.handoffCheckpoint.rationale}

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

        {props.handoffCheckpoint.assessment}
        User response: {props.handoffCheckpoint.response}
        Rationale: {props.handoffCheckpoint.rationale}

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

  <Capture as="checkpointMaterial">
    ## Implementation plan

    {plan}

    ## Planner review

    Passed: {verdict.passed}

    {verdict.review}

    Revision prompt:

    {verdict.revisionPrompt}
  </Capture>
  <UserCheckpoint
    purpose="resolve the plan review"
    agent={planner}
    material={checkpointMaterial}
    as="planCheckpoint"
  />
  <If condition={planCheckpoint.proceed}>
    <If condition={verdict.passed}>
      <Break />
      <Else>
        <Prompt agent={implementor} session="implementor">
          Revise the implementation plan using this review:

          {verdict.review}

          Focused revision prompt:

          {verdict.revisionPrompt}

          User involvement record:

          {planCheckpoint.assessment}
          User response: {planCheckpoint.response}
          Rationale: {planCheckpoint.rationale}
        </Prompt>
      </Else>
    </If>
    <Else>
      <Break />
    </Else>
  </If>
</Loop>

<Return value={{
  plan: plan,
  verdictPassed: verdict.passed,
  review: verdict.review,
  revisionPrompt: verdict.revisionPrompt,
  decision: planCheckpoint
}} />

## The stage returns its control state

This is a **value component**. A stage that resolves a user decision internally
cannot discard it as rendered prose: its caller has to gate on that decision,
and prose gives a caller nothing to branch on. So `Planning` declares `returns`,
renders nothing, and hands back the plan, the parsed verdict's fields, and the
complete plan-review `UserDecision`.

It returns those sources and nothing derived from them. A field like
`authorized` would be a second copy of `decision.proceed && verdictPassed`, and
a return schema cannot express that the copy must agree with its sources — a
record claiming approval over a decline would validate. The caller reads the two
authoritative fields and computes the gate itself, so there is only ever one
answer.

Three outcomes are distinguishable from those fields alone, which is all a caller
needs:

| `decision.proceed` | `verdictPassed` | What happened |
| --- | --- | --- |
| `true` | `true` | the review passed and the user approved it |
| `false` | either | the user declined; the loop stopped without revising |
| `true` | `false` | the loop reached `max` still failing — exhaustion |

Only the first pair advances.

The loop is bounded and records why it stopped. `<Loop>` journals every
iteration it enters and one terminal record whose outcome is `break` — a passing
verdict or a declined checkpoint — `exhausted`, or `error`, and it refuses a
replay whose stored outcome or iteration count disagrees with what this run
reached. `<Loop>` opens no binding scope, so `plan`, `verdict`, and
`planCheckpoint` hold their final values where `<Return>` reads them.

The user's decision outranks the verdict. The outer `<If>` reads
`planCheckpoint.proceed` before the inner one reads `verdict.passed`, so a
declined checkpoint leaves the loop without revising the plan and without
presenting it as reviewed — a rejection is neither a revision request nor an
acceptance. `<Break />` works from that nested position, so the two conditions
compose without a flag binding between them.

A value component's body runs fail-fast, which is what makes the bounded repair
turns a real gate: `<SafeParse>` absorbs a malformed verdict so the document can
show the correction prompt, and the final `<Parse>` ends the stage if the
candidate is still invalid. `throwOnError` on each `<Prompt>` is required for the
same reason — a failed prompt without it records its failure and returns its
text, raising nothing.

**Outstanding gap: the terminal policy for exhaustion.** Reaching `max`
completes the loop normally — exhaustion is not a failure and produces no
diagnostic. The returned pair identifies it (`decision.proceed` true,
`verdictPassed` false) and the caller's gate refuses it, so an exhausted loop
cannot advance. That is the minimum needed to keep the workflow safe; it is not
the policy. What the workflow *should* do when five rounds end without a passing
verdict — return the failing plan, fail the stage, or return to the user — is an
unresolved product decision recorded against
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
