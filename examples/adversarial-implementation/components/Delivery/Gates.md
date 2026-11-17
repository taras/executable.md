---
description: 'Read exact feedback, checkout and GitHub gates for delivery. Use <Delivery.Gates delivery={delivery} number={123} as="gates" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    number: {type: integer, minimum: 1}
  required: [delivery, number]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Schema as="schemas" />
<Parse schema={schemas.policy} as="policy"><Json value={props.delivery.policy} /></Parse>
<Let as="feedback" value={null} />
<Dir path={props.delivery.directory}><Glob include={["feedback.json"]} as="files" /></Dir>
<If condition={files.length !== 0}>
<Ticket.Text path={props.delivery.directory + "/feedback.json"} as="text" />
<Parse schema={{type:"object",properties:{status:{const:"feedback_ready"},revision:{type:"string",pattern:"^[0-9a-f]{40}$"}},required:["status","revision"],additionalProperties:false}} as="feedback">{text}</Parse>
</If>
<Delivery.Remote repository={policy.repository} number={props.number} as="remote" />
<Delivery.Source repository={props.delivery.repository} as="source" />
<Let as="ciPassed" value={remote.ciGreen === true && remote.ci?.status === "completed" && remote.ci?.conclusion === "success"} />
<Let as="mainPassed" value={remote.mainRepair || remote.main.run?.status === "completed" && remote.main.run?.conclusion === "success"} />
<Let as="sourceMatches" value={source.clean && remote.stable && remote.revision === source.head && remote.branch === source.branch && remote.base === "main"} />
<Return value={{feedback,remote,source,ciPassed,mainPassed,sourceMatches,eligible:sourceMatches && feedback?.revision === source.head && remote.state === "open" && remote.draft && ciPassed}} />
