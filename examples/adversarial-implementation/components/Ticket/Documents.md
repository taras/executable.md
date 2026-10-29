---
description: >-
  Capture new referenced text and reuse recorded documents. Use <Ticket.Documents
  repository={repository} paths={references} documents={documents} as="documents" />.
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    paths: {type: array, items: {type: string, minLength: 1}}
    documents: {type: object, default: {}}
  required: [repository, paths]
  additionalProperties: false
returns: {type: object}
---

A reference keeps its first recorded text. Reuse that reference for the same
input; return a new artifact path when a later phase produces different evidence.
Paths that are relative to the assignment resolve in its selected repository.

<Let as="documents" value={props.documents} />
<Let as="references" value={[...new Set(props.paths)]} />
<Let as="index" value={0} />
<Dir path={props.repository}>
<If condition={references.length !== 0}>
<Loop max={references.length}>
<Let as="path" value={references[index]} />
<If condition={!Object.hasOwn(documents,path)}>
<Ticket.Text path={path} as="text" />
<Let as="documents" value={{...documents,[path]:{path,content:text}}} />
</If>
<Let as="index" value={index + 1} />
</Loop>
</If>
</Dir>
<Return value={documents} />
