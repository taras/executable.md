---
description: 'Build a validated API, migrate its consumers and return conflicts to the same Planner. Use <Adversarial.Run task={task} plannerGuide={plannerGuide} implementorGuide={implementorGuide} as="work" />.'
props:
  type: object
  properties:
    task: {type: object}
    plannerGuide: {type: object}
    implementorGuide: {type: object}
    documents: {type: object}
    delivery: {type: object}
    assessment: {type: object}
  required: [task, plannerGuide, implementorGuide]
  additionalProperties: false
returns: {type: object}
---

<Adversarial.Schema as="schemas" />
<Parse schema={schemas.task} as="task"><Json value={props.task} /></Parse>
<If condition={new Set(Object.values(task.sessions)).size !== 3 || task.directory === task.repository || task.directory.startsWith(task.repository + "/")}>
<Fail message="Use distinct role sessions and an artifact directory outside the source checkout." />
</If>
<Let as="quoted" value={"'" + task.directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message="The work directory must be fresh. Resume its original XMD execution instead of starting another writer." /></If>
<If condition={props.delivery !== undefined}><Dir path={task.directory + "/delivery"}><File path="requirements.json"><Json value={props.delivery} /></File></Dir></If>
<If condition={props.documents === undefined}>
<Ticket.Documents repository={task.repository} paths={task.inputs} documents={{}} as="documents" />
<Else><Let as="documents" value={props.documents} /></Else>
</If>
<Let as="inputs" value={task.inputs.map(path => documents[path])} />

<Let as="deliveredInputs" value={{}} />
<Let as="api" value={null} />
<Let as="conflict" value={null} />
<Let as="contract" value={null} />
<Let as="initialized" value={{architect:false,planner:false,implementor:false}} />
<Let as="assessment" value={props.assessment ?? {mechanical:false,architecture:false,acceptance:true,risk:null,reason:"The accepted task introduces a validated API and migrates its consumers.",evidence:[props.plannerGuide.path]}} />
<Let as="round" value={0} />
<Let as="history" value={[]} />
<Let as="roleCalls" value={[]} />
<Let as="finished" value={false} />
<Loop max={(task.maxApiRepairs + 1) * 2}>
<Ticket.Checkout repository={task.repository} as="checkout" />
<Let as="attempt" value={task.directory + "/foundation-" + history.length} />
<Let as="assignment" value={{work:task.work,repository:task.repository,revision:checkout.head,attempt,session:task.sessions.planner,plannerProvider:task.providers.planner,maxResponseCorrections:task.maxResponseCorrections,initialize:!initialized.planner,request:task.request,inputs:[],guidePath:props.plannerGuide.path,api,conflict,contract,assessment}} />
<Let as="preparationRecord" value={{manifest:{directory:task.directory,acceptedInputs:inputs,roleInputs:{planner:[props.plannerGuide],implementor:[props.implementorGuide]},roles:{planner:{session:task.sessions.planner,provider:task.providers.planner}}},documents:{...documents,...Object.fromEntries(inputs.map(input => [input.path,input])),[props.plannerGuide.path]:props.plannerGuide,[props.implementorGuide.path]:props.implementorGuide},calls:roleCalls,deliveredInputs}} />
<Let as="call" value={{id:"foundation-" + history.length,role:"planner",session:task.sessions.planner,provider:task.providers.planner,attempt,assignment}} />
<Ticket.Prepare record={preparationRecord} call={call} as="prepared" />
<If condition={prepared.status !== "ready"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:prepared.reason,preparation:prepared.receipt,history}} /><Break /></If>
<Let as="assignment" value={{...prepared.call.assignment,inputs:prepared.inputs.filter(input => input.path !== props.plannerGuide.path)}} />
<Ticket.Capture as="execution"><Adversarial.Foundation assignment={assignment} guide={props.plannerGuide.content} selectedInputs={prepared.inputs} as="foundation" /><Json value={foundation} /></Ticket.Capture>
<Dir path={task.directory}><File path={"foundation-" + history.length + "-execution.json"}><Json value={execution} /></File></Dir>
<Ticket.Delivery execution={task.directory+"/foundation-"+history.length+"-execution.json"} record={preparationRecord} call={call} proposal={prepared} as="delivery" />
<Let as="history" value={[...history,{owner:"planner",attempt,status:execution.status}]} />
<Let as="roleCalls" value={[...roleCalls,{id:call.id,role:call.role,session:call.session,provider:call.provider,assignment:{assessment:assignment.assessment},design:true,delivery:delivery.delivery,profile:delivery.profile,record:attempt,result:execution.status === "completed" ? attempt+"/result.json" : null}]} />
<Let as="initialized" value={{...initialized,planner:initialized.planner || delivery.initialized}} />
<Let as="deliveredInputs" value={delivery.deliveredInputs} />
<If condition={execution.status !== "completed"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:execution.failure,history}} /><Break /></If>
<Parse schema={{type:"object"}} as="foundation">{execution.output}</Parse>
<If condition={foundation.result.outcome === "needs_architect"}>
<Let as="architectureCall" value={{id:"architecture-" + history.length,role:"architect",session:task.sessions.architect,provider:"codex",attempt:task.directory + "/architecture-" + history.length,assignment:{phase:"discovery",work:task.work,repository:task.repository,revision:checkout.head,priorRevision:null,request:foundation.result.handoff,assessment:foundation.result.assessment,artifacts:foundation.result.artifacts,evidence:foundation.result.evidence,findings:[],changedPaths:[],contract}}} />
<Ticket.Prepare record={{...preparationRecord,deliveredInputs,calls:roleCalls}} call={architectureCall} as="architecturePrepared" />
<If condition={architecturePrepared.status !== "ready"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:architecturePrepared.reason,preparation:architecturePrepared.receipt,history}} /><Break /></If>
<Ticket.Capture as="architectureExecution">
<Phase.Run maxResponseCorrections={task.maxResponseCorrections} phase="discovery" role="architect" session={task.sessions.architect} initialize={!initialized.architect} inputs={architecturePrepared.inputs} assignment={architecturePrepared.call.assignment} attempt={task.directory + "/architecture-" + history.length} successor="discovery" nextRole="planner" as="architecture" />
<Json value={architecture} /></Ticket.Capture>
<Dir path={task.directory}><File path={"architecture-"+history.length+"-execution.json"}><Json value={architectureExecution} /></File></Dir>
<Ticket.Delivery execution={task.directory+"/architecture-"+history.length+"-execution.json"} record={{...preparationRecord,deliveredInputs}} call={architectureCall} proposal={architecturePrepared} as="architectureDelivery" />
<Let as="deliveredInputs" value={architectureDelivery.deliveredInputs} />
<Let as="initialized" value={{...initialized,architect:initialized.architect || architectureDelivery.initialized}} />
<Let as="roleCalls" value={[...roleCalls,{...architectureCall,delivery:architectureDelivery.delivery,record:architectureCall.attempt,result:architectureExecution.status === "completed" ? architectureCall.attempt+"/result.json" : null}]} />
<If condition={architectureExecution.status !== "completed"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:architectureExecution.failure,history}} /><Break /></If>
<Parse schema={{type:"object"}} as="architecture">{architectureExecution.output}</Parse>
<If condition={architecture.outcome !== "complete"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:architecture.handoff,history}} /><Break /></If>
<Let as="contract" value={architecture.contract} />
<Let as="conflict" value={{question:foundation.result.handoff,answer:architecture.handoff,artifacts:architecture.artifacts}} />
<Let as="initialized" value={{...initialized,architect:true}} />
<Else>
<If condition={foundation.result.outcome !== "complete"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:foundation.result.handoff,history}} /><Break /></If>
<Let as="api" value={foundation.validated.api} />
<Let as="assessment" value={foundation.result.assessment} />
<Let as="apiPath" value={attempt + "/validated-api.json"} />
<Json value={api} as="apiText" />
<Dir path={attempt}><File path="validated-api.json">{apiText}</File></Dir>
<Ticket.Text path={api.guide} as="usage" />
<Let as="acceptedInputs" value={[...inputs,{path:apiPath,content:apiText},{path:api.guide,content:usage}]} />
<If condition={assessment.architecture}>
<Ticket.ChangedPaths repository={task.repository} base={assignment.revision} head={api.revision} as="foundationChanges" />
<Let as="reviewRecord" value={{...preparationRecord,deliveredInputs,calls:roleCalls,manifest:{...preparationRecord.manifest,acceptedInputs:inputs},documents:{...preparationRecord.documents,...Object.fromEntries(acceptedInputs.map(input => [input.path,input]))}}} />
<Let as="reviewCall" value={{id:"foundation-review-" + history.length,role:"architect",session:task.sessions.architect,provider:"codex",attempt:task.directory + "/foundation-review-" + history.length,assignment:{...{phase:"review",work:task.work,repository:task.repository,revision:api.revision,priorRevision:assignment.revision,request:"Review the committed API foundation's structural impact before consumer migration. Inspect its validated examples and changed paths against the accepted outcome: " + task.request,assessment,contract,artifacts:[foundation.path,apiPath],evidence:foundation.validated.checks,findings:[],changedPaths:foundationChanges.paths},handoffInputs:acceptedInputs.map(input => input.path)}}} />
<Ticket.Prepare record={reviewRecord} call={reviewCall} as="reviewPrepared" />
<If condition={reviewPrepared.status !== "ready"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:reviewPrepared.reason,preparation:reviewPrepared.receipt,history}} /><Break /></If>
<Ticket.Capture as="reviewExecution">
<Phase.Run maxResponseCorrections={task.maxResponseCorrections} phase="review" role="architect" session={task.sessions.architect} initialize={!initialized.architect} inputs={reviewPrepared.inputs} assignment={reviewPrepared.call.assignment} attempt={task.directory + "/foundation-review-" + history.length} successor="ready" as="foundationReview" />
<Json value={foundationReview} /></Ticket.Capture>
<Dir path={task.directory}><File path={"foundation-review-"+history.length+"-execution.json"}><Json value={reviewExecution} /></File></Dir>
<Ticket.Delivery execution={task.directory+"/foundation-review-"+history.length+"-execution.json"} record={reviewRecord} call={reviewCall} proposal={reviewPrepared} as="reviewDelivery" />
<Let as="deliveredInputs" value={reviewDelivery.deliveredInputs} />
<Let as="initialized" value={{...initialized,architect:initialized.architect || reviewDelivery.initialized}} />
<If condition={reviewExecution.status !== "completed"}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:reviewExecution.failure,history}} /><Break /></If>
<Parse schema={{type:"object"}} as="foundationReview">{reviewExecution.output}</Parse>
<Dir path={task.directory}><File path={"foundation-review-" + history.length + "-result.json"}><Json value={foundationReview} /></File></Dir>
<Ticket.Checkout repository={task.repository} as="reviewedFoundation" />
<If condition={foundationReview.outcome !== "pass" || foundationReview.revision !== api.revision || reviewedFoundation.head !== api.revision || !reviewedFoundation.clean}><Let as="finished" value={true} /><Return value={{status:"hold",deliveredInputs,initialized,reason:"The structural API foundation requires Architect acceptance at its unchanged validated commit.",review:foundationReview,history}} /><Break /></If>
</If>
<Let as="currentReferences" value={[...acceptedInputs.map(input => input.path),props.plannerGuide.path,props.implementorGuide.path]} />
<Let as="deliveredInputs" value={Object.fromEntries(Object.entries(deliveredInputs).map(([session,paths]) => [session,paths.filter(path => currentReferences.includes(path))]))} />
<Let as="migration" value={{schema:"ticket-workflow.v2",work:task.work,directory:task.directory + "/migration-" + round,api,maxCorrections:task.maxCorrections,maxApiRepairs:task.maxApiRepairs,maxResponseCorrections:task.maxResponseCorrections,deliveredInputs,roles:{architect:{session:task.sessions.architect,provider:"codex",initialized:initialized.architect},planner:{session:task.sessions.planner,provider:task.providers.planner,initialized:true},implementor:{session:task.sessions.implementor,provider:task.providers.implementor,initialized:initialized.implementor}},acceptedInputs,roleInputs:{planner:[props.plannerGuide],implementor:[props.implementorGuide]},assignment:{phase:"implementation",work:task.work,repository:task.repository,revision:foundation.validated.revision,priorRevision:assignment.revision,request:api.migration.request,assessment,contract,artifacts:[foundation.path,apiPath],evidence:foundation.validated.checks,findings:[],changedPaths:[]}}} />
<Let as="manifest" value={attempt + "/migration.json"} />
<Dir path={attempt}><File path="migration.json"><Json value={migration} /></File></Dir>
<Ticket.Run manifest={manifest} plannerCall={attempt + "/preparation-owner.json"} as="ticket" />
<Dir path={task.directory}><File path={"migration-" + round + "-result.json"}><Json value={ticket} /></File></Dir>
<Let as="initialized" value={ticket.checkpoint.initialized} />
<Let as="deliveredInputs" value={ticket.deliveredInputs} />
<Let as="history" value={[...history,{owner:"implementor",path:task.directory + "/migration-" + round + "-result.json",status:ticket.status}]} />
<Let as="last" value={ticket.calls.at(-1)?.resultValue} />
<If condition={ticket.status === "feedback_ready"}>
<Ticket.Capture as="retired"><Adversarial.Retirement repository={task.repository} paths={api.migration.retirePaths} as="retired" /><Json value={retired} /></Ticket.Capture>
<Dir path={task.directory}><File path="retirement.json"><Json value={retired} /></File></Dir>
<Let as="finished" value={true} />
<Return value={retired.status === "completed" ? {status:"feedback_ready",revision:ticket.revision,api,ticket,history} : {status:"hold",deliveredInputs,initialized,reason:retired.failure,ticket,history}} /><Break />
</If>
<If condition={ticket.checkpoint.hold?.kind !== "needs_discovery" || last?.apiConflict === undefined}><Return value={{status:"hold",deliveredInputs,initialized,reason:ticket.checkpoint.hold,ticket,history}} /><Let as="finished" value={true} /><Break /></If>
<Ticket.Checkout repository={task.repository} as="held" />
<If condition={!held.clean || round >= task.maxApiRepairs}><Return value={{status:"hold",deliveredInputs,initialized,reason:!held.clean ? "Preserve the partial checkout and reconcile it before API repair." : "API repair bound reached; review whether this role split is still useful.",ticket,history}} /><Let as="finished" value={true} /><Break /></If>
<Let as="conflict" value={{...last.apiConflict,artifacts:last.artifacts,evidence:last.evidence,request:last.handoff}} />
<Let as="round" value={round + 1} />
</Else>
</If>
</Loop>
<If condition={!finished}><Return value={{status:"hold",deliveredInputs,initialized,reason:"Planning bound reached; inspect the saved work before another call.",history}} /></If>
