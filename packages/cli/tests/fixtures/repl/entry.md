```js eval
const plan = { title: "Ship the REPL", steps: 2 };
const summarySource = `<Json value={${JSON.stringify(plan)}} />`;
const responseSchema = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "decline"] } },
  required: ["decision"],
  additionalProperties: false,
};
```

<Checklist title={plan.title} steps={plan.steps} />

<Evaluate text={summarySource} />

<Elicit schema={responseSchema} as="response">Approve {plan.title}?</Elicit>

Decision: {response.decision}
