---
title: Executable MDX
---

<Capture as="rendered">

<Section title="Expression Props">

Expression props pass runtime values from eval blocks to child
components. Unlike string attributes, expression props resolve
at expansion time against the eval binding environment.

```js eval
const dynamicGreeting = "Howdy";
const dynamicSubject = "expression props";
const itemCount = 3;
```

The values computed above flow into PropDemo via expression props:

<PropDemo greeting={dynamicGreeting} subject={dynamicSubject} />

JSON literals resolve at scan time — no eval block needed:

<Note message="JSON props: count={42}, verbose={true}" />

</Section>

<Section title="Text Interpolation">

Eval bindings also resolve in **prose text**, not just code blocks. Values
computed in eval blocks flow naturally into surrounding text without
needing a template literal inside an eval block.

```js eval
const textPort = 49821;
const textHost = "127.0.0.1";
```

The server is running at {textHost}:{textPort}.

Both `{meta.*}` / `{props.*}` and bare `{name}` work in the same text.
Meta values resolve first, then eval bindings fill in remaining references.
The document title is {meta.title} and the text port is {textPort}.

Escaped braces produce literal output: \{textPort} stays as-is.

If a bare reference has no matching binding, it passes through verbatim:
{undefinedBinding} is not resolved.

Non-string values are coerced via `String()`. The count from the
Expression Props section is {itemCount}.

</Section>

</Capture>

{rendered}

<Test name="Interpolation">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Expression Props"} />
<AssertStringIncludes actual={rendered} expected={"\u00a7 Text Interpolation"} />
</Test>
