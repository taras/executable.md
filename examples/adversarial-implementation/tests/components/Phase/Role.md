---
props:
  type: object
  properties:
    plannerProvider: {enum: [claude, codex], default: claude}
    implementationProvider: {enum: [claude, codex], default: claude}
    role: {type: string}
    session: {type: string}
    assignment: {type: object}
    inputs: {type: array, default: []}
    initialize: {type: boolean, default: false}
    correction: {type: [object, 'null'], default: null}
  required: [role, session, assignment]
---

<Let as="assignment" value={props.assignment} />
<Let as="handoffCase" value={assignment.request.startsWith("handoff-retention")} />
<If condition={props.correction !== null}>
<Dir path={props.assignment.artifactDirectory + "/response-corrections/" + String(props.correction.ordinal).padStart(4,"0")}><File path="called.json"><Json value={{session:props.session,plannerProvider:props.plannerProvider,implementationProvider:props.implementationProvider,initialize:props.initialize,ordinal:props.correction.ordinal,remaining:props.correction.remaining}} /></File></Dir>
<Phase.Extract text={props.correction.rejectedText} as="original" />
<Parse schema={{type:"object"}} as="reply">{original.json}</Parse>
<Json value={{...reply,summary:props.assignment.request === "uncorrectable-summary" ? reply.summary : "The saved checks passed.",handoff:"Inspect the saved evidence."}} />
<Else>
<Let as="amendmentRequest" value={assignment.request.startsWith("Delivery amendment:") || ["amendment-review","amendment-corrected","amendment-correct"].includes(assignment.request)} />
<If condition={amendmentRequest}>
<Let as="receipt" value={assignment.artifactDirectory + "/focused.json"} />
<Let as="revision" value={assignment.revision} />
<Dir path={assignment.artifactDirectory}><File path="called.json"><Json value={{session:props.session,role:props.role,initialize:props.initialize,revision,request:assignment.request,phase:assignment.phase,inputPaths:props.inputs.map(input => input.path)}} /></File></Dir>
<If condition={props.role === "implementor"}>
<If condition={assignment.work === "amend-sources"}><Dir path={assignment.repository.slice(0,assignment.repository.lastIndexOf("/"))}><File path="sources-changed.flag">The selected sources change after dispatch.</File></Dir></If>
<Let as="artifact" value={assignment.request.includes("\nArtifact: ") ? assignment.request.split("\nArtifact: ")[1].split(" ")[0] : ""} />
<Let as="quotedArtifact" value={"'" + artifact.replaceAll("'","'\"'\"'") + "'"} />
<Let as="mode" value={assignment.request === "amendment-correct" ? "correct" : assignment.work} />
```bash exec as="imported"
set -eu
case '{mode}' in
  correct) git commit -q --allow-empty -m 'record the measured weights import again' ;;
  amend-ci) cp {quotedArtifact} test-weights.json; mkdir -p .github; printf 'shards: 7\n' > .github/ci.yml; git add test-weights.json .github/ci.yml; git commit -qm 'import weights and change shards' ;;
  amend-parent) printf 'partial\n' > test-weights.json; git add test-weights.json; git commit -qm 'intermediate weights'; cp {quotedArtifact} test-weights.json; git add test-weights.json; git commit -qm 'import weights' ;;
  amend-unsigned) cp {quotedArtifact} test-weights.json; git add test-weights.json; git -c commit.gpgsign=false commit -qm 'unsigned import' ;;
  amend-bytes) cp {quotedArtifact} test-weights.json; printf '\n' >> test-weights.json; git add test-weights.json; git commit -qm 'changed import' ;;
  *) cp {quotedArtifact} test-weights.json; git add test-weights.json; git commit -qm 'import measured test weights' ;;
esac
git rev-parse HEAD
```
<If condition={imported.exitCode !== 0}><Fail message={imported.stderr} /></If>
<Let as="revision" value={imported.stdout.trim()} />
<Dir path={assignment.artifactDirectory}><File path="focused.json"><Json value={{revision,command:"git show --stat HEAD",exitCode:0}} /></File></Dir>
<Json value={{schema:"phase-result.v2",phase:assignment.phase,work:assignment.work,revision,outcome:"complete",summary:"The fixture imported the measured weights artifact.",handoff:assignment.request === "amendment-correct" ? "amendment-corrected" : "amendment-review",artifacts:[receipt],evidence:[{revision,command:"inspect the imported weights",outcome:"passed",artifact:receipt}],findings:[],assessment:assignment.assessment,discoveryRequests:[],discoveryGaps:[],next:assignment.continuation}} />
<Else>
<Let as="outcome" value={assignment.work === "amend-correction" && assignment.request === "amendment-review" ? "changes_required" : "pass"} />
<Dir path={assignment.artifactDirectory}><File path="focused.json"><Json value={{revision,command:"inspect the imported weights",exitCode:0}} /></File></Dir>
<Json value={{schema:"phase-result.v2",phase:assignment.phase,work:assignment.work,revision,outcome,summary:"The fixture reviewed the measured weights import.",handoff:outcome === "changes_required" ? "amendment-correct" : "Original owner: the measured weights import is accepted.",artifacts:[receipt],evidence:[{revision,command:"inspect the imported weights",outcome:"passed",artifact:receipt}],findings:outcome === "changes_required" ? ["Record the import again as a signed descendant."] : [],assessment:assignment.assessment,discoveryRequests:[],discoveryGaps:[],next:outcome === "changes_required" ? {phase:"implementation",role:"implementor"} : assignment.continuation}} />
</Else></If>
<Else>
<Let as="receipt" value={assignment.artifactDirectory + "/focused.json"} />
<Let as="revision" value={assignment.revision} />
<Let as="conflict" value={props.role === "implementor" && assignment.request === "first-consumer"} />
<Dir path={assignment.artifactDirectory}><File path="called.json"><Json value={{session:props.session,role:props.role,plannerProvider:props.plannerProvider,implementationProvider:props.implementationProvider,revision,changedPaths:assignment.changedPaths,initialize:props.initialize,inputPaths:props.inputs.map(input => input.path),inputs:props.inputs,request:assignment.request,phase:assignment.phase,contract:assignment.contract}} /></File></Dir>
<If condition={assignment.phase === "discovery"}>
<Let as="planPath" value={assignment.artifactDirectory + "/plan.md"} />
<Dir path={assignment.artifactDirectory}><File path="plan.md">Use the existing format API for the remaining consumer. Remove legacy.fixture, run bash consumer.sh, and return its signed feedback commit.</File></Dir>
<If condition={assignment.request.includes("stable-evidence")}>
<Let as="evidencePath" value={"'" + props.inputs[0].path.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="mutated"
printf '%s' 'Evidence B: mutable original after planning.' > {evidencePath}
```
<If condition={mutated.exitCode !== 0}><Fail message={mutated.stderr} /></If>
</If>
<Let as="ordinary" value={assignment.request.includes("#1084:")} />
<Let as="scenario" value={ordinary ? assignment.request.split("#1084:")[1].split(/\s/)[0] : ""} />
<If condition={ordinary && scenario.startsWith("source-")}>
<File path="legacy.fixture">Changed during read-only discovery.</File>
</If>
<If condition={ordinary && ["provider-failure","source-absent"].includes(scenario)}><Fail message="The provider stopped without a canonical reply; reconcile the original execution." /></If>
<Let as="decision" value={assignment.request.includes("unanswered-plan-decision") || ["decision","source-decision"].includes(scenario)} />
<Let as="blocked" value={scenario === "blocked"} />
<Let as="discovery" value={ordinary && props.role === "planner" && (props.initialize || scenario === "again") && scenario !== "source-complete"} />
<Let as="outcome" value={decision ? "needs_decision" : blocked ? "blocked" : discovery ? "needs_discovery" : "complete"} />
<If condition={scenario === "revision"}>
```bash exec as="otherRevision"
git rev-parse HEAD^
```
<Let as="revision" value={otherRevision.stdout.trim()} />
</If>
<Let as="request" value={{key:"ordinary-contract",role:scenario === "wrong-request" ? "architect" : props.role,question:"Which existing owner retains initial planning?",neededFor:"Prepare the ordinary plan.",evidenceNeeded:"The accepted Ticket boundary.",origin:assignment.artifactDirectory}} />
<Let as="gap" value={{request:{...request,role:scenario === "wrong-gap" ? "architect" : props.role},searched:[planPath],status:"resolved",evidence:[planPath],toolCalls:null,elapsedMs:null}} />
<Let as="contract" value={{work:assignment.work,sourceRevision:revision,scope:"Retain original sessions and exact source.",sections:[]}} />
<Json value={{schema:"phase-result.v2",phase:assignment.phase,work:assignment.work,outcome,revision,summary:assignment.request.includes("oversized-summary") ? "x".repeat(1201) : "The ordinary plan and focused evidence are saved.",handoff:handoffCase ? "handoff-retention implement" : decision ? "ROOT: resolve the newly discovered material choice." : ordinary ? "#1084:" + scenario + " Implement the selected plan using the accepted format API; retire legacy.fixture." : "Implement the selected ordinary plan using the accepted format API; retire legacy.fixture.",handoffInputs:[...new Set([planPath,...(ordinary ? assignment.handoffInputs ?? [] : [])])],artifacts:[planPath],evidence:[],findings:[],assessment:assignment.assessment,discoveryRequests:discovery ? [request] : [],discoveryGaps:discovery ? [gap] : [],...(props.role === "architect" ? {contract} : {}),...(blocked ? {blocker:{kind:"permission",reason:"Source permission is unavailable.",unblockCondition:"Restore the existing source permission.",evidence:[planPath]}} : {}),next:decision || blocked ? {phase:"hold",role:null} : discovery ? {phase:"discovery",role:"architect"} : assignment.continuation}} />
<Else>
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
<If condition={handoffCase && assignment.request === "handoff-retention correct"}>
<File path="consumer.sh">. ./api.sh
test "$(format consumer)" = consumer
printf '%s' ''
</File>
</If>
```bash exec as="check"
bash consumer.sh
```
<If condition={check.exitCode !== 0}><Fail message={check.stderr} /></If>
<If condition={assignment.request === "change-api"}><File path="api.sh">format() { printf '%s' "$1"; }
unvalidated() { printf '%s' changed; }
</File></If>
<If condition={assignment.request !== "keep-fixture" && assignment.request !== "handoff-retention correct"}>
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
<Let as="outcome" value={conflict ? "needs_discovery" : props.role === "implementor" ? "complete" : (props.role === "architect" && assignment.request.endsWith("structural-rejected") || handoffCase && props.role === "planner" && assignment.request === "handoff-retention review") ? "changes_required" : "pass"} />
<Let as="selectedHandoff" value={handoffCase && (props.role === "implementor" || outcome === "changes_required")} />
<Let as="handoffPath" value={assignment.artifactDirectory + "/handoff.md"} />
<If condition={selectedHandoff}>
<Dir path={assignment.artifactDirectory}>
<If condition={props.role === "implementor"}>
<If condition={assignment.request === "handoff-retention correct"}>
<File path="handoff.md">Corrected implementation evidence: bash consumer.sh passed.</File>
<Else><File path="handoff.md">Initial implementation evidence: bash consumer.sh passed.</File></Else>
</If>
<Else><File path="handoff.md">Correct the implementation while retaining its accepted plan.</File></Else>
</If>
</Dir>
</If>
<Json value={{schema:"phase-result.v2",...(assignment.request === "omitted-metadata" ? {} : {phase:assignment.phase,work:assignment.work,revision}),outcome,summary:["oversized-summary","uncorrectable-summary"].includes(assignment.request) ? "x".repeat(1201) : "The fake role ran the assigned consumer.",handoff:handoffCase ? props.role === "implementor" ? assignment.request === "handoff-retention correct" ? "handoff-retention corrected-review" : "handoff-retention review" : outcome === "changes_required" ? "handoff-retention correct" : assignment.request : conflict ? "Planner: add and validate resize for the remaining consumer." : "Original owner: inspect the completed consumer migration.",artifacts:selectedHandoff ? [receipt,handoffPath] : [receipt],evidence:[{revision:assignment.request === "short-revision" ? revision.slice(0,8) : revision,command:conflict ? "resize narrow" : "inspect the assigned commit",outcome:conflict ? "failed" : "passed",artifact:receipt}],findings:[],assessment:assignment.assessment,...(selectedHandoff ? {handoffInputs:[handoffPath,...(assignment.request === "handoff-retention correct" ? assignment.handoffInputs ?? [] : [])]} : assignment.request.includes("#1084:") ? {handoffInputs:assignment.handoffInputs ?? []} : {}),discoveryRequests:[],discoveryGaps:[],...(assignment.request === "omitted-metadata" ? {} : {next:conflict ? {phase:"discovery",role:"planner"} : outcome === "changes_required" ? {phase:"implementation",role:"implementor"} : assignment.continuation}),...(conflict ? {apiConflict:{expected:"The API can resize a remaining consumer.",observed:"resize is unavailable.",reproducer:"Source api.sh and run resize narrow.",artifact:receipt}} : {})}} />
</Else>
</If>
</Else></If>
</Else>
</If>
