---
description: 'Build a validated API, migrate its consumers and return conflicts to the same Planner. Use <Adversarial.Run task={task} plannerGuide={plannerGuide} implementorGuide={implementorGuide} as="work" />.'
props:
  type: object
  properties:
    task: {type: object}
    plannerGuide: {type: object}
    implementorGuide: {type: object}
    documents: {type: object}
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
<If condition={props.documents === undefined}>
<Ticket.Documents repository={task.repository} paths={task.inputs} documents={{}} as="documents" />
<Else><Let as="documents" value={props.documents} /></Else>
</If>
<Let as="inputs" value={Object.values(documents)} />
<If condition={inputs.reduce((total,input) => total + input.content.length,0) > 64000}><Fail message="Prepare a bounded initial packet; keep large logs as references." /></If>
<Let as="deliveredInputs" value={{}} />
<Let as="api" value={null} />
<Let as="conflict" value={null} />
<Let as="contract" value={null} />
<Let as="initialized" value={{architect:false,planner:false,implementor:false}} />
<Let as="assessment" value={props.assessment ?? {mechanical:false,architecture:false,acceptance:true,risk:null,reason:"The accepted task introduces a validated API and migrates its consumers.",evidence:[props.plannerGuide.path]}} />
<Let as="round" value={0} />
<Let as="history" value={[]} />
<Let as="finished" value={false} />
<Loop max={(task.maxApiRepairs + 1) * 2}>
<Ticket.Checkout repository={task.repository} as="checkout" />
<Let as="attempt" value={task.directory + "/foundation-" + history.length} />
<Let as="assignment" value={{work:task.work,repository:task.repository,revision:checkout.head,attempt,session:task.sessions.planner,initialize:!initialized.planner,request:task.request,inputs:inputs.filter(input => !(deliveredInputs[task.sessions.planner] ?? []).includes(input.path)),api,conflict,contract,assessment}} />
<Ticket.Capture as="execution"><Adversarial.Foundation assignment={assignment} guide={props.plannerGuide.content} as="foundation" /><Json value={foundation} /></Ticket.Capture>
<Dir path={task.directory}><File path={"foundation-" + history.length + "-execution.json"}><Json value={execution} /></File></Dir>
<Let as="history" value={[...history,{owner:"planner",attempt,status:execution.status}]} />
<Let as="initialized" value={{...initialized,planner:true}} />
<Let as="deliveredInputs" value={{...deliveredInputs,[task.sessions.planner]:[...new Set([...(deliveredInputs[task.sessions.planner] ?? []),...inputs.map(input => input.path),props.plannerGuide.path])]}} />
<If condition={execution.status !== "completed"}><Let as="finished" value={true} /><Return value={{status:"hold",reason:execution.failure,history}} /><Break /></If>
<Parse schema={{type:"object"}} as="foundation">{execution.output}</Parse>
<If condition={foundation.result.outcome === "needs_architect"}>
<Phase.Run phase="discovery" role="architect" session={task.sessions.architect} initialize={!initialized.architect} assignment={{phase:"discovery",work:task.work,repository:task.repository,revision:checkout.head,request:foundation.result.handoff,assessment:foundation.result.assessment,artifacts:foundation.result.artifacts,evidence:foundation.result.evidence,findings:[],changedPaths:[],contract}} attempt={task.directory + "/architecture-" + history.length} successor="discovery" nextRole="planner" as="architecture" />
<If condition={architecture.outcome !== "complete"}><Let as="finished" value={true} /><Return value={{status:"hold",reason:architecture.handoff,history}} /><Break /></If>
<Let as="contract" value={architecture.contract} />
<Let as="conflict" value={{question:foundation.result.handoff,answer:architecture.handoff,artifacts:architecture.artifacts}} />
<Let as="initialized" value={{...initialized,architect:true}} />
<Else>
<If condition={foundation.result.outcome !== "complete"}><Let as="finished" value={true} /><Return value={{status:"hold",reason:foundation.result.handoff,history}} /><Break /></If>
<Let as="api" value={foundation.validated.api} />
<Let as="assessment" value={foundation.result.assessment} />
<Let as="apiPath" value={attempt + "/validated-api.json"} />
<Json value={api} as="apiText" />
<Dir path={attempt}><File path="validated-api.json">{apiText}</File></Dir>
<Ticket.Text path={api.guide} as="usage" />
<Let as="acceptedInputs" value={[...inputs,{path:apiPath,content:apiText},{path:api.guide,content:usage}]} />
<If condition={assessment.architecture}>
<Ticket.ChangedPaths repository={task.repository} base={assignment.revision} head={api.revision} as="foundationChanges" />
<Phase.Run phase="review" role="architect" session={task.sessions.architect} initialize={!initialized.architect} inputs={acceptedInputs} assignment={{phase:"review",work:task.work,repository:task.repository,revision:api.revision,priorRevision:assignment.revision,request:"Review the committed API foundation's structural impact before consumer migration. Inspect its validated examples and changed paths against the accepted outcome: " + task.request,assessment,contract,artifacts:[foundation.path,apiPath],evidence:foundation.validated.checks,findings:[],changedPaths:foundationChanges.paths}} attempt={task.directory + "/foundation-review-" + history.length} successor="ready" as="foundationReview" />
<Let as="initialized" value={{...initialized,architect:true}} />
<Dir path={task.directory}><File path={"foundation-review-" + history.length + "-result.json"}><Json value={foundationReview} /></File></Dir>
<Ticket.Checkout repository={task.repository} as="reviewedFoundation" />
<If condition={foundationReview.outcome !== "pass" || foundationReview.revision !== api.revision || reviewedFoundation.head !== api.revision || !reviewedFoundation.clean}><Let as="finished" value={true} /><Return value={{status:"hold",reason:"The structural API foundation requires Architect acceptance at its unchanged validated commit.",review:foundationReview,history}} /><Break /></If>
</If>
<Let as="currentReferences" value={[...acceptedInputs.map(input => input.path),props.plannerGuide.path,props.implementorGuide.path]} />
<Let as="deliveredInputs" value={Object.fromEntries(Object.entries(deliveredInputs).map(([session,paths]) => [session,paths.filter(path => currentReferences.includes(path))]))} />
<Let as="migration" value={{schema:"ticket-workflow.v2",work:task.work,directory:task.directory + "/migration-" + round,api,maxCorrections:task.maxCorrections,deliveredInputs,roles:{architect:{session:task.sessions.architect,provider:"codex",initialized:initialized.architect},planner:{session:task.sessions.planner,provider:"claude",initialized:true},implementor:{session:task.sessions.implementor,provider:"claude",initialized:initialized.implementor}},acceptedInputs,roleInputs:{planner:[props.plannerGuide],implementor:[props.implementorGuide]},assignment:{phase:"implementation",work:task.work,repository:task.repository,revision:foundation.validated.revision,priorRevision:assignment.revision,request:api.migration.request,assessment,contract,artifacts:[foundation.path,apiPath],evidence:foundation.validated.checks,findings:[],changedPaths:[]}}} />
<Let as="manifest" value={attempt + "/migration.json"} />
<Dir path={attempt}><File path="migration.json"><Json value={migration} /></File></Dir>
<Ticket.Run manifest={manifest} as="ticket" />
<Dir path={task.directory}><File path={"migration-" + round + "-result.json"}><Json value={ticket} /></File></Dir>
<Let as="initialized" value={ticket.checkpoint.initialized} />
<Let as="deliveredInputs" value={ticket.deliveredInputs} />
<Let as="history" value={[...history,{owner:"implementor",path:task.directory + "/migration-" + round + "-result.json",status:ticket.status}]} />
<Let as="last" value={ticket.calls.at(-1)?.resultValue} />
<If condition={ticket.status === "feedback_ready"}>
<Ticket.Capture as="retired"><Adversarial.Retirement repository={task.repository} paths={api.migration.retirePaths} as="retired" /><Json value={retired} /></Ticket.Capture>
<Dir path={task.directory}><File path="retirement.json"><Json value={retired} /></File></Dir>
<Let as="finished" value={true} />
<Return value={retired.status === "completed" ? {status:"feedback_ready",revision:ticket.revision,api,ticket,history} : {status:"hold",reason:retired.failure,ticket,history}} /><Break />
</If>
<If condition={ticket.checkpoint.hold?.kind !== "needs_discovery" || last?.apiConflict === undefined}><Return value={{status:"hold",reason:ticket.checkpoint.hold,ticket,history}} /><Let as="finished" value={true} /><Break /></If>
<Ticket.Checkout repository={task.repository} as="held" />
<If condition={!held.clean || round >= task.maxApiRepairs}><Return value={{status:"hold",reason:!held.clean ? "Preserve the partial checkout and reconcile it before API repair." : "API repair bound reached; review whether this role split is still useful.",ticket,history}} /><Let as="finished" value={true} /><Break /></If>
<Let as="conflict" value={{...last.apiConflict,artifacts:last.artifacts,evidence:last.evidence,request:last.handoff}} />
<Let as="round" value={round + 1} />
</Else>
</If>
</Loop>
<If condition={!finished}><Return value={{status:"hold",reason:"Planning bound reached; inspect the saved work before another call.",history}} /></If>
