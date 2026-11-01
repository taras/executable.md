---
props:
  type: object
  properties:
    update: {type: object}
    entry: {type: integer, minimum: 1}
  required: [update, entry]
  additionalProperties: false
returns:
  type: object
---

<Query value={props.update} yq='{"phase": (.activity.phase // "waiting"), "response": (.activity.response // "none"), "replies": (.outputs | length), "questions": ([((.inputs // [])[]) | select(.kind == "question")] | length), "permissions": ([((.inputs // [])[]) | select(.kind == "permission")] | length), "ending": .ending}' as="progress" />
<Let as="text" value={"[entry " + props.entry + "] " + (progress.ending ? "exchange " + progress.ending.outcome : progress.phase) + "; response=" + progress.response + "; replies=" + progress.replies + "; questions=" + progress.questions + "; permissions=" + progress.permissions} />
<Return value={{text,terminal:props.update.ending ? props.update : null}} />
