---
props:
  type: object
  properties:
    case: {type: string}
  required: [case]
  additionalProperties: false
---

<Ticket.Text path={props.case} as="caseText" />
<Parse schema={{type:"object"}} as="test">{caseText}</Parse>
<Adversarial.Run task={{work:"test",repository:test.fixture.repository,directory:test.fixture.directory,request:test.request,inputs:[],sessions:{planner:"original-planner",implementor:"original-implementor",architect:"conditional-architect"},maxCorrections:1,maxApiRepairs:test.maxApiRepairs}} plannerGuide={{path:test.fixture.root + "/planner.md",content:"Planner test instructions."}} implementorGuide={{path:test.fixture.root + "/implementor.md",content:"Implementor test instructions."}} as="work" />
<Output><Json value={{status:work.status,reason:work.reason ?? null,history:work.history,revision:work.revision ?? null}} /></Output>
