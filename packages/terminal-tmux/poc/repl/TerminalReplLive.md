# Terminal REPL live grid

This document is what an authorized live journey launches. It opens one `xmd run`
terminal grid with two black-box coding agents — a Claude pane and a Codex pane —
each in its own native interface. The REPL POC never modifies these agents; it
watches their session files and delivers one literal message to a pane once that
pane's terminal state has converged.

It is launched only by the POC's live supervisor, under a private `HOME` and
`TMPDIR`, so the grid's tmux server, the launch journal, and the POC store are all
isolated from the operator's own work. The panes' logical session names are
stable; isolation comes from the private temporary project directory the
supervisor runs this in, whose path already makes each session key unique.

<Terminal.Grid columns={2}>
  <Terminal title="Implementor">
    <Agent name="claude">
      <Session.Launch session="repl-implementor">
You are the Implementor pane in a black-box REPL messaging check. Wait for a
message. When one arrives, follow it exactly and reply on a single line.
      </Session.Launch>
    </Agent>
  </Terminal>

  <Terminal title="Reviewer">
    <Agent name="codex">
      <Session.Launch session="repl-reviewer">
You are the Reviewer pane in a black-box REPL messaging check. Wait for a
message. When one arrives, follow it exactly and reply on a single line.
      </Session.Launch>
    </Agent>
  </Terminal>
</Terminal.Grid>
