```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="testCommandSetting"
printf '%s' "$XMD_EXAMPLE_TEST_COMMAND"
```
<Let as="tester" value={testCommandSetting.stdout || "deno run --quiet --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' test"} />
<Let as="profile" value={["--plugin",root + "/packages/cli/tests/fixtures/workflow-test-permissions.mjs","--include",root + "/examples/adversarial-implementation/tests/components","--include",root + "/examples/adversarial-implementation/components"]} />

<Test name="a joined progress reply gets one same-session completion with a separate formatting allowance" timeout="90s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/delivery-progress-completion.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{tester} {group}
```
</Test>
