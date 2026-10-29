---
description: >-
  Read the impact assessment contract. Use <ReviewPolicy.Schema as="schema" />.
returns: {type: object}
---
<Return value={{type:"object",properties:{
  mechanical:{type:"boolean"},architecture:{type:"boolean"},acceptance:{type:"boolean"},
  risk:{anyOf:[{type:"null"},{type:"object",properties:{reason:{type:"string",minLength:1,maxLength:600},evidence:{type:"array",minItems:1,uniqueItems:true,items:{type:"string",minLength:1}}},required:["reason","evidence"],additionalProperties:false}]},
  reason:{type:"string",minLength:1,maxLength:1200},
  evidence:{type:"array",minItems:1,uniqueItems:true,items:{type:"string",minLength:1}}
},required:["mechanical","architecture","acceptance","risk","reason","evidence"],additionalProperties:false}} />
