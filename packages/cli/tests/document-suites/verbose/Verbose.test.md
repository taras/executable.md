---
props: {}
---

# Tier VB — `<Verbose>`, end to end

`<Verbose>` is a run-profile component, so these rows exercise it through the
real `xmd run` command. The launcher supplies `$XMD_VERBOSE_BIN` because the
runtime-specific entrypoint differs across the corpus, and
`$XMD_VERBOSE_COMPONENTS` because the lexical-override rows run from a
temporary directory and select the checked-in fixture components by absolute
path.

<Test name="VB1: ordinary runs skip verbose content">
<TempDir>
<Let as="source" value={"Start\n\n<Verbose>\nHidden\n</Verbose>\n\nEnd\n"} />
<File path="doc.md">{source}</File>
```bash exec as="plain"
"$XMD_VERBOSE_BIN" run doc.md --raw
```

<AssertEquals actual={plain.exitCode} expected={0} />
<AssertStringIncludes actual={plain.stdout} expected="Start" />
<AssertStringIncludes actual={plain.stdout} expected="End" />
<AssertEquals actual={plain.stdout.includes("Hidden")} expected={false} />
</TempDir>
</Test>

<Test name="VB2: --verbose expands verbose content">
<TempDir>
<Let as="source" value={"Start\n\n<Verbose>\nShown\n</Verbose>\n\nEnd\n"} />
<File path="doc.md">{source}</File>
```bash exec as="verbose"
"$XMD_VERBOSE_BIN" run doc.md --raw --verbose
```

<AssertEquals actual={verbose.exitCode} expected={0} />
<AssertStringIncludes actual={verbose.stdout} expected="Start" />
<AssertStringIncludes actual={verbose.stdout} expected="Shown" />
<AssertStringIncludes actual={verbose.stdout} expected="End" />
</TempDir>
</Test>

<Test name="VB3: skipped content does not execute">
<TempDir>
<Let as="source" value={"Before\n\n<Verbose>\n<Missing />\n</Verbose>\n\nAfter\n"} />
<File path="doc.md">{source}</File>
```bash exec as="plain"
"$XMD_VERBOSE_BIN" run doc.md --raw
```

<AssertEquals actual={plain.exitCode} expected={0} />
<AssertStringIncludes actual={plain.stdout} expected="Before" />
<AssertStringIncludes actual={plain.stdout} expected="After" />
<AssertEquals actual={plain.stderr.includes("Missing")} expected={false} />
</TempDir>
</Test>

<Test name="VB4: repository components can replace it">
<TempDir>
<File path="components/Verbose.md">Replacement
</File>
<Let as="source" value={"<Verbose>Ignored</Verbose>\n"} />
<File path="doc.md">{source}</File>
```bash exec as="plain"
"$XMD_VERBOSE_BIN" run doc.md --raw
```

<AssertEquals actual={plain.exitCode} expected={0} />
<AssertStringIncludes actual={plain.stdout} expected="Replacement" />
<AssertEquals actual={plain.stdout.includes("Ignored")} expected={false} />
</TempDir>
</Test>

<Test name="VB7: run-host children retain the built-in Verbose">
<Execution host="run" source={"Before\n\n<Verbose>\n<Missing />\n</Verbose>\n\nAfter\n"} as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="Before" />
<AssertStringIncludes actual={output} expected="After" />
<AssertEquals actual={output.includes("Missing")} expected={false} />
</Execution>
</Test>

<Test name="VB8: direct xmd test roots receive no built-in Verbose">
<TempDir>
<Let as="source" value={"<Test name=\"direct boundary\">\n<Verbose>\ntest-profile verbose body executed\n<Fail message=\"verbose sentinel executed\" />\n</Verbose>\n</Test>\n"} />
<File path="direct.test.md">{source}</File>
```bash exec as="testProfile"
"$XMD_VERBOSE_BIN" test direct.test.md --verbose
```

<Let as="combined" value={testProfile.stdout + testProfile.stderr} />
<AssertEquals actual={testProfile.exitCode === 0} expected={false} />
<AssertStringIncludes actual={combined} expected="Verbose" />
<AssertEquals actual={combined.includes("test-profile verbose body executed")} expected={false} />
<AssertEquals actual={combined.includes("verbose sentinel executed")} expected={false} />
</TempDir>
</Test>

<Test name="VB9: a nearer true verbosity reaches its own content and nothing else">
<TempDir>
<Let
   as="source"
   value={"<Verbose>outer-before-hidden</Verbose>\n\n<Verbose.Enable>\n<Verbose>inner-visible</Verbose>\n</Verbose.Enable>\n\n<Verbose>outer-after-hidden</Verbose>\n"}
/>
<File path="doc.md">{source}</File>
```bash exec as="nested"
"$XMD_VERBOSE_BIN" run doc.md --raw --include "$XMD_VERBOSE_COMPONENTS"
```

<AssertEquals actual={nested.exitCode} expected={0} />
<AssertStringIncludes actual={nested.stdout} expected="inner-visible" />
<AssertEquals actual={nested.stdout.includes("outer-before-hidden")} expected={false} />
<AssertEquals actual={nested.stdout.includes("outer-after-hidden")} expected={false} />
</TempDir>
</Test>

<Test name="VB10: a nearer false verbosity skips its body and restores the enclosing value">
<TempDir>
<Let
   as="source"
   value={"<Verbose>outer-before-visible</Verbose>\n\n<Verbose.Disable>\n<Verbose>\n<Fail message=\"verbose sentinel executed\" />\n</Verbose>\n</Verbose.Disable>\n\n<Verbose>outer-after-visible</Verbose>\n"}
/>
<File path="doc.md">{source}</File>
```bash exec as="nested"
"$XMD_VERBOSE_BIN" run doc.md --raw --verbose --include "$XMD_VERBOSE_COMPONENTS"
```

<Let as="combined" value={nested.stdout + nested.stderr} />
<AssertEquals actual={nested.exitCode} expected={0} />
<AssertStringIncludes actual={nested.stdout} expected="outer-before-visible" />
<AssertStringIncludes actual={nested.stdout} expected="outer-after-visible" />
<AssertEquals actual={combined.includes("verbose sentinel executed")} expected={false} />
</TempDir>
</Test>
