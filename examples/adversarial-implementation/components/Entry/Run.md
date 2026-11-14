---
props:
  type: object
  properties:
    task: {type: string, minLength: 1}
  required: [task]
  additionalProperties: false
returns: {type: object}
---

Launch accepted work from prepared facts. Read the README before running: the
selected roles edit your checkout and use paid coding agents. A hold names the
input or existing record you need to reconcile before another launch.

<Adversarial.Schema as="schemas" />
<Let as="work" value={{status:"hold",reason:"Prepare a valid launch task.",history:[]}} />
<Loop max={1}>
<Ticket.Capture as="taskRead"><Ticket.Read path={props.task} limit={1048576} as="taskText" /><Json value={{text:taskText}} /></Ticket.Capture>
<If condition={taskRead.status !== "completed"}><Let as="work" value={{status:"hold",reason:"Read a permitted launch task of at most 1048576 UTF-8 bytes at " + props.task + ". Preserve its original read failure before another launch.",history:[]}} /><Break /></If>
<Parse schema={{type:"object"}} as="taskValue">{taskRead.output}</Parse>
<SafeParse schema={schemas.launch} as="parsed">{taskValue.text}</SafeParse>
<If condition={!parsed.ok}><Let as="work" value={{status:"hold",reason:"Correct the launch task at " + props.task + ": " + JSON.stringify(parsed.errors),history:[]}} /><Break /></If>
<Let as="task" value={{...parsed.value}} />
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
<Let as="initialRole" value={task.scope.sharedApi.needed || !task.scope.implementation.ready ? "planner" : "implementor"} />
<Let as="inspection" value={null} />
<If condition={task.scope.migration === null}>
<Let as="roles" value={{architect:{session:task.sessions.architect,provider:"codex",initialized:false},planner:{session:task.sessions.planner,provider:task.providers.planner,initialized:false},implementor:{session:task.sessions.implementor,provider:task.providers.implementor,initialized:false}}} />
<Let as="assignment" value={{phase:"implementation",work:task.work,repository:task.repository,revision:task.revision,priorRevision:null,request:task.request,assessment:task.assessment,changedPaths:[],artifacts:[],evidence:[],findings:[]}} />
<If condition={initialRole === "planner"}>
<Let as="assignment" value={{...assignment,phase:"discovery",request:"Prepare the missing ordinary implementation plan and focused evidence for this accepted work: " + task.request + "\nProduce plan/evidence only. Do not edit or commit source or build an API foundation. Necessary API work and consumers belong to one Implementor. Preserve existing product and architecture approval gates; return needs_decision for any unanswered material choice.",recipient:initialRole,continuation:{phase:"implementation",role:"implementor"}}} />
</If>
<Let as="provider" value={roles[initialRole].provider} />
<Phase.Profile role={initialRole} assessment={assignment.assessment} plannerProvider={provider} implementationProvider={provider} as="profile" />
<Phase.InspectionRecipe profile={profile} as="inspection" />
<If condition={inspection !== null}>
<Entry.CheckoutCheck root={source.stdout.trim()} as="checkCheckout" />
<Try>

```js eval
const checkoutHold = yield* checkCheckout();
```

<Finally></Finally>
</Try>
<If condition={checkoutHold !== null}><Let as="work" value={{status:"hold",reason:checkoutHold,history:[]}} /><Break /></If>
</If>
</If>
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
<If condition={task.scope.decisions.openQuestions.length !== 0}><Let as="work" value={{status:"hold",reason:"Resolve these material questions before launch: " + task.scope.decisions.openQuestions.join("; ") + ". Evidence: " + task.scope.decisions.evidence.join(", ") + ". Record accepted answers under fresh references and prepare the task again.",history:[]}} /><Break /></If>
<If condition={inspection !== null}>
<Entry.InspectionCheck repository={task.repository} recipe={inspection} as="checkInspection" />
<Try>

```js eval
const admitted = yield* checkInspection();
```

