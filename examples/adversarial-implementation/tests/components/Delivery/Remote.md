---
props: {type: object, properties: {repository: {type: string}, number: {type: integer}}, required: [repository, number], additionalProperties: false}
returns: {type: object}
---
<File path="remote.json" as="text" />
<Parse schema={{type:"object"}} as="remote">{text}</Parse>
<If condition={typeof remote.appear === "string"}>
<Let as="quotedAppear" value={"'" + remote.appear.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="appeared"
mkdir -p -- {quotedAppear}
```
</If>
<Return value={remote} />
