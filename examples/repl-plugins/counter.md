# Counter

Count visits in your live REPL session:

```xmd
<Counter as="visits" />
<Output>Visit <Json value={visits} /></Output>
```

Each invocation increments the same session counter. A child REPL has its own
counter. This component is available to authored entries.
