# Accept a message for the live Sidekick

Read this when integrating explicit UI or delivered ACP messages with the running
REPL. This CLI-private service belongs to the command that acquired it.

Purpose: accept bounded waiting work and produce one complete, joined Sidekick
exchange at a time, through the existing `owner.message` engine.

Optimized for: sending another instruction while the current exchange still owns
provider generation, response controls, feedback or cleanup.

Friction removed:

- Callers do not implement FIFO, active reservations or saved-at-start timing.
- Attachment cancellation and UI Stop share an exact exchange handle without
  sharing a human queue hold.
- The root reads detached pending facts and projects text/origin/key to the view.
  Presentation receives no exchange handle.

Friction retained:

- The root applies accepted Message revisions and saved Draft acknowledgements on
  its own input loop. Two acknowledgements protect two independent editors.
- UI Stop captures current and calls synchronous hold before spawning cancel.
  Attachment cancel calls only its captured exchange's cancel operation.
- Consumers still own their observation scopes and explicit external gates.
  Pending acceptance establishes no saved reference or provider acceptance.
- Ordinary failures hold until guarded Resume. Fatal owner failures end the
  command; unknown feedback is never cleared by Resume.

## Actual consumers

`program.ts` accepts the captured UI instruction, reports acceptance to its one UI
writer and observes completion independently:

```ts
const admitted = yield* chat.dispatch.send(intent.text, intent.held);
if (!admitted.ok) {
  return { refusal: admitted.error.message };
}
chat.accepted(intent.held);
yield* spawn(function* (): Operation<void> {
  const sent = yield* admitted.value.completion;
  if (!sent.ok) {
    chat.refuse(sent.error.message);
  }
  wakes.send({ kind: "session" });
});
```

The mounted scenario in `repl-sidekick-dispatch.test.ts`, “accepts busy UI Send”,
uses terminal input to send twice while a deterministic provider turn is held.
It observes the queue row, exact composer clearing, one saved message while
waiting, and the successor's saved result with newer composer text intact.

`sidekick-acp/server.ts` retains an attachment's returned handle. Cancel and close
capture it before suspension:

```ts
const exact = held.exchange;
if (exact !== undefined && exact.snapshot.terminal === undefined) {
  cancelled.add(exact);
  yield* exact.cancel();
}
```

The socket scenario in `repl-sidekick-acp.test.ts`, “A5: cancellation joins control
cleanup”, places a UI successor behind the attachment exchange before cancelling.
It proves joined cleanup, automatic successor start without a hold, and inert
stale attachment/handle cancellation. The transport's one-outstanding-exchange
restriction remains independent of shared queue capacity.

## Maintenance

Keep `send`, `current`, `queue`, `hold`, `resume`, `follow` and exact exchange
observation private to this live command. `send` executes lazily, captures text,
origin and Instruction once, and accepts at most sixteen waiting messages plus
active work, each at most 65536 UTF-8 bytes. Limits refuse before acceptance.

The active reservation carries only its own Instruction. Waiting work takes no
history writer and has no MessageRecord until it starts. Queue rows and keys are
live-only; teardown settles pending cancellation and cold inspection starts none.
A first setup establishes this owner's association; pending messages never move
to a replacement. Admission excludes replacement while messages wait.

Ordinary product edits to labels, fitted rows and navigation belong in the root
and presentation consumers. Execution policy, guard checks, cancellation and
queue settlement belong in `dispatch.ts`. Editor revision policy belongs in
`gate.ts`. No queue persistence or ACP schema is introduced. New helpers add the
two distinct editor acknowledgements; they do not replace the existing owner,
history writer or test harness.
