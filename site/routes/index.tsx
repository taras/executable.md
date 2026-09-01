import { Fragment } from "preact";
import type { ComponentChildren } from "preact";
import { define } from "../utils.ts";
import { Header } from "../components/Header.tsx";
import { CodeBlock } from "../components/Code.tsx";
import {
  Chain,
  CLAIM,
  H3,
  MONO,
  P_MD,
  P_MEASURED,
  P_SM,
  PageFooter,
  STRONG,
  Term,
} from "../components/Prose.tsx";
import {
  bold,
  dim,
  key,
  mod,
  Source,
  str,
  type Tok,
} from "../components/Source.tsx";

const GITHUB = "https://github.com/taras/executable.md";
const SPEC = `${GITHUB}/blob/main/specs/executable-mdx-spec.md`;
const VERSION = "v0.11.0";

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
  ["  ", "type", dim(": "), str('"object"'), dim(",")],
  ["  ", "required", dim(": ["), str('"bump"'), dim("],")],
  ["  ", "properties", dim(": {")],
  ["    ", "bump", dim(": { "), "enum", dim(": [")],
  [
    "      ",
    str('"patch"'),
    dim(", "),
    str('"minor"'),
    dim(", "),
    str('"major"'),
  ],
  ["    ", dim("] }")],
  ["  ", dim("}")],
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
  [],
  ["        Return only corrected JSON matching:"],
  [],
  [
    "        ",
    key("<Json"),
    " value",
    dim("="),
    mod("{proposalSchema}"),
    " ",
    key("/>"),
  ],
  ["      ", key("</Prompt>")],
  ["    ", key("</Else>")],
  ["  ", key("</If>")],
  [key("</Loop>")],
];

