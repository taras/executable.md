```bash exec as="suiteLocation"
pwd -P
```
<Let as="suiteRoot" value={suiteLocation.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + suiteRoot.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />

<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Bounded test migration.",evidence:["/fixture/intent.md"]}} />
<Test name="a consumer mismatch repairs the API in the same sessions" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="api-repair" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="feedback_ready" />
<AssertEquals actual={work.history.length} expected={4} />
<Ticket.Text path={fixture.directory + "/foundation-2/called.json"} as="calledText" />
<Parse schema={{type:"object"}} as="called">{calledText}</Parse>
<AssertEquals actual={called.session} expected="original-planner" />
<AssertEquals actual={called.initialize} expected={false} />
<Ticket.Text path={fixture.directory + "/migration-1/attempts/0000/called.json"} as="migratorText" />
<Parse schema={{type:"object"}} as="migrator">{migratorText}</Parse>
<AssertEquals actual={migrator.session} expected="original-implementor" />
<AssertEquals actual={migrator.initialize} expected={false} />
</TempDir>
</Test>
<Test name="the API repair bound preserves the failed consumer" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="api-repair" command={runner} root={suiteRoot} maxApiRepairs={0} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertStringIncludes actual={work.reason} expected="API repair bound reached" />
</TempDir>
</Test>

<Test name="a provider blocker holds without invoking migration" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="blocked" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertEquals actual={work.history.length} expected={1} />
<AssertEquals actual={work.reason} expected="Wait for provider availability." />
</TempDir>
</Test>

<Test name="passing reviews do not waive the retirement outcome" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="kept-fixture" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertStringIncludes actual={work.reason} expected="promised to retire" />
</TempDir>
</Test>
