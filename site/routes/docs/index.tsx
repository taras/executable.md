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
              start · resume
            </span>
          </span>
          <span style="font-size:0.84375rem;line-height:1.55;color:var(--body);">
            Runs a document in a retained Workspace, so an interrupted workflow
            resumes from its journal frontier instead of starting again.
            Unsupported operations fail explicitly instead of falling back to
            the host. Available through the Deno entrypoint and the compiled
            binary.
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

      <h3>Keeping it up to date</h3>
      <p>
        A standalone binary on macOS or Linux replaces itself. This installs the
        latest published stable release, verifies its checksum, and swaps the
        binary you just ran:
      </p>
      <CodeBlock command>{"xmd upgrade"}</CodeBlock>
      <p>
        To see what would change without downloading or replacing anything:
      </p>
      <CodeBlock command>{"xmd upgrade --status"}</CodeBlock>
      <p>
        The command prints what it is doing as it goes: the release it selected,
        the binary it downloaded, what it verified, and the replacement itself.
        Add <code>--journal &lt;path&gt;</code>{" "}
        to also write a diagnostic JSONL trace to a new file.
      </p>
      <p>
        Name an exact tag — <code>xmd upgrade v1.2.3</code>{" "}
        — to install one specific release. Installing an older version needs
        {" "}
        <code>--allow-downgrade</code>, and a prerelease tag needs{" "}
        <code>--allow-prerelease</code>.
      </p>
      <p>
        Every other installation is updated by whatever installed it, and{" "}
        <code>xmd upgrade</code>{" "}
        says so rather than replacing files it does not own: npm installs with
        {" "}
        <code>npm install -g @executablemd/cli@latest</code>, Bun with{" "}
        <code>bun add -g @executablemd/cli@latest</code>, Deno by naming a newer
        {" "}
        <code>jsr:@executablemd/cli</code>{" "}
        version, and a Windows binary by running the installer again or
        downloading the release asset.
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
          <code>--include</code> — add component search directories (defaults to
          {" "}
          <code>components</code> and <code>.</code>).
        </li>
      </ul>

      <NextCard href="/docs/components" label="Components" />
    </>
  );
});
