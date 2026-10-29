---
description: >-
  Validate an accepted implementation manifest and prepare its first checkpoint.
  Use <Ticket.Start manifest={manifest} as="checkpoint" />.
props:
  type: object
  properties:
    manifest: {type: object}
  required: [manifest]
  additionalProperties: false
returns: {type: object}
---

The ticket begins with its accepted implementation and retains three distinct
original sessions. Provider selection and initialization standing come from the
manifest; a result cannot replace them.

<Ticket.Schema as="schema" />
<Parse schema={schema} as="manifest"><Json value={props.manifest} /></Parse>
<Let as="allInputs" value={[...manifest.acceptedInputs,...Object.values(manifest.roleInputs ?? {}).flat()]} />
<If condition={allInputs.some(input => allInputs.some(other => input.path === other.path && input.content !== other.content))}>
<Fail message="One input reference cannot name different contents. Give changed evidence a fresh reference." />
</If>
<If condition={new Set(manifest.acceptedInputs.map(input => input.path)).size !== manifest.acceptedInputs.length}>
<Fail message="Give each approved input a distinct reference." />
</If>
<If condition={Object.values(manifest.deliveredInputs ?? {}).some(paths => paths.some(path => !allInputs.some(input => input.path === path)))}>
<Fail message="Previously delivered references must identify supplied accepted or role inputs." />
</If>
<Phase.Schema as="phases" />
<Parse schema={phases.assignment} as="assignment"><Json value={manifest.assignment} /></Parse>
<If condition={assignment.phase !== "implementation" || assignment.work !== manifest.work}>
<Fail message="Start with this ticket's accepted implementation assignment." />
</If>
<If condition={new Set(Object.values(manifest.roles).map(role => role.session)).size !== 3}>
<Fail message="The three original roles require distinct sessions." />
</If>
<ReviewPolicy assessment={assignment.assessment} kind="feature" as="reviewPolicy" />
<Return value={{reviewPolicy,work:manifest.work,status:"running",dispatchable:true,round:0,gate:"implementation",revision:assignment.revision,assignment,reviews:{},feedback:[],initialized:Object.fromEntries(Object.entries(manifest.roles).map(([name,role]) => [name,role.initialized])),hold:null}} />
