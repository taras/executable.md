---
description: >-
  Send one prepared request to its retained role conversation. Use <Phase.Role role="architect"
  session="ticket-architect" assignment={prepared.assignment} />.
props:
  type: object
  properties:
    role:
      enum:
        - architect
        - planner
        - implementor
    session:
      type: string
      minLength: 1
    inputs:
      type: array
      items: {type: object}
      default: []
    correction:
      anyOf:
        - type: 'null'
        - type: object
          properties:
            schema: {const: phase-response-correction.v1}
            role: {enum: [architect, planner, implementor]}
            session: {type: string}
            provider: {enum: [claude, codex]}
            initialize: {const: false}
            phase: {enum: [discovery, implementation, review]}
            work: {type: string}
            revision: {type: string}
            assignment: {type: string}
            ordinal: {type: integer, minimum: 1, maximum: 3}
            remaining: {type: integer, minimum: 0, maximum: 2}
            raw: {type: string}
            rejectedText: {type: string}
            rejection: {type: object}
            resultSchema: {type: object}
            profile: {type: object}
            established: {type: object}
            report: {type: [string, 'null']}
            applied: {type: [object, 'null']}
            references: {type: array, items: {type: string}}
            permitted: {type: string}
          required: [schema, role, session, provider, initialize, phase, work, revision, assignment, ordinal, remaining, raw, rejectedText, rejection, resultSchema, profile, established, report, applied, references, permitted]
          additionalProperties: false
      default: null
    assignment:
      type: object
    initialize:
      type: boolean
      default: false
    implementationProvider:
      enum: [claude, codex]
      default: claude
  required:
    - role
    - session
    - assignment
  additionalProperties: false
---

<Phase.Profile role={props.role} assessment={props.assignment.assessment} implementationProvider={props.implementationProvider} as="profile" />
<If condition={props.correction !== null && (props.initialize || props.correction.role !== props.role || props.correction.session !== props.session || props.correction.revision !== props.assignment.revision || props.correction.phase !== props.assignment.phase || props.correction.work !== props.assignment.work || props.correction.provider !== profile.provider)}>
<Fail message="Response correction must select the same initialized original owner, source and routing." />
</If>
<ReviewPolicy assessment={props.assignment.assessment} kind={props.assignment.reviewKind ?? "feature"} as="policy" />
<Output><If condition={profile.provider === "claude"}><Agent name="claude"><Session name={props.session} model={profile.model} effort={profile.effort}><Prompt throwOnError={true}><If condition={props.correction === null}><Phase.Instructions inputs={props.inputs} role={props.role} assignment={props.assignment} initialize={props.initialize} /><Else><Phase.CorrectionInstructions correction={props.correction} /></Else></If></Prompt></Session></Agent><Else><Agent name="codex"><Session name={props.session} model={profile.model} effort={profile.effort}><Prompt throwOnError={true}><If condition={props.correction === null}><Phase.Instructions inputs={props.inputs} role={props.role} assignment={props.assignment} initialize={props.initialize} /><Else><Phase.CorrectionInstructions correction={props.correction} /></Else></If></Prompt></Session></Agent></Else></If></Output>
