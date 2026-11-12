<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<If condition={request.text.includes('"$defs"') || request.text.includes("Return assessment on completed implementation")}><Fail message="The initial prompt included deferred submission material." /></If>
<Let as="text" value={request.text.slice(request.text.indexOf("Prepared assignment:") + "Prepared assignment:".length,request.text.indexOf("Submission guide:")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Let as="variant" value={assignment.request} />
<If condition={variant === "invalid"}>not a phase result<Else>
<Json value={{schema:"phase-result.v2",...(variant === "correction-changed" ? {phase:assignment.phase,work:assignment.work,revision:assignment.revision,handoffInputs:["unrecorded.md"]} : {}),outcome:"blocked",summary:"The required external input is unavailable.",handoff:"ROOT: provide the required external input.",artifacts:[],evidence:[],findings:[],next:{phase:"hold",role:null},blocker:{kind:"missing_input",reason:"The external input is unavailable.",unblockCondition:"Supply the external input.",evidence:[assignment.artifactDirectory + "/assignment.json"]},discoveryRequests:[],discoveryGaps:[]}} />
</Else></If>

<If condition={variant === "correction-changed"}>
<WhenPrompt as="correction" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="packetText" value={correction.text.slice(correction.text.indexOf("Exact correction packet:") + "Exact correction packet:".length).trim()} />
<Parse schema={{type:"object"}} as="packet">{packetText}</Parse>
<Json value={{schema:"phase-result.v2",phase:packet.phase,work:packet.work,revision:packet.established.revision,outcome:packet.established.outcome,summary:packet.established.summary,artifacts:packet.established.artifacts,evidence:packet.established.evidence,findings:packet.established.findings,blocker:packet.established.blocker,discoveryRequests:[],discoveryGaps:[],handoff:"ROOT: provide the required external input.",handoffInputs:[],next:{phase:"hold",role:null}}} />
</If>
