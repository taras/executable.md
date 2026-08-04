---
required: [plan, authorization, instructions, planner, implementor]

props:
  plan: { type: string }
  authorization:
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
  report: { type: string }
  verdictPassed: { type: boolean }
  review: { type: string }
  revisionPrompt: { type: string }
  findings:
    type: array
    items:
      type: object
      properties:
        disposition: { type: string }
        title: { type: string }
        description: { type: string }
        evidence:
          type: array
          items:
            type: string
      required: [disposition, title, description, evidence]
      additionalProperties: false
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

# Implementation

Implementation begins only after the user authorizes the converged plan. The
implementor edits worktree files; deterministic operations own Git metadata and
remote effects.

## Target shape

<Capture as="implementationSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "changedFiles": {
      "type": "array",
      "items": { "type": "string" }
    },
    "commitMessage": { "type": "string", "minLength": 1 },
    "report": { "type": "string" }
  },
  "required": ["changedFiles", "commitMessage", "report"],
  "additionalProperties": false
}
```
</Capture>

<Capture as="pullRequestVerdictSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "passed": { "type": "boolean" },
    "review": { "type": "string" },
    "revisionPrompt": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "disposition": {
            "type": "string",
            "enum": ["fix", "insert-repair", "defer", "reject"]
          },
          "title": { "type": "string" },
          "description": { "type": "string" },
          "evidence": {
            "type": "array",
            "items": { "type": "string" }
          }
        },
        "required": [
          "disposition",
          "title",
          "description",
          "evidence"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": ["passed", "review", "revisionPrompt", "findings"],
  "additionalProperties": false
}
```
</Capture>

<Loop name="implementation" max={5}>
  <Agent name={implementor}>
    <Session name="implementor">
      <Prompt as="implementationCandidate" throwOnError>
        Repository instructions:

        {props.instructions}

        Authorized plan:

        {props.plan}

        Authorization record:

        {props.authorization.assessment}
        User response: {props.authorization.response}
        Rationale: {props.authorization.rationale}

        Result contract:

        {implementationSchema}

        Implement the authorized plan in the current working directory. Report
        changed files, validation, and newly discovered scope. Do not modify
        shared Git metadata. Return only JSON matching the supplied result
        contract.
      </Prompt>

      <Loop max={2}>
        <SafeParse schema={implementationSchema} as="parsedImplementation">
          {implementationCandidate}
        </SafeParse>

        <If condition={parsedImplementation.ok}>
          <Break />
          <Else>
            <Prompt as="implementationCandidate" throwOnError>
              Correct your previous response without changing its meaning.
              Do not use tools, modify files, or perform additional analysis.

              Previous response:

              {implementationCandidate}

              Validation errors:

              <Each in={parsedImplementation.errors} let="error">
              - {error.instancePath}: {error.message}
              </Each>

              Result contract:

              {implementationSchema}

              Return only corrected JSON.
            </Prompt>
          </Else>
        </If>
      </Loop>

      <Parse schema={implementationSchema} as="implementation">
        {implementationCandidate}
      </Parse>
    </Session>
  </Agent>

  <Commit
    paths={implementation.changedFiles}
    message={implementation.commitMessage}
    as="commit"
  />
  <PullRequest
    commit={commit}
    draft
    as="pullRequest"
  />

  <Agent name={planner}>
    <Session name="planner">
      <Prompt as="verdictCandidate" throwOnError>
        Repository instructions:

        {props.instructions}

        Authorized plan:

        {props.plan}

        Authorization record:

        {props.authorization.assessment}
        User response: {props.authorization.response}
        Rationale: {props.authorization.rationale}

        Pull request:

        #{pullRequest.number} ({pullRequest.state}) {pullRequest.url}
        head {pullRequest.headSha} onto base {pullRequest.baseSha}

        Result contract:

        {pullRequestVerdictSchema}

        Review the pull request against the authorized plan and instruction
        content above. Classify every finding and include a focused revision
        prompt when the review fails. Return only JSON matching the supplied
        result contract.
      </Prompt>

      <Loop max={2}>
        <SafeParse schema={pullRequestVerdictSchema} as="parsedVerdict">
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

              {pullRequestVerdictSchema}

              Return only corrected JSON.
            </Prompt>
          </Else>
        </If>
      </Loop>

      <Parse schema={pullRequestVerdictSchema} as="verdict">
        {verdictCandidate}
      </Parse>
    </Session>
  </Agent>

  <Capture as="checkpointMaterial">
    ## Authorized plan

    {props.plan}

    ## Pull request

    #{pullRequest.number} ({pullRequest.state}) {pullRequest.url}
    head {pullRequest.headSha} onto base {pullRequest.baseSha}

    ## Planner review

    Passed: {verdict.passed}

    {verdict.review}

    <Each in={verdict.findings} let="finding">
    ### {finding.title}

    Disposition: {finding.disposition}

    {finding.description}
    </Each>
  </Capture>
  <UserCheckpoint
    purpose="resolve the pull-request review"
    agent={planner}
    material={checkpointMaterial}
    as="reviewCheckpoint"
  />
  <If condition={reviewCheckpoint.proceed}>
    <Each in={verdict.findings} let="finding">
      <If condition={finding.disposition === "defer"}>
        <Issue
          pullRequest={pullRequest}
          finding={finding}
        />
      </If>
    </Each>
    <If condition={verdict.passed}>
      <Break />
      <Else>
        <Prompt agent={implementor} session="implementor">
          Revise the implementation using this review:

          {verdict.review}

          Focused revision prompt:

          {verdict.revisionPrompt}

          User involvement record:

          {reviewCheckpoint.assessment}
          User response: {reviewCheckpoint.response}
          Rationale: {reviewCheckpoint.rationale}
        </Prompt>
      </Else>
    </If>
    <Else>
      <Break />
    </Else>
  </If>
