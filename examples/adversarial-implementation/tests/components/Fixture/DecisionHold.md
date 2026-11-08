---
description: >-
  Launch a deterministic ordinary ticket until its first hold. Use <Fixture.DecisionHold
  root={root} scenario="decision" as="held" /> inside a TempDir.
props:
  type: object
  properties:
    root: {type: string}
    scenario: {type: string}
    ready: {type: boolean, default: false}
    cut: {type: [object, 'null'], default: null}
  required: [root, scenario]
  additionalProperties: false
returns: {type: object}
---

<Fixture.Repository guides={true} as="fixture" />
<Dir path={fixture.repository}>
<File path="api.sh">format() { printf '%s' "$1"; }
</File>
```bash exec as="base"
git add api.sh
git -c commit.gpgsign=false commit -qm 'ordinary unsigned planning base'
git rev-parse HEAD
```
<If condition={base.exitCode !== 0}><Fail message={base.stderr} /></If>
</Dir>
<Let as="evidence" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted ordinary planning scope and frozen checks.</File></Dir>
<Let as="impact" value={{mechanical:false,architecture:true,acceptance:true,risk:null,reason:"Review the accepted routing boundary.",evidence:[evidence]}} />
<Let as="task" value={{work:"ordinary",repository:fixture.repository,directory:fixture.directory,revision:base.stdout.trim(),request:props.ready ? props.scenario : "#1084:" + props.scenario,inputs:[evidence],sessions:{planner:"original-planner",architect:"original-architect",implementor:"original-implementor"},providers:{architect:"codex",planner:"codex",implementor:"codex"},maxCorrections:3,maxApiRepairs:3,maxResponseCorrections:0,assessment:impact,scope:{decisions:{evidence:[evidence],openQuestions:[]},implementation:{ready:props.ready,evidence:[evidence]},sharedApi:{needed:false,evidence:[evidence]},migration:null},delivery:{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"ordinary",source:evidence,requirement:"Retain the original planning journey."}]}}} />
<If condition={props.cut === null}>
<Fixture.Execution entry="run" value={task} repository={fixture.repository} root={props.root} as="child" />
<Else>
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all --node-modules-dir=manual --cached-only --frozen '" + props.root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' run --allow-absolute"} />
<Dir path={fixture.root}><File path="task.json"><Json value={task} /></File></Dir>
<Let as="runArguments" value={[props.root + "/examples/adversarial-implementation/run.md","--props-task",fixture.root + "/task.json","--plugin",props.root + "/packages/cli/tests/fixtures/decision-cut.mjs","--raw","--include",props.root + "/examples/adversarial-implementation/tests/components","--include",props.root + "/examples/adversarial-implementation/components"].map(value => "'" + value.replaceAll("'","'\"'\"'") + "'").join(" ")} />
<Dir path={fixture.repository}>
```bash exec as="child"
XMD_DECISION_CUT_MODE={props.cut.mode} XMD_DECISION_CUT_MATCH={props.cut.match} {runner} {runArguments}
```
</Dir>
</Else>
</If>
<If condition={child.exitCode !== 0}><Fail message={child.stderr || child.stdout} /></If>
<Parse schema={{type:"object"}} as="work">{child.stdout}</Parse>
<If condition={work.status !== "hold" || work.publication !== "confirmed"}><Fail message={JSON.stringify(work)} /></If>
<Ticket.Load record={work} as="saved" />
<Return value={{fixture,task,evidence,work,saved}} />
