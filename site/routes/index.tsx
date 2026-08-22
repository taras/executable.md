import { Fragment } from "preact";
import type { ComponentChildren } from "preact";
import { define } from "../utils.ts";
import { Header } from "../components/Header.tsx";
import { CodeBlock } from "../components/Code.tsx";

const GITHUB = "https://github.com/taras/executable.md";
const SPEC = `${GITHUB}/blob/main/specs/executable-mdx-spec.md`;
const VERSION = "v0.8.1";

const MONO = "font-family:var(--font-mono);";
const H3 =
  "margin:0;font-size:1.0625rem;font-weight:800;letter-spacing:-0.01em;line-height:1.25;";
const P_SM = "margin:0;font-size:0.875rem;line-height:1.6;color:var(--body);";
const P_MD =
  "margin:0;max-width:74ch;font-size:0.9375rem;line-height:1.6;color:var(--body);";
const P_MEASURED = `${P_SM}max-width:74ch;`;
const CHAIN_ITEM =
  `${MONO}font-size:0.8125rem;font-weight:700;color:var(--ink);`;
const STEP_NUMBER =
  `${MONO}font-size:0.8125rem;font-weight:700;letter-spacing:0.1em;color:var(--green);`;
const SPLIT = "display:flex;flex-direction:column;gap:0.5rem;min-width:0;";
const STACK = "display:flex;flex-direction:column;gap:0.75rem;min-width:0;";
const PAIR =
  "grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-items:start;";

/**
 * The release-link hover inverts the base rule: it inherits the eyebrow's
 * dim until hover, where it picks up the accent.
 */
const PAGE_CSS = ".release-link{color:inherit;letter-spacing:inherit;}" +
  ".release-link:hover{color:var(--green);}";

/* ------------------------------------------------------------------ *
 * Hand-tokenized document source
 * ------------------------------------------------------------------ */

/**
 * One run of source text. A bare string is unstyled; a tuple carries the
 * token class the design system paints it with, and `bold` is the Markdown
 * structure (headings) that reads at full weight rather than as a token.
 */
type Tok = string | ["key" | "str" | "mod" | "dim" | "bold", string];

const key = (text: string): Tok => ["key", text];
const str = (text: string): Tok => ["str", text];
const mod = (text: string): Tok => ["mod", text];
const dim = (text: string): Tok => ["dim", text];
const bold = (text: string): Tok => ["bold", text];

const TOK_CLASS = {
  key: "tok-key",
  str: "tok-str",
  mod: "tok-mod",
  dim: "tok-dim",
} as const;

/** Source lines, joined with newlines so `<pre>` lays them out. */
function Source({ lines }: { lines: Tok[][] }) {
  return (
    <>
      {lines.map((parts, line) => (
        <Fragment key={line}>
          {line > 0 ? "\n" : null}
          {parts.map((part, i) =>
            typeof part === "string"
              ? part
              : part[0] === "bold"
              ? <span key={i} style="font-weight:700;">{part[1]}</span>
              : <span key={i} class={TOK_CLASS[part[0]]}>{part[1]}</span>
          )}
        </Fragment>
      ))}
    </>
  );
}

const RELEASE_MD: Tok[][] = [
  [bold("# Release")],
  [],
  ["Run the tests."],
  [],
  ["```bash ", mod("exec")],
  ["deno task test"],
  ["```"],
  [],
  ["Now decide how these changes should be"],
  ["versioned."],
  [],
  [key("<Let"), " value", dim("="), mod("{{")],
  [
    "  ",
    mod("type: "),
    str('"object"'),
    mod(', required: ["bump"],'),
  ],
  ["  ", mod("properties: { bump: { enum: [")],
  [
    "    ",
    str('"patch"'),
    mod(", "),
    str('"minor"'),
    mod(", "),
    str('"major"'),
    mod(" ] } }"),
  ],
  [mod("}}"), " as", dim("="), str('"schema"'), " ", key("/>")],
  [],
  [
    key("<Parse"),
    " schema",
    dim("="),
    mod("{schema}"),
    " as",
    dim("="),
    str('"release"'),
    key(">"),
  ],
  ["  ", key("<Prompt>")],
  ["  Which version bump do these changes"],
  ["  require? Return JSON matching:"],
  [],
  ["  ", key("<Json"), " value", dim("="), mod("{schema}"), " ", key("/>")],
  [],
  ["  ```bash ", mod("exec")],
  ["  git log --oneline main..HEAD"],
  ["  ```"],
  ["  ", key("</Prompt>")],
  [key("</Parse>")],
  [],
  [
    key("<Publish"),
    " bump",
    dim("="),
    mod("{release.bump}"),
    " ",
    key("/>"),
  ],
];

