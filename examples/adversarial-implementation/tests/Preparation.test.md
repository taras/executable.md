```bash exec as="location"
pwd -P
```
<Let as="root" value={location.stdout.trim()} />
<Let as="clause" value={'Keep the accepted scope. If validation fails, hold; except the named read-only case. Unresolved: preserve finding U. Run `deno task test focused.test.ts`. Review identity: exact-sha-123.\n'} />

<Test name="F D W: actual input inspection, UTF-16 counts and immutable captures">
<TempDir as="directory" />
<Let as="accepted" value={[{path:"/seed",content:"s".repeat(30470)}]} />
<Let as="guide" value={{path:"/guide",content:"g".repeat(11148)}} />
<Let as="inputs" value={[...accepted,guide,{path:"plan.md",content:"p".repeat(22382)}]} />
<Let as="documents" value={{}} />
<Let as="index" value={0} />
<Loop max={inputs.length}>
<Ticket.Snapshot repository={root} directory={directory + "/retained"} path={inputs[index].path} content={inputs[index].content} as="saved" />
<Let as="documents" value={{...documents,[inputs[index].path]:saved}} />
<Let as="index" value={index + 1} />
</Loop>
<Let as="record" value={{manifest:{directory,acceptedInputs:accepted.map(input => documents[input.path]),roleInputs:{implementor:[documents[guide.path]]},deliveredInputs:{recipient:["/seed","/guide"]}},documents,deliveredInputs:{recipient:[]},calls:[]}} />
<Let as="call" value={{id:"fit",role:"implementor",provider:"codex",session:"recipient",assignment:{work:"fit",phase:"implementation",repository:root,revision:"a".repeat(40),handoffInputs:["plan.md","plan.md"]}}} />
<Ticket.Inputs record={record} call={call} inspect={true} as="selected" />
<AssertEquals actual={selected.budget} expected={{limit:64000,total:64000,mandatory:41618,remaining:22382,excess:0,admitted:true}} />
<AssertEquals actual={JSON.stringify(selected.inputs) === JSON.stringify(inputs)} expected={true} />
<AssertEquals actual={Object.values(selected.documents).every(document => document.content === undefined && document.snapshot.startsWith(directory))} expected={true} />
<Ticket.Prepare record={record} call={call} as="prepared" />
<AssertEquals actual={prepared.status} expected="ready" />
<AssertEquals actual={JSON.stringify(prepared.inputs) === JSON.stringify(inputs)} expected={true} />
<AssertEquals actual={prepared.call} expected={call} />
<Ticket.Text path={prepared.receipt} as="text" /><Parse schema={{type:"object"}} as="receipt">{text}</Parse>
<AssertEquals actual={receipt.attempts} expected={[]} />
<Ticket.Inputs record={{...record,deliveredInputs:{recipient:["/seed","/guide"]}}} call={call} inspect={true} as="continued" />
<AssertEquals actual={continued.budget.remaining} expected={64000} />
<AssertEquals actual={continued.inputs} expected={[inputs[2]]} />
<Ticket.Windows inputs={[{path:"astral",content:"x".repeat(7999)+"😀"+"y"}]} as="windows" />
<AssertEquals actual={windows.map(window => window.content.length)} expected={[7999,3]} />
<AssertEquals actual={windows.map(window => window.content).join("").length} expected={8002} />
<Ticket.Fingerprint inputs={[{path:"astral",content:"😀"}]} as="hash" />
<AssertEquals actual={{characters:hash[0].characters,bytes:hash[0].bytes}} expected={{characters:2,bytes:4}} />
<Dir path={directory}><File path="source.txt">original</File></Dir>
<Ticket.Documents repository={directory} directory={directory + "/captured"} paths={["source.txt"]} as="original" />
<Dir path={directory}><File path="source.txt">changed</File></Dir>
<Ticket.Documents repository={directory} directory={directory + "/captured"} paths={["source.txt"]} documents={original} as="historical" />
<AssertEquals actual={historical} expected={original} />
<Ticket.Hydrate repository={directory} document={historical["source.txt"]} as="retainedSource" />
<Ticket.Material inputs={[retainedSource]} directory={directory+"/windows"} as="material" />
<AssertEquals actual={material.total} expected={8} />
<AssertEquals actual={material.inputs[0].content} expected="original" />
<AssertEquals actual={Object.values(material.documents).map(document => [document.path,document.utf8Bytes,"content" in document])} expected={[[directory+"/windows/0000.txt",8,false]]} />
</Test>

