# Upstream delta: `@effectionx/worker` 0.5.4

The proof uses `@effectionx/worker` 0.5.4 for its Effection-owned Worker
lifecycle and bidirectional request/response channel. The published cleanup
sends `{ type: "close" }` and waits for the Worker to answer. A CPU-bound
interpreter cannot process that message, so cleanup never returns and the host
cannot reach mutation rollback or failed-result publication.

`patch-worker.ts` checks the exact package version and source text, then adds
this spike-only delta to `dist/worker.js` immediately after the close message:

```js
worker.terminate();
if (!outcomeSettled) {
  rejectOutcome(new Error("worker terminated"));
}
```

The package's protocol, channel implementation, Worker entrypoint and public
types are unchanged. Normal completion has already settled the outcome;
timeout, cancellation and explicit termination settle the internal outcome and
allow resource teardown to finish after the Deno Worker is preempted.

Production #218 must not patch installed dependencies. It must consume an
upstream `@effectionx/worker` termination contract or own an equivalent
reviewed adapter that force-terminates before the effect transaction rolls back.
