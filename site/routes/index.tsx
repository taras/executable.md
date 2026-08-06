import type { ComponentChildren } from "preact";
import { define } from "../utils.ts";
import { Header } from "../components/Header.tsx";
import { Footer } from "../components/Footer.tsx";
import { CodeBlock } from "../components/Code.tsx";
import CopyCommand from "../islands/CopyCommand.tsx";

const GITHUB = "https://github.com/taras/executable.md";

const MONO = "font-family:var(--font-mono);";
const STAGE_LABEL =
  `${MONO}font-size:0.75rem;font-weight:800;letter-spacing:0.1em;color:var(--fg-muted);`;
const CARD_H3 =
  "margin:0;font-size:1.125rem;font-weight:800;letter-spacing:-0.01em;line-height:1.25;";
const CARD_P =
  "margin:0;font-size:0.875rem;line-height:1.55;color:var(--fg-body);text-wrap:pretty;";

/** The four stages of "How it works". */
const STAGES: {
  step: string;
  mark: "arrow" | "today";
  title: string;
  body: ComponentChildren;
}[] = [
  {
    step: "01 · Document",
    mark: "arrow",
    title: "Readable source",
    body:
      "Frontmatter, prose, and fenced blocks. The file renders normally in GitHub, editors, and other Markdown viewers.",
  },
  {
    step: "02 · Compose",
    mark: "arrow",
    title: "Reusable components",
    body:
      "Components, typed props, content slots, providers, and declarative operations turn repeated instructions into named building blocks.",
  },
  {
    step: "03 · Execute",
    mark: "today",
    title: "Run the procedure",
    body: (
      <>
        <Term>xmd run</Term>{" "}
        executes the document against the current environment with ordinary
        operation-level correctness.
      </>
    ),
  },
  {
    step: "04 · Observe",
    mark: "arrow",
    title: "Diagnostic journals",
    body: (
      <>
        <Term>--journal</Term>{" "}
        writes a JSONL trace of a single run for troubleshooting. It is never
        replayed, and it does not recover a run.
      </>
    ),
  },
];

/**
 * The four steps the "See it" document performs, in order. `model` marks the
 * one probabilistic step; `done` marks the step that produces the artifact.
 */
const STEPS: {
  title: string;
  tag: string;
  kind: string;
  model?: boolean;
  done?: boolean;
}[] = [
  { title: "Discover", tag: "<Glob>", kind: "deterministic" },
  { title: "Read repeatedly", tag: "<Each> + <File>", kind: "deterministic" },
  {
    title: "Apply judgment",
    tag: "<Prompt>",
    kind: "model tokens",
    model: true,
  },
  {
    title: "Save the result",
    tag: "<File>",
    kind: "deterministic",
    done: true,
  },
];

/** What each step of the "See it" document does, numbered to match. */
const NOTES: { n: string; body: ComponentChildren; model?: boolean }[] = [
  {
    n: "1",
    body: (
      <>
        <Term>{"<Glob>"}</Term> deterministically selects the instruction files.
      </>
    ),
  },
  {
    n: "2",
    body: (
      <>
        <Term>{"<Each>"}</Term>{" "}
        applies the same read procedure to every selected path.
      </>
    ),
  },
  {
    n: "3",
    body: (
      <>
        <Term>{"<File>"}</Term>{" "}
        reads through the contextual filesystem capability.
      </>
    ),
  },
  {
    n: "4",
    model: true,
    body: (
      <>
        <Term warn>{"<Prompt>"}</Term>{" "}
        is the one explicitly probabilistic judgment step, and the one step that
        spends model tokens.
      </>
    ),
  },
  {
    n: "5",
    body: (
      <>
        The write form of <Term>{"<File>"}</Term>{" "}
        atomically saves the review at a declared path.
      </>
    ),
  },
  {
    n: "6",
    body: "The read form renders the saved artifact back into the document.",
  },
];

