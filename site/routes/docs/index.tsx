import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";
import { NextCard } from "../../components/NextCard.tsx";

/** The README.md example, hand-tokenized to match the docs type system. */
function ReadmeExample() {
  return (
    <>
      <span class="tok-comment">---</span>
      {"\ntitle: "}
      <span class="tok-str">My Project</span>
      {"\n"}
      <span class="tok-comment">---</span>
      {"\n\n"}
      <span style="font-weight:700;">
        {"# "}
        <span class="tok-mod">{"{meta.title}"}</span>
      </span>
      {"\n\n"}
      <span class="tok-key">{"<Greeting"}</span>
      {" name"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"world"</span> <span class="tok-key">{"/>"}</span>
      {"\n\n"}
      <span class="tok-dim">```bash</span> <span class="tok-mod">exec</span>
      {"\nls ./src\n"}
      <span class="tok-dim">```</span>
    </>
  );
}

export default define.page(function GettingStarted({ url }) {
  return (
    <>
      <h1>Getting started</h1>
      <p class="muted" style="margin:0;">
        executable.md runs markdown documents as executable workflows using the
        {" "}
        <code>xmd</code>{" "}
        command. This page gets you from install to your first run.
      </p>

      <div class="split-box" style="margin-top:1.75rem;">
        <div>
          <span style="font-family:var(--font-mono);font-size:0.8125rem;font-weight:700;">
            xmd run
          </span>
          <span style="font-size:0.84375rem;line-height:1.55;color:var(--body);">
            Runs a document against the current environment. Operations complete
            correctly, but nothing promises that another execution can restore
            or reattach to that environment.
          </span>
        </div>
        <div>
          <span style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
            <span style="font-family:var(--font-mono);font-size:0.8125rem;font-weight:700;color:var(--code-expr);">
              xmd workflow
            </span>
            <span class="pill" style="color:var(--code-expr);">
              Not yet shipped
            </span>
          </span>
          <span style="font-size:0.84375rem;line-height:1.55;color:var(--body);">
            Will run a document in a retained Workspace so an interrupted
            workflow can reattach and continue. Unsupported imperative
            operations fail explicitly instead of falling back to the host.
          </span>
        </div>
      </div>

      <h2>Install</h2>
      <p>
        Install the standalone <code>xmd</code> binary (macOS / Linux):
      </p>
      <CodeBlock command>
        {`curl -fsSL ${url.origin}/install.sh | sh`}
      </CodeBlock>
      <p>
        Or, for Deno users, run it straight from JSR:
      </p>
      <CodeBlock command>
        {"deno run -A jsr:@executablemd/cli run doc.md"}
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

      <h3>From npm</h3>
      <p>
        <code>xmd</code> is published to npm as <code>@executablemd/cli</code>:
      </p>
      <CodeBlock command>{"npm install -g @executablemd/cli"}</CodeBlock>
      <p>
        No registry configuration is needed — every <code>@executablemd</code>
        {" "}
        package resolves from the default npm registry.
      </p>

      <h2>Your first document</h2>
      <p>
        A document is a component. Frontmatter becomes{" "}
        <code>meta</code>, capitalized JSX tags expand other markdown files, and
        fenced blocks marked <code>exec</code> run and render their output.
      </p>
      <CodeBlock filename="README.md">
        <ReadmeExample />
      </CodeBlock>
      <p>Run it:</p>
      <CodeBlock command>{"xmd run README.md"}</CodeBlock>

      <h2>Write a diagnostic journal</h2>
      <p>
        Pass <code>--journal</code>{" "}
        to write a JSONL trace of the run to a new file for troubleshooting. The
        path must not already exist, and the trace is never replayed.
      </p>
      <CodeBlock command>
        {"xmd run README.md --journal .xmd/events.jsonl"}
      </CodeBlock>

      <h2>Useful flags</h2>
      <ul>
        <li>
          <code>--journal</code>, <code>-j</code>{" "}
          — write current-run journal entries to a new JSONL file (the path must
          not exist).
        </li>
        <li>
          <code>--verbose</code>, <code>-V</code>{" "}
          — print journal entries to stderr while running.
        </li>
        <li>
          <code>--component-dir</code>{" "}
          — add component search directories (defaults to{" "}
          <code>components</code> and <code>.</code>).
        </li>
      </ul>

      <NextCard href="/docs/components" label="Components" />
    </>
  );
});
