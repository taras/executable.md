---
description: >-
  Prepare a phase and run its nested continuation. Use <Phase.Preparation from={phase}
  target="review" as="prepared">…</Phase.Preparation>. The next request is the preceding result’s
  handoff verbatim.
props:
  type: object
  properties:
    assessment: {type: object}
    reviewKind: {enum: [feature, correction], default: feature}
    phase:
      enum:
        - discovery
        - implementation
        - review
    recipient:
      anyOf:
        - enum: [architect, planner, implementor]
        - type: 'null'
      default: null
    continuation:
      anyOf:
        - type: object
        - type: 'null'
      default: null
    work:
      type: string
      minLength: 1
    repository:
      type: string
      pattern: ^/
    revision:
      type: string
      pattern: '^[0-9a-f]{40}$'
    priorRevision:
      anyOf:
        - type: string
          pattern: '^[0-9a-f]{40}$'
        - type: 'null'
    request:
      type: string
      minLength: 1
    changedPaths:
      type: array
      items:
        type: string
        minLength: 1
    artifacts:
      type: array
      items:
        type: string
        minLength: 1
    evidence:
      type: array
      items:
        type: object
        properties:
          revision:
            anyOf:
              - type: string
                pattern: '^[0-9a-f]{40}$'
              - type: 'null'
          command:
            type: string
            minLength: 1
          outcome:
            enum:
              - passed
              - failed
              - not_run
          artifact:
            type: string
            minLength: 1
          candidate:
            type: string
            minLength: 1
        required:
          - revision
          - command
          - outcome
          - artifact
        additionalProperties: false
    findings:
      type: array
      items:
        type: string
        minLength: 1
    issue:
      anyOf:
        - type: object
          properties:
            url:
              type: string
              minLength: 1
            title:
              type: string
              minLength: 1
            description:
              type: string
            tags:
              type: array
              items:
                type: string
                minLength: 1
            assignee:
              type:
                - string
                - 'null'
          required:
            - url
            - title
            - description
            - tags
            - assignee
          additionalProperties: false
        - type: 'null'
    from:
      type: object
      properties:
        assignment:
          type: object
        result:
          type: object
        next:
          type: object
      required:
        - assignment
        - result
        - next
      additionalProperties: false
    target:
      enum:
        - discovery
        - implementation
        - review
    contract:
      anyOf:
        - type: object
          properties:
            work:
              type: string
              minLength: 1
            sourceRevision:
              type: string
              pattern: '^[0-9a-f]{40}$'
            scope:
              type: string
              minLength: 1
            sections:
              type: array
              items:
                type: object
                properties:
                  path:
                    type: string
                    minLength: 1
                  heading:
                    type: string
                    minLength: 1
                  relevance:
                    type: string
                    minLength: 1
                  requirements:
                    type: array
                    minItems: 1
                    items:
                      type: string
                      minLength: 1
                required:
                  - path
                  - heading
                  - relevance
                  - requirements
                additionalProperties: false
          required:
            - work
            - sourceRevision
            - scope
            - sections
          additionalProperties: false
        - type: 'null'
  additionalProperties: false
  oneOf:
    - required:
        - phase
        - work
        - repository
        - revision
        - request
      not:
        anyOf:
          - required:
              - from
            properties:
              from: {}
          - required:
              - target
            properties:
              target: {}
      properties:
        phase: {}
        work: {}
        repository: {}
        revision: {}
        request: {}
    - required:
        - from
        - target
      not:
        anyOf:
          - required:
              - phase
            properties:
              phase: {}
          - required:
              - work
            properties:
              work: {}
          - required:
              - repository
            properties:
              repository: {}
          - required:
              - revision
            properties:
              revision: {}
          - required:
              - priorRevision
            properties:
              priorRevision: {}
          - required:
              - request
            properties:
              request: {}
          - required:
              - changedPaths
            properties:
              changedPaths: {}
          - required:
              - artifacts
            properties:
              artifacts: {}
          - required:
              - evidence
            properties:
              evidence: {}
          - required:
              - findings
            properties:
              findings: {}
          - required:
              - issue
            properties:
              issue: {}
          - required:
              - contract
            properties:
              contract: {}
      properties:
        from: {}
        target: {}
returns:
  type: object
---

<If condition={props.from === undefined}>
<Phase.Checkout phase={props.phase} work={props.work} repository={props.repository} revision={props.revision} request={props.request} priorRevision={props.priorRevision ?? null} changedPaths={props.changedPaths ?? []} artifacts={props.artifacts ?? []} evidence={props.evidence ?? []} findings={props.findings ?? []} issue={props.issue ?? null} contract={props.contract ?? null} assessment={props.assessment} reviewKind={props.reviewKind} recipient={props.recipient} continuation={props.continuation} as="_phasePrepared" />
<Let as="phase" value={{assignment: _phasePrepared.assignment, result: null, next: {phase: "preparation", target: _phasePrepared.assignment.phase, work: _phasePrepared.assignment.work, revision: _phasePrepared.assignment.revision, request: _phasePrepared.assignment.request, role: _phasePrepared.assignment.recipient}}} />
<Content />
<Return value={_phasePrepared} />
</If>
<If condition={props.from !== undefined}>
<Phase.Schema as="_phaseSchemas" />
<Parse schema={_phaseSchemas.assignment} as="_phasePrevious"><Json value={props.from.assignment} /></Parse>
<Json value={props.from.result} as="_phaseReply" />
<Phase.Accept assignment={_phasePrevious} text={_phaseReply} as="_phaseResult" />
<Phase.Next result={_phaseResult} successor={props.target} role={props.from.next.role} as="_phaseNext" />
<If condition={_phaseNext.phase !== "preparation" || _phaseNext.target !== props.target}>
<Fail message="The result does not route to this preparation target. Preserve the result and follow its selected phase or hold." />
</If>
<If condition={props.from.next.phase !== _phaseNext.phase || props.from.next.target !== _phaseNext.target || props.from.next.work !== _phaseNext.work || props.from.next.revision !== _phaseNext.revision || props.from.next.request !== _phaseNext.request || props.from.next.role !== _phaseNext.role}>
<Fail message="The requested preparation differs from the recorded next gate. Preserve the phase record and resolve the gate before continuing." />
</If>
<If condition={_phaseResult.revision === null}>
<Fail message="Preparation needs an exact source revision. Preserve the result and resolve the missing revision before continuing." />
</If>
<Phase.Checkout phase={props.target} work={_phaseResult.work} repository={_phasePrevious.repository} revision={_phaseResult.revision} request={_phaseResult.handoff} priorRevision={_phasePrevious.revision} changedPaths={_phasePrevious.changedPaths} artifacts={_phaseResult.artifacts} evidence={_phaseResult.evidence} findings={_phaseResult.findings} issue={_phasePrevious.issue} contract={_phaseResult.contract ?? _phasePrevious.contract} assessment={_phaseResult.assessment ?? _phasePrevious.assessment} reviewKind={_phasePrevious.reviewKind} recipient={_phaseNext.role} as="_phasePrepared" />
<Let as="_phasePrepared" value={{..._phasePrepared,assignment:{..._phasePrepared.assignment,handoffInputs:_phaseResult.handoffInputs ?? []}}} />
<Let as="phase" value={{assignment: _phasePrepared.assignment, result: _phaseResult, next: _phaseNext}} />
<Content />
<Return value={_phasePrepared} />
</If>
