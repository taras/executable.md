<Section title="Binding Capture">

Binding routes a value into the eval binding environment instead of writing it
at the invocation site. Component-level capture uses `as="name"` on any
component invocation. The built-in `<Let>` directive binds either what its
children render — narrowed by `<Let select="...">` to the first node a CSS
selector matches — or, written with `value`, the exact value that prop names,
which is how structured data reaches a later prop without a round trip through
text.

</Section>

<Test name="Component as-capture binds without rendering inline">
<Let as="hiddenNoteSite">Hidden note site:
<Note as="hiddenCapturedNote" message="Hidden capture should not render inline." /></Let>
<AssertEquals actual={hiddenCapturedNote} expected={"\n> 📝 **info:** Hidden capture should not render inline.\n"} />
<AssertEquals actual={hiddenNoteSite} expected={"Hidden note site:"} />
<AssertNotMatch actual={hiddenNoteSite} expected={/Hidden capture should not render inline/} />
</Test>

<Test name="Let binds inline content">
<Let as="capturedInline">inline binding from Let
</Let>
<AssertEquals actual={capturedInline} expected={"inline binding from Let"} />
</Test>

<Test name="Let select extracts the matching node">
<Let as="jsonSite">Selecting from rich content:
<Let as="capturedJson" select="code[lang=json]">
Some prose before the data.

```json
["alpha","bravo",42]
```

More prose after.
</Let></Let>
<AssertEquals actual={capturedJson} expected={"[\"alpha\",\"bravo\",42]"} />
<AssertEquals actual={jsonSite} expected={"Selecting from rich content:"} />
<AssertNotMatch actual={jsonSite} expected={/Some prose before the data/} />
</Test>

<Test name="Let binds a direct value rather than rendering it">
<Let
  as="releaseSchema"
  value={{
    type: "object",
    required: ["bump"],
    properties: { bump: { enum: ["patch", "minor", "major"] } }
  }}
/>
<AssertEquals actual={typeof releaseSchema} expected={"object"} />
<AssertEquals actual={releaseSchema.properties.bump.enum[2]} expected={"major"} />
</Test>

<Test name="Let binds a preceding value by reference">
```js eval
const settings = { title: "Release", steps: [1, 2] };
```
<Let as="alias" value={settings} />
<AssertStrictEquals actual={alias} expected={settings} />
</Test>
