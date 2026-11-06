---
props:
  type: object
  properties:
    fixture: {type: object}
    work: {type: string}
    maxCorrections: {type: integer, default: 2}
  required: [fixture, work]
  additionalProperties: false
returns: {type: object}
---

Settle a genuinely completed ticket at A through the production Ticket owners,
with the fixture role boundary. The committed corpus is a private two-file
workspace; its weights come from synthetic fixture records, never a runner.

<Let as="fixture" value={props.fixture} />
<Let as="workspace" value={"'" + JSON.stringify({workspace:["packages/*"]}) + "'"} />
<Dir path={fixture.repository}>
<File path="api.sh">format() { printf '%s' "$1"; }
</File>
```bash exec as="base"
set -e
mkdir -p packages/a/tests
printf '%s\n' {workspace} > deno.json
printf '%s\n' 'Deno.test("a", () => undefined);' > packages/a/tests/a.test.ts
printf '%s\n' 'Deno.test("b", () => undefined);' > packages/a/tests/b.test.ts
git add api.sh deno.json packages
git commit -qm 'existing API and corpus'
git rev-parse HEAD
```
</Dir>
<If condition={base.exitCode !== 0}><Fail message={base.stderr} /></If>
<Let as="accepted" value={fixture.root + "/accepted.md"} />
<Dir path={fixture.root}><File path="accepted.md">Accepted behavior and its focused checks.</File></Dir>
<Ticket.AmendmentProgram as="program" />
<Let as="workflowQuoted" value={"'" + program.root.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="workflow"
git -C {workflowQuoted} rev-parse HEAD
```
<Let as="workflowRevision" value={workflow.stdout.trim()} />
<Dir path={fixture.root}><File path="launch.json"><Json value={{schema:"workflow-launch.v1",work:props.work,directory:fixture.directory,revision:workflowRevision,selection:{...program,revision:workflowRevision}}} /></File></Dir>
<Let as="policy" value={{repository:"taras/executable.md",reviewer:{provider:"claude",model:"fixture",effort:null,session:"independent-review"},acceptance:[{id:"behavior",source:accepted,requirement:"Keep the accepted behavior."}]}} />
<Delivery.Prepare task={{work:props.work,repository:fixture.repository,directory:fixture.directory,inputs:[accepted],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"original-architect"},delivery:policy}} inputs={[{path:accepted,content:"Accepted behavior and its focused checks."}]} as="delivery" />
<Let as="assessment" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Inspect the accepted behavior.",evidence:[accepted]}} />
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:props.work,directory:fixture.directory,maxCorrections:props.maxCorrections,maxApiRepairs:0,maxResponseCorrections:0,delivery,roles:{architect:{session:"original-architect",provider:"codex",initialized:false},planner:{session:"original-planner",provider:"codex",initialized:false},implementor:{session:"original-implementor",provider:"claude",initialized:false}},acceptedInputs:[{path:accepted,content:"Accepted behavior and its focused checks."}],assignment:{phase:"implementation",work:props.work,repository:fixture.repository,revision:base.stdout.trim(),priorRevision:null,request:"migrate-consumer",assessment,changedPaths:[],artifacts:[],evidence:[],findings:[]}}} />
<Dir path={fixture.root}><File path="manifest.json"><Json value={manifest} /></File></Dir>
<Ticket.Run manifest={fixture.root + "/manifest.json"} as="completed" />
<If condition={completed.status !== "feedback_ready"}><Ticket.Load record={completed} as="unfinished" /><Fail message={"The original ticket did not complete: " + JSON.stringify(unfinished.checkpoint.hold)} /></If>
<Dir path={delivery.directory}><File path="requirements.json"><Json value={delivery} /></File></Dir>
<Dir path={fixture.root}><File path="completed.json"><Json value={completed} /></File></Dir>
<Return value={{envelope:completed,record:fixture.root + "/completed.json",revision:completed.revision,launchRevision:base.stdout.trim(),delivery,launch:fixture.root + "/launch.json",workflowRevision}} />
