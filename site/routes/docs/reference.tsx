import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const GITHUB = "https://github.com/taras/executable.md";

export default define.page(function Reference() {
  return (
    <>
      <h1>Reference</h1>
      <p class="muted">CLI usage and pointers to the full specification.</p>

      <h2>CLI</h2>
      <CodeBlock command>
        {"xmd run <document.md> [options]\nxmd <document.md> [options]   # run is the default command\nxmd -e '<markdown>' [options]  # an inline document, no file needed"}
      </CodeBlock>
      <ul>
        <li>
          <code>--eval</code>, <code>-e</code>{" "}
          — execute the given markdown as the root document instead of a path.
          Exactly one of the two is required. Quote it so the shell passes one
          argument; printed errors report the source as{" "}
          <code>&lt;eval&gt;</code>, and relative paths resolve from the current
          directory.
        </li>
        <li>
          <code>--journal</code>, <code>-j</code>{" "}
          — write a diagnostic JSONL trace of the run to a new file. The path
          must not exist and is never replayed.
        </li>
        <li>
          <code>--no-secret-detection</code>{" "}
          — turn off credential detection for the whole invocation. Detection is
          on by default, and refuses to persist a durable event carrying a
          credential. This is the only spelling that disables it, and a disabled
          run warns once on standard error that credentials may be persisted. A
          dangerous diagnostic escape hatch: the normal response to a finding is
          to fix the code or data flow that produced it.
        </li>
        <li>
          <code>--verbose</code>, <code>-V</code>{" "}
          — print journal entries to stderr.
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
          <code>&lt;Let as="name"&gt;</code>{" "}
          binds one name in the current environment — what its children render,
          or the exact value a <code>value</code>{" "}
          prop names — and renders nothing itself.
        </li>
        <li>
          <code>&lt;Json value={"{...}"} /&gt;</code>{" "}
          renders one value as two-space JSON text where it is written, and
          binds nothing.
        </li>
        <li>
          <code>&lt;Parse schema={"{...}"} as="name"&gt;</code>{" "}
          turns the text its children render into a validated value, and renders
          nothing.
        </li>
        <li>
          <code>&lt;If condition={"{...}"}&gt;</code> with an optional{" "}
          <code>&lt;Else&gt;</code>{" "}
          expands one branch; the other performs no work.
        </li>
        <li>
          <code>&lt;Loop max={"{n}"}&gt;</code> expands its body at most{" "}
          <code>n</code> times, sharing the enclosing bindings;{" "}
          <code>&lt;Break /&gt;</code>{" "}
          exits the nearest loop and skips the rest of the iteration.
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
