Long-form documentation for the components the web package registers.

One component. It answers the same question core's `<Elicit>` does — ask a
person something and validate the answer — and differs only in *where* the
asking happens.

## WebForm

Asks a person a question in a browser form.

```mdx
<WebForm schema={preferences} uiSchema={layout} as="answer">
Choose how the release notes should be grouped.
</WebForm>
```

Builds the form from `schema` and shows its content above it. `uiSchema` sets
presentation options — ordering, widgets, labels — without changing what the
answer has to be. The validated response binds through `as`, which is required:
the answer is the point.

Reach for `<Elicit>` instead when the document should not choose the browser. It
asks the same question and lets the host decide how — a terminal prompt, or
whatever else that host arranges. `<WebForm>` is for when the question genuinely
needs a form: several fields, a choice among many, anything awkward to type at a
prompt.
