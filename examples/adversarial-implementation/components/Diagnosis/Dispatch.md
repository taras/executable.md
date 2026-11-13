---
description: 'Settle a diagnostic turn and record a validated result. Use <Diagnosis.Dispatch request={request} namespace={namespace} directory={directory} position={0} inputs={inputs} />.'
props:
  type: object
  properties:
    request: {type: object}
    namespace: {type: object}
    directory: {type: string}
    position: {enum: [0, 1]}
    inputs: {type: array}
    previous: {type: [object, 'null'], default: null}
    previousModel: {type: [string, 'null'], default: null}
  required: [request, namespace, directory, position, inputs]
  additionalProperties: false
returns: {type: object}
---

<Let as="revision" value={props.request.assignment.revision} />
<Let as="hold" value={{status:"hold",revision,attempt:props.directory}} />
<Ticket.Capture as="execution"><Diagnosis.Attempt request={props.request} namespace={props.namespace} directory={props.directory} position={props.position} inputs={props.inputs} previous={props.previous} previousModel={props.previousModel} as="attempt" /><Json value={attempt} /></Ticket.Capture>
<If condition={execution.status !== "completed"}>
<Dir path={props.directory}><File path="failure.json"><Json value={{failure:execution.failure}} /></File></Dir>
<Return value={{replace:false,result:{...hold,reason:execution.failure.split("\n")[0]}}} />
<Else>
<Parse schema={{type:"object"}} as="attempt">{execution.output}</Parse>
<If condition={attempt.turn?.state !== "reply"}>
<Diagnosis.CanReplace solver={attempt.record.solver} catalog={attempt.catalog} turn={attempt.turn} as="replace" />
<Return value={{replace,result:{...hold,reason:attempt.turn?.failure?.split("\n")[0] ?? attempt.catalog.failure ?? "The requested diagnostic model is unavailable."}}} />
<Else>
<Diagnosis.Schema as="schema" />
<Phase.Extract text={attempt.turn.reply} as="extracted" />
<If condition={!extracted.ok}><Return value={{replace:false,result:{...hold,reason:extracted.rejection.message}}} />
<Else>
<SafeParse schema={schema.result} as="parsed">{extracted.json}</SafeParse>
<If condition={!parsed.ok || parsed.value.revision !== revision || (parsed.value.outcome === "cause" && (parsed.value.regression.expected.trim() === parsed.value.regression.observed.trim() || parsed.value.evidence.some(path => !props.inputs.some(input => input.path === path))))}><Return value={{replace:false,result:{...hold,reason:"The saved reply does not match the diagnostic result contract or captured evidence."}}} />
<Else>
<Ticket.Capture as="receipt"><Ticket.Read path={attempt.record.identities + "/" + encodeURIComponent(attempt.record.solver.session) + ".json"} limit={1048576} as="text" /><Json value={text} /></Ticket.Capture>
<Let as="identityText" value={receipt.status === "completed" ? JSON.parse(receipt.output) : ""} />
<SafeParse schema={schema.identity} as="checked">{identityText}</SafeParse>
<If condition={!checked.ok || checked.value.agent !== attempt.record.solver.provider || checked.value.name !== attempt.record.solver.session}><Return value={{replace:false,result:{...hold,reason:"The diagnostic reply has no matching confirmed session identity. Reconcile the saved attempt."}}} />
<Else>
<Dir path={props.directory}><File path="result.json"><Json value={{schema:"diagnosis-result.v1",assignment:attempt.record,model:attempt.catalog.model,identity:checked.value,result:parsed.value}} /></File></Dir>
<Return value={{replace:false,result:{status:parsed.value.outcome,revision,attempt:props.directory,result:props.directory + "/result.json"}}} />
</Else>
</If>
</Else>
</If>
</Else>
</If>
</Else>
</If>
</Else>
</If>
