---
description: >-
  Save decision texts and one ticket-decision.v1 request bound to a held ticket. Use
  <Fixture.DecisionRequest held={held} name="accept" disposition="accept" as="decision" />.
props:
  type: object
  properties:
    held: {type: object}
    name: {type: string}
    disposition: {type: string, default: accept}
    acceptedInputs: {type: array, default: []}
    override: {type: object, default: {}}
  required: [held, name]
  additionalProperties: false
returns: {type: object}
---

<Let as="directory" value={props.held.fixture.root + "/decisions/" + props.name} />
<Dir path={directory}>
<Let as="decisionText" value={"Decision " + props.name + ": " + props.disposition + " the held proposal within the accepted scope."} />
<File path="decision.md">{decisionText}</File>
<File path="provenance.md">Standing coordinator authority recorded in the accepted contract; no new human answer is recorded.</File>
</Dir>
<Ticket.Documents repository={directory} directory={directory + "/described"} paths={[directory + "/decision.md",directory + "/provenance.md"]} as="described" />
<Let as="result" value={props.held.saved.documents[props.held.saved.calls.at(-1).result]} />
<Let as="decision" value={described[directory + "/decision.md"]} />
<Let as="provenance" value={described[directory + "/provenance.md"]} />
<Let as="request" value={{schema:"ticket-decision.v1",work:props.held.saved.manifest.work,continuation:props.held.work.continuation,heldResult:{path:result.path,utf8Bytes:result.utf8Bytes,sha256:result.sha256},disposition:props.disposition,decision:{path:decision.path,utf8Bytes:decision.utf8Bytes,sha256:decision.sha256},provenance:{path:provenance.path,utf8Bytes:provenance.utf8Bytes,sha256:provenance.sha256},acceptedInputs:props.acceptedInputs,...props.override}} />
<Dir path={directory}><File path="decision.json"><Json value={request} /></File></Dir>
<Return value={{path:directory + "/decision.json",request,directory}} />
