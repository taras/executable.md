# Environment

Read this when you need to understand what this host can do, or how paths and
permissions behave, before writing an entry that touches either.

## Applies to

Sidekick responses asking about the host, and the REPL entries that act on the
answer.

## Instructions

- Responses and entries submitted through `<REPL.Submit />` start in this
  session's workspace, beside its journals. A manually submitted entry starts
  in the invocation's project directory. Read `<REPL.Environment />` for your
  current cwd; do not infer a project path from the workspace path.
- Write session components under `components/`, copied inputs under `inputs/`,
  and generated files at an appropriate workspace-relative path. These files
  survive reopening; another session has its own directory.
- Component lookup searches the invocation's configured directories first,
  then this session's `components/`, then ordinary registered defaults. Explicit
  includes replace the project defaults. Read the selected origin through
  `<REPL.Syntax names={["Greeting"]} />` before invoking a new component: a
  configured definition can win. A selected malformed definition fails; fix it
  rather than assuming another candidate runs.
- Request real tests with `<REPL.Test path="components/Greeting.test.md" />`
  or `<REPL.Test path="components" />`. Targets are relative to the session
  workspace even inside a response Dir; absolute and escaping paths refuse.
  A directory selects `**/*.test.md` recursively and retains configured-first
  component lookup. Tests have effects and use the command's ordinary permissions.
  Read `<Guide.Entries />` for the create, test, fix and reuse sequence.
- A nested `<Dir>` selects another known, authorized directory for its content;
  later siblings return to the workspace. To copy project input, enter its
  explicitly known project path, capture the read there, then write the copy
  after leaving Dir. Ask for the project path if you do not know it.
- Reopening restores acknowledged results, not file snapshots. A retained read
  answers with its old text; a retained write does not replace an external edit.
  Work performed before its acknowledgement may repeat after interruption.
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
<Guide.Entries />
<REPL.Environment />
<REPL.Syntax names={["File"]} />
```

The host returns the facts it knows — and its explicit unknowns — as feedback,
then asks for your next response.

For an explicitly known project at `/known/project`, this **entry** copies one
input into the session workspace. Replace that example path with the actual
known project path before submission:

```xmd
<Dir path="/known/project">
<File path="request.md" as="request" />
</Dir>
<File path="inputs/request.md">{request}</File>
```

## Common mistake

Writing an entry against a path, platform or capability you assumed rather than
read, or re-using a fact from several turns ago. Ask for the facts in the
response that is about to depend on them, and let an absent fact stop you rather
than be filled in.

## Read next

Read `<Guide.Lifetimes />` before starting processes or connections, and
`<Guide.Entries />` for the pattern that prepares the entry itself.
