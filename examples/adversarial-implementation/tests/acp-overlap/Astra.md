<WhenPrompt as="request" template="{?before}Perform one independent correctness review of {?revision} in {?review}" model="gpt-6-astra" />
<Gate as="released" />
<Json value={{revision:request.revision,verdict:"pass",summary:"Reviewed the assigned behavior.",acceptance:["behavior"],findings:[]}} />
