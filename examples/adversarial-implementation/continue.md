---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
    steps: {type: integer, minimum: 1, default: 1}
    implementationModel: {type: string, minLength: 1}
    implementationModelEvidence: {type: string, pattern: '^/'}
  required: [record]
  additionalProperties: false
---
<Entry.Continue record={props.record} steps={props.steps} implementationModel={props.implementationModel} implementationModelEvidence={props.implementationModelEvidence} as="work" />
<Output><Json value={work} /></Output>
