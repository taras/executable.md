# Elicit

`<Elicit>` asks a person a question and binds their answer. It does not choose
how they are asked — the host installs a provider through the Elicitation Api,
and the document is the same either way.

Most of the tests below say what the answer is with an `<Answers>` region, which
is the document's own vocabulary for it: a matcher names a question and supplies
its answer, and the region is the provider for as long as its body lasts. What
that demonstrates is `<Elicit>` under an ordinary provider, because that is all
an `<Answers>` region is.

<Test name="A structured schema binds the answer">

```ts persist eval
const decisionSchema = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
  additionalProperties: false,
};
```

<Answers>
<Answer template="Approve the plan?" value={{ decision: "approve" }} />

<Elicit schema={decisionSchema} as="review">Approve the plan?</Elicit>
</Answers>

<AssertEquals actual={review.decision} expected="approve" />
</Test>

A schema may also be captured JSON text. Both spellings normalize to the same
compilation, so a document can hold its schema in a code fence or in a binding
and get identical behavior.

<Test name="A schema as captured JSON text binds the same way">

```ts persist eval
const decisionText = JSON.stringify({
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
});
```

<Answers>
<Answer template="Approve the plan?" value={{ decision: "reject" }} />

<Elicit schema={decisionText} as="review">Approve the plan?</Elicit>
</Answers>

<AssertEquals actual={review.decision} expected="reject" />
</Test>

The invocation content is the request. It is expanded first, so what the provider
receives is what a reader of the document would see — including anything the
document generated.

Seeing the request is the one thing an `<Answers>` region cannot show, because a
matcher answers a question rather than reporting it. So this test installs
middleware on the Elicitation Api directly — the same seam a host installs a
real provider on, and the way anything that needs to *observe* an elicitation
reaches it.

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

Several elicitations in one region are answered by whichever matcher matches
each, so the document says which answer belongs to which question rather than
relying on the order they happen to be asked in.

<Test name="Each elicitation takes the matcher that matches it">

```ts persist eval
const stepSchema = { type: "object", properties: { step: { type: "string" } }, required: ["step"] };
```

<Answers>
<Answer template="Step one?" value={{ step: "first" }} />
<Answer template="Step two?" value={{ step: "second" }} />
<Answer template="Step three?" value={{ step: "third" }} />

<Elicit schema={stepSchema} as="one">Step one?</Elicit>
<Elicit schema={stepSchema} as="two">Step two?</Elicit>
<Elicit schema={stepSchema} as="three">Step three?</Elicit>
</Answers>

<AssertEquals actual={[one.step, two.step, three.step]} expected={["first", "second", "third"]} />
</Test>

An elicitation no matcher answers fails the whole test rather than producing a
value, and `<Elicit>` is unmarked, so that failure is a thrown error rather than
a raised segment `<AssertThrows>` could capture. It is asserted in
`answers-component.test.ts`, where the failure itself can be observed, together
with the rest of the region's contract.
