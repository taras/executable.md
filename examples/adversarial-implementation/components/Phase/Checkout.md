---
description: >-
  Check one prepared assignment against its checkout HEAD. Use <Phase.Checkout phase="review"
  work="ticket" repository="/path/to/worktree" revision="FULL_SHA" request="Review this commit."
  as="prepared" />.
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
      default: null
    request:
      type: string
      minLength: 1
    changedPaths:
      type: array
      items:
        type: string
        minLength: 1
      default: []
    artifacts:
      type: array
      items:
        type: string
        minLength: 1
      default: []
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
      default: []
    findings:
      type: array
      items:
        type: string
        minLength: 1
      default: []
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
      default: null
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
      default: null
  required:
    - phase
    - work
    - repository
    - revision
    - request
  additionalProperties: false
returns:
  type: object
---

<Phase.Schema as="schemas" />
<Parse schema={schemas.assignment} as="assignment"><Json value={props} /></Parse>
<If condition={assignment.contract !== null && assignment.contract.work !== assignment.work}>
<Fail message="The contract packet belongs to another work item. Prepare the correct ticket context before continuing." />
</If>
<Dir path={assignment.repository}>
```bash exec as="observed"
git rev-parse --verify HEAD
```
<If condition={observed.exitCode !== 0}>
<Fail message="Git did not establish the checkout HEAD. Preserve its first error before another preparation attempt." />
</If>
<If condition={observed.stdout.trim() !== assignment.revision}>
<Fail message="The checkout HEAD differs from the requested revision. Preserve the checkout and prepare an assignment for its actual state." />
</If>
<Return value={{ phase: "preparation", target: assignment.phase, assignment }} />
</Dir>
