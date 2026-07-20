<Section title="Binding Capture">

Binding capture routes rendered output into the eval binding environment
instead of writing it at the invocation site. Component-level capture
uses `as="name"` on any component invocation; inline capture uses the
built-in `<Capture>` directive; and `<Capture select="...">` extracts
specific nodes from rendered content with a CSS selector.

</Section>

<Test name="Component as-capture binds without rendering inline">
<Capture as="hiddenNoteSite">Hidden note site:
<Note as="hiddenCapturedNote" message="Hidden capture should not render inline." /></Capture>
<AssertEquals actual={hiddenCapturedNote} expected={"\n> 📝 **info:** Hidden capture should not render inline.\n"} />
<AssertEquals actual={hiddenNoteSite} expected={"Hidden note site:"} />
<AssertNotMatch actual={hiddenNoteSite} expected={/Hidden capture should not render inline/} />
</Test>

<Test name="Capture binds inline content">
<Capture as="capturedInline">inline binding from Capture
</Capture>
<AssertEquals actual={capturedInline} expected={"inline binding from Capture"} />
</Test>

<Test name="Capture select extracts the matching node">
<Capture as="jsonSite">Selecting from rich content:
<Capture as="capturedJson" select="code[lang=json]">
Some prose before the data.

```json
["alpha","bravo",42]
```

More prose after.
</Capture></Capture>
<AssertEquals actual={capturedJson} expected={"[\"alpha\",\"bravo\",42]"} />
<AssertEquals actual={jsonSite} expected={"Selecting from rich content:"} />
<AssertNotMatch actual={jsonSite} expected={/Some prose before the data/} />
</Test>
