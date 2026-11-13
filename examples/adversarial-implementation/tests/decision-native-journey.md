---
props:
  type: object
  properties:
    manifest: {type: string}
    root: {type: string}
    variant: {enum: [continued, missing, first-failure]}
  required: [manifest, root, variant]
---
<Ticket.Read path={props.manifest} limit={1048576} as="text" />
<Parse schema={{type:"object"}} as="manifest">{text}</Parse>
<Ticket.Run manifest={props.manifest} maxSteps={1} as="heldReturn" />
<Ticket.Load record={heldReturn} as="held" />
<If condition={props.variant === "first-failure"}>
<Dir path={manifest.directory + "/attempts"}><Glob include={["**/*"]} as="attemptsBefore" /></Dir>
<Ticket.Continue record={heldReturn} maxSteps={1} as="continuedReturn" />
<Ticket.Load record={continuedReturn} as="continued" />
<Dir path={manifest.directory + "/attempts"}><Glob include={["**/*"]} as="attemptsAfter" /></Dir>
<Output><Json value={{held,heldReturn,continued,continuedReturn,attemptsBefore,attemptsAfter}} /></Output>
<Else>
<Let as="identityPath" value={manifest.directory + "/sessions/" + encodeURIComponent(manifest.roles.planner.session) + ".json"} />
<Ticket.Read path={identityPath} limit={1048576} as="identityBefore" />
<Dir path={props.root}><File path="decision.md">Decision native: accept the held proposal.</File><File path="provenance.md">Standing coordinator authority; no new human answer is recorded.</File></Dir>
<Ticket.Documents repository={props.root} directory={props.root + "/described"} paths={[props.root + "/decision.md",props.root + "/provenance.md"]} as="described" />
<Let as="result" value={held.documents[held.calls[0].result]} />
<Let as="facts" value={Object.fromEntries(Object.entries(described).map(([path,document]) => [path,{path,utf8Bytes:document.utf8Bytes,sha256:document.sha256}]))} />
<Dir path={props.root}><File path="decision.json"><Json value={{schema:"ticket-decision.v1",work:manifest.work,continuation:heldReturn.continuation,heldResult:{path:result.path,utf8Bytes:result.utf8Bytes,sha256:result.sha256},disposition:"accept",decision:facts[props.root + "/decision.md"],provenance:facts[props.root + "/provenance.md"],acceptedInputs:[]}} /></File></Dir>
<Ticket.ResolveDecision record={heldReturn} decision={props.root + "/decision.json"} as="resolvedReturn" />
<Ticket.Read path={identityPath} limit={1048576} as="identityResolved" />
<If condition={props.variant === "missing"}>
<Let as="quoted" value={"'" + identityPath.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="removed"
rm -- {quoted}
```
</If>
<Ticket.Continue record={resolvedReturn} maxSteps={1} as="continuedReturn" />
<Ticket.Load record={continuedReturn} as="continued" />
<Ticket.Capture as="identityAfter"><Ticket.Read path={identityPath} limit={1048576} as="identityText" /><Json value={identityText} /></Ticket.Capture>
<Output><Json value={{held,heldReturn,resolvedReturn,continued,continuedReturn,identityBefore,identityResolved,identityAfter}} /></Output>
</Else></If>
