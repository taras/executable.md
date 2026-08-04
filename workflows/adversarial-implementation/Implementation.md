---
required: [plan, authorization, instructions, planner, implementor]

props:
  plan: { type: string }
  authorization: { type: string }
  instructions: { type: string }
  planner: { type: string }
  implementor: { type: string }
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

        {props.authorization}

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

        {props.authorization}

        Pull request:

        {pullRequest}

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

  <Each in={verdict.findings} let="finding">
    <If condition={finding.disposition === "defer"}>
      <Issue
        pullRequest={pullRequest}
        finding={finding}
      />
    </If>
  </Each>

  <UserCheckpoint
    purpose="resolve the pull-request review"
    agent={planner}
    as="reviewCheckpoint"
  >
    ## Authorized plan

    {props.plan}

    ## Pull request

    {pullRequest}

    ## Planner review

    Passed: {verdict.passed}

    {verdict.review}

    <Each in={verdict.findings} let="finding">
    ### {finding.title}

    Disposition: {finding.disposition}

    {finding.description}
    </Each>
  </UserCheckpoint>
  <If condition={verdict.passed}>
    <Break />
    <Else>
      <Prompt agent={implementor} session="implementor">
        Revise the implementation using this review:

        {verdict.review}

        Focused revision prompt:

        {verdict.revisionPrompt}

        User involvement record:

        {reviewCheckpoint}
      </Prompt>
    </Else>
  </If>
</Loop>

<Output>
  # Implementation result

  ## Pull request

  {pullRequest}

  ## Planner review

  Passed: {verdict.passed}

  {verdict.review}

  ## Findings

  <Each in={verdict.findings} let="finding">
  ### {finding.title}

  Disposition: {finding.disposition}

  {finding.description}
  </Each>
</Output>

The agent, parsing, and control-flow syntax in this component runs today, on
the same terms as `Planning`: the body outside `<Output>` runs under the
`throw` error mode, so the final `<Parse>` in each repair loop ends the stage
rather than passing malformed data to a durable effect.

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
