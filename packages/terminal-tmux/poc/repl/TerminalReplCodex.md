# Terminal REPL live grid — Codex only

This document is what an authorized **Codex** live journey launches. It opens one
`xmd run` terminal grid with a single Codex pane in its own native interface.
Because it contains no Claude pane, authorizing the Codex journey can never start
Claude.

The REPL POC never modifies the agent; it watches Codex's own rollout file and
delivers one literal message once the pane's terminal state has converged. It is
launched only by the POC's live supervisor, under a private `HOME` and `TMPDIR`,
so the grid's tmux server, the launch journal, and the POC store are isolated from
the operator's own work. The pane's logical session name is stable; isolation
comes from the private temporary project directory the supervisor runs this in.

<Terminal.Grid columns={1}>
  <Terminal title="Reviewer">
    <Agent name="codex">
      <Session.Launch session="repl-reviewer">
You are the Reviewer pane in a black-box REPL messaging check. Wait for a
message. When one arrives, follow it exactly and reply on a single line.
      </Session.Launch>
    </Agent>
  </Terminal>
</Terminal.Grid>
