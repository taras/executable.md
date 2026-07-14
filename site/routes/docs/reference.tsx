import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const GITHUB = "https://github.com/taras/executable.md";

export default define.page(function Reference() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Reference</h1>
      <p class="muted">CLI usage and pointers to the full specification.</p>

      <h2>CLI</h2>
      <CodeBlock>
        {"xmd run <document.md> [options]\nxmd <document.md> [options]   # run is the default command"}
      </CodeBlock>
      <ul>
        <li>
          <code>--journal</code>, <code>-j</code>{" "}
          — JSONL journal file (creates if missing, replays if it exists,
          retries on failure).
        </li>
        <li>
          <code>--verbose</code>, <code>-V</code>{" "}
          — log durable journal events to stderr.
        </li>
        <li>
          <code>--component-dir</code>{" "}
          — add a component search directory (repeatable).
        </li>
        <li>
          <code>--raw</code>{" "}
          — output raw markdown without normalization or terminal formatting.
        </li>
      </ul>

      <h2>Document model</h2>
      <ul>
        <li>
          Frontmatter becomes <code>meta</code>.
        </li>
        <li>
          Capitalized JSX tags become component invocations;{" "}
          <code>&lt;Content /&gt;</code> is a child slot.
        </li>
        <li>
          Text segments support <code>{"{meta.key}"}</code> and{" "}
          <code>{"{props.key}"}</code> interpolation.
        </li>
        <li>
          A fenced block is executable iff <code>exec</code> or{" "}
          <code>eval</code> appears after the language word.
        </li>
      </ul>

      <h2>Full specification</h2>
      <p>
        The authoritative design and behavior spec (draft) lives in the
        repository:
      </p>
      <ul>
        <li>
          <a
            href={`${GITHUB}/blob/main/specs/executable-mdx-spec.md`}
            rel="noopener"
          >
            Executable MDX specification →
          </a>
        </li>
        <li>
          <a href={`${GITHUB}/blob/main/README.md`} rel="noopener">
            Project README →
          </a>
        </li>
        <li>
          <a href={`${GITHUB}/issues`} rel="noopener">
            Issues &amp; feedback →
          </a>
        </li>
      </ul>

      <h2>Status</h2>
      <p>
        executable.md is an early, first public release and a draft spec. Expect
        rough edges, and please{" "}
        <a href={`${GITHUB}/issues`} rel="noopener">open an issue</a>{" "}
        with feedback.
      </p>
    </>
  );
});
