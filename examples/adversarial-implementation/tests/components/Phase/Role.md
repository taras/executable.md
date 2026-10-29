---
props:
  type: object
  properties:
    role: {type: string}
    session: {type: string}
    assignment: {type: object}
    inputs: {type: array, default: []}
    initialize: {type: boolean, default: false}
  required: [role, session, assignment]
---

<Let as="assignment" value={props.assignment} />
<Let as="receipt" value={assignment.artifactDirectory + "/focused.json"} />
<Let as="revision" value={assignment.revision} />
<Let as="conflict" value={props.role === "implementor" && assignment.request === "first-consumer"} />
<Dir path={assignment.artifactDirectory}><File path="called.json"><Json value={{session:props.session,role:props.role,revision,changedPaths:assignment.changedPaths,initialize:props.initialize,inputPaths:props.inputs.map(input => input.path)}} /></File></Dir>
<If condition={props.role === "implementor"}>
<If condition={conflict}>
```bash exec as="check"
. ./api.sh
resize narrow
```
<If condition={check.exitCode === 0}><Fail message="The first consumer must demonstrate the missing API operation." /></If>
<Else>
<File path="consumer.sh">. ./api.sh
test "$(format consumer)" = consumer
</File>
```bash exec as="check"
bash consumer.sh
```
<If condition={check.exitCode !== 0}><Fail message={check.stderr} /></If>
<If condition={assignment.request === "change-api"}><File path="api.sh">format() { printf '%s' "$1"; }
unvalidated() { printf '%s' changed; }
</File></If>
<If condition={assignment.request !== "keep-fixture"}>
```bash exec as="retired"
git rm -q legacy.fixture
```
</If>
```bash exec as="committed"
set -eu
git add consumer.sh api.sh
git commit -qm migration
git rev-parse HEAD
```
<If condition={committed.exitCode !== 0}><Fail message={committed.stderr} /></If>
<Let as="revision" value={committed.stdout.trim()} />
</Else>
</If>
<Else><Let as="check" value={{exitCode:0,stdout:"Independent review inspected the migration.",stderr:""}} /></Else>
</If>
<Dir path={assignment.artifactDirectory}><File path="focused.json"><Json value={{revision,...check}} /></File></Dir>
<Let as="outcome" value={conflict ? "needs_discovery" : props.role === "implementor" ? "complete" : props.role === "architect" && assignment.request.endsWith("structural-rejected") ? "changes_required" : "pass"} />
<Json value={{schema:"phase-result.v2",phase:assignment.phase,work:assignment.work,outcome,revision,summary:"The fake role ran the assigned consumer.",handoff:conflict ? "Planner: add and validate resize for the remaining consumer." : "Original owner: inspect the completed consumer migration.",artifacts:[receipt],evidence:[{revision,command:conflict ? "resize narrow" : "inspect the assigned commit",outcome:conflict ? "failed" : "passed",artifact:receipt}],findings:[],assessment:assignment.assessment,discoveryRequests:[],discoveryGaps:[],next:conflict ? {phase:"discovery",role:"planner"} : outcome === "changes_required" ? {phase:"implementation",role:"implementor"} : assignment.continuation,...(conflict ? {apiConflict:{expected:"The API can resize a remaining consumer.",observed:"resize is unavailable.",reproducer:"Source api.sh and run resize narrow.",artifact:receipt}} : {})}} />
