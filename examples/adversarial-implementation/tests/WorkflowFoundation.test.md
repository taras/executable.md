```bash exec as="suiteLocation"
pwd -P
```
<Let as="suiteRoot" value={suiteLocation.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + suiteRoot.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />

<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Bounded test migration.",evidence:["/fixture/intent.md"]}} />
<Test name="real committed examples precede migration and obsolete files disappear" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="normal" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="feedback_ready" />
<AssertEquals actual={work.history.length} expected={2} />
<Ticket.Text path={fixture.directory + "/retirement.json"} as="retirement" />
<AssertStringIncludes actual={retirement} expected="legacy.fixture" />
</TempDir>
</Test>
<Test name="structural foundations reach Architect before migration" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="structural" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="feedback_ready" />
<Ticket.Text path={fixture.directory + "/foundation-review-1/called.json"} as="calledText" />
<Parse schema={{type:"object"}} as="called">{calledText}</Parse>
<Ticket.Text path={fixture.directory + "/foundation-0/validated-api.json"} as="apiText" />
<Parse schema={{type:"object"}} as="api">{apiText}</Parse>
<AssertEquals actual={called.revision} expected={api.revision} />
<AssertEquals actual={called.changedPaths.includes("api.sh")} expected={true} />
</TempDir>
</Test>

<Test name="a rejected structural foundation starts no migration" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="structural-rejected" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertEquals actual={work.history.length} expected={1} />
<AssertStringIncludes actual={work.reason} expected="requires Architect acceptance" />
</TempDir>
</Test>

<Test name="a migration cannot silently change the validated API" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="change-api" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertStringIncludes actual={work.reason.reason} expected="API-owned path" />
</TempDir>
</Test>
