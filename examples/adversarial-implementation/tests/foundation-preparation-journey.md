---
props:
  type: object
  properties:
    task: {type: object}
    assessment: {type: object}
  required: [task, assessment]
---
<Let as="plannerGuidePath" value={props.task.repository+"/.agents/planner.md"} />
<Let as="implementorGuidePath" value={props.task.repository+"/.agents/implementor.md"} />
<Ticket.Documents repository={props.task.repository} directory={props.task.directory + ".journey"} paths={[...props.task.inputs,plannerGuidePath,implementorGuidePath]} as="documents" />
<Ticket.Selected repository={props.task.repository} documents={{[plannerGuidePath]:documents[plannerGuidePath],[implementorGuidePath]:documents[implementorGuidePath]}} as="guides" />
<Ticket.Snapshot repository={props.task.repository} directory={props.task.directory + ".journey"} path="incidental" content={"x".repeat(65000)} as="incidental" />
<Adversarial.Run task={props.task} plannerGuide={guides[plannerGuidePath]} implementorGuide={guides[implementorGuidePath]} documents={{...documents,incidental}} assessment={props.assessment} as="work" />
<Let as="ticketState" value={null} />
<If condition={work.ticket !== undefined}><Ticket.Load record={work.ticket} as="ticketState" /></If>
<Output><Json value={{...work,ticketState}} /></Output>
