```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />
<Let as="cases" value={[
  {name:"DR1 A1 A6 accepting a Planner decision continues the original Planner, then implementation",fixture:'<Fixture.DecisionJourney root={ROOT} scenario="decision" disposition="accept" route={["planner","implementor"]} />'},
  {name:"DR2 A2 amending a Planner decision routes original Architect, retained Planner, then Implementor",fixture:'<Fixture.DecisionJourney root={ROOT} scenario="decision" disposition="amend" route={["architect","planner","implementor"]} />'},
  {name:"DR3 A2 accepting an Architect decision returns to that Architect before the retained Planner",fixture:'<Fixture.DecisionJourney root={ROOT} scenario="architect-decision" disposition="accept" route={["architect","planner","implementor"]} />'},
  {name:"DR4 A3 an Implementor discovery hold at clean source routes Architect, retained Planner, original Implementor",fixture:'<Fixture.DecisionJourney root={ROOT} scenario="all-owner" disposition="accept" route={["architect","planner","implementor"]} />'},
  {name:"DR5 A4 A6 stale, foreign, unsupported and excluded resolutions refuse without dispatch or managed change",fixture:'<Fixture.DecisionRefusal root={ROOT} />'},
  {name:"DR6 A5 repeats, contenders and interrupted publication never duplicate or adopt effects",fixture:'<Fixture.DecisionInterruption root={ROOT} />'},
  {name:"DR7 A6 decision inputs keep snapshot, descriptor, protection, permission and capacity boundaries",fixture:'<Fixture.DecisionBoundary root={ROOT} />'}
]} />

<Each in={cases} let="selected">
<Test name={selected.name} timeout="180s">
<Let as="program" value={'<Testing><Test name="case" timeout="170s">' + selected.fixture.replaceAll("ROOT",JSON.stringify(root)) + '</Test></Testing>'} />
<Let as="caseArguments" value={["--eval",program,"--plugin",root + "/packages/cli/tests/fixtures/workflow-test-permissions.mjs","--include",root + "/examples/adversarial-implementation/tests/components","--include",root + "/examples/adversarial-implementation/components"].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="ran"
{runner} {caseArguments}
```
<If condition={ran.exitCode !== 0}><Fail message={ran.stdout + "\n" + ran.stderr} /></If>
</Test>
</Each>

<Test name="DR1 native identity: resolution continues only the established Planner session" timeout="180s">
```bash exec as="testCommandSetting"
printf '%s' "$XMD_EXAMPLE_TEST_COMMAND"
```
<Let as="testRunner" value={testCommandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' test"} />
<Let as="nativeArguments" value={[root + "/examples/adversarial-implementation/tests/decision-native-cases.md","--plugin",root + "/packages/cli/tests/fixtures/workflow-test-permissions.mjs","--include",root + "/examples/adversarial-implementation/components"].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
```bash exec as="native"
{testRunner} {nativeArguments}
```
<If condition={native.exitCode !== 0}><Fail message={native.stderr || native.stdout} /></If>
</Test>
