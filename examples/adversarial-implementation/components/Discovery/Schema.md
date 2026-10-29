---
description: Read the discovery request, gap and fact contracts. Use <Discovery.Schema as="schemas" />.
returns: {type: object}
---

<Let as="request" value={{
  type:"object",
  properties:{
    key:{type:"string",minLength:1,maxLength:120},
    role:{enum:["architect","planner","implementor"]},
    question:{type:"string",minLength:1,maxLength:600},
    neededFor:{type:"string",minLength:1,maxLength:600},
    evidenceNeeded:{type:"string",minLength:1,maxLength:600},
    origin:{type:"string",minLength:1}
  },
  required:["key","role","question","neededFor","evidenceNeeded","origin"],
  additionalProperties:false
}} />
<Let as="gap" value={{
  type:"object",
  properties:{
    request,
    searched:{type:"array",items:{type:"string",minLength:1},uniqueItems:true,maxItems:12},
    status:{enum:["open","resolved"]},
    evidence:{type:"array",items:{type:"string",minLength:1},uniqueItems:true,maxItems:12},
    toolCalls:{type:["integer","null"],minimum:0},
    elapsedMs:{type:["integer","null"],minimum:0}
  },
  required:["request","searched","status","evidence","toolCalls","elapsedMs"],
  additionalProperties:false
}} />
<Let as="fact" value={{
  type:"object",
  properties:{
    key:{type:"string",minLength:1},
    answer:{type:"string",minLength:1,maxLength:2000},
    sourceRevision:{type:"string",pattern:"^[0-9a-f]{40}$"},
    evidence:{type:"array",minItems:1,items:{type:"string",minLength:1},uniqueItems:true,maxItems:12},
    reuseReason:{type:"string",minLength:1,maxLength:600}
  },
  required:["key","answer","sourceRevision","evidence"],
  additionalProperties:false
}} />
<Return value={{request,gap,fact}} />
