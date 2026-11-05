---
props:
  type: object
  properties:
    repository: {type: string}
    document: {type: object}
  required: [repository, document]
  additionalProperties: false
returns: {type: object}
---
<Dir path={props.document.snapshot.slice(0,props.document.snapshot.lastIndexOf("/")) || "/"}>
<Ticket.CheckText repository={props.repository} document={props.document} as="hydrated"><Ticket.Finite><File path={props.document.snapshot.slice(props.document.snapshot.lastIndexOf("/") + 1)} /></Ticket.Finite></Ticket.CheckText>
</Dir>
<Return value={hydrated} />
