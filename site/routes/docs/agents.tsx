import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const REVIEW = `<Agent>
  <Session name="review">
    <Prompt text="Review the current repository. List the highest-risk changes as a checklist." as="review" />
    <Prompt text="Turn that review into the next three actions." as="actions" />
  </Session>
</Agent>

## Review checklist

{review}

## Next actions

{actions}`;

const APPROVE_ALL = `<ApproveAll>
  <Prompt text="Apply the approved migration." />
</ApproveAll>`;

const ASK = `<AskPermission>
  <Prompt text="Make the proposed edit." />
</AskPermission>`;

export default define.page(function Agents() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Coding agents</h1>

      <h2>Why put a coding agent in a document?</h2>
      <p>
        Use a coding agent when a workflow has both predictable steps and a part
        that needs judgment. A single document keeps the instructions, agent
        result, and later processing together. You can run a repository review,
        planning task, maintenance check, migration preparation, or
        documentation update the same way each time.
      </p>
      <p>
        Capture the agent&apos;s result and use it in a later document stage.
        Keep unattended work bounded by choosing the working directory,
        permission policy, and time limit before it starts.
      </p>

      <h2>When to use it</h2>
      <p>Agent documents work well when you want to:</p>
      <ul>
        <li>Review a repository and turn the findings into a checklist.</li>
        <li>
          Investigate a failure, then pass the diagnosis to a later stage.
        </li>
        <li>Maintain documentation from source changes.</li>
        <li>Ask several related questions in one working session.</li>
        <li>Add agent judgment to an otherwise deterministic workflow.</li>
      </ul>
      <p>
        Use normal executable components for deterministic shell and process
        work. Use the stateless sampling API when no coding-agent session or
        repository interaction is needed. For a one-off conversation, use an
        interactive agent directly instead of creating a repeatable workflow.
      </p>

      <h2>A complete first workflow</h2>
      <p>
        This document asks for a review, captures it, asks a follow-up in the
        same conversation, and presents both results. Save it as
        <code>review.md</code> in the repository to review.
      </p>
      <CodeBlock filename="review.md">{REVIEW}</CodeBlock>
      <p>
        <code>&lt;Agent&gt;</code> chooses the coding agent. The first
        <code>&lt;Prompt&gt;</code> captures its reply as <code>review</code>
        instead of placing it immediately in the output. The two headings later
        in the document show the captured review and actions. Without a
        <code>name</code> prop, <code>&lt;Agent&gt;</code>{" "}
        uses the selected default; set <code>name</code>{" "}
        only when this document needs to override that choice.
      </p>
      <p>Run the workflow with an agent your ACPX setup can run:</p>
      <CodeBlock>{"xmd run review.md --default-agent codex"}</CodeBlock>
      <p>
        The rendered document contains the review checklist followed by the next
        actions. If you omit{" "}
        <code>as</code>, a prompt reply appears at the prompt&apos;s position
        instead.
      </p>

      <h2>Continue the same task</h2>
      <p>
        The named <code>&lt;Session name="review"&gt;</code>{" "}
        in the example keeps the follow-up connected to the review. Use a
        session when a later prompt should retain the context of earlier work,
        such as asking an agent to turn findings into a plan. Use different
        session names for separate conversations in the same document.
      </p>

      <h2>Run it safely</h2>
      <p>
        Start from the default,{" "}
        <code>--approve-reads</code>. It allows read and search requests, asks
        about other requests in an interactive terminal, and denies those other
        requests when no interactive terminal is available. This is the safest
        common choice for reviews and investigations.
      </p>
      <ul>
        <li>
          <strong>Where may it work?</strong> Run <code>xmd</code>{" "}
          from the repository or directory the agent should use. That working
          directory determines where its session starts or resumes.
        </li>
        <li>
          <strong>What may it do?</strong> Choose <code>--approve-reads</code>,
          <code>--approve-all</code>, or{" "}
          <code>--deny-all</code>. The flags are mutually exclusive.
        </li>
        <li>
          <strong>How long may it wait?</strong>{" "}
          Prompts have a two-minute default limit. Use <code>--timeout 90</code>
          {" "}
          for a shared 90-second limit for each operation without its own
          timeout, or set a prompt-specific <code>timeout</code>{" "}
          when one request needs a different limit.
        </li>
      </ul>
      <p>
        Give a single prompt a broader or interactive policy only when that work
        requires it. These wrappers apply only to their contents:
      </p>
      <CodeBlock filename="review.md">{APPROVE_ALL}</CodeBlock>
      <CodeBlock filename="review.md">{ASK}</CodeBlock>
      <p>
        <code>&lt;ApproveAll&gt;</code> chooses an available allow option;
        <code>&lt;AskPermission&gt;</code>{" "}
        asks in an interactive terminal and otherwise denies. No JavaScript eval
        block is needed to use either.
      </p>

      <h2>Reference</h2>
      <p>
        <code>xmd run</code>{" "}
        uses ACPX by default. Agent defaults become more specific in this order:
        ACPX default, <code>DEFAULT_AGENT_NAME</code>,
        <code>--default-agent</code>, an enclosing
        <code>&lt;AgentProvider defaultAgent="…"&gt;</code>, then an explicit
        <code>&lt;Agent&gt;</code> or{" "}
        <code>&lt;Prompt agent="…" /&gt;</code>. Use{" "}
        <code>--agent-provider acpx</code>{" "}
        to state the current provider explicitly.
      </p>
      <p>
        A <code>session</code>, <code>agent</code>, or <code>timeout</code>{" "}
        prop on <code>&lt;Prompt&gt;</code>{" "}
        overrides the enclosing choice for that one request. When the document
        finishes, active work is cancelled and the agent resources close before
        the command completes.
      </p>
      <p>
        <code>Unknown agent provider "…"</code>{" "}
        means the provider flag is not registered.{" "}
        <code>agent "…" is unavailable</code>{" "}
        means the selected agent could not be checked; verify its name,
        installation, and ACPX configuration. For a timeout or denial, first
        check the working directory, permission choice, and limit.
      </p>

      <h2>Test the workflow without a model</h2>
      <p>
        Use the bundled test agent to verify prompts, sessions, captures, and
        failure handling with controlled replies instead of a real model. The
        <a
          href="https://github.com/taras/executable.md/blob/main/packages/test-agent/README.md"
          rel="noopener"
        >
          deterministic test-agent guide
        </a>{" "}
        starts with the normal <code>xmd test</code>{" "}
        workflow and includes an advanced ACPX walkthrough for client
        integration work.
      </p>
    </>
  );
});
