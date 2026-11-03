<WhenPrompt template="{?lead}Perform one independent correctness review of {?request}" model="fixture" />
<Json value={{revision:"a".repeat(40),verdict:"pass",summary:"The controlled reviewer returned its exact reply.",acceptance:["behavior"],findings:[]}} />
