---
description: Describe an exact correction offer. Use <ExactCorrection.Schema as="schema" />.
returns: {type: object}
---
<Return value={{type:"object",properties:{schema:{const:"exact-correction.v1"},baseRevision:{type:"string",pattern:"^[0-9a-f]{40}$"},targetTree:{type:"string",pattern:"^[0-9a-f]{40}$"},patch:{type:"string",pattern:"^/"},patchBlob:{type:"string",pattern:"^[0-9a-f]{40}$"},checks:{type:"array",minItems:1,items:{type:"object",properties:{name:{type:"string",minLength:1},argv:{type:"array",minItems:1,items:{type:"string"}}},required:["name","argv"],additionalProperties:false}}},required:["schema","baseRevision","targetTree","patch","patchBlob","checks"],additionalProperties:false}} />
