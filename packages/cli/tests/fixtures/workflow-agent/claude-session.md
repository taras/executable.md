# One reviewer, named Claude

Claude is the agent whose ordinary-`xmd run` sessions belong to a machine: they
are owned across processes, their construction is written down, and the build
behind them is observed. None of that is true of a workflow.

A workflow session belongs to a run. It is named by a row in the run's own
database, arranged in the run's own sidecar, and continued by reattaching that
row — so this document asks Claude for something, and a restart has to bring the
same conversation back without any of the machine-wide account existing at all.

<Agent name="claude">

<Session name="review">
<Prompt>What did the reviewer see?</Prompt>
<Prompt>And what did they recommend?</Prompt>
</Session>

</Agent>
