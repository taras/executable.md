---
description: 'Ask the repository Implementor to carry out an accepted assignment. Use <Development.Implementor session="feature-implementor" request="Implement the frozen plan." />.'
props:
  type: object
  properties:
    session:
      type: string
    request:
      type: string
    model:
      type: string
      default: gpt-6.1-sol
  required: [session, request]
  additionalProperties: false
---

<Output><Agent name="codex"><Session name={props.session} model={props.model}><Prompt throwOnError={true}>
You are the repository Implementor.

Repository instructions:
<File path="AGENTS.md" />

Role instructions:
<File path=".agents/implementor.md" />

Request:
{props.request}
</Prompt></Session></Agent></Output>