<Finally></Finally>
</Try>
<If condition={!admitted}><Let as="work" value={{status:"hold",reason:inspection.displayName + " could not verify model " + inspection.model + " with effort " + inspection.effort + ". Correct the " + inspection.displayName + " profile or launch environment and explicitly submit the same fresh task again.",history:[]}} /><Break /></If>
</If>
<Ticket.Documents directory={task.directory + ".inputs"} repository={task.repository} paths={[...task.inputs,...guidePaths]} as="retained" />
<Ticket.Selected repository={task.repository} documents={retained} as="documents" />
<Let as="inputs" value={task.inputs.map(path => documents[path])} />
<Ticket.Capture as="deliveryCheck"><Delivery.Prepare task={task} inputs={inputs} as="delivery" /><Json value={delivery} /></Ticket.Capture>
<If condition={deliveryCheck.status !== "completed"}><Let as="work" value={{status:"hold",reason:deliveryCheck.failure,history:[]}} /><Break /></If>
<Parse schema={{type:"object"}} as="delivery">{deliveryCheck.output}</Parse>
<Let as="plannerGuide" value={documents[guidePaths[0]]} />
<Let as="implementorGuide" value={documents[guidePaths[1]]} />
<If condition={task.scope.migration !== null}>
<Adversarial.Run delivery={delivery} task={{work:task.work,repository:task.repository,directory:task.directory,request:task.request + "\n\nAccepted migration commitments: " + JSON.stringify(task.scope.migration),inputs:task.inputs,sessions:task.sessions,providers:task.providers,maxCorrections:task.maxCorrections,maxApiRepairs:task.maxApiRepairs,maxResponseCorrections:task.maxResponseCorrections}} plannerGuide={plannerGuide} implementorGuide={implementorGuide} documents={retained} assessment={task.assessment} as="work" />
<Else>
```bash exec as="reserved"
mkdir -- {directoryPath}
```
<If condition={reserved.exitCode !== 0}><Let as="work" value={{status:"hold",reason:"The fresh work directory could not be reserved: " + task.directory + ". Preserve any existing effects and reconcile the original record before retrying. " + reserved.stderr,history:[]}} /><Break /></If>
<Dir path={task.directory + "/delivery"}><File path="requirements.json"><Json value={delivery} /></File></Dir>
<Let as="manifest" value={{schema:"ticket-workflow.v2",work:task.work,directory:task.directory,maxCorrections:task.maxCorrections,maxApiRepairs:task.maxApiRepairs,maxResponseCorrections:task.maxResponseCorrections,delivery,roles,acceptedInputs:inputs,roleInputs:{planner:[plannerGuide],implementor:[implementorGuide]},assignment}} />
<Dir path={task.directory}><File path="implementation.json"><Json value={manifest} /></File></Dir>
<Ticket.Run manifest={task.directory + "/implementation.json"} as="work" />
<If condition={work.status === "hold" && work.publication === "confirmed"}>
<Ticket.Load record={work} as="launched" />
<If condition={launched.calls.length === 0 && launched.checkpoint.hold?.kind === "input_preparation"}><Let as="work" value={{status:"hold",reason:launched.checkpoint.hold.reason,preparation:launched.checkpoint.hold.receipt,history:[],record:work}} /></If>
</If>
</Else>
</If>
</Loop>
<If condition={work.status === "feedback_ready"}>
<If condition={task.scope.migration !== null}><Dir path={delivery.directory}><File path="feedback.json"><Json value={{status:work.status,revision:work.revision}} /></File></Dir></If>
<Let as="work" value={{...work,delivery:{record:delivery.directory + "/requirements.json",status:"review_pending"},remainingRequiredDeliveryWork:delivery.required,nextAction:{entry:"delivery.md",record:delivery.directory + "/requirements.json",action:"review"}}} />
</If>
<Ticket.Outward value={work} as="bounded" /><Return value={bounded} />
