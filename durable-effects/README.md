# @effectionx/durable-effects

Durable effects and replay guards for Effection workflows.

Provides a collection of durable effects (`durableExec`, `durableReadFile`,
`durableGlob`, `durableFetch`, `durableEval`, `durableResolve`) and replay
guards (`useFileContentGuard`, `useGlobContentGuard`, `useCodeFreshnessGuard`)
for use with `@effectionx/durable-streams`.

---

## Installation

```bash
npm install @executablemd/durable-effects @executablemd/durable-streams effection
```

## Usage

```typescript
import { durableRun, InMemoryStream } from "@executablemd/durable-streams";
import {
  durableExec,
  durableReadFile,
  useFileContentGuard,
} from "@executablemd/durable-effects";
import { run } from "effection";

await run(function* () {
  // Optionally install replay guards
  yield* useFileContentGuard();

  // Run a durable workflow
  const stream = new InMemoryStream();
  yield* durableRun(function* () {
    const result = yield* durableExec("build", {
      command: ["npm", "run", "build"],
    });
    const config = yield* durableReadFile("config", "./config.json");
    return { result, config };
  }, { stream });
});
```

Runtime operations are provided by `@executablemd/runtime` and are consumed
through durable effect helpers. For tests, use `@executablemd/runtime/test` or
install custom middleware with `API.*.around()`.
