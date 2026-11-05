<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<If condition={!request.text.includes("Keep the accepted scope. If validation fails, hold; except the named read-only case.")}><Fail message="The production prompt omitted a required preparation instruction or extract." /></If>
<If condition={!request.text.includes("Unresolved: preserve finding U.")}><Fail message="The production prompt omitted a required preparation instruction or extract." /></If>
<If condition={!request.text.includes("Review identity: exact-sha-123.")}><Fail message="The production prompt omitted a required preparation instruction or extract." /></If>
<If condition={!request.text.includes("Preparation receipt:")}><Fail message="The production prompt omitted a required preparation instruction or extract." /></If>
<Let as="text" value={request.text.slice(request.text.indexOf("Prepared assignment:") + "Prepared assignment:".length,request.text.indexOf("Return assessment on completed implementation")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Parse schema={{type:"object"}} as="context">{assignment.request}</Parse>
<If condition={context.case === "validation"}>
Successful raw reply with deliberately invalid phase JSON.
<Else>
<Json value={{schema:"phase-result.v2",phase:"implementation",work:assignment.work,outcome:"needs_discovery",revision:assignment.revision,summary:"The previously unstarted successor received the exact reduced contract.",handoff:"Architect: inspect the saved synthetic successor result.",artifacts:[],evidence:[],findings:[],assessment:assignment.assessment,next:{phase:"discovery",role:"architect"},discoveryRequests:[{key:"synthetic-continuation",role:"implementor",question:"Confirm the synthetic continuation receipt.",neededFor:"End this controlled journey after the intended successor.",evidenceNeeded:"Its actual saved canonical result.",origin:assignment.artifactDirectory}],discoveryGaps:[]}} />
</Else>
</If>
