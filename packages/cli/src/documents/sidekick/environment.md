# Environment

Read this when you need to understand what this host can do, or how paths and
permissions behave, before writing an entry that touches either.

## Applies to

Sidekick responses asking about the host, and the REPL entries that act on the
answer.

## Instructions

- Responses, manual entries and entries submitted through `<REPL.Submit />`
  start in the selected launch project. `<Cwd />` renders that contextual
  directory with no added newline; `as="directory"` captures the same text.
  `<REPL.Environment />` reports it with the host's other current facts.
- Resolve relative paths against the current working directory. For example,
  `inputs/sales.json` names a file beneath that directory. Do not add a leading
  slash or reinterpret an absolute path as relative to the workspace.
- Use relative paths for ordinary file and command work. Host absolute Dir
  selection requires the person to invoke `xmd repl --allow-absolute` and the
  effective filesystem policy to permit both absolute and write. A mount grants
  neither: new mapped absolute ensures need that opt-in too. File, File.Delete
  and Glob operands remain relative even when absolute directory access is allowed.
  When you intentionally need an external non-repository file, request approval
  to import it with `<REPL.ImportAsset />`, then use its returned relative path.
  Import remains available with absolute denied when effective read and write
  allow it. Its individual approval grants no subsequent absolute access.
- Write project files with ordinary File operations. Sidekick XMD file access
  stays within the launch project, read-only session assets and this session's
  components. Journals, compiler files and other private session storage remain
  unavailable even when storage is beneath the project. Absolute opt-in, mounts,
  Repository and cwd selection grant no additional file authority. Shell and
  trusted native code have their own permissions; these XMD limits are not an
  operating-system sandbox.
- Use `<REPL.ComponentDir>…</REPL.ComponentDir>` to publish or edit session
  component source, tests and contained fixtures. Paths inside are relative to
  `SESSION/components`; outside they are ordinary project paths. Publishing a
  definition invokes none of it. A later invocation runs in its caller's cwd.
- Use `<REPL.AssetDir>…</REPL.AssetDir>` to read or list approved assets. Paths
  inside are relative to `SESSION/assets`. The scope is read-only, including
  nested scopes and temporary allocation, and entering it creates nothing.
- Import a non-repository asset directly in your response with
  `<REPL.ImportAsset source="/known/external/mock ü.html" destination="assets/mock ü.html" />`.
  Propose `assets/<original filename>`, preserving spaces and Unicode. The
  question shows the exact resolved source, destination and relative result.
  Only Import permits copying; Decline or Stop copies nothing while approval
  waits. A supplied path alone is not approval. Read the returned session-relative copy inside AssetDir, including after reopening.
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
- Read `current response policy` as the effective XMD file read/write/absolute
  policy for this response. Read `submitted-entry start policy (session scope;
  entry content may narrow it)` as the policy observed in the owner that starts
  submitted entries. It does not describe arbitrary nested entry content.
  `approved import` states eligibility under current response read/write plus
  separate per-file user approval, independent of absolute; eligibility is not
  source/destination validation or approval. These facts grant no native tools
  or component admission.
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

- Read the session checklist with `<Sidekick.Todo as="items" />`. Edit it with
  the paired form containing one fenced unified diff. Both return ordered
  `{ text, completed }` items and render nothing. Keep inline Markdown source.
- Both Todo forms receive ordinary result feedback in this exchange. A person's
  eligible idle edit can send a TODO change message; busy edits arrive as context
  on a later independently allowed prompt. Neither an edit nor recovery resumes
  a stopped exchange. Read again when you need current state.

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
<REPL.ImportAsset source="/known/external/mock ü.html" destination="assets/mock ü.html" />
```

The person sees the exact source and destination before any file content is
read. After Import succeeds, feedback gives `assets/mock ü.html`. A later
**entry** reads that copy, including after reopening:

```xmd
<REPL.AssetDir><File path="mock ü.html" /></REPL.AssetDir>
```

Capture or list that same copy in its read-only context:

```xmd
<REPL.AssetDir as="asset">
<File path="mock ü.html" as="mock" />
<Glob include={["*.html"]} as="paths" />
<Output>{mock}</Output>
</REPL.AssetDir>
<Output>{asset}</Output>
```

Outside AssetDir, `assets/mock ü.html` names the project's independent file.
After either session scope ends, the enclosing cwd and permissions return.

To see an imported PNG in your next turn, supply its path relative to the
session assets directory. Request up to two images per response, at most
2 MiB each.

```xmd
<REPL.InspectImage path="reference/mockup.png" />
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
