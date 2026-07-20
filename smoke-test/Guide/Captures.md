<Capture as="rendered">

<Section title="Binding Capture">

Binding capture routes rendered output into the eval binding environment
instead of writing it at the invocation site.

Component-level capture uses `as="name"`:

<Fragment as="capturedFromComponent">component binding from Fragment</Fragment>

Inline capture uses the built-in `<Capture>` directive:

<Capture as="capturedInline">inline binding from Capture
</Capture>

Captured bindings are available to later executable blocks:

```bash exec
echo "Capture values: {capturedFromComponent} | {capturedInline}"
```

Capture with CSS selector extracts specific content from rendered output:

<Capture as="capturedJson" select="code[lang=json]">
Some prose before the data.

```json
["alpha","bravo",42]
```

More prose after.
</Capture>

```bash exec
printf 'Selected JSON: %s\n' '{capturedJson}'
```

This Note is captured but intentionally not rendered inline:

<Note as="hiddenCapturedNote" message="Hidden capture should not render inline." />

</Section>

</Capture>

{rendered}

<Test name="Captures">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Binding Capture"} />
<AssertStringIncludes actual={rendered} expected={"Capture values:"} />
<AssertStringIncludes actual={rendered} expected={"component binding from Fragment"} />
<AssertStringIncludes actual={rendered} expected={"| inline binding from Capture"} />
<AssertNotMatch actual={rendered} expected={/Hidden capture should not render inline/} />
<AssertStringIncludes actual={rendered} expected={"Selected JSON: [\"alpha\",\"bravo\",42]"} />
<AssertNotMatch actual={rendered} expected={/Some prose before the data/} />
</Test>
