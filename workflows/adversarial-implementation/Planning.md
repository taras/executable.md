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

Both agents are read-only here, and that is not a restriction this stage has to
impose: planning produces a plan, not a change. Neither reads the repository
either — a workflow Agent gets no checkout (#302) — so what the stage has to do
is render the evidence each agent needs into its prompt.

## Target shape

<Let as="verdictSchema" select="code[lang=json]">
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
</Let>

<Agent name={props.implementor}>
  <Session name="implementor">
    <Loop name="planning" max={5}>
      <Prompt as="plan" throwOnError>
        Repository instructions:

        {props.instructions}

        Planner handoff:

        {props.handoff}

        User involvement record:

        {props.handoffCheckpoint.assessment}
        User response: {props.handoffCheckpoint.response}
        Rationale: {props.handoffCheckpoint.rationale}

        Work only from the material above: the repository instructions, the
        handoff, and the recorded user decision. You have no repository access
        and cannot modify anything, and this stage produces no change. Confirm,
        refute, or amend the implementation theory against that material, and
        say plainly what you cannot determine from it. Return a concrete
        implementation plan with the evidence, validation, effects, and
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

            {props.handoffCheckpoint.assessment}
            User response: {props.handoffCheckpoint.response}
            Rationale: {props.handoffCheckpoint.rationale}

            Implementation plan:

            {plan}

            Result contract:

            {verdictSchema}

            Review the plan against the handoff, the recorded user response,
            and the instruction content above. You have no repository access:
            everything you may judge is rendered here. Include a focused
            revision prompt on failure. Return only JSON matching the supplied
            result contract.
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

      <Let as="checkpointMaterial">
        ## Implementation plan

        {plan}

        ## Planner review

        Passed: {verdict.passed}

        {verdict.review}

        Revision prompt:

        {verdict.revisionPrompt}
      </Let>
      <UserCheckpoint
        purpose="resolve the plan review"
        agent={props.planner}
        material={checkpointMaterial}
        as="planCheckpoint"
      />
      <If condition={planCheckpoint.proceed}>
        <If condition={verdict.passed}>
          <Break />
          <Else>
            <Prompt>
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
  </Session>
</Agent>

<Return value={{
  plan: plan,
  verdictPassed: verdict.passed,
  review: verdict.review,
  revisionPrompt: verdict.revisionPrompt,
  decision: planCheckpoint
}} />

## Two agents, two sessions, no checkout

The implementor's `<Agent>` and `<Session>` wrap the whole loop, so the plan
prompt and the revision prompt reach the same conversation without repeating
`agent` and `session` props on each one. The planner's `<Agent>` nests inside
for the review; leaving it restores the implementor's for the revision turn.

Neither agent reads the repository. A workflow Agent gets no checkout, no
materialization of one, no Workspace or host path as its working directory, and
no directory registered with its session (#302). Both reason about the same
revision because both are handed the same values — the instruction text, the
handoff, the plan, the recorded user decision — rendered into their prompts.

`instructions` shows what that costs and what it buys: host-authored XMD file
effects produced the exact repository-relative paths and contents, and the
captured result travels as a prop into both prompts below. Evidence the stage does not receive as a value is
evidence it does not have. The bounded request/result loop that lets an agent ask
for more is shipped (#302, #549, #550), and **this stage deliberately does not
invoke it**: planning reasons over the handoff, the recorded decisions and the
instructions its caller passed, and an agent that could read the repository here
would be reviewing something other than what was handed to it. Everything in this
body runs today.

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
replay whose stored outcome or iteration count disagrees with what this
execution reached. `<Loop>` opens no binding scope, so `plan`, `verdict`, and
`planCheckpoint` hold their final values where `<Return>` reads them.

The user's decision outranks the verdict. The outer `<If>` reads
`planCheckpoint.proceed` before the inner one reads `verdict.passed`, so a
declined checkpoint leaves the loop without revising the plan and without
presenting it as reviewed — a rejection is neither a revision request nor an
acceptance. `<Break />` works from that nested position, so the two conditions
compose without a flag binding between them.

This component declares `returns`, so it contains no `<Output>` and there is no
documentation split: the whole body runs fail-fast and binds nothing if it
fails. That is what makes the bounded repair turns a real gate — `<SafeParse>`
absorbs a malformed verdict so the document can show the correction prompt, and
the final `<Parse>` ends the stage if the candidate is still invalid, rather than
returning something half-formed for a caller to branch on. `throwOnError` on each
`<Prompt>` is required for the same reason: a failed prompt without it records
its failure and returns its text, raising nothing.

**Exhaustion asks for direction.** Reaching `max` completes the loop normally —
exhaustion is not a failure and produces no diagnostic — and it is neither
convergence nor ordinary successful completion
([#290](https://github.com/taras/executable.md/issues/290), settled). The
returned pair is what makes it a distinct outcome: `decision.proceed` true with
`verdictPassed` false is exhaustion, and nothing else produces that pair. The
caller's gate refuses it, so an exhausted loop starts no implementation and no
later durable effect, and cannot be reported as convergence or success.

What the caller does with it is ask the user. An exhausted planning loop returns
to its caller for direction rather than terminating on its own account: five
rounds of evidence did not converge, and only the user decides what happens
next.

**Exhaustion is not a suspension, and this is the distinction to keep.** Every
`planCheckpoint` above is an ordinary `<Elicit>`, and under `xmd workflow` the
host's own registration suspends the run there durably (#577, shipped): one
retained request, the run settled `suspended`, the executor lock given back, and
continuation only through `xmd workflow answer` and an explicit
`xmd workflow resume`. Exhaustion happens *after* the final checkpoint has
already been answered — the user kept approving and the verdict never passed —
so there is no pending question and nothing waits. It authorizes nothing,
starts no later durable effect, and reports awaiting direction as the end of
that run. Nothing here creates a second wait to ask about it, and neither
exhaustion nor silence nor an unchanged verdict is read as approval.

Unattended continuation stays outside this composition. A continuation is an
explicit act, and #300 built the one thing a trusted host may decide about it:
*when* the ordinary resume runs.

Every `plan`, `verdict`, and `planCheckpoint` is already durable: each `<Prompt>`
is one durable operation, each `<Elicit>` answer is journaled against its
question fingerprint, and under `xmd workflow` those filtered events are retained
with the run and resumable from it (#291 and #366, shipped), and readable through
`xmd workflow history` (#367's first slice, delivered by #460), which reports
them without advancing the run. There is no `cancelled` loop outcome — run-level cancellation and stop
reasons are retained run state rather than loop state. The component creates no
handoff files either way.

Props are namespaced throughout: `agent={props.implementor}` and
`{props.instructions}` use one spelling in an expression prop and in text (#305).
`plan`, `verdict`, `verdictSchema`, `checkpointMaterial`, and `planCheckpoint`
are authored bindings and stay bare.
