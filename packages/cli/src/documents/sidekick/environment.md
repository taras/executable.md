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
- Resolve relative paths against the current working directory. For example,
  `inputs/sales.json` names a file beneath that directory. Do not add a leading
  slash or reinterpret an absolute path as relative to the workspace.
- Use relative paths for ordinary file and command work. Do not use absolute
  host paths in File, commands or Dir to reach files outside the workspace.
  When you intentionally need an external non-repository file, request approval
  to import it with `<REPL.ImportAsset />`, then use its returned relative path.
- Write session components under `components/`, copied inputs under `inputs/`,
  and generated files at an appropriate workspace-relative path. These files
  survive reopening; another session has its own directory.
- On Deno and compiled hosts, a fresh `<Repository>` selection in a submitted
  entry places its checkout beneath this workspace's `repositories/`. Worktrees
  follow that root. Read the actual returned checkout path and current workspace
  before deriving a relative address; do not guess the slot layout. Later entries
  can read that relative path without acquiring again, including after reopening.
  Existing recorded placements keep their paths. Placement grants no permission.
- Import a non-repository asset directly in your response with
  `<REPL.ImportAsset source="/known/external/mock ü.html" destination="inputs/mock ü.html" />`.
  Propose `inputs/<original filename>`, preserving spaces and Unicode. The
  question shows the exact resolved source, destination and relative result.
  Only Import permits copying; Decline or Stop copies nothing while approval
  waits. A supplied path alone is not approval. Use the returned relative path
  for later ordinary reads, including after reopening.
- An occupied file, directory or symlink refuses import. Choose another explicit
  destination and request fresh approval. An unfinished import has an unknown
  outcome; inspect the saved evidence and destination before another request.
  Repository files follow repository acquisition.
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
- To change the working directory for part of a document, use a nested `<Dir>`
  with a known, authorized relative path. Paths inside it resolve from that
  directory; later siblings return to the enclosing directory. A context change
  grants no permission. `<REPL.ImportAsset>` always copies into the session
  workspace, even when a response changes its working directory.
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
- You have no native shell, file-editing or MCP tools. Ordinary File and command work
  belongs in an entry, under that entry's permissions. Use the direct import
  control for non-repository host assets.
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

For a known non-repository asset, write this in your **response**:

```xmd
<REPL.ImportAsset source="/known/external/mock ü.html" destination="inputs/mock ü.html" />
```

The person sees the exact source and destination before any file content is
read. After Import succeeds, feedback gives `inputs/mock ü.html`. A later
**entry** reads that copy, including after reopening:

```xmd
<File path="inputs/mock ü.html" />
```

The same imported file can be read inside an explicit relative directory
context. Here `mock ü.html` resolves from `inputs/`; after `Dir` ends, the
enclosing working directory is restored:

```xmd
<Dir path="inputs">
<File path="mock ü.html" as="mock" />
<Output>{mock}</Output>
</Dir>
```

## Common mistake

Writing an entry against a path, platform or capability you assumed rather than
read, or re-using a fact from several turns ago. Ask for the facts in the
response that is about to depend on them, and let an absent fact stop you rather
than be filled in.

## Read next

Read `<Guide.Children />` before delegating a program to a headless XMD child.

Read `<Guide.Lifetimes />` before starting processes or connections, and
`<Guide.Entries />` for the pattern that prepares the entry itself.
