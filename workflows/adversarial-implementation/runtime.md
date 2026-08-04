---
props:
  base:
    type: string
    default: main
---

# Runtime and Isolation

The workflow's run owns its worktree, artifact ledger, processes, and
deterministic effects. It pins the source revision before creating the
worktree. A worktree isolates Git state from the user's checkout but is not a
security boundary.

`<Workflow>` (#289), `<Sandbox>` (#302), and `<Worktree>` (#293) do not exist
yet. The contextual working directory they depend on does: `Env.cwd` is
implemented and already inherited by `<File>`, `<Glob>`, exec blocks, and
daemons (#222), and `<TempDir>` already establishes one for its content (#216).

## Target shape

<Workflow base={base} historyRef="refs/xmd/runs">
  <Sandbox
    readable={["repository"]}
    writable={["workspace"]}
    environment="declared"
    processes="declared"
    agentNetwork="deny"
    deterministicEffects={["git-objects", "github"]}
  >
    <Worktree retain="on-dirty-or-failure">
      <Content />
    </Worktree>
  </Sandbox>
</Workflow>

## Manual exercise

- Resolve `base` to a pinned source revision before planner discovery and
  record it in the artifact ledger.
- Create a disposable worktree from that pinned revision before discovery.
- Keep handoffs and user decisions as restored artifact versions rather than
  transfer files within the worktree.
- Let `<Worktree>` set `Env.cwd` while it renders every child.
- Give the planner read and search access.
- Restrict implementor writes to worktree files.
- Do not give the implementor write access to shared Git metadata.
- Deny agent network access for the first deliberately limited feature.
- Let explicit user-run commands perform commits, issues, and pull requests.
- Stop all processes when a stage ends.
- Retain a dirty worktree after failure or cancellation and report its path and
  recovery state.

An enforceable sandbox becomes mandatory before implementation runs
unattended. The manual exercise uses the narrowest host sandbox and permission
policy already available.

`<Workflow>` will record an artifact version when a stage or loop iteration
completes, and a terminal record on success, failure, and cancellation, then
restore a resumed stage's declared inputs. Authors do not repeat observed
artifact paths or generate transfer files in an explicit checkpoint.

`<Loop>` already records part of that: it journals every iteration it enters
and one terminal record whose outcome is `break`, `exhausted`, or `error`, and
it refuses a replay whose stored outcome or iteration count disagrees with what
this run reached. There is no `cancelled` loop outcome, and no stage-stop
record — workflow-level cancellation and stop reasons belong to `<Workflow>`
and `<Stage>`, which do not exist yet.

## Loop interruption

An automated iteration stops on the first applicable signal:

1. The iteration reaches its defined completion.
2. A configured file is created or updated in a configured directory.
3. The user provides runtime input.

None of that arbitration is implemented ([issue
#300](https://github.com/taras/executable.md/issues/300)). Signal 3 has a
shipped in-run form: `<Elicit>` asks a person a schema-validated question
during execution, and under `xmd run` the WebForm provider answers it in a
browser. What remains missing is cross-process continuation — stopping at a
stage boundary and resuming in a later invocation — which `<Stage>` owns rather
than `<Elicit>` (#298). The Effection inspector remains out-of-band
meta-control for exceptional inspection and intervention, not the routine
decision protocol.
