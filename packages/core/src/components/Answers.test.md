# Answers

`<Answers>` supplies the answers to elicitations inside it. A component that
asks a person something asks whoever the host's provider reaches — unless a
document has already said what the answer is.

Nothing here installs a provider. That is the point: the region is the provider,
for as long as its body lasts.

<Test name="A value answers the elicitation inside it">

```ts persist eval
const decisionSchema = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
};
```

<Answers values={[{ decision: "approve" }]}>
<Elicit schema={decisionSchema} as="review">Approve the plan?</Elicit>
</Answers>

<AssertEquals actual={review.decision} expected="approve" />
</Test>

`values` may also be captured JSON text, the same two spellings `schema`
accepts.

<Test name="Values as captured JSON text">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
const valuesText = JSON.stringify([{ step: "from text" }]);
```

<Answers values={valuesText}>
<Elicit schema={stepSchema} as="one">Step?</Elicit>
</Answers>

<AssertEquals actual={one.step} expected="from text" />
</Test>

Several elicitations take the values in order.

<Test name="Values are consumed in order">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers values={[{ step: "first" }, { step: "second" }]}>
<Elicit schema={stepSchema} as="a">Step one?</Elicit>
<Elicit schema={stepSchema} as="b">Step two?</Elicit>
</Answers>

<AssertEquals actual={[a.step, b.step]} expected={["first", "second"]} />
</Test>

Values the body never asks for are fine. A branch that did not run is not a
mistake, and this is a document construct rather than a test-exactness harness —
`scriptElicitations()` is the one that insists.

<Test name="Leftover values are not an error">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers values={[{ step: "used" }, { step: "never asked for" }]}>
<Elicit schema={stepSchema} as="only">Step?</Elicit>
</Answers>

<AssertEquals actual={only.step} expected="used" />
</Test>

Regions nest, and the nearest one answers. This is ordinary middleware nesting:
an inner region is closer to the elicitation than an outer one.

<Test name="The nearest region answers">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers values={[{ step: "outer" }]}>
<Answers values={[{ step: "inner" }]}>
<Elicit schema={stepSchema} as="nearest">Step?</Elicit>
</Answers>
</Answers>

<AssertEquals actual={nearest.step} expected="inner" />
</Test>

By default, an elicitation past the last value is a failure: a document that
supplies answers is saying what will be asked. `delegate` says the other thing
explicitly — anything this region cannot answer passes outward, to an enclosing
region or to whatever the host installed.

<Test name="delegate passes the rest outward">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers values={[{ step: "outer-1" }, { step: "outer-2" }]}>
<Answers values={[{ step: "inner-1" }]} delegate={true}>
<Elicit schema={stepSchema} as="a">Step one?</Elicit>
<Elicit schema={stepSchema} as="b">Step two?</Elicit>
<Elicit schema={stepSchema} as="c">Step three?</Elicit>
</Answers>
</Answers>

<AssertEquals
  actual={[a.step, b.step, c.step]}
  expected={["inner-1", "outer-1", "outer-2"]}
/>
</Test>

A supplied answer is still judged by the asking component's schema, and a region
that runs dry without `delegate` fails. Both are thrown failures rather than
raised segments — `<Elicit>` and `<Answers>` are unmarked — so
`answers-component.test.ts` is where they are asserted.
