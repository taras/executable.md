```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_TEST_COMMAND"
```
<Let as="tester" value={commandSetting.stdout || "deno run --quiet --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' test"} />
<Let as="profile" value={["--plugin",root + "/packages/cli/tests/fixtures/workflow-test-permissions.mjs","--include",root + "/examples/adversarial-implementation/tests/components","--include",root + "/examples/adversarial-implementation/components"]} />

<Test name="G1 G2 G3 G8 G9 normal launch preserves actual ordinary owners and captured evidence" timeout="90s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/implementation-launch.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{tester} {group}
```
</Test>

<Test name="G6 unavailable evidence source identities policy and occupied work hold without calls" timeout="90s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/implementation-holds.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{tester} {group}
```
</Test>

<Test name="G7 unresolved decisions precede routes and contradictory migration never falls through" timeout="90s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/implementation-decisions.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{tester} {group}
```
</Test>

<Test name="G8 ordinary planning decision holds with its original phase result and no implementation" timeout="60s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/implementation-planning-decision.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{tester} {group}
```
</Test>

<Test name="A1 A2 A4 ordinary discovery uses original owners and stops on refused dispositions" timeout="120s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/implementation-discovery.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{tester} {group}
```
</Test>
