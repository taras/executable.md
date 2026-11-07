---
description: 'Read the preparation reply contracts. Use <Ticket.PreparationSchema as="schemas" />.'
returns: {type: object}
---
<Let as="span" value={{type:"object",properties:{source:{type:"string"},start:{type:"integer",minimum:0},end:{type:"integer",minimum:1},kind:{enum:["extract","consolidate","reference"]},targetStart:{type:["integer","null"],minimum:0},reason:{type:"string",minLength:1}},required:["source","start","end","kind","targetStart","reason"],additionalProperties:false}} />
<Return value={{reduction:{type:"object",properties:{diagnosis:{type:"string",minLength:1},content:{type:"string"},dispositions:{type:"array",items:span},uncertain:{type:"array",items:{type:"string"}}},required:["diagnosis","content","dispositions","uncertain"],additionalProperties:false},comparison:{type:"object",properties:{preserved:{type:"array",items:{type:"string"}},changed:{type:"array",items:{type:"string"}},missing:{type:"array",items:{type:"string"}},uncertain:{type:"array",items:{type:"string"}},sufficient:{type:"boolean"}},required:["preserved","changed","missing","uncertain","sufficient"],additionalProperties:false}}} />
