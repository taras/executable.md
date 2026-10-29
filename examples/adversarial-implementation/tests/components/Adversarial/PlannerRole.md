---
props: {type: object, properties: {assignment: {type: object}, guide: {type: string}}, required: [assignment, guide]}
---

<Let as="assignment" value={props.assignment} />
<Let as="assessment" value={{...assignment.assessment,architecture:assignment.request.startsWith("structural")}} />
<Dir path={assignment.attempt}><File path="called.json"><Json value={{session:assignment.session,initialize:assignment.initialize,inputPaths:assignment.inputs.map(input => input.path)}} /></File></Dir>
<If condition={assignment.request === "blocked"}>
<Json value={{outcome:"blocked",revision:assignment.revision,summary:"The test provider is unavailable.",handoff:"Wait for provider availability.",api:null,assessment:assignment.assessment,artifacts:[],evidence:[]}} />
<Else>
<File path="api.sh">format() { printf '%s' "$1"; }
</File>
<If condition={assignment.api !== null}><File path="api.sh">format() { printf '%s' "$1"; }
resize() { printf '%s' "$1"; }
</File></If>
<File path="wide.sh">. ./api.sh
test "$(format wide)" = wide
</File>
<File path="modal.sh">. ./api.sh
test "$(format modal)" = modal
</File>
```bash exec as="commit"
set -eu
git add api.sh wide.sh modal.sh
git commit -qm 'validated API'
git rev-parse HEAD
```
<If condition={commit.exitCode !== 0}><Fail message={commit.stderr} /></If>
<Let as="revision" value={commit.stdout.trim()} />
<Let as="guide" value={assignment.attempt + "/usage.md"} />
<Dir path={assignment.attempt}><File path="usage.md">Use format to name a real consumer. The API owns formatting; consumers own their scenario.</File></Dir>
<Let as="examples" value={[{name:"wide",path:"wide.sh",command:"bash wide.sh"},{name:"modal",path:"modal.sh",command:assignment.request === "failed-example" ? "false" : "bash modal.sh"}]} />
<Json value={{outcome:"complete",revision,summary:"The API and two consumers are committed.",handoff:"Implementor: migrate the remaining consumer and retire legacy.fixture.",artifacts:[guide],evidence:[],assessment,api:{purpose:"Format consumer text.",optimizedFor:"Behavioral consumer authoring.",frictionRemoved:["Manual text setup."],frictionRetained:["Each consumer names its expected output."],maintenance:["Keep ordinary changes in the adapter."],ownedPaths:["api.sh"],guide,examples,migration:{request:assignment.api === null && assignment.request === "api-repair" ? "first-consumer" : assignment.request === "kept-fixture" ? "keep-fixture" : assignment.request === "change-api" ? "change-api" : "migrate-consumer",retirePaths:["legacy.fixture"],acceptance:["The consumer passes and the old factory is absent."]}}}} />
</Else>
</If>
