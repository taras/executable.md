---
description: >-
  Capture new referenced text and reuse recorded documents. Use <Ticket.Documents
  repository={repository} directory={directory} paths={references} documents={documents} as="documents" />.
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
    paths: {type: array, items: {type: string, minLength: 1}}
    documents: {type: object, default: {}}
    directory: {type: string, pattern: '^/'}
  required: [repository, directory, paths]
  additionalProperties: false
returns: {type: object}
---

A reference keeps its first recorded text. Reuse that reference for the same
input; return a new artifact path when a later phase produces different evidence.
Paths that are relative to the assignment resolve in its selected repository.

<Let as="documents" value={props.documents} />
<Let as="references" value={[...new Set(props.paths)]} />
<Ticket.DocumentCapacity directory={props.directory} as="fits" />
<If condition={!fits}><Fail message="Captured document metadata exceeds continuation capacity; no new text was acquired." /></If>
<Let as="index" value={0} />
<Dir path={props.repository}>
<If condition={references.length !== 0}>
<Loop max={references.length}>
<Let as="path" value={references[index]} />
<If condition={!Object.hasOwn(documents,path)}>
<If condition={path.startsWith("/")}>
<Dir path={path.slice(0,path.lastIndexOf("/")) || "/"}>
<Ticket.Snapshot repository={props.repository} directory={props.directory} path={path} as="saved"><Ticket.Finite><File path={path.slice(path.lastIndexOf("/") + 1)} /></Ticket.Finite></Ticket.Snapshot>
</Dir>
<Else><Ticket.Snapshot repository={props.repository} directory={props.directory} path={path} as="saved"><Ticket.Finite><File path={path} /></Ticket.Finite></Ticket.Snapshot></Else>
</If>
<Let as="documents" value={{...documents,[path]:saved}} />
</If>
<Let as="index" value={index + 1} />
</Loop>
</If>
</Dir>
<Return value={documents} />
