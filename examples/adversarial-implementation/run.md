---
props:
  type: object
  properties:
    task: {type: string, minLength: 1}
  required: [task]
  additionalProperties: false
---

Launch accepted work from prepared facts. Read the README before running: the
selected roles edit your checkout and use paid coding agents. A hold names the
input or existing record you need to reconcile before another launch.

<Adversarial.Schema as="schemas" />
<Let as="work" value={{status:"hold",reason:"Prepare a valid launch task.",history:[]}} />
<Loop max={1}>
<Let as="taskPath" value={"'" + props.task.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="taskRead"
cat -- {taskPath}
```
<If condition={taskRead.exitCode !== 0}><Let as="work" value={{status:"hold",reason:"Read the task text at " + props.task + ". Correct its path or access before launching. " + taskRead.stderr,history:[]}} /><Break /></If>
<SafeParse schema={schemas.launch} as="parsed">{taskRead.stdout}</SafeParse>
<If condition={!parsed.ok}><Let as="work" value={{status:"hold",reason:"Correct the launch task at " + props.task + ": " + JSON.stringify(parsed.errors),history:[]}} /><Break /></If>
<Let as="task" value={{...parsed.value,maxCorrections:parsed.value.maxCorrections ?? 3,maxApiRepairs:parsed.value.maxApiRepairs ?? 3}} />
<If condition={new Set(Object.values(task.sessions)).size !== 3}><Let as="work" value={{status:"hold",reason:"sessions must name three distinct original role conversations. Correct the conflicting identities before launch.",history:[]}} /><Break /></If>
<Let as="references" value={[...task.scope.decisions.evidence,...task.scope.implementation.evidence,...task.scope.sharedApi.evidence,...(task.scope.migration?.evidence ?? []),...task.assessment.evidence,...(task.assessment.risk?.evidence ?? [])]} />
<Let as="unselected" value={references.filter(path => !task.inputs.includes(path))} />
<If condition={unselected.length !== 0}><Let as="work" value={{status:"hold",reason:"Every scope, assessment and risk evidence reference must select task.inputs. Add the accepted text or correct these references: " + unselected.join(", "),history:[]}} /><Break /></If>
<Ticket.Capture as="policyCheck"><ReviewPolicy assessment={task.assessment} as="policy" /><Json value={policy} /></Ticket.Capture>
<If condition={policyCheck.status !== "completed"}><Let as="work" value={{status:"hold",reason:"Correct the assessment consistency before launch: " + policyCheck.failure,history:[]}} /><Break /></If>
<If condition={task.scope.migration !== null && (!task.scope.sharedApi.needed || task.scope.migration.representativeConsumers.some(path => task.scope.migration.remainingConsumers.includes(path)))}><Let as="work" value={{status:"hold",reason:"scope.migration requires sharedApi.needed=true and disjoint representativeConsumers and remainingConsumers. Correct the contradictory migration facts; they cannot fall through to ordinary planning.",history:[]}} /><Break /></If>
<Let as="repositoryPath" value={"'" + task.repository.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="source"
git -C {repositoryPath} rev-parse --show-toplevel
```
<If condition={source.exitCode !== 0}><Let as="work" value={{status:"hold",reason:"Prepare the existing source repository at " + task.repository + " before launch. " + source.stderr,history:[]}} /><Break /></If>
<Ticket.Checkout repository={task.repository} as="checkout" />
<If condition={checkout.head !== task.revision || !checkout.clean}><Let as="work" value={{status:"hold",reason:"Source " + task.repository + " must be clean at task.revision " + task.revision + "; observed HEAD " + checkout.head + ". Preserve partial effects and prepare facts for the exact intended revision.",history:[]}} /><Break /></If>
<Let as="parentPath" value={"'" + (task.directory.slice(0,task.directory.lastIndexOf("/")) || "/").replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="parent"
set -e
cd -- {parentPath}
pwd -P
```
<If condition={parent.exitCode !== 0}><Let as="work" value={{status:"hold",reason:"Prepare the parent of the fresh work directory " + task.directory + " before launching. " + parent.stderr,history:[]}} /><Break /></If>
<Let as="directory" value={parent.stdout.trim().replace(/\/$/,"") + "/" + task.directory.slice(task.directory.lastIndexOf("/") + 1)} />
<If condition={directory === source.stdout.trim() || directory.startsWith(source.stdout.trim() + "/") || [".","..",""] .includes(task.directory.slice(task.directory.lastIndexOf("/") + 1))}><Let as="work" value={{status:"hold",reason:"directory must name a fresh work directory outside the source checkout. Correct " + task.directory + ".",history:[]}} /><Break /></If>
<Let as="directoryPath" value={"'" + task.directory.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="occupied"
test -e {directoryPath} -o -L {directoryPath}
```
<If condition={occupied.exitCode === 0}><Let as="work" value={{status:"hold",reason:"The fresh work directory is occupied: " + task.directory + ". Preserve it and reconcile its saved phase or continue its complete Ticket record; use a new directory only for new work.",history:[]}} /><Break /></If>
<Let as="missingConsumers" value={[]} />
<Let as="consumers" value={task.scope.migration === null ? [] : [...task.scope.migration.representativeConsumers,...task.scope.migration.remainingConsumers]} />
<Let as="consumerIndex" value={0} />
<If condition={consumers.length !== 0}>
<Loop max={consumers.length}>
<Let as="consumer" value={consumers[consumerIndex]} />
<Let as="object" value={"'" + (task.revision + ":" + consumer).replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="committedConsumer"
git -C {repositoryPath} cat-file -t {object}
```
<If condition={committedConsumer.exitCode !== 0 || committedConsumer.stdout.trim() !== "blob"}><Let as="missingConsumers" value={[...missingConsumers,consumer]} /></If>
<Let as="consumerIndex" value={consumerIndex + 1} />
</Loop>
</If>
<If condition={missingConsumers.length !== 0}><Let as="work" value={{status:"hold",reason:"scope.migration consumer paths must name committed production files at task.revision. Correct the unavailable paths: " + missingConsumers.join(", "),history:[]}} /><Break /></If>
<Let as="guidePaths" value={[task.repository + "/.agents/planner.md",task.repository + "/.agents/implementor.md"]} />
<Let as="unreadable" value={[]} />
<Let as="selectedReferences" value={[...new Set([...task.inputs,...guidePaths])]} />
<Let as="referenceIndex" value={0} />
<Loop max={selectedReferences.length}>
<Let as="reference" value={selectedReferences[referenceIndex]} />
<Let as="referencePath" value={"'" + reference.replaceAll("'","'\"'\"'") + "'"} />
```bash exec as="readable"
test -f {referencePath} -a -r {referencePath}
```
<If condition={readable.exitCode !== 0}><Let as="unreadable" value={[...unreadable,reference]} /></If>
<Let as="referenceIndex" value={referenceIndex + 1} />
</Loop>
<If condition={unreadable.length !== 0}><Let as="work" value={{status:"hold",reason:"Prepare readable selected evidence and role-guide texts before launch: " + unreadable.join(", "),history:[]}} /><Break /></If>
<Ticket.Documents repository={task.repository} paths={[...task.inputs,...guidePaths]} as="documents" />
<If condition={Object.values(documents).reduce((total,input) => total + input.content.length,0) > 64000}><Let as="work" value={{status:"hold",reason:"Selected initial evidence and role guides exceed 64000 characters. Prepare a concise accepted packet and keep full logs as references.",history:[]}} /><Break /></If>
<Let as="inputs" value={task.inputs.map(path => documents[path])} />
<Let as="plannerGuide" value={documents[guidePaths[0]]} />
<Let as="implementorGuide" value={documents[guidePaths[1]]} />
<If condition={task.scope.decisions.openQuestions.length !== 0}><Let as="work" value={{status:"hold",reason:"Resolve these material questions before launch: " + task.scope.decisions.openQuestions.join("; ") + ". Evidence: " + task.scope.decisions.evidence.join(", ") + ". Record accepted answers under fresh references and prepare the task again.",history:[]}} /><Break /></If>
<If condition={task.scope.migration !== null}>
<Adversarial.Run task={{work:task.work,repository:task.repository,directory:task.directory,request:task.request + "\n\nAccepted migration commitments: " + JSON.stringify(task.scope.migration),inputs:task.inputs,sessions:task.sessions,maxCorrections:task.maxCorrections,maxApiRepairs:task.maxApiRepairs}} plannerGuide={plannerGuide} implementorGuide={implementorGuide} documents={Object.fromEntries(inputs.map(input => [input.path,input]))} assessment={task.assessment} as="work" />
<Else>
```bash exec as="reserved"
mkdir -- {directoryPath}
```
<If condition={reserved.exitCode !== 0}><Let as="work" value={{status:"hold",reason:"The fresh work directory could not be reserved: " + task.directory + ". Preserve any existing effects and reconcile the original record before retrying. " + reserved.stderr,history:[]}} /><Break /></If>
<Let as="assignment" value={{phase:"implementation",work:task.work,repository:task.repository,revision:task.revision,priorRevision:null,request:task.request,assessment:task.assessment,changedPaths:[],artifacts:[],evidence:[],findings:[]}} />
<Let as="planned" value={false} />
<Let as="deliveredInputs" value={{}} />
<If condition={task.scope.sharedApi.needed || !task.scope.implementation.ready}>
<Let as="planning" value={{...assignment,phase:"discovery",request:"Prepare the missing ordinary implementation plan and focused evidence for this accepted work: " + task.request + "\nProduce plan/evidence only. Do not edit or commit source or build an API foundation. Necessary API work and consumers belong to one Implementor. Preserve existing product and architecture approval gates; return needs_decision for any unanswered material choice.",recipient:"planner",continuation:{phase:"implementation",role:"implementor"}}} />
<Ticket.Capture as="execution"><Phase.Run phase="discovery" role="planner" session={task.sessions.planner} initialize={true} inputs={[...inputs,plannerGuide].filter((input,index,all) => all.findIndex(other => other.path === input.path) === index)} assignment={planning} attempt={task.directory + "/planning"} successor="implementation" nextRole="implementor" as="plan" /><Json value={plan} /></Ticket.Capture>
<Dir path={task.directory}><File path="planning-execution.json"><Json value={execution} /></File></Dir>
<If condition={execution.status !== "completed"}><Let as="work" value={{status:"hold",reason:execution.failure,history:[{owner:"planner",attempt:task.directory + "/planning",status:execution.status}]}} /><Break /></If>
<Parse schema={{type:"object"}} as="plan">{execution.output}</Parse>
<If condition={plan.outcome !== "complete"}><Let as="work" value={{status:"hold",reason:plan.handoff,history:[{owner:"planner",path:task.directory + "/planning/result.json",outcome:plan.outcome}]}} /><Break /></If>
<Ticket.Checkout repository={task.repository} as="afterPlan" />
<If condition={plan.revision !== task.revision || afterPlan.head !== task.revision || !afterPlan.clean}><Let as="work" value={{status:"hold",reason:"Ordinary planning must leave source clean at the unchanged launch revision. Preserve the planning record and reconcile " + task.repository + " before implementation.",history:[{owner:"planner",path:task.directory + "/planning/result.json"}]}} /><Break /></If>
<Ticket.Text path={task.directory + "/planning/assignment.json"} as="savedText" />
<Parse schema={{type:"object"}} as="saved">{savedText}</Parse>
<Phase.Next result={plan} successor="implementation" role="implementor" as="next" />
<Phase.Preparation from={{assignment:saved,result:plan,next}} target="implementation" as="prepared" />
<Let as="assignment" value={prepared.assignment} />
<Ticket.Capture as="selection"><Ticket.Documents repository={task.repository} paths={plan.handoffInputs ?? []} documents={documents} as="selected" /><Json value={selected} /></Ticket.Capture>
<If condition={selection.status !== "completed"}><Let as="work" value={{status:"hold",reason:selection.failure,history:[{owner:"planner",path:task.directory + "/planning/result.json"}]}} /><Break /></If>
<Parse schema={{type:"object"}} as="documents">{selection.output}</Parse>
<Let as="inputs" value={[...new Set([...task.inputs,...(plan.handoffInputs ?? [])])].map(path => documents[path])} />
<Let as="planned" value={true} />
<Let as="deliveredInputs" value={{[task.sessions.planner]:[...new Set([...task.inputs,plannerGuide.path])]}} />
</If>
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:task.work,directory:task.directory,maxCorrections:task.maxCorrections,deliveredInputs,roles:{architect:{session:task.sessions.architect,provider:"codex",initialized:false},planner:{session:task.sessions.planner,provider:"claude",initialized:planned},implementor:{session:task.sessions.implementor,provider:"claude",initialized:false}},acceptedInputs:inputs,roleInputs:{planner:[plannerGuide],implementor:[implementorGuide]},assignment}} />
<Dir path={task.directory}><File path="implementation.json"><Json value={manifest} /></File></Dir>
<Ticket.Run manifest={task.directory + "/implementation.json"} as="work" />
</Else>
</If>
</Loop>
<Output><Json value={work} /></Output>
