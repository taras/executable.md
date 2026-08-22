import { define } from "../../utils.ts";
import { CodeBlock } from "../../components/Code.tsx";
import { NextCard } from "../../components/NextCard.tsx";

const OBSERVE = `import { execute } from "@executablemd/core";
import { guardDurableStream, serializeDurableEvent } from "@executablemd/durable-streams";

const stream = guardDurableStream(backend, function* (event) {
  console.error(serializeDurableEvent(event).trimEnd());
});

const execution = yield* execute({ path: "./README.md", stream });`;

const REJECT = `const stream = guardDurableStream(backend, function* (event) {
  if (yield* containsCredential(event)) {
    throw new Error("refusing to journal a credential");
  }
});`;

export default define.page(function Journal() {
  return (
    <>
      <h1>Journal gates</h1>
      <p class="muted">
        A gate is a check that runs before a durable event reaches its
        persistence backend. Wrap the stream you already pass to{" "}
        <code>execute</code>, and every live event — the root component import,
        each block's yield, each close — passes through it first.
      </p>

      <h2>Observing the journal</h2>
      <p>
        The gate receives the structured event.{" "}
        <code>serializeDurableEvent</code>{" "}
        renders it exactly as file persistence writes it, so what you inspect is
        what would land on disk.
      </p>
      <CodeBlock>{OBSERVE}</CodeBlock>

      <h2>Failing closed</h2>
      <p>
        A gate that raises stops the append. The event never reaches the
        backend, and the failure travels back to the durable effect that
        produced it — the block does not resume with a result that was never
        journaled.
      </p>
      <CodeBlock>{REJECT}</CodeBlock>
      <p class="muted">
        <code>containsCredential</code>{" "}
        stands in for whatever policy you bring. Deciding what counts as a
        secret is your call, not this library's.
      </p>

      <h2>What a gate cannot do</h2>
      <p>
        A gate returns nothing, and the event it receives is a copy — writing to
        that copy changes nothing about what gets journaled. It cannot rewrite,
        redact, or replace an event, and the backend append is not a
        continuation it holds, so it cannot cause one durable yield to be
        journaled twice.
      </p>

      <h2>Rejection is per event</h2>
      <p>
        Refusing one event does not empty the journal. Events already accepted
        stay, and the failure a rejection causes may itself produce a closing
        event that crosses the gate on its own and is admitted. When you assert
        on a rejection, assert that the offending event is absent — not that
        nothing was written.
      </p>

      <h2>Install before execution</h2>
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
