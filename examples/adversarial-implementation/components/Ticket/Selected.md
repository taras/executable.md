---
props:
  type: object
  properties:
    repository: {type: string}
    documents: {type: object}
  required: [repository, documents]
  additionalProperties: false
returns: {type: object}
---
<Let as="selected" value={{}} />
<Let as="paths" value={Object.keys(props.documents)} />
<Let as="index" value={0} />
<If condition={paths.length !== 0}>
<Loop max={paths.length}>
<Let as="path" value={paths[index]} />
<Ticket.Hydrate repository={props.repository} document={props.documents[path]} as="text" />
<Let as="selected" value={{...selected,[path]:text}} />
<Let as="index" value={index + 1} />
</Loop>
</If>
<Return value={selected} />
