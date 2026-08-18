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

<Agent name={props.agent}>
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

This checkpoint registers no directory with its agent. It assesses supplied
material and needs no repository access, so no `<Agent.AddDir>` appears here —
a read-only agent with nothing registered is the narrowest thing this workflow
can ask for.

`material` could equally be projected content: `<Content />` is substituted
wherever a body writes it, including nested inside a `<Prompt>`
([#328](https://github.com/taras/executable.md/issues/328), fixed). It stays a
declared prop because a stage's inputs are part of its contract and the schema
validates them, and because every caller here already holds the material as a
binding rather than writing it as prose.

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
rendered message, so a resumed execution restores the answer instead of asking
twice and refuses a recorded answer whose question does not match. A document
that already knows the answer — a test, a demo, a non-interactive region — wraps
this component in an `<Answers>` region and supplies it with `<Answer>` matchers,
which changes who answers without changing this file.

Under `xmd workflow` this stays an `<Elicit>`. The workflow host installs the
same WebForm provider `xmd run` does, so an unanswered question opens a loopback
browser form and blocks the run: it stays `running`, publishes no validated
answer and no suspension request, never settles `suspended`, and never gives the
executor lock back. The `<Answers>` region above is how a document answers it
without a person. A resume restores a journaled answer rather than asking again
(#366).

The durable wait this checkpoint is eventually meant to become is a different
mechanism, and its substrate is shipped: `suspendFor()` records a pending
request, gives the executor lock back, and lets `xmd workflow resume <run-id>`
continue once an answer is available (#367), with the ownership that decides who
may continue (#466) and typed delivery of that answer (#300) alongside it.

This component does not call it. `suspendFor()` is an Api operation with no v1
Markdown element, and nothing here converts an `<Elicit>` into one — so no
checkpoint releases the executor today, delivery executes nothing, and nothing
schedules a resume. Consuming that substrate is #301's supervised composition.

`<SafeParse>` exposes validation failures as data so the document can show the
repair turn explicitly. It absorbs JSON syntax and schema-validation failures
and nothing else: an unusable schema still fails, and a child execution failure
propagates unchanged. Its failure shape is `{ ok: false, input, errors }` and
preserves the rendered input exactly, which is what lets the correction prompt
quote what the agent actually said. The final `<Parse>` prevents the workflow
from continuing after the bounded repair loop with malformed output. The schema
is ordinary captured document content rather than a registry entry or
`<Prompt schema>` prop.

Props are namespaced: `<Agent name={props.agent}>` and `{props.purpose}` use the
same spelling, in an expression prop and in text (#305). The bare bindings here —
`assessmentSchema`, `candidate`, `parsed`, `assessment`, `decision` — are
authored captures and parses, which stay bare.

This component runs today.
