---
props: {}
---

# Tier CT — xmd run target selection

Rows moved from `packages/cli/tests/targets-cli.test.ts` under quest #543. Each
`<Test>` names the row it proves, and each child runs through the production
run host — the same assembly `xmd run` builds after its command line is read.
Child references are relative to the repository root, where every corpus
invokes this suite.

<Test name="CT7: an explicit run executes one target and excludes both siblings">
<Execution host="run" target="packages/cli/tests/document-suites/targets/report.md#Beta" as="child">
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

<Test name="CT9: a trailing wildcard resolving to one target executes that target">
<Execution host="run" target="packages/cli/tests/document-suites/targets/report.md#Al*" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="ALPHA_MARKER" />
<AssertEquals actual={output.includes("BETA_MARKER")} expected={false} />
</Execution>
</Test>

<Test name="CT9: an embedded wildcard resolving to one target executes that target">
<Execution host="run" target="packages/cli/tests/document-suites/targets/report.md#G*a" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="GAMMA_MARKER" />
</Execution>
</Test>

<Test name="CT9: a recursive wildcard resolving to one target executes that target">
<Execution host="run" target="packages/cli/tests/document-suites/targets/report.md#**/Nested" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="NESTED_MARKER" />
<AssertEquals actual={output.includes("ALPHA_MARKER")} expected={false} />
</Execution>
</Test>

<Test name="CT13a: a heading holding a slash runs through its reference">
<Execution host="run" target="packages/cli/tests/document-suites/targets/exotic.md#a%2Fb" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="SLASH_MARKER" />
</Execution>
</Test>

<Test name="CT13a: a heading holding a star runs through its reference">
<Execution host="run" target="packages/cli/tests/document-suites/targets/exotic.md#star%2A" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="STAR_MARKER" />
</Execution>
</Test>

<Test name="CT13a: a heading holding a hash runs through its reference">
<Execution host="run" target="packages/cli/tests/document-suites/targets/exotic.md#hash%23tag" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="HASH_MARKER" />
</Execution>
</Test>

<Test name="CT13b: a heading holding a percent runs through its reference">
<Execution host="run" target="packages/cli/tests/document-suites/targets/exotic.md#pct%25value" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="PCT_MARKER" />
</Execution>
</Test>

<Test name="CT13b: a heading holding whitespace runs through its reference">
<Execution host="run" target="packages/cli/tests/document-suites/targets/exotic.md#two%20words" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="SPACE_MARKER" />
</Execution>
</Test>

<Test name="CT13b: a heading holding Unicode runs through its reference">
<Execution host="run" target="packages/cli/tests/document-suites/targets/exotic.md#%C3%9Cn%C3%AFc%C3%B8d%C3%A9" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="UNICODE_MARKER" />
</Execution>
</Test>

<Test name="CT16: a target failure outranks an invalid props schema and runs nothing">
<Execution host="run" target="packages/cli/tests/document-suites/targets/broken-schema.md#Absent" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={false} />
<AssertStringIncludes actual={child.result.error.message} expected={'"Absent" matches no document target.'} />
<AssertStringIncludes actual={child.result.error.message} expected="Kept" />
<AssertEquals actual={child.result.error.message.includes("invalid props schema")} expected={false} />
<AssertEquals actual={output.includes("KEPT_EFFECT_MARKER")} expected={false} />
</Execution>
</Test>

<Test name="CT16: a target the document offers lets the schema failure be reported">
<Execution host="run" target="packages/cli/tests/document-suites/targets/broken-schema.md#Kept" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={false} />
<AssertStringIncludes actual={child.result.error.message} expected="invalid props schema" />
<AssertEquals actual={child.result.error.message.includes("matches no document target")} expected={false} />
<AssertEquals actual={output.includes("KEPT_EFFECT_MARKER")} expected={false} />
</Execution>
</Test>
