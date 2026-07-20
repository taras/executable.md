<Section title="Executable Code Blocks">

Code blocks with `exec` in the info string are executed as shell
commands. The output replaces the code block in the rendered document.

How many markdown files are in the smoke-test directory?

<Capture as="fileCount">
```bash exec
find smoke-test -name '*.md' | wc -l | tr -d ' '
```
</Capture>

{fileCount}

The info string is a **middleware chain** read left-to-right. Each
word after the language is a modifier handler that wraps the next.

`exec` alone — runs the command, shows stdout:

<Capture as="visibleExec">
```bash exec
echo "Hello from a durable workflow"
```
</Capture>

{visibleExec}

`silent exec` — runs and journals the command, but suppresses
output. Useful for setup steps:

<Capture as="silentExec">
```bash silent exec
echo "This output is journaled but not shown in the document"
```
</Capture>

{silentExec}

Non-executable code blocks are passed through as regular markdown.
This block has no `exec` modifier, so it's just syntax-highlighted text:

<Capture as="yamlBlock">
```yaml
# This is just a code block — not executed
inputs:
  name:
    type: string
```
</Capture>

{yamlBlock}

<Test name="Execution">
<AssertMatch actual={fileCount} expected={/^\n\d+$/} />
<AssertEquals actual={visibleExec} expected={"\nHello from a durable workflow"} />
<AssertEquals actual={silentExec} expected={""} />
<AssertEquals actual={yamlBlock} expected={"\n```yaml\n# This is just a code block — not executed\ninputs:\n  name:\n    type: string\n```"} />
</Test>

</Section>
