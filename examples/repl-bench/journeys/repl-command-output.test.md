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

    <Repl.Focus.Draft />
    <ReplBench.Key key="Enter" />
    <ReplBench.Type text={source} />
    <ReplBench.WaitForText text="printf 'hidden-%s" />
    <ReplBench.Key key="Tab" />
    <ReplBench.WaitForText text="> Send" />
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
