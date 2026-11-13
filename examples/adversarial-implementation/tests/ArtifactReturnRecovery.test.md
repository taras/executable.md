```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />
<Let as="profile" value={["--include",root + "/examples/adversarial-implementation/tests/components","--include",root + "/examples/adversarial-implementation/components"]} />

<Test name="first File text, protected recovery and joined reader cleanup" timeout="110s">
<Let as="group" value={[root + "/examples/adversarial-implementation/tests/artifact-return-recovery.md",...profile].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec
{runner} {group}
```
</Test>
