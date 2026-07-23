# Executable.md ACP Client Spec

ACP Specification: https://agentclientprotocol.com/protocol/v1/overview

## Motivation

Executable.md needs a reliable and consistent mechanism for interacting with coding agents like Claude Code and Codex.
This mechanism should work with Markdown syntax.

## Approach

Executable Markdown has two primary layers:

1. Markdown Syntax
2. Effection Runtime

The syntax is a convenient way to compose the underlying runtime primitives.

We should approach designing this functionality with these two layers in mind.

To ground the design in user experience, we'll start with the Markdown syntax, then map that to the Effection Runtime.

The core of the user experience are `<Agent />`, `<Session* />` and `<Prompt />` components.

### Agent Component

Agent is responsible for starting the agent subprocess and initializing a connection.

Starts claude-code agent
```md
<Agent name="claude-code" />
```

Invoking the agent multiple time does not cause multiple instances of an agent to be started,
it's useful for providing context for operations invoked within the content body of the agent component.

```md
<Agent name="codex">
  <Session as="codex-session">
    <Prompt>
      Hello World
    </Prompt>
  </Session>
</Agent>
```

### Session Component

The `<Session />` component ensures that a session exists and causes the prompt to be sent to that session.

### Prompt component

The prompt component takes a prompt and sends it to an agent.

```md
<Agent name="codex">
  <Prompt>
    Say hello world!
  </Prompt>
</Agent>
```

### Provider component

The provider component is how the user controls what the agent components do at runtime. 

The default provides is `ACPX`.

```md
<AcpxProvider>
  <Agent name="codex">
    <Prompt>
      Hello world
    </Prompt>
  </Agent>
</ApcxProvider>
```

## Detailed Design

Between the Markdown Syntax and the Effection runtime, there is a Context API.
The context api is a middleware layer that maps what happens when a component is
expanded.

```ts
interface AgentApi {
  agent(name?: string): Operation<Agent> // current agent (TODO: figure out what Agent type should be)
  session(name?: string): Operation<Session> // ensure a session exists
  prompt(prompt: string, options?: { agent?: Agent; session?: Session }): Operation<string> // send a prompt to the current session of the current agent
}
```

Each component maps to a property in the AgentApi.

* `<Agent />` -> `AgentApi.agent`
* `<Session />` -> `AgentApi.session`
* `<Prompt />` -> `ApentApi.prompt`

When a component is expanded, it applies a middleware to the context API.

```md
<Agent name="codex">
  ...
</Agent>
```

Adds agent middleware that applies the passed in agent value to the context.

```ts
yield* AgentApi.around({
  *agent([name: string], next) {
    if (!name) {
      return yield* next(); // return default agent
    } else if (yield* agentExists(name)) {
      return name;
    } else {
      throw new Error(`${name} is not available in this environment`);
    }
  }
});
```

Session adds a middleware that calls ensures a session exists

```md
<Session name="implementor" />
```

This intern adds session middleware

```ts
import { agent } from '@executablemd/acp'

yield* AgentApi.around({
  *session([name: string, next]) {
    const agent = yield* agent(); // we want to get the current agent
    if (!name) {
      return yield* next();
    } else if (yield* sessionExists(agent, name)) {
      return name; //
    } else {
      yield* createSession(agent, name);
      return name;
    }
  }
})
```

Prompt uses both to send to a specific agent and session

```md
<Prompt>
  Hello World
</Prompt>
```

This translates to 

```ts
import { agent, session } from '@executablemd/acp'

yield* AgentApi.around({
  prompt([prompt, opts]) {
    const agent = yield* agent(opts.agent);
    const session = yield* session(opts.session);
    return yield* next(prompt, { agent, session });
  }
})
```

The ACPX Provider provides the implemention for AgentApi.

```md
<AcpxProvider>
  {...}
</AcpxProvider>
```

Which inturn improvides the implementation

```ts
// instatiate acpx runtime
const runtime = createAcpxRuntime(...);

yield* AgentApi.around({
  agent([name]) {
    // not sure how to handle default agent
    return agent;
  },
  *session([name]) {
    const agent = yield* agent();
    // TBD
    return *until(runtime.ensureSession());
  },
  *prompt([prompt, options]) {
    // TBD
    return *until(runtime.prompt(prompt, { agent, session }))
  }
}, { at: "min" }) // at min to provide the default implemenation
```
