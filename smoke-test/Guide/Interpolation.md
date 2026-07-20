---
title: Executable MDX
---

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

<Capture as="expressionPropDemo"><PropDemo greeting={dynamicGreeting} subject={dynamicSubject} /></Capture>

{expressionPropDemo}

JSON literals resolve at scan time — no eval block needed:

<Capture as="jsonPropNote"><Note message="JSON props: count={42}, verbose={true}" /></Capture>

{jsonPropNote}

Non-string values are coerced via `String()` when interpolated in text:

<Capture as="coercionLine">The count computed above is {itemCount}.</Capture>
{coercionLine}

<Test name="Expression props">
<AssertEquals actual={expressionPropDemo} expected={"\nThe caller said: \"Howdy, expression props!\"\n\n\n> 📝 **info:** Props were successfully passed through to this component."} />
<AssertEquals actual={jsonPropNote} expected={"\n> 📝 **info:** JSON props: count={42}, verbose={true}"} />
<AssertEquals actual={coercionLine} expected={"The count computed above is 3."} />
</Test>

</Section>

<Section title="Text Interpolation">

Eval bindings also resolve in **prose text**, not just code blocks. Values
computed in eval blocks flow naturally into surrounding text without
needing a template literal inside an eval block.

```js eval
const textPort = 49821;
const textHost = "127.0.0.1";
```

<Capture as="hostLine">The server is running at {textHost}:{textPort}.</Capture>
{hostLine}

Both `{meta.*}` / `{props.*}` and bare `{name}` work in the same text.
Meta values resolve first, then eval bindings fill in remaining references
— here the enclosing Section's `{meta.emoji}` meets an eval binding:

<Capture as="metaLine">Meta and bindings coexist: section emoji {meta.emoji} and text port {textPort}.</Capture>
{metaLine}

<Capture as="escapedLine">Escaped braces produce literal output: \{textPort} stays as-is.</Capture>
{escapedLine}

<Capture as="unresolvedLine">If a bare reference has no matching binding, it passes through verbatim: {undefinedBinding} is not resolved.</Capture>
{unresolvedLine}

<Test name="Text interpolation">
<AssertEquals actual={hostLine} expected={"The server is running at 127.0.0.1:49821."} />
<AssertEquals actual={metaLine} expected={"Meta and bindings coexist: section emoji § and text port 49821."} />
<AssertEquals actual={escapedLine} expected={"Escaped braces produce literal output: {textPort} stays as-is."} />
<AssertEquals actual={unresolvedLine} expected={"If a bare reference has no matching binding, it passes through verbatim: {undefinedBinding} is not resolved."} />
</Test>

</Section>
