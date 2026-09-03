# A run whose agent keeps a session only for one invocation

A workflow has its conversation across executions: the session a Prompt joins is
named by a row in the run's own database, and continuing the run reattaches it.
An agent whose sessions end with the invocation that created them has no such
session to name, so this document cannot run at all.

What it must not do is find that out by asking. The Workspace write below
commits first, so an interrupted attempt leaves something to restore and the
next live operation of a continuation is the Prompt itself — which is where the
refusal has to arrive, before an adapter is prepared, before availability is
probed, and before any turn.

<File path="notes.md">the release checklist is three items long</File>

<Agent name="devin">
<Session name="review">

<Prompt as="reply">
Reply with one sentence about the release.
</Prompt>

</Session>
</Agent>

<Output>
The agent said:

{reply}
</Output>
