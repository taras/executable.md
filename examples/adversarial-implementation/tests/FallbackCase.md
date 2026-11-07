---
props:
  type: object
  properties:
    record: {type: string}
  required: [record]
  additionalProperties: false
---
<Ticket.Text path={props.record} as="text" />
<Parse schema={{type:"object"}} as="input">{text}</Parse>
<If condition={input.phase === "interrupt-child"}>
<Dir path={input.fixture.repository}>
<Ticket.Text path={input.fixture.directory + "/delivery/requirements.json"} as="requirementsText" />
<Parse schema={{type:"object"}} as="delivery">{requirementsText}</Parse>
<Fixture.Elicitation record={input.fixture.root + "/elicitations.json"} hold={delivery.directory + "/review-" + input.revision + "/hold.json"} mode="suspend"><Delivery.Review delivery={delivery} revision={input.revision} as="unexpected" /></Fixture.Elicitation>
</Dir>
<Else>
<Each in={input.scenarios} let="scenario">
<Let as="root" value={input.fixture.root + "/" + scenario} />
<Dir path={input.fixture.repository}>
<Fixture.Fallback scenario={scenario} fixture={{...input.fixture,root,directory:root + "/work"}} runner={input.runner} root={input.root} />
</Dir>
</Each>
</Else>
</If>
