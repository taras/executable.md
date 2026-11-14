---
props:
  type: object
  properties:
    request: {type: string, minLength: 1}
  required: [request]
  additionalProperties: false
returns: {type: object}
---

<Ticket.Read path={props.request} limit={1048576} as="text" />
<Parse schema={{type:"object"}} as="selected">{text}</Parse>
<If condition={selected.role === "problem-solver"}>
<Entry.DiagnosticSolvers as="solvers" />
<Diagnosis.Run request={selected} solvers={solvers} as="diagnosis" />
<Return value={diagnosis} />
<Else>
<Parse schema={{type:"object",properties:{role:{enum:["architect","planner","implementor"]},session:{type:"string",minLength:1},assignment:{type:"object"},attempt:{type:"string",pattern:"^/"},initialize:{type:"boolean",default:false},inputPaths:{type:"array",items:{type:"string"},default:[]},plannerProvider:{enum:["claude","codex"],default:"claude"},implementationProvider:{enum:["claude","codex"],default:"claude"},maxResponseCorrections:{type:"integer",minimum:0,maximum:3,default:3}},required:["role","session","assignment","attempt"],additionalProperties:false}} as="request">{text}</Parse>
<Ticket.Documents directory={request.attempt + ".inputs"} repository={request.assignment.repository} paths={[...new Set([...(request.inputPaths ?? []),...(request.assignment.handoffInputs ?? [])])]} as="documents" />
<Let as="record" value={{manifest:{directory:request.attempt + "-handoff",identityDirectory:request.assignment.identityDirectory ?? (request.attempt.slice(0,request.attempt.lastIndexOf("/")) + "/sessions"),acceptedInputs:(request.inputPaths ?? []).map(path => documents[path]),roleInputs:{},roles:{}},documents,calls:[]}} />
<Let as="call" value={{id:"standalone",producer:props.request,attempt:request.attempt,initialize:request.initialize,role:request.role,session:request.session,provider:request.role === "architect" ? "codex" : request.role === "planner" ? request.plannerProvider : request.implementationProvider,assignment:request.assignment}} />
<Ticket.Prepare record={record} call={call} as="prepared" />
<If condition={prepared.status !== "ready"}><Fail message={prepared.reason + " Receipt: " + prepared.receipt} /></If>
<Ticket.Capture as="execution"><Phase.Run phase={request.assignment.phase} role={request.role} session={request.session} assignment={prepared.call.assignment} attempt={request.attempt} initialize={request.initialize ?? false} inputs={prepared.inputs} plannerProvider={request.plannerProvider ?? "claude"} implementationProvider={request.implementationProvider ?? "claude"} maxResponseCorrections={request.maxResponseCorrections ?? 3} successor={request.assignment.continuation?.phase ?? null} nextRole={request.assignment.continuation?.role ?? null} as="result" /><Json value={result} /></Ticket.Capture>
<Ticket.Capture as="delivery"><Ticket.Read path={request.attempt+"/delivery.json"} limit={1048576} as="text" /><Json value={text} /></Ticket.Capture>
<Dir path={prepared.receipt.slice(0,prepared.receipt.lastIndexOf("/"))}><File path="dispatch.json"><Json value={{recipient:{role:call.role,session:call.session,provider:call.provider},attempt:request.attempt,execution,result:execution.status === "completed" ? request.attempt+"/result.json" : null,delivery:delivery.status === "completed" ? request.attempt+"/delivery.json" : null}} /></File></Dir>
<If condition={execution.status !== "completed"}><Fail message={execution.failure} /></If>
<Parse schema={{type:"object"}} as="result">{execution.output}</Parse>
<Ticket.Outward value={{status:result.outcome,revision:result.revision,result:request.attempt + "/result.json"}} as="bounded" /><Return value={bounded} />
</Else>
</If>
