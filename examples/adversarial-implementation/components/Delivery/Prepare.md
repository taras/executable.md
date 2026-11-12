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
<Fail message={"Give acceptance clauses distinct IDs and select each original source in task.inputs before launch. Duplicate IDs: " + policy.acceptance.map(clause => clause.id).filter((id,index,ids) => ids.indexOf(id) !== index).join(", ") + ". Missing source references: " + [...new Set(policy.acceptance.filter(clause => !props.task.inputs.includes(clause.source)).map(clause => clause.source))].join(", ") + ". No provider prompt began."} />
</If>
<Let as="delivery" value={{work:props.task.work,repository:props.task.repository,directory:props.task.directory + "/delivery",policy,inputs:props.inputs,maxResponseCorrections:props.task.maxResponseCorrections ?? 0,required:["independent-review","required-ci","main-health"]}} />
<Delivery.Selection delivery={delivery} revision={"0".repeat(40)} as="selection" />
<If condition={selection.reviewers.some(entry => Object.values(props.task.sessions).includes(entry.reviewer.session))}><Fail message="Independent review uses a separate conversation from the implementation and feedback roles." /></If>
<Return value={delivery} />
