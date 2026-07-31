# WebForm live

A form the compiled binary must actually serve. The schema is valid, so this
document reaches the live path: it binds a port, prints its URL, and waits.

Nothing answers it. The smoke step reads the printed URL, fetches the page and
the client script over HTTP, checks the bundle is the real one, and terminates
the process — which is the other half of what it proves, because teardown on
interruption is part of the contract.

```js eval
const reviewSchema = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
  additionalProperties: false,
};
```

<WebForm schema={reviewSchema} as="never">
# Decide

This form is served but never answered.
</WebForm>
