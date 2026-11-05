---
props:
  type: object
  properties:
    record: {type: string, minLength: 1}
  required: [record]
  additionalProperties: false
---
Read a saved return after the host has joined the original entry. This reads
confirmed control metadata without advancing its successor. A saved role result,
confirmed publication and the host's joined outer outcome are separate evidence.

<Entry.Return record={props.record} as="work" />
<Output><Json value={work} /></Output>
