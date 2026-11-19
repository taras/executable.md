```bash exec as="suiteLocation"
pwd -P
```
<Let as="suiteRoot" value={suiteLocation.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + suiteRoot.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />

<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Bounded test migration.",evidence:["/fixture/intent.md"]}} />
<Test name="a narrated fenced foundation reply needs no productive replay" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="fenced" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="feedback_ready" />
<Ticket.Text path={fixture.directory + "/foundation-0/response-acceptance.json"} as="text" />
<Parse schema={{type:"object"}} as="accepted">{text}</Parse>
<AssertEquals actual={accepted.round} expected={0} />
</TempDir>
</Test>
<Test name="an oversized summary is repaired in the same session without repeating implementation" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="response-repair" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="feedback_ready" />
<Ticket.Text path={fixture.directory + "/foundation-0/response-corrections/1/called.json"} as="text" />
<Parse schema={{type:"object"}} as="called">{text}</Parse>
<AssertEquals actual={called} expected={{session:"original-planner",initialize:false,productive:false}} />
</TempDir>
</Test>

<Test name="response repair cannot change the API and stops after three attempts" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="response-tamper" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertStringIncludes actual={work.reason} expected="selected response-only correction budget is exhausted" />
<Ticket.Text path={fixture.directory + "/foundation-0/response-corrections/3/disposition.json"} as="text" />
<Parse schema={{type:"object"}} as="disposition">{text}</Parse>
<AssertEquals actual={disposition.accepted} expected={false} />
</TempDir>
</Test>

<Test name="response repair holds if its owner changes source" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="response-source" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertStringIncludes actual={work.reason} expected="Response-only correction changed source" />
</TempDir>
</Test>

<Test name="ambiguous foundation results hold without a response correction" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="ambiguous" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertStringIncludes actual={work.reason} expected="No unambiguous substantive foundation result" />
</TempDir>
</Test>

<Test name="a failing API example prevents every migration call" timeout="60s">
<TempDir>
<Fixture.Repository as="fixture" />
<Fixture.Run fixture={fixture} request="failed-example" command={runner} root={suiteRoot} as="child" />
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<AssertEquals actual={work.status} expected="hold" />
<AssertEquals actual={work.history.length} expected={1} />
<AssertStringIncludes actual={work.reason} expected="API validation failed" />
<Ticket.Text path={fixture.directory + "/foundation-0/example-1.json"} as="firstFailure" />
<AssertStringIncludes actual={firstFailure} expected='"exitCode": 1' />
</TempDir>
</Test>
