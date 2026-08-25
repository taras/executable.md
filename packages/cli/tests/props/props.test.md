# Tier PC — xmd run document properties

Rows moved from `packages/cli/tests/props-cli.test.ts` under quest #543
(specs/root-document-props-spec.md). Each `<Test>` names the row it proves, and
each child runs through the production run host — the same assembly `xmd run`
builds after its command line is read. Child references are relative to the
repository root, where every corpus invokes this suite.

<Test name="PC9: a missing required property fails before any document effect">
<Execution host="run" target="packages/cli/tests/props/side-effect.md" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={false} />
<AssertStringIncludes actual={child.result.error.message} expected="must have required property 'name'" />
<AssertEquals actual={output.includes("SIDE_EFFECT_MARKER")} expected={false} />
</Execution>
</Test>
