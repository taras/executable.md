---
description: 'Hold an unsatisfied independent review and ask for its supported disposition. Use <Delivery.Hold delivery={delivery} revision={revision} as="held" />.'
props:
  type: object
  properties:
    delivery: {type: object}
    revision: {type: string, pattern: '^[0-9a-f]{40}$'}
  required: [delivery, revision]
  additionalProperties: false
returns: {type: object}
---

The hold is written before anyone is asked, so an unanswered or cancelled
question leaves it in place for the next explicit review action. A retained
answer is never asked again.

<Delivery.Attempts delivery={props.delivery} revision={props.revision} as="read" />
<If condition={read.state.hold === null}>
<Let as="exhausted" value={read.state.next === "exhausted"} />
<Dir path={read.directory}><File path="hold.json"><Json value={{schema:"delivery-review-hold.v1",work:props.delivery.work,revision:props.revision,chain:read.selection.chain,summary:exhausted ? "Every eligible independent reviewer failed without a valid review." : "The selected review attempt is uncertain, so no replacement reviewer may start.",unknown:exhausted ? "No eligible reviewer remains for this revision." : "Whether the held attempt completed and released its provider is not established.",attempts:read.state.attempts}} /></File></Dir>
<Delivery.Attempts delivery={props.delivery} revision={props.revision} as="read" />
</If>
<If condition={read.state.hold === null || !read.state.hold.valid}><Fail message="The retained review hold is malformed or belongs to another selection. Preserve it and reconcile the delivery records; no reviewer was started." /></If>
<If condition={read.state.hold.answer !== null}><Fail message={"The review hold was already answered with " + read.state.hold.answer.disposition + ". A retained answer starts no reviewer and is not asked again."} /></If>
<Let as="hold" value={read.state.hold.record} />
<Let as="answerSchema" value={{type:"object",properties:{disposition:{type:"string",enum:["hold","reconcile"],title:"Delivery decision",description:"hold leaves delivery waiting. reconcile reads and validates the existing attempt evidence once."}},required:["disposition"],additionalProperties:false}} />
<Elicit schema={answerSchema} as="answer">
Independent review of {props.revision} is not satisfied. {hold.summary} {hold.unknown}

<Each in={hold.attempts} let="attempt">
- {attempt.reviewer.provider} {attempt.reviewer.model} in conversation {attempt.reviewer.session}: {attempt.state}. {attempt.reason}
</Each>

Choose hold to leave delivery waiting, or reconcile to read and validate the existing attempt evidence once. Neither choice starts another reviewer, waives the review or changes a correction allowance.
</Elicit>
<Dir path={read.directory}><File path="disposition.json"><Json value={{schema:"delivery-review-disposition.v1",hold,answer}} /></File></Dir>
<Let as="result" value={{status:"held",hold,answer,receipt:null,reconciliation:null}} />
<If condition={answer.disposition === "reconcile"}>
<Try>
<Delivery.Reconcile delivery={props.delivery} revision={props.revision} publish={true} as="receipt" />
<Return value={{...result,status:"reconciled",receipt}} />
<Catch as="error"><Return value={{...result,reconciliation:error.message}} /></Catch>
</Try>
<Else>
<Return value={result} />
</Else>
</If>
