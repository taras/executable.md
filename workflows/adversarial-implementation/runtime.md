# Runtime and Isolation

The command selects the environment; the document describes the procedure.
`xmd run` uses the caller's current environment and promises no restoration.
`xmd workflow start` creates a workflow run with one retained root Workspace
(#366, shipped). That Workspace supplies the run's filesystem today: an
authored path resolves inside the run's own transactional store rather than
against a host directory, and `temporaryDirectory` is refused because a run has
no host directory to hand out. The repository, worktree, process, and
working-directory capabilities the stages want are composition it does not have
yet (#293, #302).

The same declarative components work in both. Durability comes from the host,
not from a second spelling of `<File>` or `<Git.Commit>`.

## Target shape

```sh
xmd workflow start \
  --props-request="…" \
  --props-repository=https://github.com/acme/project.git \
  --props-base=main \
  workflows/adversarial-implementation/start.md
```

<Repository name="project" url={props.repository} base={props.base}>
  <Worktree name="implementation" branch={props.branch} as="worktree">
    <Content />
  </Worktree>
</Repository>

Root props supply the locator and the base. A repository name is stable
component identity inside the Workspace, never a key into hidden configuration,
and `xmd workflow start` uses the same generated `--props-*` arguments as
`xmd run`.

## What the run owns

The workflow run owns its Workspace, its repositories and worktrees, its Agent
sessions, its filtered journal, and the results of the commands it ran. Nothing
required lives only in an Agent transcript, a host path, a provider handle, or a
branch name.

That last one is the host's decision rather than the document's, and `start` and
`resume` both make it the same way: a run retains the exit status and both
channels each command's output arrived on at the per-exec boundary, whatever
the document's display policy showed a reader, because a resumed procedure reads
back what a command printed instead of running it again to find out. Routing is
separate — an ordinary block forwards both channels live and renders neither
again at completion — and so is failure, since a nonzero exit fails the run
unless the document bound it. `Process.join()` may settle before the output
pumps finish, so a tail written as they settle may never reach that boundary;
effectionx #244 owns the stronger guarantee and nothing here claims it.

- `<Repository>` authorizes the locator, resolves the base once, pins that
  commit, and creates the named primary checkout. Resolution happens once;
  replay does not re-query a moving branch (#293).
- `<Worktree>` adds a named linked checkout on its own branch inside that
  Repository. Its identity is Repository identity plus name, independent of any
  attachment-specific absolute path.
- Both install contextual cwd while rendering their children and bind their
  Workspace-relative path through `as`.
- `<Dir>` changes cwd and nothing else.

A worktree isolates Git state from the user's checkout. It is composition and
isolation, not a security boundary.

## The Agent ceiling is the host's, not the document's

Workflow Agents are mandatorily read-only, enforced in two places: the provider
permission bridge allows only read and search operations, and the provider runs
in its native read-only sandbox. No third place presents Workspace paths as
read-only filesystem views, because none is registered with an Agent at all.
`<ApproveAll>`, repository `.codex` or `.claude` configuration, and prompt
content cannot raise that ceiling, and a provider that cannot enforce it fails
before Prompt execution (#302).

There is therefore no `<Sandbox>` component in this workflow, and no document
prop that grants an Agent write access. Earlier drafts of this document declared
readable roots, writable roots, environment, process, and network policy as
markup; that authority moved to the host, where a document cannot widen it.

There is no directory access at all. A workflow Agent receives no Workspace
checkout and no read-only materialization of one, no Workspace or host path as
its working directory, no `additionalDirectories` over ACP, and no component
that registers a directory with its session. Lexical `<Dir>` establishes cwd for
XMD's own file effects and tells an Agent nothing.

What an Agent reasons over is what a prompt renders into it. Repository
observation, when it exists, is the bounded request/result loop #302 and #369
still owe: an Agent asks in the source it returns, XMD performs the read as its
own effect, and the result comes back as data. Until then a stage that needs
evidence is handed it as a value — `InstructionFiles` is the shipped example,
carrying exact repository-relative paths and contents that host-authored file
effects produced. An Agent still proposes changes by returning XMD, which a
constrained evaluator preflights and expands as ordinary durable effects against
the authoritative Workspace (#369).

The engine keeps the same shape underneath. A workflow run reaches core as a
trusted host installation: an admission core applies inside its own journal
read, and a preparation it runs inside the durable root ahead of every public
document policy, the root import, and every authored effect. Public middleware
composed around an execution or a document expansion may inspect what it is
given, narrow it, install contextual behavior, refuse, and delegate; whatever it
returns is ignored, and it can neither bring an execution or an expansion into
being nor publish an outcome (#432, #433). So what is composed around a run
cannot widen its authority, exactly as what a prompt says cannot widen an
Agent's.

Agent network access is denied for this workflow, which is why a review prompt
must render everything the reviewer has to judge rather than pointing at it.

## Interruption, suspension, and cancellation

Three outcomes are distinct, and none of them is a failure of the document:

- **Suspension.** A run that calls `suspendFor()` records its pending request
  and the Workspace frontier, gives the executor lock back, and returns with a
  run ID and stop reason on standard error; `resume` continues when the answer
  is available (#367, shipped). It is an Api operation rather than a v1 Markdown
  element, and this workflow calls nothing that suspends, so no checkpoint here
  reaches it.
- **Interruption.** Losing the executor outside an authored wait, including
  Ctrl-C, leaves the run `interrupted` and resumable at the journal frontier.
- **Cancellation.** `xmd workflow cancel <run-id>` never reaches into a live
  document execution. When the lock reports a live workflow executor it refuses
  without mutation and directs the caller to interrupt that foreground process
  instead. Without one, an eligible retained state — a stale `running` with no
  root Close, or a `suspended` or `interrupted` run — transitions to `cancelled`
  under the exact executor lock, validated inside the transaction that publishes
  it. A `completed` or `failed` outcome is authoritative and cancellation
  refuses. It retains the journal and Workspace for inspection and does not undo
  completed local or external effects.

An uncaught failure escaping the root is terminal too. Reusing that run's ID
replays the retained failure rather than silently retrying it; a corrected
document starts a new run.

Two of the three are here. `start` and `resume` are shipped (#366): an
interrupted run stays resumable at the journal frontier, a failed or cancelled
run is refused before anything is fetched, attached or appended, and a resume of
a completed run replays it in full. Reading a run back is shipped too —
`xmd workflow status`, `list`, and `history` report immutable lifecycle
snapshots, taking no executor lease, advancing nothing, attaching no Workspace,
and appending nothing (#367's first slice, delivered by #460).

A run whose host was lost is readable too (#521, shipped). Ordinary inspection
reads the retained snapshot; only SQLite's exact `SQLITE_READONLY_ROLLBACK` —
the hot journal a lost host left, which a read-only connection may not put back
— falls through to recovery, which copies the database and its journal under
coordination and rolls the journal back into the copy. The crashed source stays
byte-identical, still waiting for the write-capable owner whose job recovery is.
That coordination confers no executor or lifecycle authority and opens no
Workspace or provider effects, and `list` stays complete-or-error.

Lifecycle authority is here too. The executor lock owns the transitions, so
single-executor ownership, atomic begin and settle, `cancel` and `delete` are
shipped (#367's second slice, delivered by #466). Cancellation never reaches
into a live document execution: when the lock reports a live workflow executor,
`xmd workflow cancel` refuses without mutation and tells the caller to interrupt
the foreground process, and Ctrl-C tears the scope down in order, publishes
`interrupted` and leaves the run resumable. Without a live executor the
management host acquires the lock and publishes `cancelled` inside the
transaction that validates it.

The wait is here too, as substrate. `suspendFor()` suspends a run durably and
gives its executor lock back (#367), and a typed answer can be delivered to it
(#300). What is missing is anything that reaches or acts on it: `suspendFor()`
is an Api operation with no v1 element spelling it, this document calls nothing
that suspends, delivery executes nothing, and no scheduler resumes a run.

Explicit history forks are shipped (#368, delivered by #498) — compatible forks,
`history --forkable`, forkability reasons, lineage, changed-definition replay
admission and retained Workspace-root copying. That is a new run continuing one
run's retained history under a definition the caller names, and it is a
different thing from an Agent provider continuing a session: no provider-level
Agent-session fork exists, and nothing here schedules or resumes either one.

## Cleanup follows the invocation

Resources clean up with their execution. Agent sessions, processes, and streams
stop before their enclosing scope closes, and content a caller projects keeps
the caller's bindings while its live effects belong to the invocation that
projected it and stop before that invocation cleans up its own (#203, shipped).
That ordering is what makes a workspace safe to tear down: a process a stage
started stops before the directory it ran in goes away.

Scope cleanup releases live attachments. It does not delete run-owned state:
every run status is retained until an explicit `xmd workflow delete`, and
deletion never claims to undo a push, a pull request, or an issue (#367).

## Loop interruption

An automated iteration stops on the first applicable signal:

1. The iteration reaches its defined completion.
2. A durable signal the run is waiting on arrives.
3. The user provides runtime input.

Signal 3 has a shipped in-run form: `<Elicit>` asks a person a schema-validated
question during execution, and under `xmd run` the WebForm provider answers it
in a browser. Under `xmd workflow` it is the same `<Elicit>` and the same
provider: an unanswered question opens a loopback form and blocks the run, which
stays `running`, settles nothing as `suspended`, records no suspension request,
and keeps its executor lock. An authored `<Answers>` region answers it instead.

A durable suspension is a different mechanism, and it is shipped as substrate:
`suspendFor()` suspends a run and gives its executor lock back (#367), and a
typed answer can be delivered to the waiting run
([#300](https://github.com/taras/executable.md/issues/300)). `suspendFor()` is an
Api operation — there is no v1 Markdown element for it — and this workflow
installs no component or middleware that turns an `<Elicit>` into one, so no
checkpoint here releases the executor. Delivery executes nothing, arbitration
between signals is not implemented, nothing schedules a resumption, and
premature watcher semantics are deliberately excluded.

`<Loop>` already records part of this: it journals every iteration it enters and
one terminal record whose outcome is `break`, `exhausted`, or `error`, and it
refuses a replay whose stored outcome or iteration count disagrees with what
this execution reached. There is no `cancelled` loop outcome — run-level
cancellation and stop reasons are retained run state, not loop state.

The Effection inspector remains out-of-band meta-control for exceptional
inspection and intervention, not the routine decision protocol.
