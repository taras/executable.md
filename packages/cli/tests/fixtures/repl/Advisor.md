---
title: One advisor, asked one question in a session of its own
required: [session, question]
props:
  session:
    type: string
  question:
    type: string
---

<Session name={props.session}><Prompt text={props.question} /></Session>
