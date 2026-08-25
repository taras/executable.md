# Tier IE — the inline root document

Rows moved from `packages/cli/tests/inline-cli.test.ts` under quest #543. Each
`<Test>` names the row it proves, and each child runs through the production
run host — the inline `source` follows the same `run -e` path, reporting the
`<eval>` identity and writing no file.

<Test name="IE11: an empty document runs and produces nothing">
<Execution host="run" source="" as="child">
<CollectOutput as="output" />

<AssertEquals actual={child.kind} expected="settled" />
<AssertEquals actual={child.result.ok} expected={true} />
<AssertEquals actual={output.trim()} expected="" />
</Execution>
</Test>
