Long-form documentation for the Agent components canonical core registers.

These are the components a document uses to talk to a coding agent: which agent
and session to use, how to prompt it, how to answer the permission requests it
makes, and how to hand it the terminal. They register under
`@executablemd/core`, beside the components in `../components/components.md`,
and are documented here because this is the registration boundary they belong
to.

Most of them are *regions*: they establish something for the content inside them
and restore what was there on the way out. That is what lets one document use two
agents, or grant broad permission for one narrow step without granting it
everywhere.

## AgentProvider

Sets the agent provider for its content.

```mdx
<AgentProvider name="acpx" defaultAgent="claude" timeout="10m">
…
</AgentProvider>
```

Applies to everything inside. `defaultAgent` names the agent to use when a
`<Prompt>` or `<Agent>` inside does not name one, and `timeout` bounds each
prompt rather than the region as a whole.

An unknown provider fails **before** the content runs, so a document that names a
provider this host does not have stops rather than doing half its work and then
discovering it cannot finish.

## Agent

Chooses the agent for the prompts and launches inside it.

```mdx
<Agent name="claude">
<Prompt>Summarise the release notes.</Prompt>
</Agent>
```

A region, like the provider above it: the content's prompts use this agent, and
what was in force outside is restored afterwards. Use it when one document needs
more than one agent — a fast one for a mechanical pass, a stronger one for the
judgement call.

## Session

Sets the default session for every prompt in its content.

```mdx
<Session name="review">
<Prompt>What changed since the last tag?</Prompt>
<Prompt>Which of those need release notes?</Prompt>
</Session>
```

Prompts in one session share the agent's context, so a later prompt can refer to
what an earlier one established. Without a session each prompt stands alone,
which is what you want for independent questions and not what you want for a
conversation.

The session is durable: a run that resumes rejoins the session it was using
rather than starting a fresh one and losing the context the document built.

## Session.Launch

Launches a coding agent with prepared context, in the terminal.

```mdx
<Session.Launch>
Here is the failing test and what I have tried.
</Session.Launch>
```

The content becomes the agent's starting context. The agent's own interface then
takes the terminal — this is the interactive agent, not a prompt-and-reply — and
the document continues when you are done with it.

Reach for it when the work needs a person and an agent together, and for
prepared context that would be tedious to type.

## Prompt

Sends a prompt and renders the reply.

```mdx
<Prompt>Summarise these release notes in three bullets.</Prompt>
```

The paired form sends its content. The reply is rendered where the element is
written, or bound with `as`. Props naming an agent, session or timeout override
the surrounding scope for this one prompt.

A failed prompt renders what it got and the document continues, because a
partial answer is usually more useful than none. `throwOnError` stops the
document instead, for a prompt whose answer everything after it depends on.

## ApproveAll

Approves every permission request its content makes.

```mdx
<ApproveAll>
<Prompt>Fix the failing test.</Prompt>
</ApproveAll>
```

A region, and deliberately a narrow one: it is how a document says *this step is
allowed to act without asking*, for exactly this step. Wrapping a whole document
in it grants far more than any single step needed, so wrap the step.

## AskPermission

Puts every permission request its content makes to you.

```mdx
<AskPermission>
<Prompt>Clean up the scratch directory.</Prompt>
</AskPermission>
```

The opposite region to `<ApproveAll>`: each request is asked about rather than
granted. With no interactive terminal, or no valid answer, it **denies** — the
safe direction, so a document that runs unattended does not silently do what it
would have asked about.
