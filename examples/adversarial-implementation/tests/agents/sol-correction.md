<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={request.text.slice(request.text.indexOf("Exact correction packet:") + "Exact correction packet:".length).trim()} />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<Json value={{schema:"phase-result.v2",phase:packet.phase,work:packet.work,revision:packet.revision,outcome:packet.established.outcome,summary:"The saved verdict is unchanged.",handoff:"Inspect the saved verdict.",artifacts:packet.established.artifacts,evidence:packet.established.evidence,findings:packet.established.findings,assessment:packet.established.assessment,next:{phase:"ready",role:null},discoveryRequests:[],discoveryGaps:[]}} />
