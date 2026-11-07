<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={request.text.slice(request.text.indexOf("Prepared assignment:") + "Prepared assignment:".length,request.text.indexOf("Return assessment on completed implementation")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Parse schema={{type:"object"}} as="context">{assignment.request}</Parse>
<Json value={{schema:"phase-result.v2",phase:"discovery",work:assignment.work,outcome:"needs_discovery",revision:assignment.revision,summary:"The first planning call is complete.",handoff:assignment.request,artifacts:[context.plan],evidence:[],findings:[],assessment:assignment.assessment,next:{phase:"discovery",role:"architect"},handoffInputs:[context.plan],discoveryRequests:[{key:"preparation-scope",role:"planner",question:"Confirm the existing scope.",neededFor:"Finish the plan.",evidenceNeeded:"The selected architecture clauses.",origin:context.plan}],discoveryGaps:[]}} />
<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={request.text.slice(request.text.indexOf("Prepared assignment:") + "Prepared assignment:".length,request.text.indexOf("Return assessment on completed implementation")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Parse schema={{type:"object"}} as="context">{assignment.request}</Parse>
<Json value={{schema:"phase-result.v2",phase:"discovery",work:assignment.work,outcome:"complete",revision:assignment.revision,summary:"The final planning call is complete.",handoff:assignment.request,artifacts:[context.matrix],evidence:[],findings:[],assessment:assignment.assessment,next:{phase:"implementation",role:"implementor"},handoffInputs:[context.plan,context.matrix,context.architecture],discoveryRequests:[],discoveryGaps:[]}} />
<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<If condition={!request.text.includes("Perform only handoff document preparation")}><Fail message="The production prompt omitted a required preparation instruction or extract." /></If>
<Let as="text" value={request.text.slice(request.text.indexOf("Recipient assignment (unchanged):") + "Recipient assignment (unchanged):".length,request.text.indexOf("Window provenance and actual acquisitions:")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Parse schema={{type:"object"}} as="context">{assignment.request}</Parse>
<Let as="clause" value={'Keep the accepted scope. If validation fails, hold; except the named read-only case. Unresolved: preserve finding U. Run `deno task test focused.test.ts`. Review identity: exact-sha-123.\n'} />
<Let as="sources" value={[{path:context.plan,length:10837},{path:context.matrix,length:9325},{path:context.architecture,length:13944}]} />
<Let as="content" value={context.case === "overage" ? clause + "x".repeat(24000) + sources.map(source => source.path).join("\n") : clause + "\nOriginal supporting material: " + sources.map(source => source.path).join("\n")} />
<Json value={{diagnosis:"Each document repeats the same scoped binding clauses; padding is supporting narrative.",content,dispositions:sources.flatMap(source => [{source:source.path,start:0,end:clause.length,kind:"consolidate",targetStart:0,reason:"Same exact scoped obligation."},{source:source.path,start:clause.length,end:source.length,kind:"reference",targetStart:null,reason:"Supporting repeated narrative stays in the original artifact."}]),uncertain:[]}} />
<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<If condition={!request.text.includes("your comparison is a semantic judgment")}><Fail message="The production prompt omitted a required preparation instruction or extract." /></If>
<Json value={{preserved:["All exact clauses, conditions, exception, unresolved finding, command and review identity."],changed:[],missing:context.case === "missing" ? ["A binding clause is missing."] : [],uncertain:context.case === "uncertain" ? ["Scope cannot be confirmed."] : [],sufficient:context.case !== "missing" && context.case !== "uncertain"}} />
