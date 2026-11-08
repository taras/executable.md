---
description: >-
  Refuse a decision for an accepted needs_decision result whose phase execution failed
  after saving it. Use <Fixture.DecisionFailedExecution root={root} />.
props:
  type: object
  properties:
    root: {type: string}
  required: [root]
  additionalProperties: false
---

<TempDir>
<Fixture.DecisionHold root={props.root} scenario="decision" cut={{mode:"before",match:"/attempts/0000/response-acceptance.json"}} as="held" />
<Let as="saved" value={held.saved} />
<Let as="call" value={saved.calls[0]} />
<Let as="ticket" value={saved.manifest.directory} />
<AssertEquals actual={[saved.calls.length,call.role,call.status,saved.checkpoint.hold.kind,saved.checkpoint.hold.execution,saved.checkpoint.dispatchable]} expected={[1,"planner","accepted","needs_decision","failed",false]} />
<Ticket.Text path={call.execution} as="executionText" />
<Parse schema={{type:"object"}} as="execution">{executionText}</Parse>
<AssertEquals actual={[execution.status,execution.failure.includes('cannot write "response-acceptance.json"')]} expected={["failed",true]} />
<Ticket.Text path={call.result} as="resultText" />
<Parse schema={{type:"object"}} as="result">{resultText}</Parse>
<AssertEquals actual={result.outcome} expected="needs_decision" />
<Dir path={call.attempt}><Glob include={["response-acceptance.json"]} as="acceptance" /></Dir>
<AssertEquals actual={acceptance} expected={[]} />
<AssertEquals actual={held.work.nextAction} expected={{entry:"continue.md",gate:saved.checkpoint.gate,action:"resolve_feedback_hold"}} />
<Ticket.Text path={held.work.continuation.path} as="heldState" />
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="before" /></Dir>
<Fixture.DecisionRequest held={held} name="failed-execution" as="request" />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={request.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="is failed, missing or uncertain" as="refused" />
<Let as="executionPath" value={"'" + call.execution.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="hidden"
mv -- {executionPath} {executionPath}.retained
```
<Fixture.Execution entry="resolve-decision" value={held.work} decision={request.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="is failed, missing or uncertain" as="missing" />
```bash exec as="restored"
mv -- {executionPath}.retained {executionPath}
```
<AssertEquals actual={[hidden.exitCode,restored.exitCode]} expected={[0,0]} />
<Ticket.Text path={call.execution} as="executionAfter" />
<Ticket.Text path={held.work.continuation.path} as="heldStateAfter" />
<AssertEquals actual={[executionAfter === executionText,heldStateAfter === heldState]} expected={[true,true]} />
<Ticket.Load record={held.work} as="reloaded" />
<AssertEquals actual={reloaded} expected={saved} />
<Dir path={ticket}><Glob include={["continuations/*.json"]} as="after" /></Dir>
<AssertEquals actual={after} expected={before} />
<Dir path={ticket}><Glob include={["decisions/**","calls/0001/**","attempts/0001/**","preparations/0001/**"]} as="effects" /></Dir>
<AssertEquals actual={effects} expected={[]} />
<Dir path={held.fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={1} />
</TempDir>
