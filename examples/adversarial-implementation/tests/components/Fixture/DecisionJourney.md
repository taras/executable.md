---
description: >-
  Resolve one prospective managed hold and continue it through its original owners.
  Use <Fixture.DecisionJourney root={root} scenario="decision" disposition="accept"
  route={["planner","implementor"]} />.
props:
  type: object
  properties:
    root: {type: string}
    scenario: {type: string}
    disposition: {enum: [accept, amend]}
    route: {type: array, items: {enum: [architect, planner, implementor]}}
  required: [root, scenario, disposition, route]
  additionalProperties: false
---

<TempDir>
<Fixture.DecisionHold root={props.root} scenario={props.scenario} as="held" />
<Let as="saved" value={held.saved} />
<Let as="last" value={saved.calls.at(-1)} />
<Let as="before" value={saved.calls.length} />
<AssertEquals actual={held.work.nextAction} expected={{entry:"resolve-decision.md",gate:saved.checkpoint.gate,action:"resolve_decision",result:last.result,input:"ticket-decision.v1"}} />
<Dir path={held.fixture.repository}>
```bash exec as="checkout"
git rev-parse HEAD
git status --porcelain --untracked-files=no
```
</Dir>
<AssertEquals actual={[checkout.stdout,saved.checkpoint.revision,saved.checkpoint.feedback]} expected={[held.task.revision + "\n",held.task.revision,[]]} />
<Ticket.Text path={held.work.continuation.path} as="heldState" />
<Ticket.Text path={last.result} as="heldResultText" />
<Parse schema={{type:"object"}} as="heldResult">{heldResultText}</Parse>
<If condition={props.scenario === "all-owner"}>
<AssertEquals actual={[last.role,last.assignment.phase,heldResult.outcome,heldResult.next,heldResult.revision,heldResult.apiConflict]} expected={["implementor","implementation","needs_discovery",{phase:"discovery",role:"architect"},held.task.revision,undefined]} />
<AssertEquals actual={saved.checkpoint.hold.next} expected={{phase:"discovery",role:"architect"}} />
<Else><AssertEquals actual={[last.assignment.phase,heldResult.outcome]} expected={["discovery","needs_decision"]} /></Else>
</If>
<Dir path={held.fixture.root}><File path="selected.md">Selected accepted input for the routed owner.</File></Dir>
<Ticket.Documents repository={held.fixture.root} directory={held.fixture.root + "/described"} paths={[held.fixture.root + "/selected.md"]} as="selectedFacts" />
<Let as="selected" value={selectedFacts[held.fixture.root + "/selected.md"]} />
<Fixture.DecisionRequest held={held} name="journey" disposition={props.disposition} acceptedInputs={[{path:selected.path,utf8Bytes:selected.utf8Bytes,sha256:selected.sha256}]} as="decision" />
<If condition={props.scenario === "architect-decision"}>
<Fixture.DecisionRequest held={held} name="architect-amend" disposition="amend" as="amend" />
<Fixture.Execution entry="resolve-decision" value={held.work} decision={amend.path} repository={held.fixture.repository} root={props.root} as="refusedChild" />
<Parse schema={{type:"object"}} as="refused">{refusedChild.stdout}</Parse>
<AssertEquals actual={[refused.publication,refused.continuation]} expected={["held",held.work.continuation]} />
<AssertStringIncludes actual={refused.failure.message} expected="No supported decision route exists for discovery:architect:needs_decision with disposition amend" />
</If>
<Fixture.Execution entry="resolve-decision" value={held.work} decision={decision.path} repository={held.fixture.repository} root={props.root} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="resolvedReturn">{child.stdout}</Parse>
<If condition={resolvedReturn.publication !== "confirmed"}><Fail message={JSON.stringify(resolvedReturn)} /></If>
<AssertEquals actual={[resolvedReturn.status,resolvedReturn.revision,resolvedReturn.nextAction.entry,resolvedReturn.nextAction.action]} expected={["running",held.task.revision,"continue.md","continue_feedback"]} />
<Ticket.Load record={resolvedReturn} as="resolved" />
<Let as="reservation" value={saved.manifest.directory + "/decisions/" + held.work.continuation.sha256} />
<Dir path={held.fixture.root}><Glob include={["**/called.json"]} as="resolutionCalls" /></Dir>
<AssertEquals actual={resolutionCalls.length} expected={before} />
<AssertEquals actual={resolved.calls} expected={saved.calls} />
<AssertEquals actual={resolved.manifest} expected={saved.manifest} />
<AssertEquals actual={resolved.deliveredInputs} expected={saved.deliveredInputs} />
<AssertEquals actual={Object.keys(saved.deliveredInputs).length > 0} expected={true} />
<AssertEquals actual={[resolved.checkpoint.round,resolved.checkpoint.initialized,resolved.checkpoint.reviews,resolved.checkpoint.feedback,resolved.checkpoint.discovery,resolved.checkpoint.reviewPolicy]} expected={[saved.checkpoint.round,saved.checkpoint.initialized,saved.checkpoint.reviews,saved.checkpoint.feedback,saved.checkpoint.discovery,saved.checkpoint.reviewPolicy]} />
<AssertEquals actual={[resolved.checkpoint.gate,resolved.checkpoint.assignment.recipient,resolved.checkpoint.assignment.phase,resolved.checkpoint.decisions,resolved.checkpoint.hold]} expected={[props.route[0] === "planner" ? "planning" : "architect-discovery",props.route[0],"discovery",[reservation],null]} />
<AssertEquals actual={resolved.checkpoint.assignment.handoffInputs} expected={[decision.request.decision.path,decision.request.provenance.path,selected.path]} />
<AssertEquals actual={resolved.checkpoint.assignment.artifacts} expected={[last.result,reservation + "/request.json"]} />
<AssertEquals actual={resolved.checkpoint.assignment.handoffInputs.map(path => [resolved.documents[path].utf8Bytes,resolved.documents[path].sha256,resolved.documents[path].observation])} expected={[[decision.request.decision.utf8Bytes,decision.request.decision.sha256,"file"],[decision.request.provenance.utf8Bytes,decision.request.provenance.sha256,"file"],[selected.utf8Bytes,selected.sha256,"file"]]} />
<Ticket.Text path={held.work.continuation.path} as="heldStateAfter" />
<AssertEquals actual={heldStateAfter === heldState} expected={true} />
<Ticket.Text path={reservation + "/receipt.json"} as="receiptText" />
<Parse schema={{type:"object"}} as="receipt">{receiptText}</Parse>
<AssertEquals actual={[receipt.schema,receipt.status,receipt.call,receipt.route.gate,receipt.route.disposition,receipt.successor.continuation]} expected={["ticket-decision-receipt.v1","confirmed",last.id,resolved.checkpoint.gate,props.disposition,resolvedReturn.continuation]} />
<AssertEquals actual={receipt.request} expected={decision.request} />
<Ticket.Text path={reservation + "/request.json"} as="reservationText" />
<AssertEquals actual={reservationText.includes("Decision journey") || receiptText.includes("Decision journey")} expected={false} />
<Let as="current" value={resolvedReturn} />
<Let as="step" value={0} />
<Loop max={props.route.length}>
<Fixture.Execution entry="continue" value={current} repository={held.fixture.repository} steps={1} root={props.root} as="continuation" />
<If condition={continuation.exitCode !== 0}><Fail message={continuation.stderr || continuation.stdout} /></If>
<Parse schema={{type:"object"}} as="current">{continuation.stdout}</Parse>
<If condition={current.publication !== "confirmed"}><Fail message={JSON.stringify(current)} /></If>
<Let as="step" value={step + 1} />
</Loop>
<Ticket.Load record={current} as="continued" />
<AssertEquals actual={continued.calls.slice(0,before)} expected={saved.calls} />
<AssertEquals actual={continued.calls.slice(before).map(call => call.role)} expected={props.route} />
<AssertEquals actual={continued.calls.every(call => call.session === saved.manifest.roles[call.role].session && call.provider === saved.manifest.roles[call.role].provider)} expected={true} />
<AssertEquals actual={continued.calls.slice(before).map(call => call.initialize)} expected={props.route.map((role,index) => !saved.checkpoint.initialized[role] && props.route.indexOf(role) === index)} />
<AssertEquals actual={continued.calls.slice(before).map(call => call.assignment.phase)} expected={props.route.map(role => role === "implementor" ? "implementation" : "discovery")} />
<AssertEquals actual={continued.calls.slice(before).map(call => call.status)} expected={props.route.map(() => "accepted")} />
<Let as="first" value={continued.calls[before]} />
<AssertStringIncludes actual={first.assignment.request} expected={"Resolve the " + heldResult.outcome + " held by the original " + last.role} />
<AssertEquals actual={first.inputs.some(input => input.path === held.evidence)} expected={!(saved.deliveredInputs[first.session] ?? []).includes(held.evidence)} />
<AssertEquals actual={[decision.request.decision.path,decision.request.provenance.path,selected.path].every(path => first.inputs.some(input => input.path === path))} expected={true} />
<Ticket.Text path={first.attempt + "/called.json"} as="calledText" />
<Parse schema={{type:"object"}} as="called">{calledText}</Parse>
<AssertEquals actual={[called.session,called.role,called.initialize,called.phase,called.inputPaths]} expected={[first.session,first.role,first.initialize,"discovery",first.inputs.map(input => input.path)]} />
<AssertEquals actual={continued.checkpoint.round} expected={saved.checkpoint.round} />
<AssertEquals actual={continued.manifest.maxCorrections} expected={saved.manifest.maxCorrections} />
<AssertEquals actual={continued.checkpoint.decisions} expected={[reservation]} />
<Ticket.Text path={last.result} as="heldResultAfter" />
<AssertEquals actual={heldResultAfter === heldResultText} expected={true} />
<Let as="implementation" value={continued.calls.at(-1)} />
<AssertEquals actual={[implementation.role,implementation.session]} expected={["implementor",saved.manifest.roles.implementor.session]} />
<AssertEquals actual={[current.status,continued.checkpoint.gate === "implementation"]} expected={["paused",false]} />
<Dir path={held.fixture.root}><Glob include={["**/called.json"]} as="allCalls" /></Dir>
<AssertEquals actual={allCalls.length} expected={before + props.route.length} />
</TempDir>
