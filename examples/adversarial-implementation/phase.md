---
props:
  type: object
  properties:
    request: {type: string, minLength: 1}
  required: [request]
  additionalProperties: false
---

<Ticket.Text path={props.request} as="text" />
<Parse schema={{type:"object",properties:{role:{enum:["architect","planner","implementor"]},session:{type:"string",minLength:1},assignment:{type:"object"},attempt:{type:"string",pattern:"^/"},initialize:{type:"boolean",default:false},inputPaths:{type:"array",items:{type:"string"},default:[]},implementationProvider:{enum:["claude","codex"],default:"claude"}},required:["role","session","assignment","attempt"],additionalProperties:false}} as="request">{text}</Parse>
<Ticket.Documents repository={request.assignment.repository} paths={[...new Set([...(request.inputPaths ?? []),...(request.assignment.handoffInputs ?? [])])]} as="documents" />
<If condition={Object.values(documents).reduce((total,input) => total + input.content.length,0) > 64000}><Fail message="Selected phase inputs exceed 64000 characters. Select concise documents before dispatch." /></If>
<Phase.Run phase={request.assignment.phase} role={request.role} session={request.session} assignment={request.assignment} attempt={request.attempt} initialize={request.initialize ?? false} inputs={Object.values(documents)} implementationProvider={request.implementationProvider ?? "claude"} successor={request.assignment.continuation?.phase ?? null} nextRole={request.assignment.continuation?.role ?? null} as="result" />
<Output><Json value={result} /></Output>
