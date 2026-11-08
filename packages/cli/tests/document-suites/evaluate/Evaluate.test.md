---
props: {}
---

# Tier FE — the one spelling this host accepts

Rows moved from `packages/cli/tests/evaluate-component.test.ts` under issue
#1184. `<Evaluate>` takes its program as `text` and nothing else: its schema is
closed, so a retired or unreleased spelling is refused by prop validation before
the fragment is evaluated. Each `<Test>` reads its document from a checked-in
fixture, beside a `notes.md` that fragment would have read, and runs it through
the production run host — the same assembly `xmd run` builds after its command
line is read. Fixture paths are relative to the repository root, where every
corpus invokes this suite.

`source` is no longer a spelling. The refusal names the prop, and the note the
fragment would have read never reaches the output.

<Test name="FE19: every profile refuses `source`, which is no longer a spelling">
<File path="packages/cli/tests/document-suites/evaluate/case-a.md" as="program" />
<TempDir>
<File path="notes.md">the retained note
</File>
<Execution host="run" source={program} as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={false} />
<AssertMatch actual={child.result.error.message} expected={/source|additional/i} />
<AssertStringIncludes actual={child.result.error.message} expected="Prop validation failed for <Evaluate />:" />
<AssertEquals actual={output.includes("the retained note")} expected={false} />
</Execution>
</TempDir>
</Test>

`program` was never released, and is refused the same way.

<Test name="FE19: every profile refuses `program`, which was never released">
<File path="packages/cli/tests/document-suites/evaluate/case-b.md" as="program" />
<TempDir>
<File path="notes.md">the retained note
</File>
<Execution host="run" source={program} as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={false} />
<AssertMatch actual={child.result.error.message} expected={/program|additional/i} />
<AssertStringIncludes actual={child.result.error.message} expected="Prop validation failed for <Evaluate />:" />
<AssertEquals actual={output.includes("the retained note")} expected={false} />
</Execution>
</TempDir>
</Test>
