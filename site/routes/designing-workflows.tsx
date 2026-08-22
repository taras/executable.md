import { define } from "../utils.ts";
import { Header } from "../components/Header.tsx";
import { CodeBlock } from "../components/Code.tsx";
import { Chain, CLAIM, P_MD, PageFooter, Term } from "../components/Prose.tsx";
import { dim, key, mod, Source, str, type Tok } from "../components/Source.tsx";

const ISSUES = "https://github.com/taras/executable.md/issues/new";

/** The ladder of mechanisms, weakest first. Reach right only when you must. */
const POWER = [
  "static value",
  "deterministic operation",
  "control flow",
  "bounded agent judgment",
  "autonomous agent",
];

/** How a task travels as it stops being unknown. */
const MATURITY = ["unknown", "agentic", "understood", "encoded"];

/** The practices that follow from encoding what is already known. */
const PRACTICES = [
  "Do not ask an agent to decide something the workflow already knows.",
  "If you know how to do it, encode it.",
  "Use agents where judgment or genuine uncertainty remains.",
  "Give each agent a specific purpose and bounded responsibility.",
  "Supply known context explicitly rather than asking agents to rediscover it.",
  "Prefer deterministic validation and control flow when success conditions are known.",
  "Put sequencing, retries, lifecycle, cleanup, and anything else you already know how to do into the workflow rather than prompts whenever possible.",
  "Prefer composing bounded agents over giving one autonomous agent responsibility for an entire known multi-step procedure.",
  "When repeated executions show that an agent makes the same decision in the same way, consider moving that decision into the program.",
  "Keep workflow semantics independent of the execution environment and model/provider assignments when possible.",
];

/** The prompt that hands one agent the whole procedure. */
const AUTONOMOUS: Tok[][] = [
  ["Agent: find the issue, inspect the"],
  ["repository, determine the relevant"],
  ["standards, create a worktree,"],
  ["implement it, test it, review it,"],
  ["fix problems..."],
];

/** The same job, with everything already known encoded around the agents. */
const ENCODED: Tok[][] = [
  [key("<Repository"), " name", dim("="), str('"project"')],
  ["            ", "url", dim("="), mod("{props.repository}"), key(">")],
  ["  ", key("<Worktree"), " name", dim("="), str('"implementation"')],
  ["            ", "branch", dim("="), mod("{props.branch}"), key(">")],
  [
    "    ",
    key("<Implementor"),
    " issue",
    dim("="),
    mod("{props.issue}"),
    " ",
    key("/>"),
  ],
  ["    ", key("<Reviewer"), " ", key("/>")],
  ["  ", key("</Worktree>")],
  [key("</Repository>")],
];