const README_MD: Tok[][] = [
  [dim("---")],
  [dim("props:")],
  [dim("  package:")],
  [dim("    type:"), " ", str("string")],
  [dim("    pattern:"), " ", str('"^packages/[a-z0-9._-]+$"')],
  [dim("---")],
  [],
  [bold("## Setup")],
  [],
  ["```bash ", mod("exec")],
  ["deno task setup"],
  ["```"],
  [],
  [bold("## Test")],
  [],
  [bold("### Complete")],
  [],
  ["```bash ", mod("timeout=30m exec")],
  ["deno task verify"],
  ["```"],
  [],
  [bold("## Bootstrap")],
  [],
  [key("<BootstrapNpmPackage")],
  ["  package", dim("="), mod("{props.package}"), " ", key("/>")],
];

const AGENTS_MD: Tok[][] = [
  [bold("## Architect")],
  [key("<Architect"), " ", key("/>")],
  [],
  [bold("## Implementor")],
  [
    key("<Implementor"),
    " issue",
    dim("="),
    mod("{props.issue}"),
    " ",
    key("/>"),
  ],
  [],
  [bold("## Reviewer")],
  [key("<Reviewer"), " ", key("/>")],
];

const IMPLEMENTOR_MD: Tok[][] = [
  [key("<Agent>")],
  ["  ", key("<Session"), " name", dim("="), str('"implementor"'), key(">")],
  ["    ", key("<Session.Launch>")],
  ["      You're an implementor agent."],
  [
    "      ",
    key("<If"),
    " condition",
    dim("="),
    mod("{props.issue}"),
    key(">"),
  ],
  ["        Implement this ticket:"],
  [
    "        ",
    key("<Issue"),
    " url",
    dim("="),
    mod("{props.issue}"),
    " ",
    key("/>"),
  ],
  ["      ", key("</If>")],
  [
    "      ",
    key("<File"),
    " path",
    dim("="),
    str('"coding-standards.md"'),
    " ",
    key("/>"),
  ],
  [
    "      ",
    key("<File"),
    " path",
    dim("="),
    str('"security-standards.md"'),
    " ",
    key("/>"),
  ],
  ["    ", key("</Session.Launch>")],
  ["  ", key("</Session>")],
  [key("</Agent>")],
];

const SCOPES_MD: Tok[][] = [
  [key("<Repository"), " name", dim("="), str('"project"')],
  ["            url", dim("="), mod("{props.repository}"), key(">")],
  ["  ", key("<Worktree"), " name", dim("="), str('"implementation"')],
  ["            branch", dim("="), mod("{props.branch}"), key(">")],
  [
    "    ",
    key("<Implementor"),
    " issue",
    dim("="),
    mod("{props.issue}"),
    " ",
    key("/>"),
  ],
  ["  ", key("</Worktree>")],
  [key("</Repository>")],
];

const WRAPPERS_MD: Tok[][] = [
  [key("<Repository"), " ", dim("…"), key(">")],
  [
    "  ",
    key("<Worktree"),
    " name",
    dim("="),
    str('"issue-142"'),
    " branch",
    dim("="),
    str('"fix/142"'),
    key(">"),
  ],
  [
    "    ",
    key("<Implementor"),
    " issue",
    dim("="),
    str('"#142"'),
    " ",
    key("/>"),
  ],
  ["  ", key("</Worktree>")],
  [
    "  ",
    key("<Worktree"),
    " name",
    dim("="),
    str('"issue-158"'),
    " branch",
    dim("="),
    str('"fix/158"'),
    key(">"),
  ],
  [
    "    ",
    key("<Implementor"),
    " issue",
    dim("="),
    str('"#158"'),
    " ",
    key("/>"),
  ],
  ["  ", key("</Worktree>")],
  [key("</Repository>")],
];

