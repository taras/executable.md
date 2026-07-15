import { define } from "../utils.ts";
import { Header } from "../components/Header.tsx";
import { Footer } from "../components/Footer.tsx";
import { Wordmark } from "../components/Wordmark.tsx";
import { CodeBlock } from "../components/Code.tsx";
import CopyCommand from "../islands/CopyCommand.tsx";

const GITHUB = "https://github.com/taras/executable.md";

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Components",
    body:
      'Invoke other markdown files with JSX-style tags like <Greeting name="world" />. Frontmatter declares meta and typed inputs; <Content /> slots wrap children.',
  },
  {
    title: "Executable blocks",
    body:
      "Mark a fence exec to run it as a subprocess, or eval to run it in-process as an Effection operation. The output replaces the block.",
  },
  {
    title: "Modifier chains",
    body:
      "Compose behavior left-to-right: silent, persist, timeout=30s, daemon. The fence info string is a middleware chain.",
  },
  {
    title: "Diagnostic journals",
    body:
      "Pass --journal to write a JSONL trace of the run — component sources, command output, evaluated values, and errors — to a new file for troubleshooting.",
  },
  {
    title: "Shared bindings",
    body:
      "Top-level bindings from eval blocks export automatically to later blocks. Reference them inline as {name} inside any executable block.",
  },
  {
    title: "LLM providers",
    body:
      "Provider components wire up cloud and local models (Anthropic, Ollama, Llamafile) with readiness checks and sampling — no custom runtime glue.",
  },
];

const GREETING_DOC = `---
title: My Project
---

# {meta.title}

<Greeting name="world" />

\`\`\`bash exec
ls ./src
\`\`\``;

const GREETING_COMPONENT = `---
emoji: Hello
inputs:
  name:
    type: string
    required: true
---

{meta.emoji}, {props.name}!`;

const GREETING_OUTPUT = `# My Project

Hello, world!

main.ts
utils.ts`;

const HELLO_WORLD = `---
title: Hello World
---

# {meta.title}

<AnthropicProvider model="claude-opus-4-5">
  <OllamaProvider model="llama3.2">
    <Instruction system="You are a creative comedian.">
      <Sample model="llama3.2">
        Smart: <Sample prompt="Say something smart" model="claude-opus-4-5" />
        Joke:  <Sample prompt="Tell me a joke" model="llama3.2" />
        Combine Smart and Joke into one smart joke
      </Sample>
    </Instruction>
  </OllamaProvider>
</AnthropicProvider>`;

