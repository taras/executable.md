---
description: 'Read the delivery contracts. Use <Delivery.Schema as="schemas" />.'
returns: {type: object}
---

<Let as="text" value={{type:"string",minLength:1}} />
<Let as="revision" value={{type:"string",pattern:"^[0-9a-f]{40}$"}} />
<Return value={{progress:{const:{status:"in_progress"}},policy:{type:"object",properties:{repository:{type:"string",pattern:"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"},reviewer:{type:"object",properties:{provider:{enum:["claude","codex"]},model:text,effort:{type:["string","null"]},session:text},required:["provider","model","effort","session"],additionalProperties:false},acceptance:{type:"array",minItems:1,items:{type:"object",properties:{id:text,source:text,requirement:text},required:["id","source","requirement"],additionalProperties:false}}},required:["repository","reviewer","acceptance"],additionalProperties:false},review:{type:"object",properties:{revision,verdict:{enum:["pass","changes_required","blocked"]},summary:{type:"string",minLength:1,maxLength:1500},acceptance:{type:"array",items:{type:"string"},uniqueItems:true},findings:{type:"array",items:{type:"object",properties:{blocking:{type:"boolean"},description:text},required:["blocking","description"],additionalProperties:false}}},required:["revision","verdict","summary","acceptance","findings"],additionalProperties:false}}} />
