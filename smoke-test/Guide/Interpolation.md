---
title: Executable MDX
---

<Section title="Expression Props">

Expression props pass runtime values from eval blocks to child
components. Unlike string attributes, expression props resolve
at expansion time against the eval binding environment. JSON literals
resolve at scan time — no eval block needed — and non-string values
coerce via `String()` when interpolated in text.

</Section>

<Test name="Expression props resolve from eval bindings">
```js eval
const dynamicGreeting = "Howdy";
const dynamicSubject = "expression props";
```
<Capture as="expressionPropDemo"><PropDemo greeting={dynamicGreeting} subject={dynamicSubject} /></Capture>
<AssertEquals actual={expressionPropDemo} expected={"\nThe caller said: \"Howdy, expression props!\"\n\n\n> 📝 **info:** Props were successfully passed through to this component."} />
</Test>

<Test name="JSON literal props resolve at scan time">
<Capture as="jsonPropNote"><Note message="JSON props: count={42}, verbose={true}" /></Capture>
<AssertEquals actual={jsonPropNote} expected={"\n> 📝 **info:** JSON props: count={42}, verbose={true}"} />
</Test>

<Test name="Non-string bindings coerce in text">
```js eval
const itemCount = 3;
```
<Capture as="coercionLine">The count computed above is {itemCount}.</Capture>
<AssertEquals actual={coercionLine} expected={"The count computed above is 3."} />
</Test>

<Section title="Text Interpolation">

Eval bindings also resolve in **prose text**, not just code blocks. Values
computed in eval blocks flow naturally into surrounding text without
needing a template literal inside an eval block. Both `{meta.*}` /
`{props.*}` and bare `{name}` work in the same text: meta values resolve
first, then eval bindings fill in remaining references. Escaped braces
stay literal, and references with no matching binding pass through
verbatim.

</Section>

<Test name="Eval bindings resolve in prose text">
```js eval
const textPort = 49821;
const textHost = "127.0.0.1";
```
<Capture as="hostLine">The server is running at {textHost}:{textPort}.</Capture>
<AssertEquals actual={hostLine} expected={"The server is running at 127.0.0.1:49821."} />
</Test>

<Test name="Meta and eval bindings share the same text">
```js eval
const textPort = 49821;
```
<Capture as="metaLine">The document title is {meta.title} and the text port is {textPort}.</Capture>
<AssertEquals actual={metaLine} expected={"The document title is Executable MDX and the text port is 49821."} />
</Test>

<Test name="Escaped braces stay literal">
```js eval
const textPort = 49821;
```
<Capture as="escapedLine">Escaped braces produce literal output: \{textPort} stays as-is.</Capture>
<AssertEquals actual={escapedLine} expected={"Escaped braces produce literal output: {textPort} stays as-is."} />
</Test>

<Test name="Unresolved references pass through verbatim">
<Capture as="unresolvedLine">If a bare reference has no matching binding, it passes through verbatim: {undefinedBinding} is not resolved.</Capture>
<AssertEquals actual={unresolvedLine} expected={"If a bare reference has no matching binding, it passes through verbatim: {undefinedBinding} is not resolved."} />
</Test>