const LOOP_MD: Tok[][] = [
  [key("<Loop"), " max", dim("="), mod("{2}"), key(">")],
  ["  ", key("<SafeParse"), " schema", dim("="), mod("{proposalSchema}")],
  ["             as", dim("="), str('"parsedProposal"'), key(">")],
  ["    ", mod("{proposalCandidate}")],
  ["  ", key("</SafeParse>")],
  [],
  [
    "  ",
    key("<If"),
    " condition",
    dim("="),
    mod("{parsedProposal.ok}"),
    key(">"),
  ],
  ["    ", key("<Break"), " ", key("/>")],
  ["    ", key("<Else>")],
  ["      ", key("<Prompt"), " as", dim("="), str('"proposalCandidate"')],
  ["              ", mod("throwOnError"), key(">")],
  ["        Correct your previous response"],
  ["        without changing its meaning."],
  ["        Return only corrected JSON matching"],
  ["        the supplied result contract."],
  ["      ", key("</Prompt>")],
  ["    ", key("</Else>")],
  ["  ", key("</If>")],
  [key("</Loop>")],
];

const PARSE_MD: Tok[][] = [
  [key("<Let"), " value", dim("="), mod("{{")],
  ["  ", mod("type: "), str('"object"'), mod(",")],
  ["  ", mod("required: ["), str('"bump"'), mod("],")],
  ["  ", mod("properties: {")],
  [
    "    ",
    mod("bump: { enum: ["),
    str('"patch"'),
    mod(", "),
    str('"minor"'),
    mod(", "),
    str('"major"'),
    mod("] }"),
  ],
  ["  ", mod("}")],
  [mod("}}"), " as", dim("="), str('"schema"'), " ", key("/>")],
  [
    key("<Parse"),
    " schema",
    dim("="),
    mod("{schema}"),
    " as",
    dim("="),
    str('"release"'),
    key(">"),
  ],
  [
    "  ",
    key("<Prompt>"),
    "Which version bump is required?",
    key("</Prompt>"),
  ],
  [key("</Parse>")],
];

const ELICIT_MD: Tok[][] = [
  [
    key("<Elicit"),
    " as",
    dim("="),
    str('"release"'),
    " schema",
    dim("="),
    mod("{{"),
  ],
  ["  ", mod("type: "), str('"object"'), mod(",")],
  ["  ", mod("required: ["), str('"confirmed"'), mod("],")],
  ["  ", mod("properties: { confirmed: {")],
  ["    ", mod("type: "), str('"boolean"'), mod(" } }")],
  [mod("}}"), key(">")],
  ["  Publish this release?"],
  [key("</Elicit>")],
];

const HANDOFF_MD: Tok[][] = [
  [key("<Architect"), " as", dim("="), str('"approvedPlan"'), " ", key("/>")],
  [
    key("<Implementor"),
    " plan",
    dim("="),
    mod("{approvedPlan}"),
    " ",
    key("/>"),
  ],
];

/* ------------------------------------------------------------------ *
 * Page pieces
 * ------------------------------------------------------------------ */

/** An inline identifier: monospace, at full contrast against body prose. */
function Term({ children }: { children: ComponentChildren }) {
  return (
    <code style={`${MONO}font-weight:700;color:var(--ink);`}>{children}</code>
  );
}

/** The shell prompt that opens each line of a terminal slab. */
function Prompt() {
  return (
    <span style="color:var(--green);font-weight:700;user-select:none;">$</span>
  );
}

/** A ruled arrow chain, e.g. `Repository → Worktree → Implementor`. */
function Chain({ steps, boxed }: { steps: string[]; boxed?: boolean }) {
  return (
    <div
      style={`display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;${
        boxed
          ? "border:var(--rule) solid var(--line);padding:0.75rem 0.875rem;"
          : "padding-top:0.125rem;"
      }`}
    >
      {steps.map((step, i) => (
        <Fragment key={step}>
          <span style={CHAIN_ITEM}>{step}</span>
          {i < steps.length - 1
            ? <span style="color:var(--dim);">→</span>
            : null}
        </Fragment>
      ))}
    </div>
  );
}

/** The rule-and-arrow that carries the eye from one durability step to the next. */
function Descent() {
  return (
    <div
      aria-hidden="true"
      style="display:flex;flex-direction:column;align-items:center;width:1.5rem;gap:0.125rem;"
    >
      <span style="width:var(--rule);height:1.25rem;background:var(--line);" />
      <span style={`${MONO}font-size:0.875rem;line-height:1;color:var(--dim);`}>
        ↓
      </span>
    </div>
  );
}

