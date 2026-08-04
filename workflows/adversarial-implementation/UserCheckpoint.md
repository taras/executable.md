---
required: [purpose, agent, material]

props:
  purpose: { type: string }
  agent: { type: string }
  material: { type: string }

returns:
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
---

# User Checkpoint

This authored component asks its supplied agent whether a transition contains a
material choice. It obtains the user's answer when needed; it never resolves
that choice on the user's behalf.

It is a **value component**: it declares `returns`, renders nothing, and must be
invoked with `as`. What it binds is a schema-validated transition decision, so a
caller gates on `checkpoint.proceed` rather than reading prose. `proceed: false`
never advances the workflow. The human-readable material travels in the same
value — `assessment`, `recommendation`, `question`, `options`, `response`, and
`rationale` — so a later prompt interpolates exactly the fields it needs.

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

<Capture as="decisionSchema" select="code[lang=json]">
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
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

<Agent name={agent}>
  <Session name="user-checkpoint">
    <Prompt as="candidate" throwOnError>
      Determine whether the user must be involved to {props.purpose}.

      Material to assess:

      {props.material}

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
  <Elicit schema={decisionSchema} as="decision">
    {assessment.question}

    Options:

    <Each in={assessment.options} let="option">
    - {option}
    </Each>

    Recommendation: {assessment.recommendation}
  </Elicit>
  <Else>
    <Parse schema={decisionSchema} as="decision">
    {"proceed": true, "response": "continue", "rationale": "The assessing agent found no material choice, so this transition needs no user decision."}
    </Parse>
  </Else>
</If>

<Return value={{requiresUser: assessment.requiresUser, proceed: decision.proceed, assessment: assessment.assessment, recommendation: assessment.recommendation, question: assessment.question, options: assessment.options, response: decision.response, rationale: decision.rationale}} />

## Continuation is represented, never inferred

Both branches bind `decision` against the same `decisionSchema`, so `proceed` is
always a validated boolean that some path explicitly produced. When the agent
reports no material choice, the `<Else>` branch parses an explicit
`"proceed": true` with the reason recorded. Nothing reads a missing elicitation
as consent, which is what keeps #290's "cannot become implicit approval"
requirement intact: a transition advances because a decision said so, not
because no decision was found.

`UserInvolvementAssessment` distinguishes whether involvement is required from
the choice itself. The caller passes the complete material to assess as the
`material` prop rather than asking the agent to locate or read it.

**Missing: projecting the material as content.** `material` would read better as
`<Content />` — the caller writing the material as children — but `<Content />`
is substituted only at a body's top level or directly inside `<Output>`, never
nested inside a `<Prompt>` where this component needs it
([issue #328](https://github.com/taras/executable.md/issues/328)). A prop
interpolates anywhere, so that is what this component takes until #328 lands.

`<Elicit>` asks without choosing how. It requires `schema` and `as`, compiles
the schema before its content expands, renders that content as the request
message, and validates the provider's answer against the same compiled schema
before binding it. There is no `mode`, `provider`, or `uiSchema` prop and no
built-in approve, decline, or cancel — `decisionSchema` above defines every
response available, and `proceed` is a field the author declared rather than a
built-in verb. Where the asking happens is the host's decision, made through the
Elicitation Api: `xmd run` composes WebForm as its current provider, so this
checkpoint opens a loopback browser form under the CLI. Only the validated
answer is journaled, keyed by a fingerprint of the compiled schema and the
rendered message, so a resumed run restores the answer instead of asking twice
and refuses a recorded answer whose question does not match. A document that
already knows the answer — a test, a demo, a non-interactive region — wraps this
component in an `<Answers>` region and supplies it with `<Answer>` matchers,
which changes who answers without changing this file.

What `<Elicit>` does not solve is stopping between processes. It answers a
question inside one run; selecting and resuming a stopped stage in a later
invocation is cross-process continuation, which belongs to `<Stage>` and
`<Workflow>` (#298, #289) and does not exist yet.

`<SafeParse>` exposes validation failures as data so the document can show the
repair turn explicitly. It absorbs JSON syntax and schema-validation failures
and nothing else: an unusable schema still fails, and a child execution failure
propagates unchanged. Its failure shape is `{ ok: false, input, errors }` and
preserves the rendered input exactly, which is what lets the correction prompt
quote what the agent actually said. The final `<Parse>` prevents the workflow
from continuing after the bounded repair loop with malformed output. The schema
is ordinary captured document content rather than a registry entry or
`<Prompt schema>` prop.

`<Agent name={agent}>` reads the bare binding because that is the expression-
prop spelling current main supports, while `{props.purpose}` in the prompt body
is text interpolation; #305 unifies the two.

This component runs today.
