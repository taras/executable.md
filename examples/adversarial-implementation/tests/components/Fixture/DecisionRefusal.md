---
description: >-
  Refuse stale, conflicting, foreign and excluded decision resolutions without a role
  call or managed change. Use <Fixture.DecisionRefusal root={root} />.
props:
  type: object
  properties:
    root: {type: string}
  required: [root]
  additionalProperties: false
---

<TempDir>
<Fixture.DecisionHold root={props.root} scenario="decision" as="held" />
<Let as="saved" value={held.saved} />
<Let as="ticket" value={saved.manifest.directory} />
<Let as="last" value={saved.calls.at(-1)} />
<Ticket.Text path={held.work.continuation.path} as="heldState" />
<Fixture.DecisionRequest held={held} name="valid" as="valid" />
<Let as="bindings" value={[
  {name:"wrong-work",override:{work:"another-work"},expected:"another work item"},
  {name:"stale-continuation",override:{continuation:{...held.work.continuation,sha256:"0".repeat(64)}},expected:"stale continuation"},
  {name:"wrong-result",override:{heldResult:{...valid.request.heldResult,sha256:"1".repeat(64)}},expected:"another held result"},
  {name:"disagreeing",override:{acceptedInputs:[{...valid.request.decision,path:held.fixture.root + "/decisions/disagreeing/decision.md",sha256:"2".repeat(64)}]},expected:"different contents"},
  {name:"unclosed",override:{answer:"embedded decision body"},expected:"answer"}
]} />
<Each in={bindings} let="binding">
<Fixture.DecisionRequest held={held} name={binding.name} override={binding.override} as="request" />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={request.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected={binding.expected} as="refused" />
<AssertStringIncludes actual={refused.hold} expected="without changing the managed ticket" />
</Each>
<Let as="excluded" value={[
  {kind:"execution_failure",checkpoint:{}},
  {kind:"changed_input",checkpoint:{}},
  {kind:"source_mismatch",checkpoint:{}},
  {kind:"correction_bound",checkpoint:{}},
  {kind:"verification_failure",checkpoint:{}},
  {kind:"input_preparation",checkpoint:{}},
  {kind:"blocked",checkpoint:{}},
  {kind:"needs_decision",checkpoint:{feedback:[last.result]},expected:"before implementation feedback"}
]} />
<Each in={excluded} let="entry">
<Let as="variant" value={{...saved,checkpoint:{...saved.checkpoint,...entry.checkpoint,hold:{kind:entry.kind,reason:"Synthetic " + entry.kind + " hold for the refusal table."}}}} />
<Ticket.Publish record={variant} as="published" />
<AssertEquals actual={[entry.kind,published.publication,published.nextAction]} expected={[entry.kind,"confirmed",{entry:"continue.md",gate:saved.checkpoint.gate,action:"resolve_feedback_hold"}]} />
<Fixture.DecisionRequest held={{...held,work:published}} name={"excluded-" + entry.kind + (entry.expected === undefined ? "" : "-feedback")} as="request" />
<Fixture.Execution entry="resolve-decision" value={published} decision={request.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={published.continuation} expected={entry.expected ?? "keeps its existing recovery path"} as="refused" />
</Each>
<Dir path={held.fixture.repository}>
```bash exec as="dirty"
printf 'edited during the hold\n' > legacy.fixture
```
</Dir>
<Fixture.Execution entry="resolve-decision" value={held.work} decision={valid.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="requires clean source at the launch revision" as="refused" />
<Dir path={held.fixture.repository}>
```bash exec as="moved"
set -e
git checkout -q -- legacy.fixture
git -c commit.gpgsign=false commit -q --allow-empty -m 'moved during the hold'
```
</Dir>
<If condition={dirty.exitCode !== 0 || moved.exitCode !== 0}><Fail message={dirty.stderr + moved.stderr} /></If>
<Fixture.Execution entry="resolve-decision" value={held.work} decision={valid.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="requires clean source at the launch revision" as="refused" />
<Dir path={held.fixture.repository}>
```bash exec as="restored"
git reset -q --hard {held.task.revision}
```
</Dir>
<Fixture.Execution entry="resolve-decision" value={{...held.work,publication:"held"}} decision={valid.path} repository={held.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={held.work.continuation} expected="Unknown ticket publication" as="refused" />
<Ticket.Text path={held.work.continuation.path} as="heldStateAfter" />
<AssertEquals actual={heldStateAfter === heldState} expected={true} />
<Ticket.Load record={held.work} as="reloaded" />
<AssertEquals actual={reloaded} expected={saved} />
<Dir path={ticket}><Glob include={["decisions/**","calls/0001/**","attempts/0001/**","preparations/0001/**"]} as="effects" /></Dir>
<AssertEquals actual={effects} expected={[]} />
<Dir path={held.fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={1} />
</TempDir>

<TempDir>
<Fixture.DecisionHold root={props.root} scenario="first-consumer" ready={true} as="conflict" />
<Let as="conflictCall" value={conflict.saved.calls.at(-1)} />
<AssertEquals actual={[conflictCall.role,conflict.saved.checkpoint.hold.kind,conflict.saved.checkpoint.hold.next]} expected={["implementor","needs_discovery",{phase:"discovery",role:"planner"}]} />
<AssertEquals actual={conflict.work.nextAction} expected={{entry:"continue.md",gate:"implementation",action:"resolve_feedback_hold"}} />
<Fixture.DecisionRequest held={conflict} name="api-conflict" as="request" />
<Fixture.Execution entry="resolve-decision" value={conflict.work} decision={request.path} repository={conflict.fixture.repository} root={props.root} as="child" />
<Fixture.Refused output={child.stdout} continuation={conflict.work.continuation} expected="No supported decision route exists for implementation:implementor:needs_discovery" as="refused" />
<Dir path={conflict.saved.manifest.directory}><Glob include={["decisions/**"]} as="effects" /></Dir>
<AssertEquals actual={effects} expected={[]} />
<Dir path={conflict.fixture.root}><Glob include={["**/called.json"]} as="calls" /></Dir>
<AssertEquals actual={calls.length} expected={1} />
</TempDir>
