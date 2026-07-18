---
title: Output Demo
---

# {meta.title}

This paragraph is documentation. It explains how the component works but
must never reach the consumer — OUTPUTDEMO_DOC_LEAK should not appear in the
rendered output.

```ts eval
const ready = true;
```

The eval block above runs as documentation, before the `<Output>` region is
evaluated, so `<Show>` below can depend on the `ready` binding it computed.

<Output>

<Show when={ready}>

OUTPUTDEMO_SELECTED

</Show>

</Output>
