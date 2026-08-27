---
props: {}
---

# Tier SM — `xmd syntax`, end to end

`xmd syntax` answers what a document may write in a directory, and it answers
without running any of it: no component body expands, no repository TypeScript
module is imported, and no journal exists. These rows check that against the
fixture directory beside this document, through the real command.

`$XMD_SYNTAX_BIN` is this repository's `xmd`. The launcher supplies it, because
which interpreter and entrypoint that is differs by runtime and a document does
not detect one.

## Running the command

Three invocations, once each: the default Markdown format, the same catalog as
version-1 JSON, and one more with two includes written in a deliberate order.

```bash exec as="markdown"
"$XMD_SYNTAX_BIN" syntax --include packages/cli/tests/document-suites/syntax/components
```

```bash exec as="json"
"$XMD_SYNTAX_BIN" syntax --json --include packages/cli/tests/document-suites/syntax/components
```

```bash exec as="ordered"
"$XMD_SYNTAX_BIN" syntax --json --include packages/cli/tests/document-suites/syntax/alternate --include packages/cli/tests/document-suites/syntax/components
```

Nothing the fixtures would do if they ran leaves a trace, and one of them writes
a file when it expands. Looking for that file is how "inspection expands
nothing" is checked rather than asserted.

<Glob include={["packages/cli/tests/document-suites/syntax/*.txt"]} as="markers" />

Both formats are projections of one catalog, so comparing them compares
renderers rather than two discoveries. Each binding below names one thing the
rows read.

<Let as="catalog" value={JSON.parse(json.stdout)} />
<Let as="categoryKinds" value={catalog.categories.map((category) => category.kind)} />
<Let as="builtInNames" value={catalog.categories[1].entries.map((entry) => entry.name)} />
<Let as="userEntries" value={catalog.categories[2].entries} />
<Let as="userNames" value={userEntries.map((entry) => entry.name)} />
<Let as="documented" value={userEntries.find((entry) => entry.name === "Documented")} />
<Let as="undocumented" value={userEntries.find((entry) => entry.name === "Undocumented")} />
<Let as="annotated" value={userEntries.find((entry) => entry.name === "Annotated")} />
<Let as="opaque" value={userEntries.find((entry) => entry.name === "Opaque")} />

<Let as="orderedEntries" value={JSON.parse(ordered.stdout).categories[2].entries} />
<Let as="orderedNames" value={orderedEntries.map((entry) => entry.name)} />
<Let as="orderedDocumented" value={orderedEntries.find((entry) => entry.name === "Documented")} />

<Let as="headingPositions" value={["## Built-in structural syntax", "## Built-in components", "## User-provided components"].map((heading) => markdown.stdout.indexOf(heading))} />
<Let as="headingsPresent" value={headingPositions.every((position) => position !== -1)} />
<Let as="headingsOrdered" value={headingPositions.join(",") === [...headingPositions].sort((one, other) => one - other).join(",")} />

<Let as="rendersEveryName" value={builtInNames.concat(userNames).every((name) => markdown.stdout.includes("<" + name + ">"))} />
<Let as="rendersEveryOrigin" value={userEntries.every((entry) => markdown.stdout.includes(entry.origin.path))} />

## Rows

<Test name="SM1: both commands succeed, so nothing in the fixtures was run">
<AssertEquals actual={markdown.exitCode} expected={0} />
<AssertEquals actual={json.exitCode} expected={0} />
<AssertEquals actual={ordered.exitCode} expected={0} />
</Test>

<Test name="SM2: the three categories render as top-level sections in a fixed order">
<AssertEquals actual={headingsPresent} expected={true} />
<AssertEquals actual={headingsOrdered} expected={true} />
<AssertEquals actual={categoryKinds} expected={["structural", "built-in", "user-provided"]} />
</Test>

<Test name="SM3: a documented Markdown component renders its prose and its props">
<AssertEquals actual={documented.description} expected="Greets the person a caller names." />
<AssertEquals actual={documented.as} expected="The rendered greeting." />
<AssertEquals actual={documented.context} expected="Markdown appended after the greeting." />
<AssertStringIncludes actual={markdown.stdout} expected="Greets the person a caller names." />
<AssertStringIncludes actual={markdown.stdout} expected="**`as`:** The rendered greeting." />
<AssertStringIncludes actual={markdown.stdout} expected="**Body context:** Markdown appended after the greeting." />
<AssertStringIncludes actual={markdown.stdout} expected="| `name` | `string` | yes | Who to greet |" />
</Test>

<Test name="SM4: an undocumented Markdown component stays discoverable and complete">
<AssertEquals actual={undocumented.inspectability} expected="complete" />
<AssertEquals actual={undocumented.description} expected={undefined} />
<AssertEquals actual={undocumented.returnMode} expected="text" />
<AssertEquals actual={undocumented.forms} expected={["self-closing", "paired"]} />
</Test>

<Test name="SM5: a non-string metadata value stays metadata and documents nothing">
<AssertEquals actual={annotated.description} expected={undefined} />
<AssertEquals actual={annotated.as} expected="Still an ordinary string." />
</Test>

<Test name="SM6: a repository TypeScript component is origin-only, and was not imported">
<AssertEquals actual={opaque.sourceKind} expected="typescript" />
<AssertEquals actual={opaque.inspectability} expected="origin-only" />
<AssertEquals actual={opaque.props} expected={undefined} />
<AssertEquals actual={opaque.forms} expected={undefined} />
<AssertStringIncludes actual={markdown.stdout} expected="The module was not imported" />
<AssertEquals actual={markdown.stdout.includes("declares no individual props\n\n```json\n{}\n```")} expected={false} />
</Test>

<Test name="SM7: discovery expanded no component body, so its effect never happened">
<AssertEquals actual={markers} expected={[]} />
</Test>

<Test name="SM8: repository paths map to direct, dotted and index names">
<AssertEquals actual={userNames} expected={["Annotated", "Documented", "Effectful", "Indexed", "Nested.Deep", "Opaque", "Undocumented"]} />
</Test>

<Test name="SM9: the two formats describe the same components the same way">
<AssertEquals actual={rendersEveryName} expected={true} />
<AssertEquals actual={rendersEveryOrigin} expected={true} />
<AssertStringIncludes actual={markdown.stdout} expected="**Forms:** `<Documented />`, `<Documented>…</Documented>`" />
<AssertStringIncludes actual={markdown.stdout} expected="**Returns:** text" />
</Test>

<Test name="SM10: repeated includes select in caller order, and the defaults do not participate">
<AssertEquals actual={orderedDocumented.origin.path} expected="packages/cli/tests/document-suites/syntax/alternate/Documented.md" />
<AssertEquals actual={orderedNames.includes("BootstrapNpmPackage")} expected={false} />
<AssertEquals actual={orderedNames.includes("Opaque")} expected={true} />
</Test>

<Test name="SM11: the built-in category holds the run profile, including <Session>">
<AssertEquals actual={builtInNames.includes("Session")} expected={true} />
<AssertEquals actual={builtInNames.includes("Prompt")} expected={true} />
<AssertEquals actual={builtInNames.includes("AssertEquals")} expected={true} />
<AssertEquals actual={builtInNames.includes("WebForm")} expected={true} />
<AssertEquals actual={builtInNames.includes("TempDir")} expected={true} />
</Test>
