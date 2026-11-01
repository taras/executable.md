---
description: 'Record delivery requirements before starting roles. Use <Delivery.Prepare task={task} as="delivery" />.'
props:
  type: object
  properties:
    task: {type: object}
    inputs: {type: array, items: {type: object}}
  required: [task, inputs]
  additionalProperties: false
returns: {type: object}
---

<Delivery.Schema as="schemas" />
<Parse schema={schemas.policy} as="policy"><Json value={props.task.delivery} /></Parse>
<If condition={new Set(policy.acceptance.map(clause => clause.id)).size !== policy.acceptance.length || policy.acceptance.some(clause => !props.task.inputs.includes(clause.source))}>
<Fail message="Give acceptance clauses distinct IDs and select each original source in task.inputs before launch." />
</If>
<If condition={Object.values(props.task.sessions).includes(policy.reviewer.session)}><Fail message="Independent review uses a separate conversation from the implementation and feedback roles." /></If>
<Return value={{work:props.task.work,repository:props.task.repository,directory:props.task.directory + "/delivery",policy,inputs:props.inputs,required:["independent-review","required-ci","main-health"]}} />
