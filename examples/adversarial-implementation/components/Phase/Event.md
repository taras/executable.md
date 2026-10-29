---
description: >-
  Save a phase milestone for the live watcher. Use <Phase.Event attempt="/private/tmp/ticket/attempt-1"
  stage="started" assignment={assignment} role="architect" as="event" />.
props:
  type: object
  properties:
    attempt: {type: string, pattern: '^/'}
    stage: {enum: [started, reply-saved, result-saved]}
    assignment: {type: object}
    role: {enum: [architect, planner, implementor]}
    revision: {type: [string, 'null'], default: null}
    outcome: {type: [string, 'null'], default: null}
    next: {type: [object, 'null'], default: null}
  required: [attempt, stage, assignment, role]
  additionalProperties: false
returns: {type: object}
---

```bash exec as="stamp"
date -u +%Y-%m-%dT%H:%M:%SZ
```
<If condition={stamp.exitCode !== 0}><Fail message="The phase event timestamp could not be recorded." /></If>
<Let as="event" value={{timestamp:stamp.stdout.trim(),stage:props.stage,attempt:props.attempt,work:props.assignment.work,phase:props.assignment.phase,role:props.role,sourceRevision:props.assignment.revision,revision:props.stage === "result-saved" ? props.revision : props.assignment.revision,outcome:props.outcome,next:props.next}} />
<Dir path={props.attempt}>
<File path={"event-" + props.stage + ".json"}><Json value={event} /></File>
<File path="status.json"><Json value={event} /></File>
</Dir>
<Return value={event} />
