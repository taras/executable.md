<Section title="Binding Capture">

Binding capture routes rendered output into the eval binding environment
instead of writing it at the invocation site.

Component-level capture uses `as="name"`:

<Fragment as="capturedFromComponent">component binding from Fragment</Fragment>

Inline capture uses the built-in `<Capture>` directive:

<Capture as="capturedInline">inline binding from Capture
</Capture>

Capture with CSS selector extracts specific content from rendered output.
The site below renders only its explanatory sentence — the captured prose
and JSON never render inline:

<Capture as="jsonSite">Selecting from rich content:
<Capture as="capturedJson" select="code[lang=json]">
Some prose before the data.

```json
["alpha","bravo",42]
```

More prose after.
</Capture></Capture>
{jsonSite}

This Note is captured but intentionally not rendered inline:

<Capture as="hiddenNoteSite">Hidden note site:
<Note as="hiddenCapturedNote" message="Hidden capture should not render inline." /></Capture>
{hiddenNoteSite}

<Test name="Captures">
<AssertEquals actual={capturedFromComponent} expected={"\ncomponent binding from Fragment\n"} />
<AssertEquals actual={capturedInline} expected={"inline binding from Capture"} />
<AssertEquals actual={capturedJson} expected={"[\"alpha\",\"bravo\",42]"} />
<AssertEquals actual={hiddenCapturedNote} expected={"\n> 📝 **info:** Hidden capture should not render inline.\n"} />
<AssertEquals actual={jsonSite} expected={"Selecting from rich content:"} />
<AssertEquals actual={hiddenNoteSite} expected={"Hidden note site:"} />
<AssertNotMatch actual={jsonSite} expected={/Some prose before the data/} />
<AssertNotMatch actual={hiddenNoteSite} expected={/Hidden capture should not render inline/} />
</Test>

</Section>
