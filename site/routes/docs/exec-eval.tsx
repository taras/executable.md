import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const CHAIN = "```bash silent timeout=30s exec\ngit diff --stat\n```";

const EVAL = `\`\`\`ts eval
const port = yield* findFreePort();
const baseUrl = \`http://127.0.0.1:\${port}\`;
\`\`\`

\`\`\`bash daemon exec
./server --port {port}
\`\`\``;

export default define.page(function ExecEval() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Exec &amp; Eval</h1>
      <p class="muted">
        The first word in a fence info string is the language. The remaining
        words form a middleware chain read left-to-right. Standard renderers
        only read the first word, so the modifiers stay invisible everywhere
        else.
      </p>

      <CodeBlock>{CHAIN}</CodeBlock>

      <h2>Built-in modifiers</h2>
      <ul>
        <li>
          <code>exec</code> — run the block as a subprocess and render stdout.
        </li>
        <li>
          <code>eval</code>{" "}
          — run JavaScript/TypeScript in-process as an Effection operation.
        </li>
        <li>
          <code>silent</code> — execute but suppress rendered output.
        </li>
        <li>
          <code>persist</code>{" "}
          — keep resources created by an eval block alive for the component
          lifetime.
        </li>
        <li>
          <code>timeout=30s</code> — cancel a long-running block.
        </li>
        <li>
          <code>daemon</code>{" "}
          — start a long-running subprocess tied to the component scope.
        </li>
      </ul>
      <p class="muted">
        LLM sampling is not a fence modifier — it happens through the{" "}
        <a href="/docs/providers">
          <code>&lt;Sample&gt;</code> component
        </a>{" "}
        installed by provider middleware.
      </p>

      <h2>Eval blocks share bindings</h2>
      <p>
        <code>eval</code>{" "}
        blocks run in a shared binding environment for the current component.
        Top-level bindings export automatically to later blocks, and bare{" "}
        <code>{"{name}"}</code>{" "}
        interpolation inside any executable block reads from them.
      </p>
      <CodeBlock>{EVAL}</CodeBlock>

      <h2>Rendering from eval</h2>
      <ul>
        <li>
          <code>output("...")</code>{" "}
          renders text into the document from an eval block.
        </li>
        <li>
          <code>renderChildren()</code> and <code>render(markdown)</code>{" "}
          render nested content intentionally.
        </li>
      </ul>

      <h2>Daemons</h2>
      <p>
        <code>daemon exec</code>{" "}
        starts a long-lived process, returns control immediately, and is torn
        down by structured concurrency when the component scope closes — no
        manual cleanup. Combined with readiness polling, this is how provider
        components run local model servers.
      </p>

      <p style="margin-top:2rem;">
        Next: <a href="/docs/durability">Durable replay →</a>
      </p>
    </>
  );
});
