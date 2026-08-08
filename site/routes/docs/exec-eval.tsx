import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";
import { NextCard } from "../../components/NextCard.tsx";

const CHAIN = "```bash silent timeout=30s exec\ngit diff --stat\n```";

const EVAL = `\`\`\`bash service=server exec
node handshake-compatible-server.js
\`\`\`

\`\`\`ts persist ephemeral eval
import { callService } from "./client.ts";

const endpoint = server;
yield* Sample.around({
  *sample([request]) { return yield* callService(endpoint, request); },
});
\`\`\``;

export default define.page(function ExecEval() {
  return (
    <>
      <h1>Exec &amp; Eval</h1>
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
          invocation.
        </li>
        <li>
          <code>timeout=30s</code> — cancel a long-running block.
        </li>
        <li>
          <code>daemon</code>{" "}
          — start an arbitrary fixed-configuration subprocess tied to the
          component invocation.
        </li>
        <li>
          <code>service=name</code>{" "}
          — start an attached service and publish its invocation-local endpoint.
        </li>
        <li>
          <code>ephemeral</code>{" "}
          — reconstruct live eval state without writing a journal event.
        </li>
      </ul>
      <p class="muted">
        LLM sampling is not a fence modifier — it happens through the{" "}
        <a href="/docs/providers">
          <code>&lt;Sample&gt;</code> component
        </a>{" "}
        installed by provider middleware.
      </p>

      <h2>Durable and live bindings</h2>
      <p>
        Plain <code>eval</code>{" "}
        blocks run in a shared durable binding environment for the current
        component. Top-level bindings export automatically to later blocks, and
        bare <code>{"{name}"}</code>{" "}
        interpolation inside any executable block reads from them.
        <code>ephemeral eval</code>{" "}
        reruns during partial replay and can also read invocation-local live
        bindings such as service endpoints; those bindings are never
        interpolated or journaled.
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
        down by structured concurrency when the component invocation completes —
        no manual cleanup. It remains the primitive for processes whose fixed
        configuration the document or host manages explicitly. Dynamic service
        endpoints use <code>service=name</code>{" "}
        with a handshake-compatible command and the XMD service handshake
        protocol.
      </p>

      <NextCard href="/docs/providers" label="LLM providers" />
    </>
  );
});
