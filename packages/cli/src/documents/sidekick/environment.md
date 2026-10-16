# Environment

Read this when you need to understand what this host can do, or how paths and
permissions behave, before writing an entry that touches either.

## Applies to

Sidekick responses asking about the host, and the REPL entries that act on the
answer.

## Instructions

- This chapter teaches you how to *interpret* host facts. It states none of
  them, because a fact written into teaching text is a fact that goes stale.
  Ask for the current ones with `<REPL.Environment />`.
- Treat what that read returns as the facts at the moment you asked. It is a
  snapshot retained with your operation, not a cache you can rely on later.
- What it does not report, you do not know. An absent fact is an explicit
  unknown, not a default — do not substitute a guess for it.
- Component documentation is not permission. `<REPL.Syntax />` describes what
  the entry vocabulary *is*; whether a particular execution admits a particular
  capability is a separate question, answered when the entry runs.
- An entry's subprocesses are its own: they are started under the entry's
  permissions, captured and recorded, and released with it. They are not a shell
  you hold open across entries.
- You have no native shell, file-editing or MCP tools. File and command work
  belongs in an ordinary entry, under that entry's permissions.
- Workspace policy and language rules are different things. The language says
  what you may write; the workspace says what this execution may reach. A
  construct can be perfectly valid and still be refused here.

## Example

```xmd
<REPL.Environment />
```

The host returns the facts it knows — and its explicit unknowns — as feedback,
then asks for your next response.

## Common mistake

Writing an entry against a path, platform or capability you assumed rather than
read, or re-using a fact from several turns ago. Ask for the facts in the
response that is about to depend on them, and let an absent fact stop you rather
than be filled in.

## Read next

Read `<Guide.Lifetimes />` before starting processes or connections, and
`<Guide.Entries />` for the pattern that prepares the entry itself.
