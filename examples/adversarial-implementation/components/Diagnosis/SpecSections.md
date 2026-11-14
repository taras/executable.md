---
props:
  type: object
  properties:
    repository: {type: string}
    revision: {type: string}
    references: {type: array}
  required: [repository, revision, references]
  additionalProperties: false
---

<Each in={props.references} let="reference">
<Dir path={props.repository}>
<Git.File commit={props.revision} path={reference.split("#")[0]} limit={2097152} as="specFile" />
<If condition={specFile.next !== null}><Fail message="The spec file exceeds the supported read size. Select a section in a smaller spec file." /></If>
<Diagnosis.SpecSection reference={reference} source={specFile.text} as="specSection" />
</Dir>

Owning spec section from {reference} at {props.revision}

{specSection}

</Each>
