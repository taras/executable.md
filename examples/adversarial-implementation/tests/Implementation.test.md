```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />

<Test name="Implementation fixture journeys" timeout="120s">
<Let as="program" value={'<Testing><Fixture.Implementation root={' + JSON.stringify(root) + '} command={' + JSON.stringify(runner) + '} /></Testing>'} />
<Let as="caseArguments" value={["--eval",program,"--plugin",root + "/packages/cli/tests/fixtures/workflow-test-permissions.mjs","--include",root + "/examples/adversarial-implementation/tests/components","--include",root + "/examples/adversarial-implementation/components"].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="cases"
{runner} {caseArguments}
```
<If condition={cases.exitCode !== 0}><Fail message={cases.stdout + "\n" + cases.stderr} /></If>
</Test>
