# Add session state to a REPL Plugin

Select the example from the repository root:

```sh
xmd repl --plugin ./examples/repl-plugins/counter.ts
```

Submit this entry twice. It prints `Visit 1`, then `Visit 2`:

```xmd
<Counter as="visits" />
<Output>Visit <Json value={visits} /></Output>
```

`counter.ts` declares the component once in `repl.components`. Change its factory
to change what an entry does. The host supplies entry syntax and documentation
from the declaration and packaged chapter; the Plugin needs no custom assembler.
A declaration with generated metadata also offers those forms to Sidekick.

`initialize` establishes a scoped counter once per live logical session. Its
Context lets the component and conversation setup use the same state. Child
sessions initialize independently; attaching a UI does not reset the counter.
Command installation contributes documentation without starting that state.

`sidekick` runs once per live conversation. The example retains the selected
provider and adds the current count to prompt content before Core captures it.
Agent, session and options methods forward directly to that provider. The prompt
keeps the exact checked options, so content composition changes no target.
Ordinary `Agent.prompt` middleware serves authored Prompts; retained Sidekick
turns use the captured provider directly. A conversation's decoration ends with
that conversation and does not reach entry Prompts.
