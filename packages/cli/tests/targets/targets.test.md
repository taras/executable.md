# Tier CT — xmd run target selection

Rows moved from `packages/cli/tests/targets-cli.test.ts` under quest #543. Each
`<Test>` names the row it proves, and each child runs through the production
run host — the same assembly `xmd run` builds after its command line is read.
Child references are relative to the repository root, where every corpus
invokes this suite.

<Test name="CT7: an explicit run executes one target and excludes both siblings">
<Execution host="run" target="packages/cli/tests/targets/report.md#Beta" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="PREAMBLE_MARKER" />
<AssertStringIncludes actual={output} expected="BETA_MARKER" />
<AssertStringIncludes actual={output} expected="NESTED_MARKER" />
<AssertEquals actual={output.includes("ALPHA_MARKER")} expected={false} />
<AssertEquals actual={output.includes("GAMMA_MARKER")} expected={false} />
</Execution>
</Test>