/** A numbered durability step. */
function Step(
  { n, title, experimental, children }: {
    n: string;
    title: string;
    experimental?: boolean;
    children: ComponentChildren;
  },
) {
  return (
    <div style={STACK}>
      <div style="display:flex;align-items:baseline;gap:0.75rem;">
        <span style={STEP_NUMBER}>{n}</span>
        <h3 style={H3}>{title}</h3>
        {experimental
          ? (
            <span class="pill" style="color:var(--code-expr);">
              Experimental
            </span>
          )
          : null}
      </div>
      {children}
    </div>
  );
}

/** One of the three runtimes the same CLI installs under. */
const RUNTIMES: { name: string; body: string; lines: string[][] }[] = [
  {
    name: "Deno",
    body: "Run the CLI directly from JSR.",
    lines: [[
      " deno run -A \\\n    jsr:@executablemd/cli \\\n    run README.md",
    ]],
  },
  {
    name: "Node",
    body: "Install the CLI from npm, then run the same command.",
    lines: [[" npm install -g \\\n    @executablemd/cli"], [
      " xmd README.md --help",
    ]],
  },
  {
    name: "Bun",
    body: "Install the same npm package with Bun.",
    lines: [[" bun add -g \\\n    @executablemd/cli"], [
      " xmd README.md --help",
    ]],
  },
];

/** A terminal slab whose lines each open with a prompt. */
function Terminal({ lines }: { lines: string[][] }) {
  return (
    <CodeBlock command>
      {lines.map((parts, i) => (
        <Fragment key={i}>
          {i > 0 ? "\n" : null}
          <Prompt />
          {parts}
        </Fragment>
      ))}
    </CodeBlock>
  );
}

