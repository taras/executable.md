---
description: 'Shorten only an oversized independent-review summary, or validate its saved correction chain without prompting. Use <Delivery.Response delivery={delivery} revision={revision} reviewer={reviewer} attempt={attempt} raw={raw} dispatch={false} as="response" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string}
    reviewer: {type: object}
    attempt: {type: string}
    raw: {type: string}
    dispatch: {type: boolean, default: false}
  required: [delivery, revision, reviewer, attempt, raw]
  additionalProperties: false
returns: {type: object}
---

The original review stays unchanged. Each extra call belongs to the same
reviewer, model and native conversation, and consumes the recorded response
allowance before dispatch. Reconciliation reads that chain and sends no prompt.

<Delivery.Schema as="schemas" />
<Ticket.Text path={props.attempt + "/assignment.json"} as="assignmentText" />
<Parse schema={{type:"object"}} as="assignment">{assignmentText}</Parse>
<Let as="limit" value={assignment.maxResponseCorrections ?? 0} />
<If condition={!Number.isInteger(limit) || limit < 0 || limit > 3 || limit !== (props.delivery.maxResponseCorrections ?? 0)}><Fail message="The review response allowance differs from its recorded assignment." /></If>
<Delivery.Validate text={props.raw} revision={props.revision} acceptance={props.delivery.policy.acceptance} as="checked" />
<Let as="original" value={checked.result ?? null} />
<Let as="rawPath" value={props.attempt + "/raw.txt"} />
<Let as="round" value={0} />
<If condition={!checked.ok && props.dispatch}>
<Dir path={props.attempt}><File path="response-rejection.json"><Json value={checked} /></File></Dir>
</If>
<Ticket.Text path={props.attempt + "/outcome.json"} as="outcomeText" />
<Parse schema={{type:"object"}} as="originalOutcome">{outcomeText}</Parse>
<Let as="catalog" value={originalOutcome.catalog} />
<If condition={originalOutcome.turn?.state !== "reply" || originalOutcome.turn.reply !== props.raw || JSON.stringify(originalOutcome.reviewer) !== JSON.stringify(props.reviewer)}><Fail message="The original review does not match its joined outcome." /></If>
<Loop max={3}>
<If condition={checked.ok || !checked.repairable || round >= limit}><Break /></If>
<Let as="round" value={round + 1} />
<Let as="directory" value={props.attempt + "/response-corrections/" + String(round).padStart(4,"0")} />
<Let as="repairSchema" value={{...schemas.review,properties:Object.fromEntries(Object.entries(schemas.review.properties).map(([key,value]) => [key,key === "summary" ? value : {const:original[key]}]))}} />
<Let as="packet" value={{schema:"delivery-summary-correction.v1",revision:props.revision,reviewer:props.reviewer,model:catalog.model,ordinal:round,remaining:limit-round,original:props.attempt + "/raw.txt",result:original,responseSchema:repairSchema}} />
<If condition={JSON.stringify(packet).length > 64000}><Fail message="The review correction packet exceeds 64000 characters; no prompt was sent." /></If>
<If condition={props.dispatch}>
<Ticket.Checkout repository={props.delivery.repository} as="before" />
<If condition={before.head !== props.revision || !before.clean}><Fail message="Source changed before response-only review correction." /></If>
<Dir path={props.attempt + "/response-corrections"}><Let as="parentPrepared" value={true} /></Dir>
<Let as="quoted" value={"'" + directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="Preserve the occupied review correction; no prompt is repeated." /></If>
<Dir path={directory}><File path="request.json"><Json value={packet} /></File><File path="source-before.json"><Json value={before} /></File></Dir>
<Delivery.Turn as="turn"><Agent name={props.reviewer.provider}><Session name={props.reviewer.session} model={catalog.model} effort={props.reviewer.effort ?? undefined}><Phase.Session directory={props.delivery.directory + "/sessions"} name={props.reviewer.session} requireExisting={true}><Prompt throwOnError={true}>
Shorten only the summary of your completed independent review to at most {schemas.review.properties.summary.maxLength} characters. This is response-only correction {round}, with {limit-round} remaining. Do not inspect source, run commands, repeat the review, publish or change any other field. Preserve the verdict, findings, clause IDs and revision exactly. Return one JSON object satisfying the frozen schema below.
<Json value={packet} />
</Prompt></Phase.Session></Session></Agent></Delivery.Turn>
<Dir path={directory}><File path="outcome.json"><Json value={{reviewer:props.reviewer,catalog,turn}} /></File></Dir>
<If condition={turn.state !== "reply"}><Fail message={"The review summary correction failed: " + turn.failure + ". Preserve its outcome and original review; no replacement reviewer is eligible."} /></If>
<Dir path={directory}><File path="raw.txt">{turn.reply}</File></Dir>
<Ticket.Checkout repository={props.delivery.repository} as="after" />
<Dir path={directory}><File path="source-after.json"><Json value={after} /></File></Dir>
<If condition={after.head !== before.head || !after.clean}><Fail message="Response-only review correction changed source; preserve the work and hold." /></If>
</If>
<Ticket.Text path={directory + "/request.json"} as="requestText" />
<Parse schema={{type:"object"}} as="savedRequest">{requestText}</Parse>
<If condition={JSON.stringify(savedRequest) !== JSON.stringify(packet)}><Fail message="The saved correction differs from its original review, identity or allowance." /></If>
<Ticket.Text path={directory + "/outcome.json"} as="returnedText" />
<Parse schema={{type:"object"}} as="returned">{returnedText}</Parse>
<Ticket.Text path={directory + "/raw.txt"} as="raw" />
<If condition={JSON.stringify(returned.reviewer) !== JSON.stringify(props.reviewer) || JSON.stringify(returned.catalog) !== JSON.stringify(catalog) || returned.turn?.state !== "reply" || returned.turn.reply !== raw}><Fail message="The correction reply differs from its joined reviewer outcome." /></If>
<Ticket.Text path={directory + "/source-before.json"} as="beforeText" />
<Ticket.Text path={directory + "/source-after.json"} as="afterText" />
<Parse schema={{type:"object",properties:{head:{const:props.revision},clean:{const:true}},required:["head","clean"]}} as="before">{beforeText}</Parse>
<Parse schema={{type:"object",properties:{head:{const:props.revision},clean:{const:true}},required:["head","clean"]}} as="after">{afterText}</Parse>
<Let as="rawPath" value={directory + "/raw.txt"} />
<Delivery.Validate text={raw} revision={props.revision} acceptance={props.delivery.policy.acceptance} frozen={original} as="checked" />
<If condition={props.dispatch}>
<Dir path={directory}><File path="disposition.json"><Json value={{ordinal:round,limit,accepted:checked.ok,rejection:checked.ok ? null : checked.reason,raw:rawPath}} /></File></Dir>
</If>
</Loop>
<If condition={!checked.ok}>
<If condition={props.dispatch}><Dir path={props.attempt}><File path="response-disposition.json"><Json value={{status:"held",consumed:round,limit,reason:checked.reason,repairable:checked.repairable}} /></File></Dir></If>
<Fail message={"Independent review response is held after " + round + "/" + limit + " corrections: " + checked.reason} />
</If>
<Return value={{result:checked.result,round,rawPath}} />
