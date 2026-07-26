import { define } from "../utils.ts";
import { Header } from "../components/Header.tsx";
import { Footer } from "../components/Footer.tsx";
import { Wordmark } from "../components/Wordmark.tsx";
import { CodeBlock } from "../components/Code.tsx";
import CopyCommand from "../islands/CopyCommand.tsx";

const GITHUB = "https://github.com/taras/executable.md";
const FENCE = String.fromCharCode(96).repeat(3);

const OUTCOMES: { title: string; body: string }[] = [
  {
    title: "Repository reports",
    body:
      "Run checks, capture their results, and leave a readable record for a review, handoff, or maintenance task.",
  },
  {
    title: "Repeatable maintenance",
    body:
      "Turn a release checklist, migration step, or environment check into a document the team can run the same way.",
  },
  {
    title: "Guided local work",
    body:
      "Keep instructions, command output, and the next decision together instead of splitting a workflow across a script and a separate guide.",
  },
];

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

const REPORT_OUTPUT = [
  "# Project snapshot",
  "",
  "## Working tree",
  "",
  " M README.md",
  "",
  "## Most recent commit",
  "",
  "abc1234 Document the release process",
].join("\n");

export default define.page(function Home({ url }) {
  const installCmd = "curl -fsSL " + url.origin + "/install.sh | sh";
  return (
    <>
      <Header />

      <section
        class="container"
        style="padding-block:4rem 3rem;text-align:center;"
      >
        <p class="eyebrow">Open source</p>
        <h1 style="font-size:clamp(2.4rem,6vw,3.8rem);font-weight:800;letter-spacing:-0.02em;line-height:1.05;margin:0.6rem 0 1rem;">
          Make useful work visible.
        </h1>
        <p
          class="muted"
          style="font-size:clamp(1.05rem,2.2vw,1.25rem);max-width:48ch;margin:0 auto 2rem;line-height:1.5;"
        >
          <Wordmark size="1em" />{" "}
          turns Markdown into repeatable workflows. Describe a task, run the
          steps, and keep the results in the same document for the next person
          who needs them.
        </p>
        <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;">
          <a class="btn btn-primary" href="/docs">
            Write your first workflow →
          </a>
          <a class="btn btn-ghost" href={GITHUB} rel="noopener">
            View on GitHub
          </a>
        </div>
      </section>

      <section class="band">
        <div
          class="container prose-w"
          style="padding-block:3rem;text-align:center;margin-inline:auto;"
        >
          <h2 style="font-size:1.7rem;font-weight:700;margin-bottom:0.75rem;">
            When a document is better than a script
          </h2>
          <p class="muted" style="font-size:1.05rem;">
            Use Executable Markdown when people need to understand the purpose
            of a task, see the evidence it produced, and run it again. Use a
            normal script for background automation with no reader-facing
            result.
          </p>
        </div>
      </section>

      <section id="outcomes" class="container" style="padding-block:3.5rem;">
        <h2 style="font-size:1.7rem;font-weight:700;text-align:center;margin-bottom:2rem;">
          What you can accomplish
        </h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;">
          {OUTCOMES.map((outcome) => (
            <div class="card" key={outcome.title}>
              <h3 style="font-size:1.05rem;font-weight:700;margin-bottom:0.4rem;">
                {outcome.title}
              </h3>
              <p class="muted" style="font-size:0.92rem;">{outcome.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="example" class="band">
        <div class="container" style="padding-block:3.5rem;">
          <h2 style="font-size:1.7rem;font-weight:700;text-align:center;margin-bottom:0.5rem;">
            Start with a project snapshot
          </h2>
          <p
            class="muted"
            style="text-align:center;max-width:60ch;margin:0 auto 2rem;"
          >
            This small document explains what it checks and then replaces each
            executable block with the current result. Save it in a Git
            repository and run <code>xmd run project-report.md</code>.
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem;align-items:start;">
            <CodeBlock filename="project-report.md">{REPORT}</CodeBlock>
            <CodeBlock filename="rendered result">{REPORT_OUTPUT}</CodeBlock>
          </div>
          <p
            class="muted"
            style="text-align:center;max-width:60ch;margin:1.5rem auto 0;"
          >
            The result is ordinary Markdown, ready to commit, share, or use as
            input to the next documented step.
          </p>
        </div>
      </section>

      <section
        class="container prose-w"
        style="padding-block:3.5rem;margin-inline:auto;text-align:center;"
      >
        <h2 style="font-size:1.7rem;font-weight:700;margin-bottom:0.75rem;">
          Grow a workflow only when it helps
        </h2>
        <p class="muted" style="font-size:1.05rem;">
          Extract repeated report sections into components. Use evaluation only
          when a later step needs a calculated value. Start a local process only
          for the part of a workflow that needs it. The guides introduce each
          choice with a working example.
        </p>
        <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem;">
          <a class="btn btn-ghost" href="/docs/components">
            Reuse a workflow pattern
          </a>
          <a class="btn btn-ghost" href="/docs/exec-eval">
            Run commands and local processes
          </a>
        </div>
      </section>

      <section id="install" class="band">
        <div
          class="container prose-w"
          style="padding-block:3.5rem;margin-inline:auto;text-align:center;"
        >
          <h2 style="font-size:1.7rem;font-weight:700;margin-bottom:0.75rem;">
            Ready to write one?
          </h2>
          <p class="muted" style="font-size:1.05rem;margin-bottom:1.5rem;">
            Install the standalone command on macOS or Linux, then follow the
            first workflow guide.
          </p>
          <div style="max-width:34rem;margin:0 auto;">
            <CopyCommand lines={[installCmd]} />
          </div>
          <p style="margin-top:1.25rem;">
            <a href="/docs">Getting started →</a>
          </p>
        </div>
      </section>

      <Footer />
    </>
  );
});
