import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const HELLO = `---
title: Hello World
---

# {meta.title}

<AnthropicProvider model="claude-opus-4-5">
  <OllamaProvider model="llama3.2">
    <Instruction system="You are a creative comedian.">
      <Sample model="llama3.2">
        Smart: <Sample prompt="Say something smart" model="claude-opus-4-5" />
        Joke:  <Sample prompt="Tell me a joke" model="llama3.2" />
        Combine Smart and Joke into one smart joke
      </Sample>
    </Instruction>
  </OllamaProvider>
</AnthropicProvider>`;

export default define.page(function Providers() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">LLM providers</h1>
      <p class="muted">
        Provider components install <code>Sample</code>{" "}
        middleware so a document can talk to cloud or local models with no
        custom runtime wiring. Model routing is by the <code>model</code> prop.
      </p>

      <h2>Built-in providers</h2>
      <p>
        These ship in <code>packages/core/components/</code>:
      </p>
      <ul>
        <li>
          <code>AnthropicProvider.md</code>{" "}
          — cloud models via the Anthropic API.
        </li>
        <li>
          <code>OllamaProvider.md</code>{" "}
          — local models via a running Ollama server.
        </li>
        <li>
          <code>LlamafileProvider.md</code> — local models via llamafile.
        </li>
        <li>
          <code>Sample.md</code> — the sampling call itself.
        </li>
        <li>
          <code>Instruction.md</code>{" "}
          — surfaces a system prompt as visible, composable content.
        </li>
      </ul>

      <h2>One document, two models</h2>
      <p>
        Providers nest. <code>&lt;Sample&gt;</code>{" "}
        routes each prompt to the matching model and combines the results — all
        in a single markdown file.
      </p>
      <CodeBlock filename="packages/core/examples/hello-world.md">
        {HELLO}
      </CodeBlock>

      <h2>Running provider documents</h2>
      <p>
        For this release, provider documents need the built-in components on the
        search path:
      </p>
      <CodeBlock>
        {"xmd run packages/core/examples/hello-world.md --component-dir packages/core/components"}
      </CodeBlock>
      <p>
        The example above also needs an <code>ANTHROPIC_API_KEY</code>{" "}
        in the environment and a local Ollama server running{" "}
        <code>llama3.2</code>. Embedding the built-in components into the binary
        (so <code>--component-dir</code> isn't required) is on the roadmap.
      </p>

      <p style="margin-top:2rem;">
        Next: <a href="/docs/reference">Reference →</a>
      </p>
    </>
  );
});
