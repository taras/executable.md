<Capture as="rendered">

<Section title="Durability">

Every component import and code execution is recorded in a journal.
If this document's execution crashes mid-way, re-running it replays
completed operations from the journal and continues from where it
left off — no command is re-executed, no file is re-read.

```bash exec
echo "Run at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Run this document twice. The timestamp above will be the same both
times — it was journaled on the first run and replayed on the second.

If a component file changes between runs, the replay guard detects
the stale content hash and halts replay, forcing a fresh execution.

</Section>

</Capture>

{rendered}

<Test name="Durability">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Durability"} />
<AssertStringIncludes actual={rendered} expected={"Run at:"} />
</Test>
