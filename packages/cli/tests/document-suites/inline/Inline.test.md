---
props: {}
---

# Tier IE — the inline root document

Rows moved from `packages/cli/tests/inline-cli.test.ts` under quest #543. Each
`<Test>` names the row it proves, and each child runs through the production
run host — an inline `source` follows the same `run -e` path, reporting the
`<eval>` identity and writing no file. File references are relative to the
repository root, the contextual invocation directory every corpus runs from.

<Test name="IE11: an empty document runs and produces nothing">
<Execution host="run" source="" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertEquals actual={output.trim()} expected="" />
</Execution>
</Test>

<Test name="IE15: a positioned diagnostic names a file-backed root by its path">
<Execution host="run" target="packages/cli/tests/document-suites/inline/stray-else.md" as="child">
<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={false} />
<AssertStringIncludes actual={child.result.error.message} expected="(packages/cli/tests/document-suites/inline/stray-else.md:1:1)" />
</Execution>
</Test>

<Test name="IE15: a positioned diagnostic names an inline root as eval">
<Execution host="run" source={"<Else>orphan</Else>\n"} as="child">
<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={false} />
<AssertStringIncludes actual={child.result.error.message} expected="(<eval>:1:1)" />
</Execution>
</Test>

<Test name="IE16: an inline relative path resolves against the invocation directory">
<Execution host="run" source={'<File path="packages/cli/tests/document-suites/inline/invocation-notes.md" />\n'} as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="notes from the invocation directory" />
</Execution>
</Test>

<Test name="IE16: nothing about eval supplies a base directory, so an absent file is simply not there">
<Execution host="run" source={'<File path="inline-suite-absent-notes.md" />\n'} as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="inline-suite-absent-notes.md" />
<AssertEquals actual={output.includes("notes from the invocation directory")} expected={false} />
</Execution>
</Test>

<Test name="IE23: an inline document addresses no target, so a hash in it is text">
<Execution host="run" source={"# Title\n\n## Alpha\n\nALPHA_MARKER\n\n## Beta\n\nBETA_MARKER\n"} as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertStringIncludes actual={output} expected="ALPHA_MARKER" />
<AssertStringIncludes actual={output} expected="BETA_MARKER" />
</Execution>
</Test>
