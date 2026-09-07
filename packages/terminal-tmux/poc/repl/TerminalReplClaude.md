# Terminal REPL live grid — Claude only

This document is what an authorized **Claude** live journey launches. It opens one
`xmd run` terminal grid with a single Claude pane in its own native interface.
Because it contains no Codex pane, authorizing the Claude journey can never start
Codex.

The REPL POC never modifies the agent; it watches Claude's own session file and
delivers one literal message once the pane's terminal state has converged. It is
launched only by the POC's live supervisor, under a private `HOME` and `TMPDIR`,
so the grid's tmux server, the launch journal, and the POC store are isolated from
the operator's own work. The pane's logical session name is stable; isolation
comes from the private temporary project directory the supervisor runs this in.

<Terminal.Grid columns={1}>
  <Terminal title="Implementor">
    <Agent name="claude">
      <Session.Launch session="repl-implementor">
You are the Implementor pane in a black-box REPL messaging check. Wait for a
message. When one arrives, follow it exactly and reply on a single line.
      </Session.Launch>
    </Agent>
  </Terminal>
</Terminal.Grid>
