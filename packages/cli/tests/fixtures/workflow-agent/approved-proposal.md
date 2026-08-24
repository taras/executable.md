---
props:
  approved: { type: boolean }
required: [approved]
---

# Apply a change an agent proposed, once somebody has approved it

This workflow gives an agent no files. It has no working directory you would
recognise, no checkout, and no tool it is allowed to call. It is asked for one
thing: a small fragment of Executable Markdown — **generated XMD** — that would
make the change it thinks this run needs.

That fragment is data, not permission. Nothing performs it until this document
reaches `<Evaluate>`, and this document reaches `<Evaluate>` only on the far
side of an approval given before the run started. Withhold the approval and the
element is never expanded at all: no admission is recorded, and the run's
Workspace is exactly as it was.

Every example below is written in a fenced block on purpose. An element written
as prose in this document is an element this document runs.

<Let as="applied" value={null} />

<Agent name="codex">
<Session name="apply">

<Prompt as="reply">
You are proposing a change to a workspace you cannot open.

Reply with one JSON object and nothing else:

```json
{"kind": "proposal", "source": "<the XMD that makes the change>"}
```

A proposal may write a file, and may put that file under a directory. It may use
nothing else:

```md
<Dir path="nested">
<File path="out.md">the new contents</File>
</Dir>
```
</Prompt>

<Parse as="proposal" schema={{"type":"object","properties":{"kind":{"const":"proposal"},"source":{"type":"string"}},"required":["kind","source"],"additionalProperties":false}}>{reply}</Parse>

</Session>
</Agent>

The proposal is now an ordinary string this run holds. Approval is ordinary
authored control flow around the element that performs it — not a prompt hidden
inside `<Evaluate>`, and not something the agent can reach.

<If condition={props.approved}>

`allow={["write"]}` selects the host's write table rather than granting
anything: a paired `<File>` and a lexical `<Dir>`, chosen before this document
existed. A proposal naming a Git push, an issue, a command or a network read
refuses whole, and nothing it asked for happens.

<Evaluate source={proposal.source} allow={["write"]} />

The admitted write went through the ordinary file provider, into the Workspace
this run owns, so an ordinary read finds it there:

<File path="nested/out.md" as="applied" />

</If>

<Output>
The agent proposed:

{proposal.source}

<If condition={props.approved}>
You approved it, and the run's Workspace now holds:

{applied}
</If>
<If condition={!props.approved}>
Nobody approved it, so nothing was admitted and the Workspace is unchanged.
</If>
</Output>