const FITS: { title: string; body: string }[] = [
  {
    title: "Release and repository procedures",
    body:
      "Files, branches, commits, pull requests, tests, and review steps expressed as one readable process.",
  },
  {
    title: "Repeatable AI-assisted work",
    body:
      "Deterministic structure around visible probabilistic steps such as agents and sampling, with inputs and outputs named in the document.",
  },
  {
    title: "Operational runbooks",
    body:
      "Documentation that can collect input, branch, retry, and eventually suspend or continue when those contracts ship.",
  },
];

const AMORTIZATION = [
  "authoring and improving the executable procedure has an up-front reasoning cost;",
  "deterministic steps do not incur repeated LLM interpretation on every run;",
  "per-run token cost is limited to the explicit agent or sampling steps the workflow contains; and",
  "reduced interpretation also reduces latency, variance, retries, and human supervision.",
];

/** An inline identifier: monospace, at full contrast against body prose. */
function Term(
  { warn, children }: { warn?: boolean; children: ComponentChildren },
) {
  return (
    <span
      style={`${MONO}font-weight:700;color:var(--${warn ? "warn" : "fg"});`}
    >
      {children}
    </span>
  );
}

/** `review-instructions.md`, hand-tokenized. */
function ReviewDocument() {
  const tag = "tok-key";
  return (
    <>
      <span style="font-weight:700;">{"# Review repository instructions"}</span>
      {"\n\n"}
      <span class={tag}>{"<Glob"}</span>
      {" include"}
      <span class="tok-dim">=</span>
      <span class="tok-mod">{"{["}</span>
      <span class="tok-str">"**/AGENTS.md"</span>
      <span class="tok-mod">{"]}"}</span>
      {" as"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"instructionPaths"</span>{" "}
      <span class={tag}>{"/>"}</span>
      {"\n\n"}
      <span class={tag}>{"<Each"}</span>
      {" in"}
      <span class="tok-dim">=</span>
      <span class="tok-mod">{"{instructionPaths}"}</span>
      {" let"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"path"</span>
      {" as"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"instructions"</span>
      <span class={tag}>{">"}</span>
      {"\n"}
      <span style="font-weight:700;">
        {"  ## "}
        <span class="tok-mod">{"{path}"}</span>
      </span>
      {"\n\n  "}
      <span class={tag}>{"<File"}</span>
      {" path"}
      <span class="tok-dim">=</span>
      <span class="tok-mod">{"{path}"}</span> <span class={tag}>{"/>"}</span>
      {"\n"}
      <span class={tag}>{"</Each>"}</span>
      {"\n\n"}
      <span class={tag}>{"<Agent>"}</span>
      {"\n  "}
      <span class={tag}>{"<Prompt"}</span>
      {" as"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"review"</span>
      <span class={tag}>{">"}</span>
      {"\n    Review these repository instructions for contradictions\n    and missing safeguards.\n\n    "}
      <span class="tok-mod">{"{instructions}"}</span>
      {"\n  "}
      <span class={tag}>{"</Prompt>"}</span>
      {"\n"}
      <span class={tag}>{"</Agent>"}</span>
      {"\n\n"}
      <span class={tag}>{"<File"}</span>
      {" path"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"reports/instruction-review.md"</span>
      <span class={tag}>{">"}</span>
      {"\n"}
      <span style="font-weight:700;">{"  # Instruction review"}</span>
      {"\n\n  "}
      <span class="tok-mod">{"{review}"}</span>
      {"\n"}
      <span class={tag}>{"</File>"}</span>
      {"\n\nThe saved report:\n\n"}
      <span class={tag}>{"<File"}</span>
      {" path"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"reports/instruction-review.md"</span>{" "}
      <span class={tag}>{"/>"}</span>
    </>
  );
}

/** `hello-world.md`, hand-tokenized. */
function HelloWorld() {
  const tag = "tok-key";
  const open = (name: string, prop: string, value: string, close: string) => (
    <>
      <span class={tag}>{`<${name}`}</span>
      {` ${prop}`}
      <span class="tok-dim">=</span>
      <span class="tok-str">{`"${value}"`}</span>
      <span class={tag}>{close}</span>
    </>
  );
  return (
    <>
      {open("AnthropicProvider", "model", "claude-opus-4-5", ">")}
      {"\n  "}
      {open("OllamaProvider", "model", "llama3.2", ">")}
      {"\n    "}
      {open("Instruction", "system", "You are a creative comedian.", ">")}
      {"\n      "}
      {open("Sample", "model", "llama3.2", ">")}
      {"\n        Smart: "}
      <span class={tag}>{"<Sample"}</span>
      {" prompt"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"Say something smart"</span>
      {" model"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"claude-opus-4-5"</span>{" "}
      <span class={tag}>{"/>"}</span>
      {"\n        Joke:  "}
      <span class={tag}>{"<Sample"}</span>
      {" prompt"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"Tell me a joke"</span>
      {" model"}
      <span class="tok-dim">=</span>
      <span class="tok-str">"llama3.2"</span> <span class={tag}>{"/>"}</span>
      {"\n        Combine Smart and Joke into one smart joke\n      "}
      <span class={tag}>{"</Sample>"}</span>
      {"\n    "}
      <span class={tag}>{"</Instruction>"}</span>
      {"\n  "}
      <span class={tag}>{"</OllamaProvider>"}</span>
      {"\n"}
      <span class={tag}>{"</AnthropicProvider>"}</span>
    </>
  );
}

export default define.page(function Home({ url }) {
  const installCmd = `curl -fsSL ${url.origin}/install.sh | sh`;
  return (
    <>
      <Header />

      <div class="container">
        {/* Hero */}
        <section style="padding-block:4rem 3.5rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:3rem;align-items:start;">
          <div style="display:flex;flex-direction:column;gap:1.5rem;min-width:0;">
            <span class="eyebrow eyebrow-mark">
              Open source · Early / experimental
            </span>

            <h1 style="margin:0;font-size:clamp(2.4rem,5vw,3.9rem);line-height:1.02;font-weight:800;letter-spacing:-0.03em;overflow-wrap:break-word;text-wrap:balance;">
              Turn documentation into repeatable workflows.
            </h1>

            <p style="margin:0;max-width:50ch;font-size:clamp(1.05rem,2.2vw,1.2rem);line-height:1.5;color:var(--fg-body);text-wrap:pretty;">
              Executable.md keeps procedures readable as Markdown, then gives
              them reusable components, typed inputs, and executable steps so
              the same process can run consistently.
            </p>

            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:0.875rem;padding-top:0.25rem;">
              <a class="btn btn-primary btn-lg push" href="#install">
                Run your first document →
              </a>
              <a class="btn btn-ghost btn-lg push" href="#example">
                See an example
              </a>
              <a class="link-rule" href={GITHUB} rel="noopener">
                View on GitHub
              </a>
            </div>

            <p style="margin:0;max-width:56ch;font-size:0.8125rem;line-height:1.6;color:var(--fg-muted);">
              Markdown that runs. Standalone binary (built with{" "}
              <span style={`${MONO}color:var(--fg);`}>deno compile</span>) ·
              also runs from source on Deno · CLI command: <Term>xmd</Term>
            </p>
          </div>

          <div style="display:flex;flex-direction:column;gap:1.125rem;padding-top:0.375rem;min-width:0;">
            <CopyCommand lines={[installCmd]} />

            <div class="panel">
              <div class="panel-head">Still just markdown</div>
              <div class="panel-body">
                <p style="margin:0;font-size:0.9375rem;line-height:1.6;color:var(--fg-body);text-wrap:pretty;">
                  Standard renderers only read the first word of a fenced code
                  block's info string, so <Term warn>exec</Term>,{" "}
                  <Term warn>eval</Term>, and every modifier stay invisible to
                  GitHub, your editor, and any markdown viewer. The procedure
                  stays a document your team can read, review in a pull request,
                  and diff — maintaining the workflow is the same work as
                  maintaining the docs.
                </p>
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                  <span class="chip">reviewable in a PR</span>
                  <span class="chip">renders anywhere</span>
                  <span class="chip">no new file format</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" class="section">
          <div class="section-head">
            <h2>How it works</h2>
            <p>
              A documented procedure becomes named building blocks, then runs
              against the current environment. Detailed mechanics live in the
              {" "}
              <a href="/docs">docs</a>.
            </p>
          </div>

          <div class="grid grid-4">
            {STAGES.map((s) => (
              <div
                key={s.step}
                class="card"
                style="display:flex;flex-direction:column;gap:0.5625rem;min-width:0;"
              >
                <div style="display:flex;align-items:center;justify-content:space-between;">
                  <span style={STAGE_LABEL}>{s.step}</span>
                  {s.mark === "today"
                    ? (
                      <span style="font-size:0.75rem;font-weight:800;color:var(--accent-strong);">
                        ✓ today
                      </span>
                    )
                    : <span style="color:var(--fg-muted);">→</span>}
                </div>
                <h3 style={CARD_H3}>{s.title}</h3>
                <p style={CARD_P}>{s.body}</p>
              </div>
            ))}
          </div>

          <div
            class="dashed"
            style="padding:1.375rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1.75rem;align-items:start;"
          >
            <div style="display:flex;flex-direction:column;gap:0.625rem;min-width:0;">
              <span
                class="pill"
                style="align-self:flex-start;color:var(--warn);"
              >
                Product direction · not yet shipped
              </span>
              <h3 style="margin:0;font-size:1.125rem;font-weight:800;letter-spacing:-0.01em;">
                Continuation after interruption
              </h3>
              <p style="margin:0;font-size:0.875rem;line-height:1.6;color:var(--fg-body);text-wrap:pretty;">
                <Term>xmd workflow</Term>{" "}
                will execute supported operations in a constrained, retained
                environment so a workflow can reattach and continue. The
                constraint is the point: durable workflows do not require
                arbitrary native command compatibility.
              </p>
            </div>
            <div style="display:flex;flex-direction:column;gap:0.75rem;min-width:0;">
              <div style="display:flex;flex-direction:column;gap:0.25rem;border-left:var(--rule) solid var(--ink);padding-left:0.8125rem;">
                <span style={`${MONO}font-size:0.8125rem;font-weight:700;`}>
                  xmd run
                </span>
                <span style="font-size:0.8125rem;line-height:1.55;color:var(--fg-body);">
                  Available now. Ordinary host capabilities. No promise of
                  Workspace retention, reattachment, or continuation — a
                  successful file write still completes correctly.
                </span>
              </div>
              <div style="display:flex;flex-direction:column;gap:0.25rem;border-left:var(--rule) dashed var(--warn);padding-left:0.8125rem;">
                <span
                  style={`${MONO}font-size:0.8125rem;font-weight:700;color:var(--warn);`}
                >
                  xmd workflow
                </span>
                <span style="font-size:0.8125rem;line-height:1.55;color:var(--fg-body);">
                  Planned. Durable Workspace-backed capabilities. An unsupported
                  imperative operation fails explicitly rather than silently
                  falling back to the host.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* See it */}
        <section id="example" class="section">
          <div class="section-head">
            <h2>See it</h2>
            <p>
              This document deterministically discovers and reads every
              repository instruction file, uses an agent only for the judgment
              step, then writes the resulting review. Every structural step
              performs work.
            </p>
          </div>

          <div
            class="grid"
            style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0.875rem;"
          >
            {STEPS.map((s) => (
              <div
                key={s.title}
                style={`border:var(--rule) solid var(--${
                  s.model ? "warn" : "ink"
                });padding:0.875rem;display:flex;flex-direction:column;gap:0.375rem;min-width:0;${
                  s.model ? "background:var(--term-bg);" : ""
                }`}
              >
                <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
                  <span
                    style={`font-size:0.9375rem;font-weight:800;letter-spacing:-0.01em;${
                      s.model ? "color:var(--term-fg);" : ""
                    }`}
                  >
                    {s.title}
                  </span>
                  <span
                    style={s.done
                      ? "color:var(--accent-strong);font-weight:800;"
                      : "color:var(--fg-muted);"}
                  >
                    {s.done ? "✓" : "→"}
                  </span>
                </div>
                <span
                  style={`${MONO}font-size:0.8125rem;font-weight:700;color:var(--${
                    s.model ? "term-warn" : "accent-strong"
                  });`}
                >
                  {s.tag}
                </span>
                <span
                  style={`${MONO}font-size:0.625rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--${
                    s.model ? "term-warn" : "fg-muted"
                  });`}
                >
                  {s.kind}
                </span>
              </div>
            ))}
          </div>

          <div
            class="grid"
            style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-items:start;"
          >
            <div style="display:flex;flex-direction:column;gap:0.875rem;min-width:0;">
              <CodeBlock filename="review-instructions.md">
                <ReviewDocument />
              </CodeBlock>
              <CodeBlock command>
                <span style="color:var(--term-accent);font-weight:700;user-select:none;">
                  $
                </span>{" "}
                xmd run review-instructions.md --default-agent codex
              </CodeBlock>
            </div>

            <div class="panel">
              <div class="panel-head">What each step does</div>
              <div class="panel-body">
                {NOTES.map((note) => (
                  <div key={note.n} style="display:flex;gap:0.6875rem;">
                    <span
                      style={`${MONO}flex:0 0 auto;font-size:0.75rem;font-weight:800;color:var(--${
                        note.model ? "warn" : "fg-muted"
                      });`}
                    >
                      {note.n}
                    </span>
                    <p style={CARD_P}>{note.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Economics */}
        <section id="economics" class="section">
          <div class="section-head">
            <h2>Pay for reasoning once. Run it repeatedly.</h2>
            <p style="max-width:56ch;font-size:clamp(1rem,2vw,1.15rem);line-height:1.55;">
              Spend tokens defining and improving the workflow—not asking a
              model to reinterpret every deterministic step each time it runs.
            </p>
          </div>

          <div class="grid grid-2">
            <div
              class="card"
              style="padding:1.375rem;display:flex;flex-direction:column;gap:0.75rem;min-width:0;"
            >
              <span class="eyebrow">Instruction-only document</span>
              <p style="margin:0;font-size:0.9375rem;line-height:1.6;color:var(--fg-body);text-wrap:pretty;">
                The entire procedure stays probabilistic on every invocation. A
                model reads it, reconstructs the plan, chooses tools and
                arguments, resolves ambiguities, and often verifies or retries
                the work.
              </p>
            </div>
            <div
              class="card push"
              style="background:var(--accent);color:var(--accent-contrast);padding:1.375rem;display:flex;flex-direction:column;gap:0.75rem;min-width:0;"
            >
              <span
                class="eyebrow"
                style="color:var(--accent-contrast);opacity:0.85;"
              >
                Executable document
              </span>
              <p style="margin:0;font-size:0.9375rem;line-height:1.6;text-wrap:pretty;">
                A human or AI encodes the stable parts once as a Markdown
                script. File discovery, input validation, control flow,
                filesystem changes, Git effects, and other declared operations
                execute directly. Model calls stay visible in the document and
                are reserved for steps that actually require judgment.
              </p>
            </div>
          </div>

          <div
            class="grid grid-2"
            style="gap:1.75rem;align-items:start;"
          >
            <div style="display:flex;flex-direction:column;gap:0.6875rem;min-width:0;">
              <span class="eyebrow">The advantage is amortization</span>
              <ul class="marks">
                {AMORTIZATION.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
            <div
              class="dashed-warn"
              style="padding:1.25rem;display:flex;flex-direction:column;gap:0.5rem;min-width:0;"
            >
              <span class="eyebrow" style="color:var(--warn);">
                Not every workflow pays only once
              </span>
              <p style="margin:0;font-size:0.875rem;line-height:1.6;color:var(--fg-body);text-wrap:pretty;">
                A workflow containing <Term>{"<Prompt>"}</Term>,{" "}
                <Term>{"<Sample>"}</Term>, or another probabilistic step still
                spends tokens when that step runs. What stops paying an
                interpretation cost on every execution is the deterministic
                portion.
              </p>
            </div>
          </div>
        </section>

        {/* Where it fits */}
        <section class="section">
          <h2>Where it fits</h2>
          <div class="grid grid-3">
            {FITS.map((f) => (
              <div
                key={f.title}
                class="card"
                style="display:flex;flex-direction:column;gap:0.5625rem;min-width:0;"
              >
                <h3 style={CARD_H3}>{f.title}</h3>
                <p style={CARD_P}>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* One document, two models */}
        <section
          class="section"
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:2.5rem;align-items:start;"
        >
          <div style="display:flex;flex-direction:column;gap:1rem;min-width:0;">
            <h2 style="margin:0;font-size:clamp(1.5rem,3vw,2.1rem);line-height:1.1;font-weight:800;letter-spacing:-0.03em;">
              One document, two models.
            </h2>
            <p style="margin:0;max-width:56ch;font-size:0.9375rem;line-height:1.6;color:var(--fg-body);text-wrap:pretty;">
              A deeper example of composition.{" "}
              <Term>{"<AnthropicProvider>"}</Term> and{" "}
              <Term>{"<OllamaProvider>"}</Term>{" "}
              nest inside a single markdown file. <Term>{"<Sample>"}</Term>{" "}
              routes prompts to a cloud model and a local model, then combines
              the results — no orchestration code, just markdown.
            </p>
            <a
              class="link-rule"
              style="align-self:flex-start;"
              href="/docs/providers"
            >
              Provider docs →
            </a>
          </div>
          <CodeBlock filename="packages/core/examples/hello-world.md">
            <HelloWorld />
          </CodeBlock>
        </section>

        {/* Get started */}
        <section id="install" class="section">
          <h2>Get started</h2>
          <div class="grid grid-3">
            <div
              class="card"
              style="display:flex;flex-direction:column;gap:0.625rem;min-width:0;"
            >
              <h3 style={CARD_H3}>Install script</h3>
              <p style="margin:0;font-size:0.875rem;line-height:1.55;color:var(--fg-muted);">
                Standalone binary, no runtime required.
              </p>
              <div style="margin-top:auto;">
                <CodeBlock command>{installCmd}</CodeBlock>
              </div>
            </div>
            <div
              class="card"
              style="display:flex;flex-direction:column;gap:0.625rem;min-width:0;"
            >
              <h3 style={CARD_H3}>Deno users</h3>
              <p style="margin:0;font-size:0.875rem;line-height:1.55;color:var(--fg-muted);">
                Or run it straight from JSR, with no install at all.
              </p>
              <div style="margin-top:auto;">
                <CodeBlock command>
                  {"deno run -A jsr:@executablemd/cli run doc.md"}
                </CodeBlock>
              </div>
            </div>
            <div
              class="card"
              style="display:flex;flex-direction:column;gap:0.625rem;min-width:0;"
            >
              <h3 style={CARD_H3}>Prebuilt binary</h3>
              <p style="margin:0;font-size:0.875rem;line-height:1.55;color:var(--fg-muted);">
                Download for your platform from{" "}
                <a href={`${GITHUB}/releases`} rel="noopener">
                  GitHub Releases
                </a>.
              </p>
              <div style="margin-top:auto;">
                <CodeBlock command>{"xmd run path/to/doc.md"}</CodeBlock>
              </div>
            </div>
          </div>
        </section>

        {/* Early, and open */}
        <section
          class="section"
          style="align-items:flex-start;gap:1.25rem;"
        >
          <h2>Early, and open.</h2>
          <p style="margin:0;max-width:70ch;font-size:1rem;line-height:1.6;color:var(--fg-body);text-wrap:pretty;">
            executable.md is a first public release and a draft spec. It's built
            for experimentation with executable markdown workflows,
            Effection-based evaluation, and provider-driven AI documents.
            Feedback, issues, and contributions are very welcome.
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:0.875rem;padding-top:0.25rem;">
            <a
              class="btn btn-primary btn-lg push"
              href={`${GITHUB}/issues`}
              rel="noopener"
            >
              Open an issue →
            </a>
            <a
              class="btn btn-ghost btn-lg push"
              href={`${GITHUB}/blob/main/specs/executable-mdx-spec.md`}
              rel="noopener"
            >
              Read the draft spec
            </a>
          </div>
        </section>
      </div>

      <Footer />
    </>
  );
});
