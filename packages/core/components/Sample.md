---
meta:
  componentName: Sample

inputs:
  type: object
  properties:
    prompt:
      type: string
      default: ""
      description: >
        Text prompt to send to the Sample Api. Used in self-closing mode
        when no children are provided. If both children and prompt are
        present, children output takes precedence.
    model:
      type: string
      default: ""
      description: >
        Model routing key. When set, the SampleContext.model field is
        populated so the Sample Api middleware can route to a specific
        provider. When unset, the innermost active provider handles the call.
    params:
      type: string
      default: ""
      description: >
        Additional instruction params passed to the Sample Api middleware
        as SampleContext.params. Providers can use this for custom behavior
        (e.g., "brief", "json", "classify").
  additionalProperties: false
---

```js persist eval
const childrenOutput = yield* renderChildren();
const content = childrenOutput || prompt || '';

const sampleResult = yield* Sample.operations.sample({
  content,
  params: params || undefined,
  componentName: 'Sample',
  model: model || undefined,
});

return sampleResult;
```
