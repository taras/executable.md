---
description: 'Promote inputs only from a saved successful raw reply. Use <Ticket.Delivery record={record} call={call} proposal={proposal} as="delivery" />.'
props:
  type: object
  properties:
    record: {type: object}
    call: {type: object}
    proposal: {type: object}
    execution: {type: string, minLength: 1}
  required: [record, call, proposal, execution]
  additionalProperties: false
returns: {type: object}
---
<Ticket.Capture as="captured"><Ticket.Text path={props.call.attempt + "/delivery.json"} as="text" /><Parse schema={{type:"object"}} as="value">{text}</Parse><Json value={value} /></Ticket.Capture>
<Let as="deliveredInputs" value={props.record.deliveredInputs ?? {}} />
<Let as="delivery" value={null} />
<Let as="profile" value={null} />
<If condition={captured.status === "completed"}>
<Parse schema={{type:"object"}} as="value">{captured.output}</Parse>
<Ticket.Fingerprint inputs={props.proposal.inputs} as="expected" />
<If condition={value.session !== props.call.session || value.role !== props.call.role || value.provider !== props.call.provider || JSON.stringify(value.inputs) !== JSON.stringify(expected)}><Fail message="Delivery evidence differs from the exact selected packet or recipient." /></If>
<Let as="delivery" value={props.call.attempt + "/delivery.json"} />
<Let as="profile" value={value.profile} />
<Let as="deliveredInputs" value={props.proposal.deliveryProposal} />
</If>
<Ticket.Capture as="canonical"><Ticket.Text path={props.call.attempt+"/result.json"} as="text" /><Parse schema={{type:"object"}} as="result">{text}</Parse><Json value={result} /></Ticket.Capture>
<Dir path={props.proposal.receipt.slice(0,props.proposal.receipt.lastIndexOf("/"))}><File path="dispatch.json"><Json value={{recipient:{role:props.call.role,session:props.call.session,provider:props.call.provider},attempt:props.call.attempt,execution:props.execution,delivery,result:canonical.status === "completed" ? props.call.attempt+"/result.json" : null}} /></File></Dir>
<Return value={{delivery,profile,deliveredInputs,initialized:delivery !== null}} />
