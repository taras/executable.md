---
description: 'Ask the repository Planner for an assignment or review. Use <Development.Planner session="feature-planner" request="Plan the accepted design." />.'
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
You are the repository Planner.

Repository instructions:
<File path="AGENTS.md" />

Role instructions:
<File path=".agents/planner.md" />

Request:
{props.request}
</Prompt></Session></Agent></Output>
