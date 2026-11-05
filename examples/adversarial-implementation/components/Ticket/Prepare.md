---
description: 'Check and reduce the next selected packet before dispatch. Use <Ticket.Prepare record={record} call={call} as="prepared" />.'
props:
  type: object
  properties:
    record: {type: object}
    call: {type: object}
  required: [record, call]
  additionalProperties: false
returns: {type: object}
---
<Ticket.Inputs record={props.record} call={props.call} inspect={true} as="original" />
<Ticket.Fingerprint inputs={original.inputs} as="before" />
<Let as="directory" value={props.record.manifest.directory + "/preparations/" + props.call.id} />
<Dir path={props.record.manifest.directory + "/preparations"}><Let as="parentPrepared" value={true} /></Dir>
<Let as="quoted" value={"'" + directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="reserved"
mkdir -- {quoted}
```
<If condition={reserved.exitCode !== 0}><Fail message={"Preparation already has retained or uncertain work. Preserve " + directory + "; do not replenish its allowance."} /></If>
<Let as="path" value={directory + "/receipt.json"} />
<Ticket.WorkflowSource as="workflowSource" />
<Let as="workflowQuoted" value={"'" + workflowSource.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="workflow"
set -e
git -C {workflowQuoted} rev-parse HEAD
git -C {workflowQuoted} status --porcelain --untracked-files=no -- examples/adversarial-implementation
```
<If condition={workflow.exitCode !== 0}><Fail message="Cannot record the workflow revision; no successor or reduction prompt started." /></If>
<Let as="receipt" value={{schema:"handoff-preparation.v1",work:props.call.assignment.work,phase:props.call.assignment.phase ?? "foundation",producer:props.call.producer ?? props.record.calls.at(-1)?.result ?? null,workflow:{revision:workflow.stdout.split("\n")[0],dirty:workflow.stdout.split("\n").slice(1).join("\n").trim() !== ""},recipient:{role:props.call.role,session:props.call.session,provider:props.call.provider},sourceRevision:props.call.assignment.revision,call:props.call.id,delivered:original.received,before,budget:original.budget,original:directory + "/original.json",originalFailure:original.budget.admitted ? null : {reason:"Selected handoff inputs exceed 64000 characters.",excess:original.budget.excess},limits:{reduction:1,comparison:1,corrections:0,window:8000,material:128000,selected:64000,complete:256000},attempts:[],costs:null,status:"inspected",dispatch:directory + "/dispatch.json"}} />
<Dir path={directory}><File path="original.json"><Json value={{call:props.call,inputs:original.inputs.map(input => original.documents[input.path])}} /></File><File path="receipt.json"><Json value={receipt} /></File></Dir>
<Let as="call" value={props.call} />
<Let as="selection" value={original} />
<Let as="reason" value={null} />
<Loop max={1}>
<If condition={original.budget.admitted}><Break /></If>
<If condition={original.budget.mandatory > 64000}><Let as="reason" value={"Irreducible mandatory floor exceeds 64000 by " + (original.budget.mandatory-64000) + " UTF-16 units."} /><Break /></If>
<Let as="lastPlanner" value={props.record.calls.filter(call => call.role === "planner" && call.delivery).at(-1)} />
<If condition={lastPlanner === undefined && props.record.checkpoint?.plannerCall}>
<Ticket.Read path={props.record.checkpoint.plannerCall} limit={1048576} as="plannerText" />
<Parse schema={{type:"object",properties:{role:{const:"planner"},session:{type:"string"},provider:{enum:["claude","codex"]},assignment:{type:"object",properties:{assessment:{type:"object"}},required:["assessment"]},delivery:{type:"string"},record:{type:"string"},design:{type:"boolean"}},required:["role","session","provider","assignment","delivery","record","design"]}} as="lastPlanner">{plannerText}</Parse>
</If>
<If condition={lastPlanner === undefined || lastPlanner.session !== props.record.manifest.roles?.planner?.session || lastPlanner.provider !== props.record.manifest.roles?.planner?.provider}>
<Let as="reason" value={"No established original Planner with recorded productive profile is available; no replacement owner is authorized."} /><Break />
</If>
<Phase.Profile role="planner" assessment={lastPlanner.assignment.assessment} design={lastPlanner.design ?? false} plannerProvider={lastPlanner.provider} as="profile" />
<Let as="owner" value={{session:lastPlanner.session,profile,productiveCall:lastPlanner.record + "/call.json",identityDirectory:props.record.manifest.identityDirectory ?? props.record.manifest.directory + "/sessions"}} />
<Let as="sources" value={original.inputs.filter(input => !original.mandatoryPaths.includes(input.path))} />
<If condition={sources.reduce((total,input) => total+input.content.length,0)>128000}>
<Let as="reason" value={"Reduction material exceeds 128000; unexamined sources: " + JSON.stringify(before.filter(input => !original.mandatoryPaths.includes(input.path)).map(input => ({...input,start:0,end:input.characters})))} /><Break />
</If>
<Ticket.Material inputs={sources} directory={directory + "/reduce-windows"} as="material" />
<Let as="materialRecord" value={{...props.record,documents:{...original.documents,...material.documents}}} />
<Let as="materialCall" value={{...props.call,role:"planner",session:owner.session,assignment:{...props.call.assignment,handoffInputs:material.inputs.map(input => input.path)}}} />
<Ticket.Inputs record={materialRecord} call={materialCall} inspect={true} as="admission" />
<If condition={!admission.budget.admitted}><Let as="reason" value={"Preparation material exceeds its selected-input allowance: " + JSON.stringify(admission.budget) + "; no reduction Prompt started."} /><Break /></If>
<Ticket.PreparationSchema as="schemas" />
<Let as="receipt" value={{...receipt,owner,attempts:[{stage:"reduce",status:"attempted",material:material.observations,acquired:material.total,admission:admission.budget,execution:directory + "/reduce-execution.json",raw:directory + "/reduce-raw.txt"}]}} />
<Dir path={directory}><File path="receipt.json"><Json value={receipt} /></File></Dir>
<Ticket.Capture as="reduced"><Ticket.PreparationPrompt owner={owner} stage="reduce" assignment={props.call.assignment} material={{...material,inputs:admission.inputs}} schema={schemas.reduction} allowance={original.budget.remaining} as="raw" /><Dir path={directory}><File path="reduce-raw.txt">{raw}</File></Dir><SafeParse schema={schemas.reduction} as="parsed">{raw}</SafeParse><Json value={parsed} /></Ticket.Capture>
<Dir path={directory}><File path="reduce-execution.json"><Json value={reduced} /></File></Dir>
<If condition={reduced.status !== "completed"}><Let as="reason" value={"Reduction failed or completion is uncertain; preserve the first execution and do not retry."} /><Break /></If>
<Parse schema={{type:"object"}} as="parsed">{reduced.output}</Parse>
<If condition={!parsed.ok}><Let as="reason" value="Malformed reduction reply; the single reduction allowance is spent." /><Break /></If>
<Let as="receipt" value={{...receipt,attempts:receipt.attempts.map(attempt => ({...attempt,status:"reply_saved",parsed:parsed.ok}))}} />
<Let as="reduction" value={parsed.value} />
<Dir path={directory}><File path="reduction.json"><Json value={reduction} /></File></Dir>
<Ticket.Preservation inputs={sources} reduction={reduction} as="preservation" />
<Let as="receipt" value={{...receipt,diagnosis:reduction.diagnosis,reduction:directory + "/reduction.json",preservation}} />
<If condition={!preservation.valid || reduction.uncertain.length !== 0}><Let as="reason" value={"Exact extraction or source mapping is incomplete or uncertain: " + JSON.stringify({preservation,uncertain:reduction.uncertain})} /><Break /></If>
<Let as="candidate" value={directory + "/candidate.md"} />
<Let as="content" value={reduction.content + "\n\nPreparation receipt: " + path} />
<Ticket.Snapshot repository={directory} directory={directory} path={candidate} content={content} as="retainedCandidate" />
<Ticket.Hydrate repository={directory} document={retainedCandidate} as="capturedCandidate" />
<Let as="captured" value={capturedCandidate.content} />
<If condition={captured !== content}><Let as="reason" value="Candidate capture differs from the proposed text." /><Break /></If>
<Let as="call" value={{...props.call,assignment:{...props.call.assignment,handoffInputs:[candidate],artifacts:[...new Set([...(props.call.assignment.artifacts ?? []),path])]}}} />
<Let as="candidateRecord" value={{...props.record,documents:{...original.documents,[candidate]:retainedCandidate}}} />
<Ticket.Inputs record={candidateRecord} call={call} inspect={true} as="selection" />
<Ticket.Fingerprint inputs={selection.inputs} as="after" />
<Let as="receipt" value={{...receipt,after,revalidated:selection.budget,candidate}} />
<If condition={!selection.budget.admitted}><Let as="reason" value={"Reduced packet still exceeds 64000 by " + selection.budget.excess + "; no comparison or successor Prompt started."} /><Break /></If>
<Let as="mappingPath" value={directory+"/compare-mapping.json"} />
<Let as="mappingText" value={JSON.stringify({diagnosis:reduction.diagnosis,dispositions:reduction.dispositions,uncertain:reduction.uncertain})} />
<Dir path={directory}><File path="compare-mapping.json">{mappingText}</File></Dir>
<Let as="receipt" value={{...receipt,mapping:mappingPath}} />
<Let as="comparisonSources" value={[...sources,{path:candidate,content:captured},{path:mappingPath,content:mappingText}]} />
<If condition={comparisonSources.reduce((total,input) => total+input.content.length,0)>128000}><Let as="reason" value={"Comparison material exceeds 128000; unexamined spans: " + JSON.stringify([...before,...after])} /><Break /></If>
<Ticket.Material inputs={comparisonSources} directory={directory + "/compare-windows"} as="material" />
<Let as="materialRecord" value={{...props.record,documents:{...original.documents,...material.documents}}} />
<Let as="materialCall" value={{...materialCall,assignment:{...materialCall.assignment,handoffInputs:material.inputs.map(input => input.path)}}} />
<Ticket.Inputs record={materialRecord} call={materialCall} inspect={true} as="admission" />
<If condition={!admission.budget.admitted}><Let as="reason" value={"Comparison selected material exceeds 64000: " + JSON.stringify(admission.budget) + "; no comparison Prompt started."} /><Break /></If>
<Let as="receipt" value={{...receipt,attempts:[...receipt.attempts,{stage:"compare",status:"attempted",material:material.observations,acquired:material.total,admission:admission.budget,execution:directory + "/compare-execution.json",raw:directory + "/compare-raw.txt"}]}} />
<Dir path={directory}><File path="receipt.json"><Json value={receipt} /></File></Dir>
<Ticket.Capture as="compared"><Ticket.PreparationPrompt owner={owner} stage="compare" assignment={props.call.assignment} material={{...material,inputs:admission.inputs}} schema={schemas.comparison} allowance={original.budget.remaining} as="raw" /><Dir path={directory}><File path="compare-raw.txt">{raw}</File></Dir><SafeParse schema={schemas.comparison} as="parsed">{raw}</SafeParse><Json value={parsed} /></Ticket.Capture>
<Dir path={directory}><File path="compare-execution.json"><Json value={compared} /></File></Dir>
<If condition={compared.status !== "completed"}><Let as="reason" value="Comparison failed or completion is uncertain; preserve its execution without retry." /><Break /></If>
<Parse schema={{type:"object"}} as="parsed">{compared.output}</Parse>
<If condition={!parsed.ok}><Let as="reason" value="Malformed comparison reply." /><Break /></If>
<Let as="receipt" value={{...receipt,attempts:receipt.attempts.map(attempt => attempt.stage === "compare" ? {...attempt,status:"reply_saved",parsed:parsed.ok} : attempt)}} />
<Let as="comparison" value={parsed.value} />
<Let as="receipt" value={{...receipt,comparison}} />
<If condition={!comparison.sufficient || comparison.changed.length !== 0 || comparison.missing.length !== 0 || comparison.uncertain.length !== 0}><Let as="reason" value="Preservation comparison reports changed, missing, uncertain or insufficient obligations." /><Break /></If>
<Ticket.Inputs record={candidateRecord} call={call} as="selection" />
</Loop>
<Let as="receipt" value={{...receipt,status:reason === null ? "ready" : "hold",reason}} />
<Dir path={directory}><File path="receipt.json"><Json value={receipt} /></File></Dir>
<Return value={{status:reason === null ? "ready" : "hold",call,documents:selection.documents,inputs:selection.inputs,deliveryProposal:selection.deliveryProposal,receipt:path,reason}} />
