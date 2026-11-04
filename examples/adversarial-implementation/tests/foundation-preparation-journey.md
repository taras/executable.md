---
props:
  type: object
  properties:
    task: {type: object}
    assessment: {type: object}
  required: [task, assessment]
---
<Ticket.Documents repository={props.task.repository} paths={[...props.task.inputs,props.task.repository+"/.agents/planner.md",props.task.repository+"/.agents/implementor.md"]} as="documents" />
<Adversarial.Run task={props.task} plannerGuide={documents[props.task.repository+"/.agents/planner.md"]} implementorGuide={documents[props.task.repository+"/.agents/implementor.md"]} documents={{...documents,incidental:{path:"incidental",content:"x".repeat(65000)}}} assessment={props.assessment} as="work" />
<Output><Json value={work} /></Output>
