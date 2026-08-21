<Section title="Executable Code Blocks">

Code blocks with `exec` in the info string are executed as shell
commands. The output replaces the code block in the rendered document.
For example, counting the markdown files in this suite:

```bash exec
find smoke-test -name '*.md' | wc -l | tr -d ' '
```

The info string is a **middleware chain** read left-to-right. Each
word after the language is a modifier handler that wraps the next:
`exec` alone runs the command and shows stdout, `silent exec` runs and
journals the command but suppresses output, and blocks without `exec`
are passed through as regular markdown.

</Section>

<Test name="exec renders command stdout">
<Let as="visibleExec">
```bash exec
echo "Hello from a durable workflow"
```
</Let>
<AssertEquals actual={visibleExec} expected={"\nHello from a durable workflow"} />
</Test>

<Test name="silent exec suppresses rendered output">
<Let as="silentExec">
```bash silent exec
echo "This output is journaled but not shown in the document"
```
</Let>
<AssertEquals actual={silentExec} expected={""} />
</Test>

<Test name="Non-executable code blocks pass through verbatim">
<Let as="yamlBlock">
```yaml
# This is just a code block — not executed
props:
  name:
    type: string
```
</Let>
<AssertEquals actual={yamlBlock} expected={"\n```yaml\n# This is just a code block — not executed\nprops:\n  name:\n    type: string\n```"} />
</Test>
