<Capture as="rendered">

<Section title="Executable Code Blocks">

Code blocks with `exec` in the info string are executed as shell
commands. The output replaces the code block in the rendered document.

How many markdown files are in the smoke-test directory?

```bash exec
find smoke-test -name '*.md' | wc -l | tr -d ' '
```

The info string is a **middleware chain** read left-to-right. Each
word after the language is a modifier handler that wraps the next.

`exec` alone — runs the command, shows stdout:

```bash exec
echo "Hello from a durable workflow"
```

`silent exec` — runs and journals the command, but suppresses
output. Useful for setup steps:

```bash silent exec
echo "This output is journaled but not shown in the document"
```

Non-executable code blocks are passed through as regular markdown.
This block has no `exec` modifier, so it's just syntax-highlighted text:

```yaml
# This is just a code block — not executed
inputs:
  name:
    type: string
```

</Section>

</Capture>

{rendered}

<Test name="Execution">
<AssertStringIncludes actual={rendered} expected={"\u00a7 Executable Code Blocks"} />
<AssertMatch actual={rendered} expected={/\d+/} />
<AssertStringIncludes actual={rendered} expected={"Hello from a durable workflow"} />
<AssertNotMatch actual={rendered} expected={/This output is journaled but not shown in the document/} />
<AssertStringIncludes actual={rendered} expected={"# This is just a code block"} />
<AssertStringIncludes actual={rendered} expected={"type: string"} />
</Test>
