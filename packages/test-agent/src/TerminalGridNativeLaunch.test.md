# Native sessions in terminal panes

A `<Session.Launch>` written at the root takes the run's one foreground
terminal, so native UIs are sequential: the second waits for the first to
close. Inside a `<Terminal>` that would defeat the point of a grid, where every
pane is interactive at the same time.

So a pane comes with a launcher of its own. `<Session.Launch>` finds it simply
by being written there — it is handed no pane, no ordinal and no mode, and the
session it prepares, the argv it hands the UI and the phases it retains are the
ones a root launch would have. What changes is which terminal answers.

Terminal ownership and session ownership stay separate. Holding a pane says
nothing about which Agent session that pane may own, which is still the session
coordinator's to answer.

Everything below runs against the deterministic test agent and a terminal
provider that presents nothing, so the "native UI" in each pane is a recorded
request rather than a process.

<TestAgent>
<TestAgent.Scenario session="planner" src="./TerminalGridNativeLaunch.planner.md" />
<TestAgent.Scenario session="implementor" src="./TerminalGridNativeLaunch.implementor.md" />

Two panes, two sessions. Neither launch names the other, and neither waits for
it: they hold their own pane terminals at the same time, and the grid is shown
only once both native children have started.

<Test name="two panes launch two native sessions of their own">
<Terminal.Grid columns={2}>
<Terminal title="Planner">
<Session.Launch session="planner">
You are the repository planner.
</Session.Launch>
</Terminal>
<Terminal title="Implementor">
<Session.Launch session="implementor">
You are the repository implementor.
</Session.Launch>
</Terminal>
</Terminal.Grid>

Neither launch was a turn. Each scenario still holds its one stage, and the
answers say which conversation replied — so the two panes prepared two
sessions rather than one shared between them.

<Session name="planner">
<Prompt as="planner">which pane are you in?</Prompt>
</Session>

<Session name="implementor">
<Prompt as="implementor">which pane are you in?</Prompt>
</Session>

<AssertMatch actual={planner} expected={/the planner pane/} />
<AssertMatch actual={implementor} expected={/the implementor pane/} />
</Test>
</TestAgent>
