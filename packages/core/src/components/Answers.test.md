# Answers

`<Answers>` supplies the answers to elicitations inside it. A component that
asks a person something asks whoever the host's provider reaches — unless the
surrounding document has already said what the answer is.

Nothing here installs a provider. That is the point: the region is the provider,
for as long as its body lasts.

<Test name="A matcher answers the elicitation inside it">

```ts persist eval
const decisionSchema = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
};
```

<Answers>
<Answer template="Approve {?what}?" value={{ decision: "approve" }} />

<Elicit schema={decisionSchema} as="review">Approve the plan?</Elicit>
</Answers>

<AssertEquals actual={review.decision} expected="approve" />
</Test>

`{?name}` matches any text and binds nothing — it says "something goes here"
without saying what, and without carrying it anywhere. The literal text around
it still has to match.

<Test name="A wildcard hole constrains without binding">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers>
<Answer template="Deploy {?service} to production?" value={{ step: "deployed" }} />

<Elicit schema={stepSchema} as="one">Deploy api to production?</Elicit>
</Answers>

<AssertEquals actual={one.step} expected="deployed" />
</Test>

A template written as children rather than a prop reads the same way, which is
what a multiline question needs.

<Test name="A template can be written as children">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers>
<Answer value={{ step: "multiline" }}>
Deploy {?service} to production?
</Answer>

<Elicit schema={stepSchema} as="two">Deploy api to production?</Elicit>
</Answers>

<AssertEquals actual={two.step} expected="multiline" />
</Test>

A matcher with no template at all matches anything.

<Test name="A templateless matcher answers anything">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers>
<Answer value={{ step: "catch-all" }} />

<Elicit schema={stepSchema} as="three">Any question whatsoever</Elicit>
</Answers>

<AssertEquals actual={three.step} expected="catch-all" />
</Test>

The first declared matching `<Answer>` answers, and a matcher is not used up by
answering. Together those two rules are the whole of selection — which means a
broad template written above a narrow one shadows it permanently.

<Test name="The first declared match wins, and matchers are reusable">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers>
<Answer template="Step {?n}?" value={{ step: "matched" }} />
<Answer template="Step one?" value={{ step: "never reached" }} />

<Elicit schema={stepSchema} as="a">Step one?</Elicit>
<Elicit schema={stepSchema} as="b">Step two?</Elicit>
</Answers>

<AssertEquals actual={[a.step, b.step]} expected={["matched", "matched"]} />
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

<Answers>
<Answer template="Which region?" value={{ step: "outer" }} />

<Answers>
<Answer template="Which region?" value={{ step: "inner" }} />

<Elicit schema={stepSchema} as="nearest">Which region?</Elicit>
</Answers>
</Answers>

<AssertEquals actual={nearest.step} expected="inner" />
</Test>

An elicitation no matcher answers is a failure by default: a document that
supplies answers is saying what will be asked. `delegate` says the other thing
explicitly — anything this region cannot answer passes outward, to an enclosing
region or to whatever the host installed.

<Test name="delegate passes unmatched elicitations outward">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers>
<Answer template="Outer question?" value={{ step: "from-outer" }} />

<Answers delegate={true}>
<Answer template="Inner question?" value={{ step: "from-inner" }} />

<Elicit schema={stepSchema} as="first">Inner question?</Elicit>
<Elicit schema={stepSchema} as="second">Outer question?</Elicit>
</Answers>
</Answers>

<AssertEquals
  actual={[first.step, second.step]}
  expected={["from-inner", "from-outer"]}
/>
</Test>

A matcher that never fires is not a mistake — a branch that did not run is still
a branch you were right to describe.

<Test name="A matcher that never fires is fine">

```ts persist eval
const stepSchema = {
  type: "object",
  properties: { step: { type: "string" } },
  required: ["step"],
};
```

<Answers>
<Answer template="Asked" value={{ step: "used" }} />
<Answer template="Never asked" value={{ step: "unused" }} />

<Elicit schema={stepSchema} as="only">Asked</Elicit>
</Answers>

<AssertEquals actual={only.step} expected="used" />
</Test>

Everything else is asserted in `answers-component.test.ts`: an unmatched
elicitation without `delegate`, a value the asking schema rejects, and the
configuration printed errors — a misplaced `<Answer>`, an `<Answers>` with no body,
both template forms at once, an unparseable template, and a `value` that is not
JSON. Those are raised printed errors and thrown failures rather than values, so a
document cannot assert on them about itself.
