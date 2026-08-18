---
required: [handoff, handoffCheckpoint, instructions, planner, implementor, worktree]

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
  worktree: { type: string }

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
impose: planning produces a plan, not a change. What the stage does have to do
is give each agent the checkout to reason about, which is `<Agent.AddDir>`.

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

<Agent name={props.implementor}>
  <Session name="implementor">
    <Agent.AddDir path={props.worktree} />

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

        Investigate the registered checkout. Confirm, refute, or amend the
        implementation theory with evidence. You cannot modify anything, and
        this stage produces no change. Return a concrete implementation plan
        with the evidence, validation, effects, and pull-request boundaries
        described by this workflow.
      </Prompt>

      <Agent name={props.planner}>
        <Session name="planner">
          <Agent.AddDir path={props.worktree} />

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

## Two agents, two sessions, one checkout

The implementor's `<Agent>` and `<Session>` wrap the whole loop, so the plan
prompt and the revision prompt reach the same conversation without repeating
`agent` and `session` props on each one. The planner's `<Agent>` nests inside
for the review and gives that session its own registration; leaving it restores
the implementor's for the revision turn.

`<Agent.AddDir>` registers a read-only Workspace path with its enclosing Agent
session (#302). Registration is what grants an agent access — the lexical cwd the
enclosing `<Worktree>` established governs where XMD's own file operations
resolve and registers nothing. Both agents read the same checkout because both
are reasoning about the same revision, and neither can write to it under
`xmd workflow`. `<Agent.AddDir>` does not exist yet, and its exact placement
relative to `<Session>` is #302's to settle; everything else in this body runs
today.

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
next. Under a composed workflow that request is meant to become a durable
suspension — the run recording why it stopped and the material the user needs,
giving its executor lock back, and resuming only from explicit user direction.

The substrate exists: `suspendFor()` suspends and releases the lock (#367), and
a typed answer can be delivered to the waiting run (#300). It is an Api
operation with no v1 Markdown element, and this stage calls nothing that
suspends, so today the request is reported rather than waited on. Either way
neither exhaustion nor silence nor an unchanged verdict is read as approval, and
the boundary this document owns holds.

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
