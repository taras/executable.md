---
props: {type: object, properties: {repository: {type: string}, number: {type: integer}}, required: [repository, number], additionalProperties: false}
returns: {type: object}
---
<File path="remote.json" as="text" />
<Parse schema={{type:"object"}} as="remote">{text}</Parse>
<Glob include={["remote-next.json","ready-count.txt"]} as="control" />
<If condition={control.includes("remote-next.json")}>
<File path="remote-next.json" as="next" />
<File path="remote.json">{next}</File>
<File.Delete path="remote-next.json" />
</If>
<Return value={control.includes("ready-count.txt") ? {...remote,draft:false} : remote} />
