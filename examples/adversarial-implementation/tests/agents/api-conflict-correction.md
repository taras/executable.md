<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={request.text.slice(request.text.indexOf("Prepared assignment:") + "Prepared assignment:".length,request.text.indexOf("Submission guide:")).trim()} />
<Parse schema={{type:"object"}} as="assignment">{text}</Parse>
<Parse schema={{type:"object"}} as="reply">{assignment.request}</Parse>
<Json value={reply} />
<WhenPrompt as="request" template="{?text}" model="gpt-6.1-sol" effort="medium" />
<Let as="text" value={request.text.slice(request.text.indexOf("Exact correction packet:") + "Exact correction packet:".length).trim()} />
<Parse schema={{type:"object"}} as="packet">{text}</Parse>
<If condition={packet.session !== "original-conflict-implementor" || packet.role !== "implementor" || packet.initialize}><Fail message="Response repair changed its original Implementor owner." /></If>
<Let as="corrected" value={{...reply,handoffInputs:[]}} />
<If condition={assignment.work === "conflict-changed"}><Let as="corrected" value={{...corrected,apiConflict:{...reply.apiConflict,observed:"A different API conflict."}}} /></If>
<If condition={assignment.work === "conflict-removed"}><Let as="corrected" value={{...Object.fromEntries(Object.entries(corrected).filter(([key]) => key !== "apiConflict")),next:{phase:"discovery",role:"architect"}}} /></If>
<Json value={corrected} />
