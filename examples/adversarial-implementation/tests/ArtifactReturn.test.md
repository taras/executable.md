```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />
<Let as="profile" value={["--include",root + "/examples/adversarial-implementation/tests/components","--include",root + "/examples/adversarial-implementation/components"]} />

<Test name="bounded artifact growth and saturation" timeout="110s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/artifact-return-growth.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{runner} {group}
```
</Test>

<Test name="migration repair uses retained result after original mutation or removal and holds on missing snapshot" timeout="100s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/artifact-return-repair.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{runner} {group}
```
</Test>