<Test name="H: mandatory floor records its exact refusal without a reducer">
<TempDir as="directory" />
<Let as="seed" value={{path:"/seed",content:"s".repeat(64001)}} />
<Ticket.Snapshot repository={root} directory={directory + "/retained"} path={seed.path} content={seed.content} as="retainedSeed" />
<Let as="record" value={{manifest:{directory,acceptedInputs:[retainedSeed]},documents:{"/seed":retainedSeed},calls:[]}} />
<Ticket.Prepare record={record} call={{id:"floor",role:"implementor",session:"recipient",provider:"codex",assignment:{phase:"implementation",work:"floor",repository:root,revision:"a".repeat(40)}}} as="prepared" />
<AssertEquals actual={prepared.status} expected="hold" />
<AssertStringIncludes actual={prepared.reason} expected="exceeds 64000 by 1" />
<Ticket.Text path={prepared.receipt} as="text" /><Parse schema={{type:"object"}} as="receipt">{text}</Parse>
<AssertEquals actual={receipt.attempts} expected={[]} />
</Test>

<Test name="W: material and selected admission refusal retain unexamined spans without a Prompt">
<Each in={[128001,65000]} let="size">
<TempDir as="directory" />
<Let as="source" value={{path:"original.md",content:"x".repeat(size)}} />
<Let as="impact" value={{mechanical:false,architecture:false,acceptance:true,risk:null,reason:"Preserve selected material.",evidence:["original.md"]}} />
<Ticket.Snapshot repository={root} directory={directory + "/retained"} path={source.path} content={source.content} as="retainedSource" />
<Let as="record" value={{manifest:{directory,acceptedInputs:[],roles:{planner:{session:"original-planner",provider:"codex"}}},documents:{"original.md":retainedSource},calls:[{role:"planner",session:"original-planner",provider:"codex",delivery:"recorded-delivery.json",record:"recorded-planner",assignment:{assessment:impact}}]}} />
<Ticket.Prepare record={record} call={{id:"bounded",role:"implementor",provider:"codex",session:"recipient",assignment:{work:"windows",phase:"implementation",repository:root,revision:"a".repeat(40),handoffInputs:["original.md"]}}} as="prepared" />
<AssertEquals actual={prepared.status} expected="hold" />
<Ticket.Text path={prepared.receipt} as="text" /><Parse schema={{type:"object"}} as="receipt">{text}</Parse>
<AssertEquals actual={receipt.attempts} expected={[]} />
<AssertStringIncludes actual={prepared.reason} expected={size === 128001 ? "unexamined" : "no reduction Prompt started"} />
</Each>
</Test>

<Test name="provider-dependent preparation journeys use the explicit Deno fixture host" timeout="390s">
```bash exec as="commandSetting"
printf '%s' "$XMD_EXAMPLE_TEST_COMMAND"
```
<Let as="runner" value={commandSetting.stdout || "deno run --allow-all '" + root.replaceAll("'","'\"'\"'") + "/packages/cli/src/deno.ts' test"} />
<Let as="caseArguments" value={[root+"/examples/adversarial-implementation/tests/preparation-cases.md","--plugin",root+"/packages/cli/tests/fixtures/workflow-test-permissions.mjs","--include",root+"/examples/adversarial-implementation/components"].map(value => "'"+value.replaceAll("'","'\"'\"'")+"'").join(" ")} />
```bash exec as="cases"
{runner} {caseArguments}
```
<If condition={cases.exitCode !== 0}><Fail message={cases.stderr || cases.stdout} /></If>
</Test>