export default define.page(function Home({ url }) {
  const installCmd = `curl -fsSL ${url.origin}/install.sh | sh`;
  return (
    <>
      <Header />

      {/* Hero */}
      <section
        class="container"
        style="padding-block:4rem 3rem;text-align:center;"
      >
        <p class="eyebrow">Open source · Early / experimental</p>
        <h1 style="font-size:clamp(2.4rem,6vw,3.8rem);font-weight:800;letter-spacing:-0.02em;line-height:1.05;margin:0.6rem 0 1rem;">
          Markdown that runs.
        </h1>
        <p
          class="muted"
          style="font-size:clamp(1.05rem,2.2vw,1.25rem);max-width:46ch;margin:0 auto 2rem;line-height:1.5;"
        >
          <Wordmark size="1em" />{" "}
          treats plain markdown documents as executable workflows — components,
          runnable code blocks, and in-process Effection operations, all in a
          file that still renders as normal markdown anywhere.
        </p>
        <div style="max-width:30rem;margin:0 auto 1rem;">
          <CopyCommand
            lines={[
              installCmd,
              "xmd run hello-world.md",
            ]}
          />
        </div>
        <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;margin-top:1.25rem;">
          <a class="btn btn-ghost" href={GITHUB} rel="noopener">
            View on GitHub →
          </a>
          <a class="btn btn-ghost" href="/docs">Read the docs</a>
        </div>
        <p class="muted" style="font-size:0.8rem;margin-top:1.25rem;">
          Standalone binary (built with{" "}
          <code>deno compile</code>) · also runs from source on Deno · CLI
          command: <code>xmd</code>
        </p>
      </section>

      {/* Still just markdown */}
      <section class="band">
        <div
          class="container prose-w"
          style="padding-block:3rem;text-align:center;margin-inline:auto;"
        >
          <h2 style="font-size:1.7rem;font-weight:700;margin-bottom:0.75rem;">
            Still just markdown.
          </h2>
          <p class="muted" style="font-size:1.05rem;">
            Standard renderers only read the first word of a fenced code block's
            info string. So{" "}
            <code style="color:var(--accent-strong)">exec</code>,{" "}
            <code style="color:var(--accent-strong)">eval</code>, and every
            modifier are invisible to GitHub, your editor, and any markdown
            viewer. Your executable workflow stays a clean, readable document
            everywhere else.
          </p>
        </div>
      </section>

      {/* Features */}
      <section id="features" class="container" style="padding-block:3.5rem;">
        <h2 style="font-size:1.7rem;font-weight:700;text-align:center;margin-bottom:2rem;">
          What it does
        </h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;">
          {FEATURES.map((f) => (
            <div class="card" key={f.title}>
              <h3 style="font-size:1.05rem;font-weight:700;margin-bottom:0.4rem;">
                {f.title}
              </h3>
              <p class="muted" style="font-size:0.92rem;">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* See it */}
      <section id="example" class="band">
        <div class="container" style="padding-block:3.5rem;">
          <h2 style="font-size:1.7rem;font-weight:700;text-align:center;margin-bottom:0.5rem;">
            See it
          </h2>
          <p
            class="muted"
            style="text-align:center;max-width:60ch;margin:0 auto 2rem;"
          >
            A document is a component. Frontmatter becomes{" "}
            <code>meta</code>, capitalized tags expand other documents, and{" "}
            <code>exec</code> blocks run and render their output.
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem;align-items:start;">
            <div style="display:flex;flex-direction:column;gap:1rem;">
              <CodeBlock filename="README.md">{GREETING_DOC}</CodeBlock>
              <CodeBlock filename="components/Greeting.md">
                {GREETING_COMPONENT}
              </CodeBlock>
            </div>
            <CodeBlock filename="rendered output">{GREETING_OUTPUT}</CodeBlock>
          </div>
        </div>
      </section>

      {/* Diagnostic journals */}
      <section
        class="container prose-w"
        style="padding-block:3.5rem;margin-inline:auto;text-align:center;"
      >
        <h2 style="font-size:1.7rem;font-weight:700;margin-bottom:0.75rem;">
          Diagnostic journals.
        </h2>
        <p class="muted" style="font-size:1.05rem;margin-bottom:1.5rem;">
          Pass <code>--journal</code>{" "}
          to write a JSONL trace of a single run — component sources, command
          output, evaluated values, and errors. The path must not already exist,
          and the trace is never replayed: it's for troubleshooting, not
          recovery. Treat it as potentially sensitive data.
        </p>
        <div style="max-width:34rem;margin:0 auto;">
          <CopyCommand lines={["xmd run doc.md --journal .xmd/events.jsonl"]} />
        </div>
      </section>

      {/* Provider example */}
      <section class="band">
        <div class="container" style="padding-block:3.5rem;">
          <h2 style="font-size:1.7rem;font-weight:700;text-align:center;margin-bottom:0.5rem;">
            One document, two models.
          </h2>
          <p
            class="muted"
            style="text-align:center;max-width:62ch;margin:0 auto 2rem;"
          >
            <code>&lt;AnthropicProvider&gt;</code> and{" "}
            <code>&lt;OllamaProvider&gt;</code>{" "}
            nest inside a single markdown file. <code>&lt;Sample&gt;</code>{" "}
            routes prompts to a cloud model (Claude Opus) and a local model
            (llama3.2), then combines the results — no orchestration code, just
            markdown.
          </p>
          <div style="max-width:760px;margin:0 auto;">
            <CodeBlock filename="core/examples/hello-world.md">
              {HELLO_WORLD}
            </CodeBlock>
          </div>
        </div>
      </section>

      {/* Get started */}
      <section id="install" class="container" style="padding-block:3.5rem;">
        <h2 style="font-size:1.7rem;font-weight:700;text-align:center;margin-bottom:2rem;">
          Get started
        </h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;max-width:900px;margin:0 auto;">
          <div class="card">
            <h3 style="font-weight:700;margin-bottom:0.5rem;">
              Install script
            </h3>
            <p class="muted" style="font-size:0.9rem;margin-bottom:0.75rem;">
              Standalone binary, no runtime required.
            </p>
            <CodeBlock>{installCmd}</CodeBlock>
          </div>
          <div class="card">
            <h3 style="font-weight:700;margin-bottom:0.5rem;">Deno users</h3>
            <p class="muted" style="font-size:0.9rem;margin-bottom:0.75rem;">
              Run from source (a JSR package is coming soon).
            </p>
            <CodeBlock>
              {"git clone https://github.com/taras/executable.md\ncd executable.md && deno task xmd run doc.md"}
            </CodeBlock>
          </div>
          <div class="card">
            <h3 style="font-weight:700;margin-bottom:0.5rem;">
              Prebuilt binary
            </h3>
            <p class="muted" style="font-size:0.9rem;margin-bottom:0.75rem;">
              Download for your platform from{" "}
              <a href={`${GITHUB}/releases`} rel="noopener">GitHub Releases</a>.
            </p>
            <CodeBlock>{"xmd run path/to/doc.md"}</CodeBlock>
          </div>
        </div>
      </section>

      {/* Community */}
      <section class="band">
        <div
          class="container prose-w"
          style="padding-block:3.5rem;margin-inline:auto;text-align:center;"
        >
          <h2 style="font-size:1.7rem;font-weight:700;margin-bottom:0.75rem;">
            Early, and open.
          </h2>
          <p class="muted" style="font-size:1.05rem;margin-bottom:1.5rem;">
            executable.md is a first public release and a draft spec. It's built
            for experimentation with executable markdown workflows,
            Effection-based evaluation, and provider-driven AI documents.
            Feedback, issues, and contributions are very welcome.
          </p>
          <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;">
            <a class="btn btn-primary" href={`${GITHUB}/issues`} rel="noopener">
              Open an issue →
            </a>
            <a
              class="btn btn-ghost"
              href={`${GITHUB}/blob/main/specs/executable-mdx-spec.md`}
              rel="noopener"
            >
              Read the draft spec
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
});
