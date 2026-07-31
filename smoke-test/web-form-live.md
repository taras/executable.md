# WebForm live

A form the compiled binary must actually serve, and one you can answer by hand.

Run it and the form opens in your browser. What the document prints afterwards
depends on what you chose, so a manual check confirms the whole path — the
answer really reaches the workflow rather than merely being accepted by a server.

CI answers nothing. The smoke step reads the printed URL, fetches the page and
the client script, checks the bundle is the real one, and terminates the process
— which is the other half of what it proves, because teardown on interruption is
part of the contract.

```js eval
const reviewSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    confirmed: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
};

const reviewUi = {
  note: { "ui:widget": "textarea" },
};
```

The schema asks for a required choice, an optional checkbox, and free text, so
answering it exercises a select, a checkbox, and a textarea — the three widget
kinds the bundled theme has to render.

<WebForm schema={reviewSchema} uiSchema={reviewUi} as="review">
# Decide

Approve or reject, and say why if you like.

Leaving the choice empty and submitting should show a field error rather than
sending anything.
</WebForm>

## What you chose

<If condition={review.decision === "approve"}>
**Approved.**

The workflow would carry on from here.
<Else>
**Rejected.**

The workflow would stop, and this is where it would say so.
</Else>
</If>

<If condition={review.confirmed === true}>
You ticked the confirmation box.
<Else>
You left the confirmation box unticked.
</Else>
</If>

<If condition={typeof review.note === "string" && review.note.length > 0}>
Your note: {review.note}
<Else>
You left the note empty, which the schema allows.
</Else>
</If>

The form is gone now — its port is released, and answering it a second time is
no longer possible.
