# WebForm

`<WebForm>` asks a person a structured question and binds their answer. This
document asks one — the responder installed by the harness answers it, so the
form completes without a browser while the server, the schema, and the validation
are all real.

```js eval
const reviewSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    note: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
};
```

The component renders nothing. What it produces is the validated response, bound
by `as` and read afterwards like any other value.

<Test name="A submitted answer becomes the captured value">
<Capture as="rendered">
<WebForm schema={reviewSchema} as="response">
# Review required

Read the plan and decide.
</WebForm>
</Capture>
<AssertEquals actual={rendered} expected={""} />
<AssertEquals actual={response.decision} expected={"approve"} />
<AssertEquals actual={response.note} expected={"looks right"} />
</Test>

A UI schema is optional, and it reaches the page without ever being validated as
a JSON Schema — it is RJSF configuration, which a strict validator would reject.

<Test name="An optional uiSchema is accepted">
<WebForm schema={reviewSchema} uiSchema={{ "ui:order": ["decision", "note"] }} as="second">
Decide again.
</WebForm>
<AssertEquals actual={second.decision} expected={"approve"} />
</Test>
