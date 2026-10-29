---
description: 'Read the validated API handoff contract. Use <Adversarial.Schema as="schemas" />.'
returns: {type: object}
---

<Phase.Schema as="phases" />
<ReviewPolicy.Schema as="assessment" />
<Let as="text" value={{type:"string",minLength:1}} />
<Let as="texts" value={{type:"array",items:text}} />
<Let as="api" value={{type:"object",properties:{
  purpose:text,optimizedFor:text,
  frictionRemoved:{...texts,minItems:1},frictionRetained:texts,
  maintenance:{...texts,minItems:1},
  ownedPaths:{...texts,minItems:1,uniqueItems:true},
  guide:{type:"string",pattern:"^/"},
  examples:{type:"array",minItems:2,items:{type:"object",properties:{name:text,path:text,command:text},required:["name","path","command"],additionalProperties:false}},
  migration:{type:"object",properties:{request:text,retirePaths:{...texts,uniqueItems:true},acceptance:{...texts,minItems:1}},required:["request","retirePaths","acceptance"],additionalProperties:false}
},required:["purpose","optimizedFor","frictionRemoved","frictionRetained","maintenance","ownedPaths","guide","examples","migration"],additionalProperties:false}} />
<Return value={{
  api,
  task:{type:"object",properties:{
    work:{type:"string",pattern:"^[A-Za-z0-9_-]+$"},
    repository:{type:"string",pattern:"^/"},directory:{type:"string",pattern:"^/"},request:text,
    inputs:{...texts,uniqueItems:true,default:[]},
    sessions:{type:"object",properties:{planner:text,implementor:text,architect:text},required:["planner","implementor","architect"],additionalProperties:false},
    maxCorrections:{type:"integer",minimum:0,maximum:10,default:3},
    maxApiRepairs:{type:"integer",minimum:0,maximum:10,default:3}
  },required:["work","repository","directory","request","sessions"],additionalProperties:false},
  foundation:{type:"object",properties:{
    outcome:{enum:["complete","needs_architect","needs_decision","blocked"]},
    revision:{type:"string",pattern:"^[0-9a-f]{40}$"},
    summary:{type:"string",minLength:1,maxLength:1200},
    handoff:{type:"string",minLength:1,maxLength:1800},
    artifacts:{...texts,uniqueItems:true},evidence:phases.result.properties.evidence,
    assessment,api:{anyOf:[api,{type:"null"}]}
  },required:["outcome","revision","summary","handoff","artifacts","evidence","assessment","api"],additionalProperties:false,
  allOf:[{if:{properties:{outcome:{const:"complete"}}},then:{properties:{api}}}]}
}} />
