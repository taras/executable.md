<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={request.text.slice(request.text.indexOf("Prepared assignment:") + "Prepared assignment:".length,request.text.indexOf("Return assessment on completed implementation")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Json value={{schema:"phase-result.v2",phase:"discovery",work:assignment.work,outcome:"needs_decision",revision:assignment.revision,summary:"A material choice needs a recorded decision before planning completes.",handoff:"ROOT: record the accepted design decision.",artifacts:[],evidence:[],findings:[],assessment:assignment.assessment,next:{phase:"hold",role:null},discoveryRequests:[],discoveryGaps:[]}} />
