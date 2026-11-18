```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
<Each in={["selected-capacity","final-source","late-proof","current-permission","repeat-proof","repeat-snapshot","repeat-linkage","public-props"]} let="scenario">
<Test name={"P4/P6/P9 native recovery boundary: " + scenario} timeout="240s">
<Let as="caseArguments" value={["run","--allow-all","--node-modules-dir=manual","--cached-only","--frozen",root + "/packages/cli/tests/fixtures/joined-response-owner/boundary-runner.ts",scenario].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="ran"
deno {caseArguments}
```
<If condition={ran.exitCode !== 0}><Fail message={ran.stdout + "\n" + ran.stderr} /></If>
<Let as="checked" value={JSON.parse(ran.stdout.trim().split("\n").at(-1))} />
<AssertEquals actual={checked.refused} expected={true} />
<AssertEquals actual={checked.noProviderCalls} expected={true} />
</Test>
</Each>
