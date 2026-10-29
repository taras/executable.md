---
props:
  type: object
  properties:
    task: {type: string, minLength: 1}
  required: [task]
  additionalProperties: false
---

Build an API against representative consumers, then let a second implementer
finish the migration and challenge the API with evidence. Read the README before
running: these roles edit the selected checkout and use paid coding agents.

<Ticket.Text path={props.task} as="taskText" />
<Parse schema={{type:"object"}} as="task">{taskText}</Parse>
```bash exec as="location"
pwd -P
```
<If condition={location.exitCode !== 0}><Fail message="Resolve the workflow repository before loading its role guides." /></If>
<File path=".agents/planner.md" as="plannerGuide" />
<File path=".agents/implementor.md" as="implementorGuide" />
<Adversarial.Run task={task} plannerGuide={{path:location.stdout.trim() + "/.agents/planner.md",content:plannerGuide}} implementorGuide={{path:location.stdout.trim() + "/.agents/implementor.md",content:implementorGuide}} as="work" />
<Output><Json value={work} /></Output>
