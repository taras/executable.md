# Children

Read this before delegating a program to another XMD Sidekick or attaching to its live work.

## Applies to

Sidekick responses prepare the entries below. The entries start, select and stop
children owned by this parent REPL.

## Instructions

- Read `<REPL.Environment />` for actual host facts and known paths. Inspect
  `<REPL.Syntax names={["Agent", "Session", "XMD.Session", "XMD.Session.Shutdown", "Parse", "Json"]} />`
  before preparing the entry. Read `<Guide.Entries />` for literal entry submission.
- Select `xmd` through `<Agent name="xmd">`. A canonical `<Session>` starts its
  child before its content runs. Its name is a readable label; separate Session
  declarations remain separate children even when their labels match.
- Read `<XMD.Session as="started" />` in that Session to obtain exactly
  `{sessionId}`. This read sends no Prompt. Prompt captures contain reply text.
- Publish the reference as root JSON when later entries need it. A nested capture
  does not automatically become a root binding. Use `<REPL.Bindings />` in a
  response to inspect the published reference; each response starts without the
  entry's bindings.
- Select the saved reference in later entries using the paired XMD.Session form.
  An unavailable or ended reference refuses and starts no replacement. After
  uncertain prompt acceptance, inspect that exact live child; never repeat the
  prompt or create a replacement to recover an unknown outcome.
- Tell the person the actual returned sessionId and the command
  `xmd repl --attach <sessionId>`, filled with that ID. The terminal attaches to
  the same live execution and conversation. One UI can attach at a time.
  `[detach]`, EOF and connection loss leave the parent-owned child running.
- Questions and permissions remain pending without a UI. A capable embedded ACP
  client presents the actual question through the parent REPL's input provider;
  permission choices follow the existing policy. Stock clients without form
  input display the question and a capability refusal. Attach a UI to answer it.
  Invalid answers leave the same question pending; stale answers refuse.
- Stop a child through XMD.Session.Shutdown in its owning parent. This waits for
  cleanup. Ending the parent performs the same cleanup. Sidekick Stop and Round
  Stop retain their existing meanings and do not shut down a child.

## Example

This **entry** publishes a reference and sends its first prompt:

```xmd
<Parse as="child" schema={{type: "object", properties: {sessionId: {type: "string"}}, required: ["sessionId"], additionalProperties: false}}>
<Agent name="xmd">
<Session name="worker">
<XMD.Session as="started" />
<Json value={started} />
</Session>
</Agent>
</Parse>

<Agent name="xmd">
<XMD.Session sessionId={child.sessionId}>
<Prompt>Run the requested program and report its actual output.</Prompt>
</XMD.Session>
</Agent>
```

The root binding `child` contains the exact reference. Another entry continues it:

```xmd
<Agent name="xmd">
<XMD.Session sessionId={child.sessionId}>
<Prompt>Continue the requested work.</Prompt>
</XMD.Session>
</Agent>
```

When the work is finished, submit:

```xmd
<XMD.Session.Shutdown sessionId={child.sessionId} />
```

## Common mistake

Using `worker`, an ACP attachment mapping, or a retained-history location as the
sessionId. Save the object returned by XMD.Session and use its sessionId. A cold
history location does not reopen an ended live resource.

## Read next

Read `<Guide.Bindings />` for cross-entry data and `<Guide.Lifetimes />` for
entry cancellation and scope-owned resources.
