<Section title="Return Values">

A component returns one thing. `Note` declares no `returns`, so its rendered
Markdown is its return value — invoking it renders that text, and `as` binds
it as a string. `Verdict` declares `returns`, which makes it a value
component: it renders nothing, must be invoked with `as`, and binds a
schema-validated JSON value produced by its single top-level `<Return>`. The
caller decides how to present it.

</Section>

<Test name="A text component returns its rendered markdown">
<Note as="renderedNote" message="Text components are unchanged." />
<AssertEquals actual={renderedNote} expected={"\n> 📝 **info:** Text components are unchanged.\n"} />
</Test>

<Test name="A value component binds its validated value and renders nothing">
<Capture as="verdictSite">Verdict site:
<Verdict as="verdict" findings={[]} /></Capture>
<AssertEquals actual={verdict.passed} expected={true} />
<AssertEquals actual={verdict.summary} expected={"no findings"} />
<AssertEquals actual={verdictSite} expected={"Verdict site:"} />
<AssertNotMatch actual={verdictSite} expected={/VERDICT_DOC_LEAK/} />
</Test>

<Test name="The caller renders whatever presentation it wants from the value">
<Verdict as="failing" findings={["missing test", "stale doc"]} />
<Capture as="report"><If condition={!failing.passed}>Needs revision: {failing.summary}</If></Capture>
<AssertEquals actual={report} expected={"Needs revision: 2 findings"} />
</Test>

<Section title="Structured root results">

A root document uses the same two modes, minus the capture: it has no caller,
so a value root needs no `as`. `xmd run smoke-test/value-root.md` executes the
whole document and prints only its validated value:

```json
{"passed":true,"summary":"no findings"}
```

Rendered body output stays observability — `--verbose` sends it to stderr, and
without it the body renders nowhere. A failure writes its diagnostic to stderr
and exits non-zero, so stdout never carries anything but a successful result.

</Section>
