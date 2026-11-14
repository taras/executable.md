---
props:
  type: object
  properties:
    request: {type: object}
    call:
      type: object
      properties:
        identities: {type: string, pattern: '^/'}
        directory: {type: string, pattern: '^/'}
        solver: {type: object}
        solverKey: {type: string}
        models: {type: array, minItems: 1, items: {type: string}}
        position: {enum: [0, 1]}
        requireExisting: {type: boolean}
        quotaNotice: {type: string}
      required: [identities, directory, solver, solverKey, models, position, requireExisting]
      additionalProperties: false
    reply:
      type: object
      properties:
        schema: {type: object}
        identity: {type: object}
        invalid: {type: string}
      required: [schema, identity, invalid]
      additionalProperties: false
    inputs: {type: array}
  required: [request, call, reply, inputs]
  additionalProperties: false
returns: {type: object}
---

<Let as="call" value={props.call} />
<Let as="revision" value={props.request.assignment.revision} />
<Let as="hold" value={{status:"hold",revision,attempt:call.directory}} />
<Ticket.Capture as="execution">
<Diagnosis.Attempt request={props.request} call={call} inputs={props.inputs} as="attempt"><Content /></Diagnosis.Attempt>
<Json value={attempt} />
</Ticket.Capture>
<If condition={execution.status !== "completed"}>
<Dir path={call.directory}><File path="failure.json"><Json value={{failure:execution.failure}} /></File></Dir>
<Return value={{replace:false,result:{...hold,reason:execution.failure.split("\n")[0]}}} />
<Else>
<Parse schema={{type:"object"}} as="attempt">{execution.output}</Parse>
<If condition={attempt.turn?.state !== "reply"}>
<Diagnosis.CanReplace solver={attempt.record.solver} catalog={attempt.catalog} turn={attempt.turn} quotaNotice={call.quotaNotice} as="replace" />
<Return value={{replace,result:{...hold,reason:attempt.turn?.failure?.split("\n")[0] ?? attempt.catalog.failure ?? "The requested diagnostic model is unavailable."}}} />
<Else>
<Phase.Extract text={attempt.turn.reply} as="extracted" />
<If condition={!extracted.ok}><Return value={{replace:false,result:{...hold,reason:extracted.rejection.message}}} />
<Else>
<SafeParse schema={props.reply.schema} as="parsed">{extracted.json}</SafeParse>
<If condition={!parsed.ok || parsed.value.revision !== revision || (parsed.value.outcome === "cause" && (parsed.value.regression.expected.trim() === parsed.value.regression.observed.trim() || parsed.value.evidence.some(path => !props.inputs.some(input => input.path === path))))}><Return value={{replace:false,result:{...hold,reason:props.reply.invalid}}} />
<Else>
<Ticket.Capture as="receipt"><Ticket.Read path={attempt.record.identities + "/" + encodeURIComponent(attempt.record.solver.session) + ".json"} limit={1048576} as="text" /><Json value={text} /></Ticket.Capture>
<Let as="identityText" value={receipt.status === "completed" ? JSON.parse(receipt.output) : ""} />
<SafeParse schema={props.reply.identity} as="checked">{identityText}</SafeParse>
<If condition={!checked.ok || checked.value.agent !== attempt.record.solver.provider || checked.value.name !== attempt.record.solver.session}><Return value={{replace:false,result:{...hold,reason:"The diagnostic reply has no matching confirmed session identity. Reconcile the saved attempt."}}} />
<Else>
<Dir path={call.directory}><File path="result.json"><Json value={{schema:"diagnosis-result.v1",assignment:attempt.record,model:attempt.catalog.model,identity:checked.value,result:parsed.value}} /></File></Dir>
<Return value={{replace:false,result:{status:parsed.value.outcome,revision,attempt:call.directory,result:call.directory + "/result.json"}}} />
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
