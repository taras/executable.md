import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const FENCE = String.fromCharCode(96).repeat(3);

const REPORT = [
  "# Project snapshot",
  "",
  "## Working tree",
  "",
  FENCE + "bash exec",
  "git status --short",
  FENCE,
  "",
  "## Most recent commit",
  "",
  FENCE + "bash exec",
  "git log -1 --oneline",
  FENCE,
].join("\n");

export default define.page(function GettingStarted({ url }) {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Getting started</h1>
      <p class="muted">
        Use Executable Markdown when a repeatable command needs an explanation,
        its result, and a place in a document someone can read. A project status
        report is a small example: it records what it checks and turns the
        current repository state into a shareable Markdown result.
      </p>

      <h2>Run a useful first document</h2>
      <p>
        In a Git repository, save this as{" "}
        <code>project-report.md</code>. It remains the executable source
        document. The commands run where you invoke{" "}
        <code>xmd</code>; their standard output replaces the executable blocks
        in the rendered result.
      </p>
      <CodeBlock filename="project-report.md">{REPORT}</CodeBlock>

      <h2>Install and run it</h2>
      <p>
        Install the standalone <code>xmd</code> binary on macOS or Linux:
      </p>
      <CodeBlock>{"curl -fsSL " + url.origin + "/install.sh | sh"}</CodeBlock>
      <p>Then render the report and save the shareable result:</p>
      <CodeBlock>
        {"xmd run project-report.md > project-snapshot.md"}
      </CodeBlock>
      <p>
        The command leaves <code>project-report.md</code>{" "}
        unchanged and writes ordinary Markdown with the current working-tree
        status and latest commit to{" "}
        <code>project-snapshot.md</code>. Share or commit that artifact for a
        pull-request checklist, maintenance run, or handoff note.
      </p>
      <p>
        You can also run the checkout from source with{" "}
        <code>
          deno task xmd run project-report.md &gt; project-snapshot.md
        </code>. Prebuilt binaries are available from the{" "}
        <a
          href="https://github.com/taras/executable.md/releases"
          rel="noopener"
        >
          releases page
        </a>.
      </p>

      <h2>See what happened when a run needs debugging</h2>
      <p>
        Add a journal when you need the command inputs, outputs, and errors
        behind a result. It writes a new JSONL file; choose a path that does not
        already exist, and treat the file as potentially sensitive.
      </p>
      <CodeBlock>
        {"xmd run project-report.md --journal .xmd/project-report.jsonl"}
      </CodeBlock>
      <p>
        Add <code>--verbose</code>{" "}
        to see journal events on stderr while the document runs. Use{" "}
        <code>--component-dir</code>{" "}
        when your reusable document patterns live outside the default{" "}
        <code>components</code> and current directories.
      </p>

      <h2>Choose the next capability</h2>
      <ul>
        <li>
          Reuse a report or check with different inputs:{" "}
          <a href="/docs/components">Components</a>.
        </li>
        <li>
          Need a command, a calculated value, or a short-lived local process:
          {" "}
          <a href="/docs/exec-eval">Exec &amp; Eval</a>.
        </li>
        <li>
          Need an LLM response in a document:{" "}
          <a href="/docs/providers">LLM providers</a>.
        </li>
      </ul>
    </>
  );
});
