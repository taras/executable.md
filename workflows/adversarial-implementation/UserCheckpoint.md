---
inputs:
  type: object
  properties:
    purpose:
      type: string
    agent:
      type: string
  required:
    - purpose
    - agent
  additionalProperties: false
---

# User Checkpoint

This authored component asks its supplied agent whether a transition contains a
material choice. It obtains the user's answer when needed; it never resolves
that choice on the user's behalf.

## Target shape

<Capture as="assessmentSchema" select="code[lang=json]">

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "requiresUser": { "type": "boolean" },
    "assessment": { "type": "string" },
    "question": { "type": "string" },
    "options": {
      "type": "array",
      "items": { "type": "string" }
    },
    "recommendation": { "type": "string" }
  },
  "required": [
    "requiresUser",
    "assessment",
    "question",
    "options",
    "recommendation"
  ],
  "additionalProperties": false
}
```

</Capture>

<Capture as="elicitationSchema" select="code[lang=json]">
```json
{
  "type": "object",
  "properties": {
    "proceed": {
      "type": "boolean",
      "title": "Continue the workflow"
    },
    "response": { "type": "string" },
    "rationale": { "type": "string" }
  },
  "required": ["proceed", "response", "rationale"],
  "additionalProperties": false
}
```
</Capture>

<Agent name={props.agent}>
  <Session name="user-checkpoint">
    <Prompt as="candidate" throwOnError>
      Determine whether the user must be involved to {props.purpose}.

      Material to assess:

      <Content />

      Result contract:

      {assessmentSchema}

      Require user involvement for choices affecting behavior, scope,
      architecture, risk, pull-request decomposition or sequencing, and lasting
      constraints. Do not require it for reversible implementation details
      within an already authorized plan. If uncertain, require verification.

      Explain the material choice, viable options, consequences, evidence, and
      recommendation. Do not choose for the user. Return only JSON matching the
      supplied result contract. When involvement is unnecessary, return an
      empty question and options list.
    </Prompt>

    <Loop max={2}>
      <SafeParse schema={assessmentSchema} as="parsed">
        {candidate}
      </SafeParse>

      <If condition={parsed.ok}>
        <Break />
        <Else>
          <Prompt as="candidate" throwOnError>
            Correct your previous response without changing its meaning.
            Do not use tools or perform additional analysis.

            Previous response:

            {candidate}

            Validation errors:

            <Each in={parsed.errors} let="error">
            - {error.instancePath}: {error.message}
            </Each>

            Result contract:

            {assessmentSchema}

            Return only corrected JSON matching the supplied result contract.
          </Prompt>
        </Else>
      </If>
    </Loop>

    <Parse schema={assessmentSchema} as="assessment">
      {candidate}
    </Parse>
  </Session>
</Agent>

<If condition={assessment.requiresUser}>
  <Elicit schema={elicitationSchema} as="elicitation">
    {assessment.question}

    Options:

    <Each in={assessment.options} let="option">
    - {option}
    </Each>

    Recommendation: {assessment.recommendation}
  </Elicit>
</If>

<Output>
## User involvement assessment

{assessment.assessment}

Recommendation: {assessment.recommendation}

<If condition={assessment.requiresUser}>
Question: {assessment.question}

Options:

<Each in={assessment.options} let="option">
- {option}
</Each>

## User response

Proceed: {elicitation.proceed}

Response: {elicitation.response}

Rationale: {elicitation.rationale}
</If>
</Output>

`UserInvolvementAssessment` distinguishes whether involvement is required from
the choice itself. The caller renders the complete material to assess as child
content rather than asking the agent to locate or read it. `<Elicit>` only
transports and records a response as a runtime primitive. During the manual
exercise an explicit user-run step records that response in run history;
runtime input can implement the same narrow contract later.

`<SafeParse>` exposes validation failures as data so the document can show the
repair turn explicitly. The final `<Parse>` prevents the workflow from
continuing after the bounded repair loop with malformed output. The schema is
ordinary captured document content rather than a registry entry or
`<Prompt schema>` prop.