export default define.page(function DesigningWorkflows() {
  return (
    <>
      <Header active="workflows" />

      <div class="container" id="top">
        <section style="padding-block:2.5rem 1.5rem;display:flex;flex-direction:column;gap:1.25rem;">
          <span class="eyebrow eyebrow-mark">Documentation</span>
          <h1 style="margin:0;max-width:24ch;font-size:clamp(2.1rem,4.4vw,3.2rem);line-height:1.04;font-weight:800;letter-spacing:-0.03em;">
            Designing workflows
          </h1>
          <p style="margin:0;max-width:56ch;font-size:clamp(1.05rem,2.2vw,1.2rem);line-height:1.5;color:var(--body);">
            What is the least autonomous workflow that will get the job done?
          </p>
          <p style={P_MD}>
            This is the principle of least power applied to workflow design: use
            the least powerful mechanism capable of reliably expressing the
            behavior.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>Use the least autonomy that works.</h2>
          </div>
          <Chain steps={POWER} boxed />
          <p style={P_MD}>
            Move toward the more powerful mechanism only when the less powerful
            mechanism cannot adequately express the task.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>Encode what is known.</h2>
          </div>
          <ul class="marks" style="max-width:74ch;">
            {PRACTICES.map((practice) => <li key={practice}>{practice}</li>)}
          </ul>
          <p style={CLAIM}>Don't give an agent autonomy it doesn't need.</p>
          <p style={P_MD}>
            Don't keep paying an agent to figure out something you already know
            how to do.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>When you don't know how, let an agent figure it out.</h2>
          </div>
          <div
            class="grid"
            style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start;"
          >
            <div style="display:flex;flex-direction:column;gap:0.625rem;min-width:0;">
              <span class="eyebrow" style="color:var(--code-expr);">
                Too autonomous
              </span>
              <CodeBlock>
                <Source lines={AUTONOMOUS} />
              </CodeBlock>
            </div>
            <div style="display:flex;flex-direction:column;gap:0.625rem;min-width:0;">
              <span class="eyebrow">xmd</span>
              <CodeBlock>
                <Source lines={ENCODED} />
              </CodeBlock>
            </div>
          </div>
          <p style={P_MD}>
            Both approaches may accomplish the goal. The <Term>xmd</Term>{" "}
            version encodes everything we already know how to do and reserves
            agent autonomy for the parts that still require judgment. It does
            not eliminate agents or make them deterministic.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>Progressive formalization.</h2>
          </div>
          <p style={P_MD}>
            A task may start with a coding agent because nobody knows how to do
            it yet. The agent discovers a successful way to accomplish it. As
            that way becomes understood and repeated, move the known parts into
            the program. Agents remain where genuine judgment or uncertainty
            remains.
          </p>
          <Chain steps={MATURITY} boxed />
          <p style={P_MD}>
            As a workflow matures, it should generally become more program and
            less prompt. This is not about eliminating AI. It is about reserving
            AI for the places where intelligence is actually valuable.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>Keep the workflow portable.</h2>
          </div>
          <p style={P_MD}>
            The workflow owns what happens. The agent owns the judgment assigned
            to it. The environment owns how and where it runs, including which
            model or provider fulfills each role. Once known behavior is
            encoded, run the same workflow locally, in CI, or in another sandbox
            without redesigning it around that environment.
          </p>
          <p style={P_MD}>
            When you don't know how, let an agent figure it out. Once you know
            how, make it a program. Then run that program anywhere.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>Why this matters.</h2>
          </div>
          <p style={P_MD}>
            <Term>xmd</Term>{" "}
            is not primarily an alternative to production-agent frameworks or
            durable cloud workflow systems. Production agents are applications
            with dedicated infrastructure and engineering attention.{" "}
            <Term>xmd</Term>{" "}
            is especially useful for the agentic work on the way to production —
            implementation, review, testing, debugging, releases, migrations,
            investigation, CI, repository maintenance, and development
            automation that need reliability without a dedicated workflow
            application.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>Prefer xmd primitives to unnecessary JavaScript.</h2>
          </div>
          <p style={P_MD}>
            JavaScript is appropriate when the problem genuinely requires
            general-purpose computation. It should not become the default way to
            express workflow semantics. Prefer{" "}
            <Term>xmd</Term>'s declarative primitives and composition model when
            they naturally represent the intent.
          </p>
          <p style={P_MD}>
            If something that belongs in a workflow is unexpectedly difficult to
            express, requires a large JavaScript workaround, or repeatedly needs
            the same workaround, treat that as feedback about <Term>xmd</Term>
            {" "}
            itself.{" "}
            <a class="link-rule" href={ISSUES} rel="noopener">File an issue</a>
            {" "}
            describing what you were trying to accomplish, why the existing
            primitives made it difficult, and the workaround you needed.
          </p>
          <p style={P_MD}>
            An AI helping author <Term>xmd</Term>{" "}
            should not enthusiastically generate a large JavaScript workaround
            for a missing generally useful primitive and call the problem
            solved. If the workflow is complicated because the problem is
            complicated, that is fine. If it is complicated because{" "}
            <Term>xmd</Term> makes the problem difficult to express, tell us.
          </p>
        </section>

        <section class="section" style="gap:1.25rem;">
          <div class="section-head">
            <h2>Guidance for components.</h2>
          </div>
          <p style={P_MD}>
            Before using an{" "}
            <Term>Agent</Term>, ask whether the operation actually requires
            model judgment. Do not delegate context discovery when the workflow
            already knows the context. Prefer deterministic validation and
            control flow over asking an agent to decide known conditions. Future
            component reference pages should link back to Designing workflows
            rather than repeat this philosophy.
          </p>
        </section>
      </div>

      <PageFooter />
    </>
  );
});