export default define.page(function Home({ url }) {
  const installCmd = ` curl -fsSL ${url.origin}/install.sh | sh`;
  return (
    <>
      <Header />

      <div class="container" id="top">
        {/* Hero */}
        <section style="padding-block:2.5rem 3.5rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));gap:3rem;align-items:start;">
          <div style="display:flex;flex-direction:column;gap:1.5rem;min-width:0;">
            <span class="eyebrow eyebrow-mark">
              Open source ·{" "}
              <a
                class="release-link"
                href={`${GITHUB}/releases`}
                rel="noopener"
              >
                {VERSION}
              </a>
            </span>

            <h1 style="margin:0;font-size:clamp(2.4rem,5vw,3.9rem);line-height:1.02;font-weight:800;letter-spacing:-0.03em;">
              Stop rolling the dice in your workflows.
            </h1>

            <p style="margin:0;max-width:50ch;font-size:clamp(1.05rem,2.2vw,1.2rem);line-height:1.5;color:var(--body);">
              Workflows described in prose have to be interpreted before
              anything happens. Humans skim, often skipping important steps.
              Agents may simply decide that the entire workflow is not relevant.
              {" "}
              <Term>xmd</Term>{" "}
              removes the interpretation step by making each document a program
              that only relies on judgment where needed.
            </p>

            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:0.75rem 1.25rem;">
              <a class="btn btn-primary btn-lg push" href="#install">
                Install xmd →
              </a>
              <a class="link-rule" href={SPEC} rel="noopener">
                Read the spec ↗
              </a>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:1.125rem;min-width:0;">
            <div class="panel">
              <div class="panel-head">What you read is what runs</div>
              <div class="panel-body">
                <p style="margin:0;font-size:1.0625rem;line-height:1.45;color:var(--ink);font-weight:800;letter-spacing:-0.01em;">
                  There is no workflow hidden behind the document. The document
                  is the workflow.
                </p>
                <CodeBlock filename="release.md">
                  <Source lines={RELEASE_MD} />
                </CodeBlock>
              </div>
            </div>
          </div>
        </section>

        {/* The README as a CLI */}
        <section id="readme" class="section">
          <div class="section-head">
            <h2>The README as a CLI.</h2>
          </div>
          <p style={P_MD}>
            Procedure belongs in the document; judgment belongs where the
            document asks for it. <Term>xmd</Term>{" "}
            moves procedure out of probabilistic interpretation and into
            executable software: tests, file loading, sequencing, retries, and
            cleanup run as code, while planning, review, interpretation, and
            design decisions stay with people or agents. Once procedure is
            executable, documentation does not need a parallel implementation to
            stay in sync — a README can explain the work to a person and expose
            the same work as runnable entry points for a CLI or an agent.
          </p>

          <div
            class="grid"
            style="grid-template-columns:repeat(auto-fit,minmax(330px,1fr));align-items:start;"
          >
            <CodeBlock filename="README.md">
              <Source lines={README_MD} />
            </CodeBlock>

            <div style="display:flex;flex-direction:column;gap:1.5rem;min-width:0;">
              <div style="display:flex;flex-direction:column;gap:0.625rem;">
                <div>
                  <Terminal lines={[[" xmd README.md --help"]]} />
                </div>
                <span class="eyebrow">Help for the README</span>
                <p style={P_SM}>
                  <Term>xmd README.md --help</Term>{" "}
                  works like help on any other CLI, showing the README's
                  arguments and runnable entrypoints.
                </p>
              </div>

              <div style="display:flex;flex-direction:column;gap:0.625rem;">
                <div>
                  <Terminal
                    lines={[[
                      " xmd README.md#Bootstrap \\\n    --props-package packages/web",
                    ]]}
                  />
                </div>
                <span class="eyebrow">Props → CLI arguments</span>
                <p style={P_SM}>
                  <Term>package</Term> becomes{" "}
                  <Term>--props-package</Term>, with its type and validation
                  coming directly from the README.
                </p>
              </div>

              <div style="display:flex;flex-direction:column;gap:0.625rem;">
                <div>
                  <Terminal
                    lines={[
                      [" xmd README.md#Setup"],
                      [" xmd README.md#Test"],
                      [" xmd README.md#Test/Complete"],
                    ]}
                  />
                </div>
                <span class="eyebrow">Headings → entrypoints</span>
                <p style={P_SM}>
                  Every heading is a runnable entrypoint. Nested headings become
                  nested paths like <Term>README.md#Test/Complete</Term>.
                </p>
              </div>
            </div>
          </div>

          <p style={P_MD}>
            One document serves both audiences: prose explains what is
            happening, while headings and explicit inputs reveal only the
            operation needed at the point it is needed.
          </p>
        </section>

        {/* Agents */}
        <section id="agent" class="section" style="gap:1.5rem;">
          <div class="section-head">
            <h2>Stop hoping the agent reads the instructions.</h2>
          </div>

          <div style="display:flex;flex-direction:column;gap:2rem;">
            <div class="grid" style={PAIR}>
              <Terminal lines={[[" xmd AGENTS.md"]]} />
              <div style={SPLIT}>
                <h3 style={H3}>Run AGENTS.md.</h3>
                <p style={P_SM}>
                  Run the agent from{" "}
                  <Term>AGENTS.md</Term>. Do not leave the file as context the
                  agent may or may not discover.
                </p>
              </div>
            </div>

            <div class="grid" style={PAIR}>
              <div style={SPLIT}>
                <h3 style={H3}>Each agent is a Markdown component</h3>
                <p style={P_SM}>
                  An agent is a Markdown file with agent instructions, and
                  selecting a heading expands that file's component in place.
                </p>
              </div>
              <CodeBlock filename="AGENTS.md">
                <Source lines={AGENTS_MD} />
              </CodeBlock>
            </div>

            <p style={P_MD}>
              Architect, Implementor, and Reviewer are semantic roles, not fixed
              models. Choose the model or provider when you invoke the workflow.
            </p>

            <div class="grid" style={PAIR}>
              <CodeBlock filename=".agents/implementor.md">
                <Source lines={IMPLEMENTOR_MD} />
              </CodeBlock>
              <div style={SPLIT}>
                <h3 style={H3}>You control what context the agent gets.</h3>
                <p style={P_MD}>
                  The previous section made the role explicit; this section
                  makes its prompt explicit. The coding agent will start with
                  the context explicitly declared by its Markdown.{" "}
                  <Term>xmd</Term>{" "}
                  reads the issue and the files first, then expands{" "}
                  <Term>{"<Session.Launch>"}</Term>{" "}
                  with them already in hand, instead of the agent guessing what
                  to search for or which tools to call. The agent starts with
                  the intended files already loaded.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Runtime */}
        <section id="runtime" class="section" style="gap:1.5rem;">
          <div class="section-head">
            <h2>The runtime handles the effects.</h2>
          </div>
          <p style={P_MD}>
            Once the prompt is explicit, the runtime can manage the effects
            safely. You declare the repository, worktree, issue, and prompt
            inputs; it handles ordering, cancellation, and cleanup.
          </p>

          <div style="display:flex;flex-direction:column;gap:2rem;">
            <div class="grid" style={PAIR}>
              <CodeBlock>
                <Source lines={SCOPES_MD} />
              </CodeBlock>
              <div style={SPLIT}>
                <h3 style={H3}>Scopes pass context down.</h3>
                <p style={P_SM}>
                  <Term>Repository</Term> sets the project.{" "}
                  <Term>Worktree</Term> sets where the work happens. The nested
                  {" "}
                  <Term>Implementor</Term> runs there automatically. Its{" "}
                  <Term>Session.Launch</Term>{" "}
                  names the issue and files that become the prompt. Nothing is
                  discovered from ambient state.
                </p>
              </div>
            </div>

            <div class="grid" style={PAIR}>
              <div style={SPLIT}>
                <h3 style={H3}>Wrappers add context.</h3>
                <p style={P_SM}>
                  Wrappers add context for everything inside them. The same{" "}
                  <Term>Implementor</Term>{" "}
                  can run against different repositories, worktrees, or issues
                  without changing its Markdown.
                </p>
                <Chain steps={["Repository", "Worktree", "Implementor"]} />
              </div>
              <CodeBlock>
                <Source lines={WRAPPERS_MD} />
              </CodeBlock>
            </div>

            <div class="grid" style={PAIR}>
              <div class="panel">
                <div class="panel-head">Structured concurrency</div>
                <div class="panel-body">
                  <p style={P_SM}>
                    Children run with their parent. When the parent ends, the
                    runtime cancels them and clears the values bound inside it.
                  </p>
                </div>
              </div>
              <div style={SPLIT}>
                <h3 style={H3}>Scopes clean up.</h3>
                <p style={P_SM}>
                  Open a worktree inside a repository and it closes with it. The
                  same is true for scope-bound values. Cleanup happens at the
                  boundary, so context does not leak into the next run.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Compose */}
        <section id="compose" class="section" style="gap:1.5rem;">
          <div class="section-head">
            <h2>The runtime composes intent.</h2>
          </div>
          <p style={P_MD}>
            When judgment needs another try, a schema, or a handoff, the
            document says how.
          </p>

          <div class="grid" style={`${PAIR}padding-top:0.5rem;`}>
            <div style={STACK}>
              <h3 style={H3}>Retries have a limit.</h3>
              <p style={P_MD}>
                A loop gives retries a limit. Break when the result is good;
                otherwise prompt again.
              </p>
              <p style={P_MD}>
                <Term>SafeParse</Term> checks the result. <Term>If</Term>{" "}
                decides whether it is good enough. <Term>Break</Term>{" "}
                stops the loop.
              </p>
              <p style={P_MD}>
                <Term>max</Term>{" "}
                is part of the document, so the runtime knows when to stop.
              </p>
            </div>
            <CodeBlock>
              <Source lines={LOOP_MD} />
            </CodeBlock>
          </div>

          <div class="grid" style={`${PAIR}padding-top:0.5rem;`}>
            <div style={STACK}>
              <CodeBlock>
                <Source lines={PARSE_MD} />
              </CodeBlock>
              <CodeBlock>
                <Source lines={ELICIT_MD} />
              </CodeBlock>
            </div>
            <div style={STACK}>
              <h3 style={H3}>Schemas make answers usable.</h3>
              <p style={P_MD}>
                Agents often return prose. When the next step needs a value,
                give it a schema. The runtime checks the answer and passes
                structured data on.
              </p>
              <p style={P_MD}>
                When a person needs to decide, <Term>Elicit</Term>{" "}
                opens the browser form and validates the answer before the
                workflow continues.
              </p>
            </div>
          </div>

          <div class="grid" style={`${PAIR}padding-top:0.5rem;`}>
            <div style={STACK}>
              <h3 style={H3}>Agents pass values.</h3>
              <p style={P_MD}>
                One agent can leave a value in memory for the next. Name it,
                then pass it as a prop. No hidden conversation and no file
                needed.
              </p>
              <p style={P_MD}>
                <Term>Architect</Term>'s result is captured as{" "}
                <Term>approvedPlan</Term>. <Term>Implementor</Term>{" "}
                receives it as{" "}
                <Term>plan</Term>. The handoff is explicit and deterministic.
              </p>
              <p style={P_MD}>
                Roles stay the same even when the model changes. Pick the model
                and provider when you run the workflow.
              </p>
              <p style={P_MD}>
                Memory lives only in this run and its nested scopes.
              </p>
            </div>
            <CodeBlock>
              <Source lines={HANDOFF_MD} />
            </CodeBlock>
          </div>
        </section>

        {/* Durability */}
        <section id="durability" class="section" style="gap:1.5rem;">
          <div style="width:100%;max-width:720px;display:flex;flex-direction:column;gap:1.5rem;">
            <p style={P_MD}>
              A retry must not repeat an external side effect. Once a workflow
              can act outside the process, it needs a record of what already
              happened.
            </p>
            <div class="section-head" style="width:100%;">
              <h2>The run can outlive the process.</h2>
            </div>
            <p style={P_MD}>
              Once the runtime manages the effects, the workflow can survive the
              process that started it. A process can stop while work remains, so
              the run needs a record of what happened.
            </p>

            <div style="display:flex;flex-direction:column;gap:1rem;">
              <Step n="01" title="Keep a diagnostic trace.">
                <Terminal
                  lines={[[" xmd run review.md --journal journal.jsonl"]]}
                />
                <p style={P_MEASURED}>
                  Add <Term>--journal</Term>{" "}
                  when you want a diagnostic JSONL trace. It shows what ran and
                  where it stopped. It is for this run, not retained workflow
                  history.
                </p>
              </Step>

              <Descent />

              <Step n="02" title="Workflows keep their history." experimental>
                <Terminal lines={[[" xmd workflow start review.md"]]} />
                <p style={P_MEASURED}>
                  Workflow mode is experimental. It keeps its own journal and
                  effect records. That history is separate from{" "}
                  <Term>--journal</Term>, and replay can reuse completed
                  effects.
                </p>
              </Step>

              <Descent />

              <Step n="03" title="Replay starts at the first gap." experimental>
                <div style="display:flex;flex-direction:column;gap:0.6875rem;min-width:0;">
                  <Chain
                    boxed
                    steps={[
                      "journal",
                      "durable effect",
                      "replay",
                      "recover",
                      "repair",
                    ]}
                  />
                  <Terminal
                    lines={[[" xmd workflow resume <run-id>"]]}
                  />
                </div>
                <p style={P_MEASURED}>
                  Resume reads the workflow history. It recognizes completed
                  work, reuses it, and stops at the first unresolved boundary
                  instead of repeating an external effect.
                </p>
              </Step>

              <Descent />

              <Step n="04" title="Repair a failed run.">
                <p style={P_MEASURED}>
                  If CI fails after some effects finish, those completions stay
                  recorded. Fix the cause and resume. Only the unresolved part
                  needs attention.
                </p>
              </Step>
            </div>

            <p style={P_MD}>
              The run is still useful after the process stops. Its journal and
              effects make it inspectable, replayable, and repairable.
            </p>
          </div>
        </section>

        {/* Install */}
        <section id="install" class="section" style="gap:1.5rem;">
          <div class="section-head">
            <h2>Install once. Run anywhere.</h2>
          </div>
          <p style={P_MD}>
            The standalone binary needs no runtime. The same CLI also runs under
            Deno, Node, and Bun.
          </p>

          <Terminal lines={[[installCmd], [" xmd README.md --help"]]} />

          <div
            class="grid"
            style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));align-items:stretch;"
          >
            {RUNTIMES.map((runtime) => (
              <div
                key={runtime.name}
                class="card"
                style="display:flex;flex-direction:column;gap:0.5625rem;min-width:0;"
              >
                <h3 style={H3}>{runtime.name}</h3>
                <p style="margin:0;font-size:0.875rem;line-height:1.55;color:var(--body);">
                  {runtime.body}
                </p>
                <div style="margin-top:auto;">
                  <Terminal lines={runtime.lines} />
                </div>
              </div>
            ))}
          </div>

          <p
            style={`margin:0;${MONO}font-size:0.8125rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;line-height:1.7;color:var(--ink);`}
          >
            Standalone binary · Deno · Node · Bun
          </p>
        </section>
      </div>

      <footer style="border-top:var(--rule) solid var(--line);padding:1.5rem 0;margin-top:1rem;">
        <div
          class="container"
          style={`${MONO}font-size:0.8125rem;color:var(--dim);`}
        >
          Made with ❤️ Effection.
        </div>
      </footer>

      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
    </>
  );
});
