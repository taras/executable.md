import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";

const DOCUMENT = `<Agent name="codex">
  <Session name="review">
    <Prompt>Review the changes in this repository.</Prompt>
  </Session>
</Agent>`;

const APPROVE_ALL = `<ApproveAll>
  <Prompt prompt="Update the dependency lockfile." />
</ApproveAll>`;

const ASK_PERMISSION = `<AskPermission>
  <Prompt prompt="Apply the suggested change." />
</AskPermission>`;

export default define.page(function Agents() {
  return (
    <>
      <h1 style="font-size:2rem;font-weight:800;">Coding agents</h1>
      <p class="muted">
        Run an ACP-compatible coding agent from a markdown document. The agent
        reply becomes ordinary document output, so a review, plan, or generated
        change request can sit beside the rest of your workflow.
      </p>

      <h2>Start with one prompt</h2>
      <p>
        Save this as{" "}
        <code>review.md</code>. This example uses the ACPX agent named{" "}
        <code>codex</code>; choose an agent name that your ACPX setup can run.
      </p>
      <CodeBlock filename="review.md">{DOCUMENT}</CodeBlock>
      <p>Run it from the repository the agent should work in:</p>
      <CodeBlock>{"xmd run review.md --default-agent codex"}</CodeBlock>
      <p>
        <code>&lt;Prompt&gt;</code>{" "}
        renders the agent&apos;s text where the tag appears. If the agent writes
        a Markdown review, that Markdown is part of the rendered document. Add
        {" "}
        <code>as="reply"</code>{" "}
        to capture the reply instead of rendering it, then use{" "}
        <code>{"{reply}"}</code> later in the document.
      </p>

      <h2>The three components</h2>
      <ul>
        <li>
          <code>&lt;Agent&gt;</code> selects an agent for its body. Without a
          <code>name</code>, it uses the current default.
        </li>
        <li>
          <code>&lt;Session&gt;</code>{" "}
          selects a named, reusable conversation. Prompts in the same session
          run in order.
        </li>
        <li>
          <code>&lt;Prompt&gt;</code> sends its rendered children, or its
          <code>prompt</code> prop when self-closing, and renders the reply.
        </li>
      </ul>
      <p>
        A <code>name</code>, <code>session</code>, or <code>timeout</code>{" "}
        prop on <code>&lt;Prompt&gt;</code>{" "}
        overrides the enclosing choice for that one turn.
      </p>

      <h2>Provider and agent selection</h2>
      <p>
        <code>xmd run</code> installs the <code>acpx</code>{" "}
        provider by default. Select it explicitly with{" "}
        <code>--agent-provider acpx</code>{" "}
        when you want the command line to state that dependency. Installing a
        provider does not start an agent; the first agent use checks
        availability.
      </p>
      <p>Defaults become more specific in this order:</p>
      <ol>
        <li>The ACPX default agent.</li>
        <li>
          <code>DEFAULT_AGENT_NAME</code>.
        </li>
        <li>
          <code>--default-agent &lt;name&gt;</code>.
        </li>
        <li>
          <code>&lt;AgentProvider defaultAgent="…"&gt;</code>.
        </li>
        <li>
          <code>&lt;Agent name="…"&gt;</code> or{" "}
          <code>&lt;Prompt agent="…" /&gt;</code>.
        </li>
      </ol>
      <p>
        In other words, the environment supplies a convenient machine-wide
        default, the CLI selects a run, and explicit document choices win for
        their scope.
      </p>

      <h2>Working directory, sessions, and time limits</h2>
      <p>
        ACPX uses the document&apos;s contextual working directory when it
        starts or finds a session. In a Git repository, it reuses the nearest
        matching session from that directory toward the Git root; otherwise it
        starts a session at the exact directory. A session name distinguishes
        parallel conversations in the same project. Prompts for one resolved
        session are FIFO; different sessions can proceed concurrently.
      </p>
      <p>
        Agent prompts use the shared execution timeout: two minutes by default.
        Override it for a run with a positive number of seconds:
      </p>
      <CodeBlock>
        {"xmd run review.md --default-agent codex --timeout 90"}
      </CodeBlock>
      <p>
        The timeout also applies to process and fetch operations that use the
        same execution context. A prompt&apos;s <code>timeout</code>{" "}
        prop wins for that individual request.
      </p>
      <p>
        The provider and every session it starts belong to the run. When the
        document finishes, it cancels active turns and closes provider
        resources; the command completes only after teardown finishes.
      </p>

      <h2>Permissions</h2>
      <p>
        Permissions control how agent tool requests are answered. Choose one
        mode for <code>xmd run</code>:
      </p>
      <ul>
        <li>
          <code>--approve-reads</code>{" "}
          is the default. It approves read and search requests, then asks about
          other requests when the terminal is interactive. Without an
          interactive terminal, those other requests are denied.
        </li>
        <li>
          <code>--approve-all</code>{" "}
          selects an allow option whenever the agent offers one.
        </li>
        <li>
          <code>--deny-all</code> denies requests.
        </li>
      </ul>
      <p>
        The flags are mutually exclusive. A policy also denies when the agent
        offers no allow option, so a request always receives a concrete answer.
      </p>
      <p>
        Use the document-level components when one prompt needs a different,
        scoped policy:
      </p>
      <CodeBlock filename="review.md">{APPROVE_ALL}</CodeBlock>
      <CodeBlock filename="review.md">{ASK_PERMISSION}</CodeBlock>
      <p>
        <code>&lt;ApproveAll&gt;</code> and <code>&lt;AskPermission&gt;</code>
        apply only to their bodies. They are the document-facing form of scoped
        Agent API middleware: an undecided nested policy denies rather than
        falling through to an enclosing policy. They do not change the
        permission mode passed to the provider by the CLI. They are not eval
        blocks, so a document does not need JavaScript to apply a scoped policy.
      </p>

      <h2>When a run fails</h2>
      <ul>
        <li>
          <code>Unknown agent provider "…"</code> means the value of{" "}
          <code>--agent-provider</code> is not registered. Current{" "}
          <code>xmd run</code> registers <code>acpx</code>.
        </li>
        <li>
          <code>agent "…" is unavailable</code>{" "}
          means ACPX could not validate the selected agent. Check the selected
          name, its installation, and its ACPX configuration.
        </li>
        <li>
          A timeout means the operation exceeded the shared or prompt-specific
          limit. Check the working directory, permissions, and whether the agent
          is waiting for input before increasing it.
        </li>
        <li>
          A permission denial means the selected mode did not allow the
          requested tool. Use the least permissive mode that permits the work,
          or scope <code>&lt;ApproveAll&gt;</code> around the specific prompt.
        </li>
      </ul>

      <h2>Test the integration without a model</h2>
      <p>
        The bundled test agent drives the same ACPX path with scripted Markdown
        scenarios. It makes tests repeatable without invoking a real coding
        agent or asserting a nondeterministic response.
      </p>
      <p>
        Continue with the{" "}
        <a
          href="https://github.com/taras/executable.md/blob/main/packages/test-agent/README.md"
          rel="noopener"
        >
          deterministic test-agent guide
        </a>{" "}
        for a direct ACPX walkthrough and an <code>xmd test</code> example using
        {" "}
        <code>&lt;TestAgent&gt;</code>, <code>&lt;Agent&gt;</code>,{" "}
        <code>&lt;Session&gt;</code>, and <code>&lt;Prompt&gt;</code>.
      </p>
    </>
  );
});
