---
props:
  type: object
  properties:
    pullModel:
      type: boolean
      default: false
    model:
      type: string
      default: "qwen3:30b-a3b"
  additionalProperties: false
---

<EnsureOxlint />

<OxlintConfig />

```ts eval
import { exec } from "@executablemd/runtime";

if (pullModel) {
  const installed = yield* exec({ command: ["ollama", "show", model] });
  if (installed.exitCode !== 0) {
    const pulled = yield* exec({ command: ["ollama", "pull", model] });
    if (pulled.exitCode !== 0) {
      throw new Error(pulled.stderr || `Unable to provision Ollama model ${model}`);
    }
  }
}
```
