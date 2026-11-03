---
props: {type: object, properties: {delivery: {type: object}, revision: {type: string}}, required: [delivery, revision], additionalProperties: false}
returns: {type: string}
---
<Dir path={props.delivery.directory}><File path="called.json"><Json value={{revision:props.revision,reviewer:props.delivery.policy.reviewer}} /></File></Dir>
<If condition={props.delivery.work === "failed"}><Fail message="The original provider operation failed." /></If>
<Let as="reply" value={{revision:props.delivery.work === "wrong-head" ? "0".repeat(40) : props.revision,verdict:props.delivery.work === "blocked" ? "blocked" : props.delivery.work === "repair" ? "changes_required" : "pass",summary:"Reviewed the assigned behavior.",acceptance:props.delivery.work === "missing-clause" ? [] : props.delivery.policy.acceptance.map(clause => clause.id),findings:["repair","false-pass"].includes(props.delivery.work) ? [{blocking:true,description:"A blocking regression remains."}] : []}} />
<Return value={JSON.stringify(reply)} />
