---
inputs:
  type: object
  properties:
    planResult:
      type: string
    authorizationGate:
      type: string
    instructionPaths:
      type: array
      items:
        type: string
    planner:
      type: string
    implementor:
      type: string
  required:
    - planResult
    - authorizationGate
    - instructionPaths
    - planner
    - implementor
  additionalProperties: false
---

# Implementation and Pull-Request Review

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

<Loop name="implementation-review" max={5}>
  <Agent name={props.implementor}>
    <Session name="implementor">
      <Prompt as="implementationCandidate" throwOnError>
        Repository instructions:

        <InstructionFiles paths={props.instructionPaths} />

        Authorized plan:

        {props.planResult}

        Authorization record:

        {props.authorizationGate}

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

  <File path="implementation-result.md">
    # Implementation result

    ## Changed files

    <Each in={implementation.changedFiles} let="changedFile">
    - {changedFile}
    </Each>

    ## Report

    {implementation.report}
  </File>

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

  <Agent name={props.planner}>
    <Session name="planner">
      <Prompt as="verdictCandidate" throwOnError>
        Repository instructions:

        <InstructionFiles paths={props.instructionPaths} />

        Authorized plan:

        {props.planResult}

        Authorization record:

        {props.authorizationGate}

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
  <File path="planner-pull-request-review.md">
    # Pull-request verdict

    Passed: {verdict.passed}

    {verdict.review}

    ## Findings

    <Each in={verdict.findings} let="finding">
    ### {finding.title}

    Disposition: {finding.disposition}

    {finding.description}
    </Each>

    ## Revision prompt

    {verdict.revisionPrompt}
  </File>

  <Each in={verdict.findings} let="finding">
    <If condition={finding.disposition === "defer"}>
      <Issue
        pullRequest={pullRequest}
        finding={finding}
      />
    </If>
  </Each>

  <File path="review-user-gate.md" as="reviewGate">
    <UserGate purpose="resolve the pull-request review"
      agent={props.planner}>
      ## Authorized plan

      {props.planResult}

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
    </UserGate>
  </File>
  <If condition={verdict.passed}>
    <Break />
    <Else>
      <Prompt agent={props.implementor} session="implementor">
        Revise the implementation using this review:

        {verdict.review}

        Focused revision prompt:

        {verdict.revisionPrompt}

        User involvement record:

        {reviewGate}
      </Prompt>
    </Else>
  </If>
</Loop>

<File
  path="implementation-review-result.md"
  as="implementationReviewResult"
>
  # Implementation review result

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
</File>

<Output>{implementationReviewResult}</Output>

## Finding dispositions

1. Fix in the current pull request.
2. Insert a focused repair needed by the remaining pull-request chain.
3. Create a provenance-linked issue when immediate work would derail the chain.
4. Reject an unsupported, unrelated, or intentionally excluded finding.

The planner proposes a disposition and asks the user when scope, urgency, or
impact remains uncertain. The user makes the final decision.