</Loop>

<Return value={{
  report: checkpointMaterial,
  verdictPassed: verdict.passed,
  review: verdict.review,
  revisionPrompt: verdict.revisionPrompt,
  findings: verdict.findings,
  decision: reviewCheckpoint
}} />

## The stage returns its control state

Like `Planning`, this is a **value component**: it resolves a user decision
internally, so it returns that decision rather than a rendering of it. It hands
back the complete `reviewCheckpoint` decision and the parsed verdict's fields,
and nothing derived from them. The caller reads
`decision.proceed && verdictPassed` directly, so there is no second copy of that
answer to disagree with the first.

The pull-request handle is **not** returned. `<PullRequest>` (#295) resolves a
structured handle carrying the number, URL, head and base identities, state,
reviews, comments, and checks, and `start.md` consumes none of it — the artifact
ledger (#291) records the effect and its handle independently. The `report`
above renders the specific fields a reader needs. A return field typed `string`
would be worse than useless here: a conforming `<PullRequest>` would perform its
durable effects and only then fail this component's return validation. If a
later caller genuinely needs the handle, it is added with #295's object schema,
never a placeholder.

The agent, parsing, and control-flow syntax runs today. A value component's body
runs fail-fast, so the final `<Parse>` in each repair loop ends the stage rather
than passing malformed data to a durable effect.

The user's decision outranks the verdict here too. `reviewCheckpoint.proceed` is
read before `verdict.passed`, so a declined pull-request review leaves the loop
without revising the implementation and without reporting it as reviewed. The
stage is reached at all only because `start.md` gated it on
`planning.decision.proceed && planning.verdictPassed` and then on
`authorization.proceed`.

After the loop, `decision.proceed` true with `verdictPassed` false is what
exhaustion looks like: the user kept approving and the verdict never passed. The
caller's gate rejects that pair, so an exhausted review cannot reach acceptance.
What the workflow should ultimately do about it stays unresolved under #290.

## Approval precedes durable effects

Deferred `<Issue>` creation sits **inside** the approved branch, after the
checkpoint. The planner proposes a disposition; the user's approval is what
turns that proposal into a durable GitHub object. Creating the issues first
would make the planner's classification take effect before anyone approved it,
and an issue is not undone by a later decline.

`proceed: true` authorizes the exact transition and the exact effects proposed
in the material the checkpoint assessed — here, an `<Issue>` for every finding
the verdict marked `defer`. It is not an invitation to amend them. The free-text
`response` and `rationale` are a record of the user's reasoning, and nothing
reads them to change which effects run: an effect that already executed cannot
be silently amended by prose. A user who wants different effects declines, and
`proceed: false` performs none of them — no issue, no revision turn, no
acceptance.

`<Commit>` (#294), `<PullRequest>` (#295), and `<Issue>` (#296) do not exist,
and reconciling those durable GitHub effects idempotently is #297. Until they
land, the loop above cannot expand at all — the three names resolve to nothing,
which is the unresolved printed error, so the missing capability is inside the
stage rather than only around it. The effects they stand for remain explicit
user-run steps between manual stages.

The surrounding workflow will record each parsed implementation result, commit
and pull-request handle, planner verdict, and user-checkpoint result as artifact
versions (#291). Only implementation source files are written into the worktree.

`<Agent name={implementor}>`, `agent={planner}` and the other expression props
read bare bindings; the prompt bodies interpolate `{props.plan}` and
`{props.instructions}`. #305 unifies the two spellings.

## Finding dispositions

1. Fix in the current pull request.
2. Insert a focused repair needed by the remaining pull-request chain.
3. Create a provenance-linked issue when immediate work would derail the chain.
4. Reject an unsupported, unrelated, or intentionally excluded finding.

The planner proposes a disposition and asks the user when scope, urgency, or
impact remains uncertain. The user makes the final decision.
