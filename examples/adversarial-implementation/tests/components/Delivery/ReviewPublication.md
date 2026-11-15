---
props: {type: object, properties: {target: {type: object}, review: {type: object}, publish: {type: boolean}}, required: [target, review, publish], additionalProperties: false}
returns: {type: object}
---
<Return value={{state:"verified",revision:props.target.revision,id:42,url:"https://github.com/" + props.target.repository + "/pull/" + props.target.number + "#issuecomment-42"}} />