const PARSE_MD: Tok[][] = [
  [key("<Let"), " value", dim("="), mod("{{")],
  ["  ", "type", dim(": "), str('"object"'), dim(",")],
  ["  ", "required", dim(": ["), str('"bump"'), dim("],")],
  ["  ", "properties", dim(": {")],
  [
    "    ",
    "bump",
    dim(": { "),
    "enum",
    dim(": ["),
    str('"patch"'),
    dim(", "),
    str('"minor"'),
    dim(", "),
    str('"major"'),
    dim("] }"),
  ],
  ["  ", dim("}")],
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
  ["    Which version bump is required?"],
  ["    Return JSON matching:"],
  [],
  ["    ", key("<Json"), " value", dim("="), mod("{schema}"), " ", key("/>")],
  ["  ", key("</Prompt>")],
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
  ["  ", "type", dim(": "), str('"object"'), dim(",")],
  ["  ", "required", dim(": ["), str('"confirmed"'), dim("],")],
  ["  ", "properties", dim(": { "), "confirmed", dim(": {")],
  ["    ", "type", dim(": "), str('"boolean"'), dim(" } }")],
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

const DRAFT_MD: Tok[][] = [
  [key("<TempDir>")],
  ["  ", key("<File"), " path", dim("="), str('"notes/draft.md"'), key(">")],
  ["  Draft"],
  ["  ", key("</File>")],
  [],
  ["  ```sh ", mod("exec")],
  ["  cat notes/draft.md"],
  ["  ```"],
  [],
  ["  ", key("<Glob"), " include", dim("="), mod('{["**/*.md"]}')],
  ["        as", dim("="), str('"drafts"'), " ", key("/>")],
  [key("</TempDir>")],
];

/* ------------------------------------------------------------------ *
 * Page pieces
 * ------------------------------------------------------------------ */

/** The shell prompt that opens each line of a terminal slab. */
function Prompt() {
  return (
    <span style="color:var(--green);font-weight:700;user-select:none;">$</span>
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
/** Where the work goes once you know how to do it. */
const PRINCIPLES: { label: string; body: string }[] = [
  { label: "Don't know how", body: "Use an agent to figure it out." },
  { label: "Know how", body: "Make it a program." },
  { label: "Judgment remains", body: "Keep only that part agentic." },
];

const RUNTIMES: { name: string; body: string; lines: string[][] }[] = [
  {
    name: "Deno",
    body: "Run the CLI directly from JSR.",
    lines: [[
      " deno run -A \\\n  jsr:@executablemd/cli \\\n  run README.md",
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
function Terminal(
  { lines, noWrap }: { lines: string[][]; noWrap?: boolean },
) {
  return (
    <CodeBlock command noWrap={noWrap}>
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
              A workflow written in prose has to be interpreted before anything
              happens. <Term>xmd</Term>{" "}
              runs the document instead: the Markdown stays readable, and the
              operations it describes execute as a program.
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
                <p style={CLAIM}>
                  The document is the workflow. There is nothing behind it.
                </p>
                <p style={P_SM}>
                  The prose stays prose in any Markdown viewer. The fenced block
                  marked <Term>exec</Term> runs, and <Term>{"<Parse>"}</Term>
                  {" "}
                  turns the model's answer into a value the next step uses.
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
            A README already has useful executable structure: headings name the
            things you want to do. <Term>xmd</Term>{" "}
            turns them into CLI entrypoints. Add frontmatter to expose
            arguments. The explanation and the command stay in the same file.
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
                  Help works as it does on any other CLI, and what it lists
                  comes from the document: the entrypoints it can run and the
                  inputs they accept.
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
                  <Term>--props-package</Term>. The flag, its type, and its
                  pattern all come from the frontmatter, so an invalid value
                  fails before anything runs.
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
        </section>

        {/* Principles */}
        <section id="principles" class="section" style="gap:1.5rem;">
          <div class="section-head">
            <h2>When you know how, make it a program.</h2>
          </div>
          <p style={P_MD}>
            When you know what you want but don't know how to get there, use an
            agent. When you know how to get there, make it a program. Don't keep
            paying an agent to work out something you already know how to do.
          </p>

          <div class="panel">
            <div class="panel-head">The point</div>
            <div class="panel-body">
              <p style={CLAIM}>
                The goal isn't autonomous agents. It's to minimize how much work
                needs to remain agentic.
              </p>
            </div>
          </div>

          <div class="grid grid-3" style="align-items:stretch;">
            {PRINCIPLES.map((principle) => (
              <div
                key={principle.label}
                class="card"
                style="display:flex;flex-direction:column;gap:0.5625rem;min-width:0;"
              >
                <span class="eyebrow">{principle.label}</span>
                <p style="margin:0;font-size:0.875rem;line-height:1.55;color:var(--body);">
                  {principle.body}
                </p>
              </div>
            ))}
          </div>

          <p style={P_MD}>
            One-off work can stay agentic. Repeated work that you know how to do
            can become an <Term>xmd</Term> workflow.
          </p>

          <a
            class="link-rule"
            href="/designing-workflows"
            style="align-self:flex-start;"
          >
            Designing workflows →
          </a>
        </section>

        {/* Agents */}
        <section id="agent" class="section" style="gap:1.5rem;">
          <div class="section-head">
            <h2>Stop hoping the agent reads the instructions.</h2>
          </div>
          <p style={P_MD}>
            A file like <Term>AGENTS.md</Term>{" "}
            is advisory. The agent may read it, skim it, or decide it isn't
            relevant to the task.
          </p>

          <div style="display:flex;flex-direction:column;gap:2rem;">
            <div class="grid" style={PAIR}>
              <Terminal lines={[[" xmd AGENTS.md"]]} />
              <div style={SPLIT}>
                <h3 style={H3}>Run AGENTS.md.</h3>
                <p style={P_SM}>
                  Run the agent from the file instead of leaving it as context
                  the agent may or may not read.
                </p>
              </div>
            </div>

            <div class="grid" style={PAIR}>
              <div style={SPLIT}>
                <h3 style={H3}>Give each role a purpose</h3>
                <p style={P_SM}>
                  Architect, Implementor, and Reviewer are semantic roles, not
                  fixed models. Choose the model or provider when you invoke the
                  workflow.
                </p>
              </div>
              <CodeBlock filename="AGENTS.md">
                <Source lines={AGENTS_MD} />
              </CodeBlock>
            </div>

            <div class="grid" style={PAIR}>
              <CodeBlock filename=".agents/implementor.md">
                <Source lines={IMPLEMENTOR_MD} />
              </CodeBlock>
              <div style={SPLIT}>
                <h3 style={H3}>
                  If you know what context the agent needs, load it explicitly.
                </h3>
                <p style={P_SM}>
                  <Term>xmd</Term>{" "}
                  reads the issue and the files first, then expands{" "}
                  <Term>{"<Session.Launch>"}</Term>{" "}
                  with them already in hand, so the agent starts with them
                  loaded rather than searching for them. Context construction
                  becomes part of the program instead of something the agent has
                  to rediscover.
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
            You declare the repository, worktree, and inputs; the runtime
            handles ordering, cancellation, and cleanup. The workflow owns the
            structure — which repository, which branch, which issue. The agent
            owns the judgment inside it.
          </p>

          <div style="display:flex;flex-direction:column;gap:2rem;">
            <div class="grid" style={PAIR}>
              <CodeBlock>
                <Source lines={SCOPES_MD} />
              </CodeBlock>
              <div style={SPLIT}>
                <h3 style={H3}>The workflow sets up the work.</h3>
                <p style={P_SM}>
                  The repository, the branch, and the issue are known, so the
                  document names them. <Term>Implementor</Term>{" "}
                  is left with the judgment.
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
            Known control flow stays in the program.
          </p>

          <div class="grid" style={`${PAIR}padding-top:0.5rem;`}>
            <div style={STACK}>
              <h3 style={H3}>Retries have a limit.</h3>
              <p style={P_MD}>
                <Term>SafeParse</Term>{" "}
                decides whether the answer is valid, because that rule is
                already known. <Term>If</Term> branches on the result,{" "}
                <Term>Break</Term>{" "}
                ends the loop on success, and the retry prompt shows the same
                schema and asks only for a correction. <Term>{"max={2}"}</Term>
                {" "}
                is in the document, so the runtime knows when to stop trying.
              </p>
            </div>
            <CodeBlock>
              <Source lines={LOOP_MD} />
            </CodeBlock>
          </div>

          <div class="grid" style={`${PAIR}padding-top:0.5rem;`}>
            <div style={STACK}>
              <CodeBlock>
                <Source lines={[...PARSE_MD, [], ...ELICIT_MD]} />
              </CodeBlock>
            </div>
            <div style={STACK}>
              <h3 style={H3}>Schemas make answers usable.</h3>
              <p style={P_MD}>
                Agents return text, and the next step needs a value. The same
                schema does two jobs.
              </p>
              <p style={P_MD}>
                <strong style={STRONG}>
                  Tell the agent what shape to return.
                </strong>{" "}
                <Term>Json</Term> puts the schema directly in the prompt.
              </p>
              <p style={P_MD}>
                <strong style={STRONG}>Validate what comes back.</strong>{" "}
                <Term>Parse</Term>{" "}
                checks the response against that same schema before binding it
                as a value the workflow can use.
              </p>
              <p style={P_MD}>
                <strong style={STRONG}>Ask a person instead.</strong>{" "}
                <Term>Elicit</Term>{" "}
                uses a schema for human input too, and validates the answer
                before the run continues.
              </p>
            </div>
          </div>

          <div class="grid" style={`${PAIR}padding-top:0.5rem;`}>
            <div style={STACK}>
              <h3 style={H3}>Agents pass values.</h3>
              <p style={P_MD}>
                <Term>Architect</Term>'s result is captured as{" "}
                <Term>approvedPlan</Term>; <Term>Implementor</Term>{" "}
                receives it as{" "}
                <Term>plan</Term>. No hidden conversation and no file needed.
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

        {/* The nesting is the model */}
        <section id="model" class="section" style="gap:1.5rem;">
          <div class="section-head">
            <h2>The nesting is the model.</h2>
            <p>
              Components can establish context for everything nested inside
              them.
            </p>
          </div>

          <div class="grid" style={PAIR}>
            <CodeBlock filename="draft.md">
              <Source lines={DRAFT_MD} />
            </CodeBlock>

            <div style="display:flex;flex-direction:column;gap:1rem;min-width:0;">
              <ul class="marks">
                <li>
                  <Term>{"<TempDir>"}</Term>{" "}
                  gives its contents an isolated working directory.
                </li>
                <li>
                  <Term>{"<File>"}</Term>{" "}
                  writes text at a path relative to that directory, creating the
                  parents the path names.
                </li>
                <li>
                  The <Term>exec</Term>{" "}
                  block runs in the same directory, so the shell finds the file
                  {" "}
                  <Term>File</Term> wrote.
                </li>
                <li>
                  <Term>{"<Glob>"}</Term> searches that directory too, and{" "}
                  <Term>as</Term> binds the paths it found.
                </li>
              </ul>
              <p style={CLAIM}>
                Read the nesting as context. Each component establishes
                something for the components inside it.
              </p>
              <p style={P_MD}>
                Move the <Term>File</Term> outside the <Term>TempDir</Term>{" "}
                and it writes somewhere else. And when the enclosing scope ends,
                the runtime removes what that scope owns — the directory goes
                with it. Nesting is context, scope, and lifecycle.
              </p>
            </div>
          </div>
        </section>

        {/* Durability */}
        <section id="durability" class="section" style="gap:1.5rem;">
          <div style="width:100%;max-width:720px;display:flex;flex-direction:column;gap:1.5rem;">
            <div class="section-head" style="width:100%;">
              <h2>The run can outlive the process.</h2>
            </div>
            <p style={P_MD}>
              A retry must not repeat an external side effect, and a process can
              stop while work remains. So the run keeps a record of what already
              happened.
            </p>

            <div style="display:flex;flex-direction:column;gap:1rem;">
              <Step n="01" title="Keep a diagnostic trace.">
                <Terminal
                  lines={[[" xmd run review.md --journal journal.jsonl"]]}
                />
                <p style={P_MEASURED}>
                  <Term>--journal</Term>{" "}
                  writes a JSONL trace of what ran and where it stopped. It is
                  for this run, not retained workflow history.
                </p>
              </Step>

              <Descent />

              <Step n="02" title="Workflows keep their history." experimental>
                <Terminal lines={[[" xmd workflow start review.md"]]} />
                <p style={P_MEASURED}>
                  Workflow mode is experimental. It keeps its own journal and
                  effect records, separate from <Term>--journal</Term>.
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
                  Resume reuses the effects the history records as completed and
                  stops at the first unresolved boundary, instead of repeating
                  an external effect.
                </p>
              </Step>

              <Descent />

              <Step n="04" title="Repair a failed run.">
                <p style={P_MEASURED}>
                  If CI fails after some effects finish, those completions stay
                  recorded. Fix the cause and resume; only the unresolved part
                  needs attention.
                </p>
              </Step>
            </div>
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
                  <Terminal lines={runtime.lines} noWrap />
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

      <PageFooter />

      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
    </>
  );
});
