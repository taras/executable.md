# Elicit

`<Elicit>` asks a person a question and binds their answer. It does not choose
how they are asked — the host installs a provider through the Elicitation Api,
and the document is the same either way.

Every test below installs an ordered queue of answers instead of a person. That
is an eval block rather than a component on purpose: installing Context Api
middleware is what an eval block is for here, and a testing-only prop or
component would be a second way to configure something that already has one.

The queue is exact. One answer is consumed per elicitation, running out is a
failure, and answers left over fail the test when it ends — so a test that stops
asking what it says it asks stops passing.

<Test name="A structured schema binds the answer">

```ts persist eval
yield* scriptElicitations([{ decision: "approve" }]);
const decisionSchema = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
  additionalProperties: false,
};
```

<Elicit schema={decisionSchema} as="review">Approve the plan?</Elicit>
<AssertEquals actual={review.decision} expected="approve" />
</Test>

A schema may also be captured JSON text. Both spellings normalize to the same
compilation, so a document can hold its schema in a code fence or in a binding
and get identical behavior.

<Test name="A schema as captured JSON text binds the same way">

```ts persist eval
yield* scriptElicitations([{ decision: "reject" }]);
const decisionText = JSON.stringify({
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
});
```

<Elicit schema={decisionText} as="review">Approve the plan?</Elicit>
<AssertEquals actual={review.decision} expected="reject" />
</Test>

The invocation content is the request. It is expanded first, so what the provider
receives is what a reader of the document would see — including anything the
document generated.

<Test name="The invocation content becomes the request">

```ts persist eval
const asked = [];
yield* Elicitation.around({
  *elicit([request]) {
    asked.push(request.message);
    return { acknowledged: true };
  },
}, { at: "min" });
const ackSchema = { type: "object", properties: { acknowledged: { type: "boolean" } } };
const plan = "ship it";
```

<Elicit schema={ackSchema} as="ack">Please review: {plan}</Elicit>
<AssertEquals actual={ack.acknowledged} expected={true} />
<AssertStringIncludes actual={asked[0]} expected="Please review: ship it" />
</Test>

`<Elicit>` declares a return value, so it renders nothing and `as` binds what
came back. Nothing of the question reaches the surrounding document — the
lower-level suite asserts the emitted text directly, which a document cannot
observe about itself.

Several elicitations consume the queue in order.

<Test name="Several elicitations consume their answers in order">

```ts persist eval
yield* scriptElicitations([{ step: "first" }, { step: "second" }, { step: "third" }]);
const stepSchema = { type: "object", properties: { step: { type: "string" } }, required: ["step"] };
```

<Elicit schema={stepSchema} as="one">Step one?</Elicit>
<Elicit schema={stepSchema} as="two">Step two?</Elicit>
<Elicit schema={stepSchema} as="three">Step three?</Elicit>

<AssertEquals actual={[one.step, two.step, three.step]} expected={["first", "second", "third"]} />
</Test>

Two more properties of the queue are not written here. Running out of scripted
answers, and leaving answers unused, both fail the whole test rather than
producing a value — and `<Elicit>` is unmarked, so its failure is a thrown error
rather than a raised segment that `<AssertThrows>` could capture. Those live in
`elicit-script.test.ts`, where the failure itself can be observed.
