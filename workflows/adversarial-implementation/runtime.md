---
inputs:
  type: object
  properties:
    base:
      type: string
      default: main
  additionalProperties: false
---

# Runtime and Isolation

The run owns its worktree, artifact history, processes, and deterministic
effects. A worktree isolates Git state from the user's checkout but is not a
security boundary.

## Target shape

<RunHistory ref="refs/xmd/runs">
  <Sandbox
    readable={["repository"]}
    writable={["workspace"]}
    environment="declared"
    processes="declared"
    agentNetwork="deny"
    deterministicEffects={["git-objects", "github"]}
  >
    <Worktree
      base={props.base}
      retain="on-dirty-or-failure"
    >
      <Content />
    </Worktree>
  </Sandbox>
</RunHistory>

## Manual exercise

- Use a disposable worktree.
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

`<RunHistory>` automatically snapshots completed manual executions, completed
loop iterations, terminal success, failure, and cancellation. Authors do not
repeat observed artifact paths in an explicit checkpoint.

## Loop interruption

An automated iteration stops on the first applicable signal:

1. The iteration reaches its defined completion.
2. A configured file is created or updated in a configured directory.
3. The user provides runtime input.

Runtime user input waits for the Effection terminal UI ecosystem to mature. The
Effection inspector remains out-of-band meta-control for exceptional inspection
and intervention, not the routine decision protocol.
