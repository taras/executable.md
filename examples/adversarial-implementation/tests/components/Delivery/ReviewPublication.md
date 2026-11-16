---
props: {type: object, properties: {target: {type: object}, review: {type: object}, publish: {type: boolean}}, required: [target, review, publish], additionalProperties: false}
returns: {type: object}
---
<Let as="comment" value={{state:"verified",revision:props.target.revision,id:42,url:"https://github.com/" + props.target.repository + "/pull/" + props.target.number + "#issuecomment-42"}} />
<Let as="publication" value={comment} />
<Dir path={props.target.directory}><Glob include={["journey"]} as="test" /></Dir>
<If condition={test.length !== 0}>
<File path="remote.json" as="remoteText" />
<Parse schema={{type:"object"}} as="remote">{remoteText}</Parse>
<Let as="name" value={"comment-" + props.target.revision + ".json"} />
<Dir path={props.target.directory}><Glob include={[name,"comments-unavailable"]} as="published" /></Dir>
<If condition={published.includes("comments-unavailable") || !published.includes(name) && (!props.publish || remote.revision !== props.target.revision)}>
<Let as="publication" value={{state:"pending"}} />
<Else>
<If condition={!published.includes(name)}>
<Dir path={props.target.directory}><File path={name}><Json value={comment} /></File></Dir>
</If>
</Else>
</If>
</If>
<Return value={publication} />
