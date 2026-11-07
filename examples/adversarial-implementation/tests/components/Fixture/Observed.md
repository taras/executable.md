---
props: {type: object, properties: {delivery: {type: string}, root: {type: string}}, required: [delivery, root], additionalProperties: false}
returns: {type: object}
---
<Let as="calls" value={[]} />
<Let as="elicitations" value={[]} />
<Dir path={props.delivery}><Glob include={["called.json"]} as="calledFiles" /></Dir>
<If condition={calledFiles.length !== 0}>
<Ticket.Text path={props.delivery + "/called.json"} as="calledText" />
<Parse schema={{type:"array"}} as="calls">{calledText}</Parse>
</If>
<Dir path={props.root}><Glob include={["elicitations.json"]} as="recordFiles" /></Dir>
<If condition={recordFiles.length !== 0}>
<Ticket.Text path={props.root + "/elicitations.json"} as="recordText" />
<Parse schema={{type:"array"}} as="elicitations">{recordText}</Parse>
</If>
<Return value={{calls,elicitations}} />
