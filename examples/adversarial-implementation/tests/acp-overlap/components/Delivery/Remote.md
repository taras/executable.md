---
props: {type: object, properties: {repository: {type: string}, number: {type: integer}}, required: [repository, number], additionalProperties: false}
returns: {type: object}
---
<File path="remote.json" as="text" />
<Parse schema={{type:"object"}} as="remote">{text}</Parse>
<Return value={remote} />
