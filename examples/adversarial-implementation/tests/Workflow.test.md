```bash exec as="suiteLocation"
pwd -P
```
<Let as="suiteRoot" value={suiteLocation.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + suiteRoot.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run"} />

<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Bounded test migration.",evidence:["/fixture/intent.md"]}} />

<Test name="fixed models separate design, migration and conditional architecture">
<Phase.Profile role="planner" design={true} assessment={assessment} as="design" />
<Phase.Profile role="planner" assessment={assessment} as="review" />
<Phase.Profile role="implementor" assessment={assessment} as="migration" />
<Phase.Profile role="architect" assessment={assessment} as="architecture" />
<AssertEquals actual={design} expected={{provider:"claude",model:"opus",effort:"high"}} />
<AssertEquals actual={review} expected={{provider:"claude",model:"opus",effort:"medium"}} />
<AssertEquals actual={migration} expected={{provider:"claude",model:"sonnet",effort:"high"}} />
<AssertEquals actual={architecture} expected={{provider:"codex",model:"gpt-6.1-sol",effort:"medium"}} />
</Test>

<Test name="the API contract requires intent, maintenance and real examples">
<Adversarial.Schema as="schemas" />
<SafeParse schema={schemas.api} as="paper"><Json value={{purpose:"Only an interface."}} /></SafeParse>
<AssertEquals actual={paper.ok} expected={false} />
</Test>

<Test name="an API conflict returns to Planner while other discovery keeps Architect">
<Let as="result" value={{phase:"implementation",outcome:"needs_discovery",next:{phase:"discovery",role:"planner"},handoff:"Planner: repair the API.",work:"test",revision:"1111111111111111111111111111111111111111",apiConflict:{expected:"resize",observed:"missing",reproducer:"call resize",artifact:"/witness"}}} />
<Phase.Route result={result} successor="review" role="planner" as="api" />
<AssertEquals actual={api.ok} expected={true} />
<Phase.Route result={{...result,apiConflict:undefined,next:{phase:"discovery",role:"architect"}}} successor="review" role="architect" as="other" />
<AssertEquals actual={other.ok} expected={true} />
</Test>

<Test name="metadata assignments stop before any workflow role">
<Ticket.Capture as="refused"><Phase.Run phase="review" role="planner" session="never-called" assignment={{}} attempt="/unused" responseProfile={{kind:"delivery-editorial",knownDocuments:[]}} as="unexpected" /></Ticket.Capture>
<AssertEquals actual={refused.status} expected="failed" />
<AssertStringIncludes actual={refused.failure} expected="metadata belong" />
</Test>

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
