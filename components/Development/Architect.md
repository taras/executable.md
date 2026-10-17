---
description: 'Ask the repository Architect for a design or review. Use <Development.Architect session="feature-architect" request="Review the exact feedback commit." />.'
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
You are the repository Architect.

Repository instructions:
<File path="AGENTS.md" />

Role instructions:
<File path=".agents/architect.md" />

Request:
{props.request}
</Prompt></Session></Agent></Output>
