import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const DOC = `---
title: My Project
---

# {meta.title}

<Greeting name="world" />

\`\`\`bash exec
ls ./src
\`\`\``;

export default define.page(function GettingStarted({ url }) {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Getting started</h1>
      <p class="muted">
        executable.md runs markdown documents as durable, executable workflows
        using the <code>xmd</code>{" "}
        command. This page gets you from install to your first run.
      </p>

      <h2>Install</h2>
      <p>
        Install the standalone <code>xmd</code> binary (macOS / Linux):
      </p>
      <CodeBlock>{`curl -fsSL ${url.origin}/install.sh | sh`}</CodeBlock>
      <p>
        Or, for Deno users, run it from source (a published JSR package is
        coming soon):
      </p>
      <CodeBlock>
        {"git clone https://github.com/taras/executable.md\ncd executable.md && deno task xmd run doc.md"}
      </CodeBlock>
      <p>
        Prebuilt binaries for every platform are on the{" "}
        <a
          href="https://github.com/taras/executable.md/releases"
          rel="noopener"
        >
          releases page
        </a>. The binary is self-contained — no Node or Deno needed to run it.
      </p>

      <h2>Your first document</h2>
      <p>
        A document is a component. Frontmatter becomes{" "}
        <code>meta</code>, capitalized JSX tags expand other markdown files, and
        fenced blocks marked <code>exec</code> run and render their output.
      </p>
      <CodeBlock filename="README.md">{DOC}</CodeBlock>
      <p>Run it:</p>
      <CodeBlock>{"xmd run README.md"}</CodeBlock>

      <h2>Keep a durable journal</h2>
      <p>
        Pass <code>--journal</code>{" "}
        to persist every I/O operation. On rerun, completed steps replay from
        the journal instead of redoing work — execution survives crashes.
      </p>
      <CodeBlock>{"xmd run README.md --journal .xmd/events.jsonl"}</CodeBlock>

      <h2>Useful flags</h2>
      <ul>
        <li>
          <code>--journal</code>, <code>-j</code>{" "}
          — persist JSONL journal events and replay on rerun.
        </li>
        <li>
          <code>--verbose</code>, <code>-V</code>{" "}
          — print durable journal events to stderr while running.
        </li>
        <li>
          <code>--component-dir</code>{" "}
          — add component search directories (defaults to{" "}
          <code>components</code> and <code>.</code>).
        </li>
      </ul>

      <p style="margin-top:2rem;">
        Next: <a href="/docs/components">Components →</a>
      </p>
    </>
  );
});
