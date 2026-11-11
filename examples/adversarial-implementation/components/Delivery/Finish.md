---
description: 'Finish an incomplete review once in its original conversation, or read that saved turn. Use <Delivery.Finish delivery={delivery} revision={revision} reviewer={reviewer} catalog={catalog} attempt={attempt} dispatch={false} as="reply" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
    reviewer: {type: object}
    catalog: {type: object}
    attempt: {type: string, pattern: '^/'}
    dispatch: {type: boolean}
  required: [delivery, revision, reviewer, catalog, attempt, dispatch]
  additionalProperties: false
returns: {type: string}
---

The initial turn has returned an explicit progress reply. Reserve the one
completion turn before prompting. Its reply and source evidence stay separate
from the first turn and any later summary corrections.

<Delivery.Schema as="schemas" />
<If condition={props.catalog.state !== "selected" || typeof props.catalog.model !== "string" || !props.catalog.model}><Fail message="The progress reply has no retained selected model. Preserve it and hold." /></If>
<Let as="directory" value={props.attempt + "/completion"} />
<Let as="request" value={{schema:"delivery-review-completion.v1",revision:props.revision,reviewer:props.reviewer,model:props.catalog.model,original:props.attempt + "/raw.txt",timeout:"5m",responseSchema:schemas.review}} />
<Let as="sourceSchema" value={{type:"object",properties:{head:{const:props.revision},clean:{const:true}},required:["head","clean"]}} />
<If condition={props.dispatch}>
<Ticket.Checkout repository={props.delivery.repository} as="before" />
<If condition={before.head !== props.revision || !before.clean}><Fail message="Source changed before review completion. Preserve the first reply and hold." /></If>
<Let as="quoted" value={"'" + directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="The review completion is already reserved or cannot be reserved. No prompt is repeated." /></If>
<Dir path={directory}><File path="request.json"><Json value={request} /></File><File path="source-before.json"><Json value={before} /></File></Dir>
<Delivery.Turn as="turn"><Agent name={props.reviewer.provider}><Session name={props.reviewer.session} model={props.catalog.model} effort={props.reviewer.effort ?? undefined}><Phase.Session directory={props.delivery.directory + "/sessions"} name={props.reviewer.session} requireExisting={true}><Prompt throwOnError={true} timeout={request.timeout}>
Continue your unfinished independent review of {props.revision} from this conversation. Finish only the checks still needed. Keep source unchanged, run checks in the foreground and join them before returning. Return the final verdict for the original acceptance clauses as one JSON object. If you cannot finish, report the concrete blocker in the verdict. This is the only completion turn.
<Json value={request.responseSchema} />
</Prompt></Phase.Session></Session></Agent></Delivery.Turn>
<Dir path={directory}><File path="outcome.json"><Json value={{reviewer:props.reviewer,catalog:props.catalog,turn}} /></File></Dir>
<If condition={turn.state !== "reply"}><Fail message={"Review completion failed: " + turn.failure + ". Preserve both turns and hold."} /></If>
<Dir path={directory}><File path="raw.txt">{turn.reply}</File></Dir>
<Ticket.Checkout repository={props.delivery.repository} as="after" />
<Dir path={directory}><File path="source-after.json"><Json value={after} /></File></Dir>
</If>
<Ticket.Text path={directory + "/request.json"} as="savedRequest" />
<Parse schema={{type:"object"}} as="packet">{savedRequest}</Parse>
<If condition={JSON.stringify(packet) !== JSON.stringify(request)}><Fail message="The saved completion request differs from the original review." /></If>
<Ticket.Text path={directory + "/outcome.json"} as="savedOutcome" />
<Parse schema={{type:"object"}} as="returned">{savedOutcome}</Parse>
<Ticket.Text path={directory + "/raw.txt"} as="reply" />
<If condition={JSON.stringify(returned.reviewer) !== JSON.stringify(props.reviewer) || JSON.stringify(returned.catalog) !== JSON.stringify(props.catalog) || returned.turn?.state !== "reply" || returned.turn.reply !== reply}><Fail message="The completion reply differs from its retained reviewer outcome." /></If>
<Ticket.Text path={directory + "/source-before.json"} as="beforeText" />
<Ticket.Text path={directory + "/source-after.json"} as="afterText" />
<Parse schema={sourceSchema} as="before">{beforeText}</Parse>
<Parse schema={sourceSchema} as="after">{afterText}</Parse>
<SafeParse schema={schemas.progress} as="progress">{reply}</SafeParse>
<If condition={progress.ok}><Fail message="The reviewer is still unfinished after its one completion turn. Preserve both replies and hold." /></If>
<Return value={reply} />
