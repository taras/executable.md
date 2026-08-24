import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";
import { NextCard } from "../../components/NextCard.tsx";

const DEFAULT = `import { execute } from "@executablemd/core";

const execution = yield* execute({ path: "./README.md", stream: backend });`;

const DISABLE = `const execution = yield* execute({
  path: "./README.md",
  stream: backend,
  secretDetection: false,
});`;

const CLI = `$ xmd run workflow.md --no-secret-detection
WARNING: secret detection is disabled; credentials may be persisted.`;

const OBSERVE = `import { execute } from "@executablemd/core";
import { guardDurableStream, serializeDurableEvent } from "@executablemd/durable-streams";

const stream = guardDurableStream(backend, function* (event) {
  console.error(serializeDurableEvent(event).trimEnd());
});

const execution = yield* execute({ path: "./README.md", stream });`;

const REJECT = `const stream = guardDurableStream(backend, function* (event) {
  if (serializeDurableEvent(event).length > 64_000) {
    throw new Error("refusing to journal an oversized event");
  }
});`;

export default define.page(function Journal() {
  return (
    <>
      <h1>Journal gates</h1>
      <p class="muted">
        A gate is a check that runs before a durable event reaches its
        persistence backend. XMD installs one for you: every execution refuses
        to persist an event that carries a credential.
      </p>

      <h2>Secret detection is on by default</h2>
      <p>
        There is nothing to install and no service to reach — the scan is local.
        {" "}
        <code>execute</code>{" "}
        selects its journal before the durable run starts, so the root component
        import is already covered, and the same policy holds for every later
        yield and close.
      </p>
      <CodeBlock>{DEFAULT}</CodeBlock>

      <h2>What a finding does</h2>
      <p>
        A finding rejects that one append before the backend is invoked, and the
        failure reaches the durable effect that produced the event. What happens
        next is ordinary error handling: a <code>&lt;PrintErrors&gt;</code>{" "}
        region prints the rejection where it stands and the run continues, while
        an effect at a plain root — and a rejection during the root import —
        fails the run.
      </p>
      <p>
        Either way the offending event is absent, and the closing event the
        failure produces is a separate append that crosses the policy on its
        own. A rejection never means an empty journal, so assert that the
        offending event is missing rather than that nothing was written.
      </p>
      <p>
        There is no allowlist, sanitization, repair, or approval step. A finding
        is a defect in the code or the data flowing through it, and fixing that
        is the response.
      </p>

      <h2>Output is held to the same policy</h2>
      <p>
        A live output chunk the execution's scanner cannot clear — a finding, or
        a scan that fails — is withheld from the output stream in full. Chunks
        already cleared stay observable and become the stream's partial close
        value. Withholding decides nothing about the run: the journal gate
        remains the rejection authority, and the rejected event stays absent
        either way.
      </p>

      <h2>What a finding reports</h2>
      <p>
        Findings and scanner failures carry the rule identity and the position
        that matched — never the matched value, the scanned content, or the
        detector's own error. A diagnostic you can paste into an issue is the
        point.
      </p>

      <h2>Replay does not rescan</h2>
      <p>
        A replayed execution restores its retained output and history without
        scanning them again. The journal it replays already crossed the gate
        when it was written.
      </p>

      <h2>Turning it off</h2>
      <p>
        A host can disable the policy with{" "}
        <code>secretDetection: false</code>. This is a dangerous diagnostic
        escape hatch, not a remediation: with it off, a credential in a document
        or in a command's output is written to the journal and stays there.
      </p>
      <CodeBlock>{DISABLE}</CodeBlock>
      <p>
        At the command line the only spelling is{" "}
        <code>--no-secret-detection</code>. It is a switch, it applies to the
        whole invocation rather than to one document, and a disabled invocation
        says so once on standard error before the first document runs.
      </p>
      <CodeBlock command>{CLI}</CodeBlock>
      <p class="muted">
        The request belongs to the host alone. Root props, frontmatter,
        component props and eval bindings named <code>secretDetection</code>
        {" "}
        mean nothing to it — a document has no way to reach the value the host
        passed, or to turn the policy off.
      </p>

      <h2>Adding a gate of your own</h2>
      <p>
        <code>guardDurableStream</code> wraps the stream you pass to{" "}
        <code>execute</code>{" "}
        so every live event passes your check first. The decorator is generic:
        it knows nothing about credentials and runs whatever gate it is given.
        XMD's credential policy is one such gate, installed for you; yours runs
        beside it.
      </p>

      <h3>Observing the journal</h3>
      <p>
        The gate receives the structured event.{" "}
        <code>serializeDurableEvent</code>{" "}
        renders it exactly as file persistence writes it, so what you inspect is
        what would land on disk.
      </p>
      <CodeBlock>{OBSERVE}</CodeBlock>

      <h3>Failing closed</h3>
      <p>
        A gate that raises stops the append. The event never reaches the
        backend, and the failure travels back to the durable effect that
        produced it — the block does not resume with a result that was never
        journaled. Rejection is per event here too: events already accepted
        stay, and the closing event a rejection causes crosses the gate on its
        own.
      </p>
      <CodeBlock>{REJECT}</CodeBlock>

      <h3>What a gate cannot do</h3>
      <p>
        A gate returns nothing, and the event it receives is a copy — writing to
        that copy changes nothing about what gets journaled. It cannot rewrite,
        redact, or replace an event, and the backend append is not a
        continuation it holds, so it cannot cause one durable yield to be
        journaled twice.
      </p>

      <h3>Install before execution</h3>
      <p>
        Wrap the stream before calling{" "}
        <code>execute</code>. A gate added later cannot see what was already
        persisted, and replay never re-runs it: restoring a journal reads
        through <code>readAll()</code>, which delegates straight to the backend.
      </p>

      <NextCard href="/docs/reference" label="Reference" />
    </>
  );
});
