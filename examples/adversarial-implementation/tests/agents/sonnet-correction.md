<WhenPrompt as="request" template="{?text}" model="sonnet" effort="high" />
<Let as="text" value={request.text.slice(request.text.indexOf("Prepared assignment:") + "Prepared assignment:".length,request.text.indexOf("Submission guide:")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Parse schema={{type:"object"}} as="reply">{assignment.request}</Parse>
<Json value={reply} />
<WhenPrompt as="request" template="{?text}" model="sonnet" effort="high" />
<Let as="text" value={request.text.slice(request.text.indexOf("Exact correction packet:") + "Exact correction packet:".length).trim()} />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<If condition={packet.session !== "original-sonnet-implementor" || packet.role !== "implementor" || packet.provider !== "claude" || packet.initialize}><Fail message="Response repair changed its original Sonnet Implementor owner." /></If>
<Json value={{...reply,handoffInputs:[]}} />
