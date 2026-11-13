<Test name="both entry readings display captured control bytes as text" timeout="60s">
  <ReplBench scenario="scripts/tests/fixtures/repl-sidekick-command-output.md" columns={160} rows={44}>
    <ReplBench.Focus target="sidekick-composer" />
    <ReplBench.Type text="Run the probe." />
    <ReplBench.Region name="sidekick-composer">
      <ReplBench.WaitForText text="Run the probe." />
    </ReplBench.Region>
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="1 ✓" />
    <ReplBench.WaitForText text="Probe completed." />
    <ReplBench.WaitForText text="[stop]" present={false} />
    <ReplBench.WaitForText text="│  Output" as="output" />
    <ReplBench.WaitForText text="Entry agents · No retained entry-agent turns" as="associated" />
    <ReplBench.WaitForText text={"PROBE\\x1b[2JTAIL\\x0dEND"} row={output.row+1} as="entryText" />
    <ReplBench.WaitForText text={"PROBE\\x1b[2JTAIL\\x0dEND"} row={associated.row+1} as="associatedText" />
    <AssertEquals actual={entryText.column === output.column+3} expected={true} />
    <AssertEquals actual={associatedText.column >= associated.column} expected={true} />
    <ReplBench.WaitForText text={"PROBE\\x1b[2JTAIL\\x0dEND"} count={2} />
    <ReplBench.WaitForText text="�" present={false} />
  </ReplBench>
</Test>

<Test name="bound, captured, and silent commands route output to the right terminal reading">
  <ReplBench columns={160} rows={52}>
    <Let as="source" select="code">
````xmd
```sh exec as="result"
printf 'bound-%s\n' stdout
printf 'bound-%s\n' stderr >&2
exit 7
```
{result.stdout}
<Let as="captured">
```sh exec
printf 'capture-%s\n' stdout
printf 'capture-%s\n' stderr >&2
```
</Let>
```sh silent exec
printf 'hidden-%s\n' stdout
printf 'hidden-%s\n' stderr >&2
```
````
    </Let>

    <ReplBench.Type text={source} />
    <ReplBench.WaitForText text="printf 'hidden-%s" />
    <ReplBench.Key key="Enter" />
    <ReplBench.WaitForText text="1 ✓" />
    <ReplBench.WaitForText text="✓ COMPLETED" />
    <ReplBench.WaitForText text="│  Output" as="output" />
    <ReplBench.WaitForText text="bound-stdout" row={output.row+1} />
    <ReplBench.WaitForText text="bound-stdout" count={1} />
    <ReplBench.WaitForText text="Command stderr" as="stderr" />
    <ReplBench.WaitForText text="capture-stderr" row={stderr.row+1} />
    <ReplBench.WaitForText text="bound-stderr" present={false} />
    <ReplBench.WaitForText text="capture-stdout" present={false} />
    <ReplBench.WaitForText text="hidden-stdout" present={false} />
    <ReplBench.WaitForText text="hidden-stderr" present={false} />
  </ReplBench>
</Test>
