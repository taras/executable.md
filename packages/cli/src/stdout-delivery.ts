/**
 * Handing one rendered result to a stream, and waiting for the stream to take
 * all of it.
 *
 * A stream is asynchronous when it is a pipe and synchronous when it is a file
 * or a terminal. A large text handed to `write` is therefore still sitting in a
 * buffer when a run ends, and the process exits without it: `xmd syntax --json
 * > file` is whole, `xmd syntax --json | jq` stops at about 64 KiB, in the
 * middle of a token. Waiting for the write callback is what makes the write
 * finish before anything can exit.
 */

import { Err, Ok, resource, scoped, withResolvers } from "effection";
import type { Operation, Result } from "effection";

/**
 * What delivery asks of a stream.
 *
 * Narrower than a writable stream so a suite can supply the arrival orders a
 * real pipe produces on one runtime and not another, and can watch the
 * listener come and go.
 */
export interface DeliverySink {
  write(text: string, callback: (error?: Error | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  /** The error the stream was destroyed with and has not emitted yet. */
  readonly errored?: Error | null;
}

/**
 * The sink's `error` events, observed for exactly as long as the enclosing
 * scope lives.
 *
 * The listener's lifetime is the scope's and nothing else's: it is not removed
 * by the event firing, and it does not survive the scope whether the event
 * fired, never fired, or the scope was halted first. A stream is a
 * process-global object, so a listener bound to anything looser would
 * accumulate across deliveries and absorb a later, unrelated failure.
 */
function useErrorObserver(sink: DeliverySink, observe: (error: Error) => void): Operation<void> {
  return resource(function* (provide) {
    sink.on("error", observe);
    try {
      yield* provide();
    } finally {
      sink.off("error", observe);
    }
  });
}

/**
 * Deliver `text`, and report whether the stream took all of it.
 *
 * A broken pipe can arrive twice: at the write callback, and again as an
 * `error` event. An `error` event nobody is listening for ends the process with
 * a stack trace, which is why this listens — and the first arrival is the
 * verdict, whichever it was, so the duplicate is absorbed rather than reported
 * a second time.
 *
 * **The listener lives for one delivery and no longer.** It survives a first
 * failed arrival only until the paired one lands, and `errored` is what says
 * whether one is still owed: Node and Deno destroy the stream with the very
 * error they are about to emit, so finding this delivery's own failure there
 * means the event is still coming, while Bun reports the failure once and holds
 * nothing. Every other path — success, cancellation, a `write` that refuses
 * outright — ends the scope, and the observer with it, without waiting at all.
 *
 * The outcome is bridged with `withResolvers()` rather than `action()`: a file
 * or a terminal calls the write callback synchronously, inside `write`, and an
 * `action()` resolved before its executor has returned never runs the cleanup
 * that executor returns (effection 4.1.0).
 */
export function deliverWhole(text: string, sink: DeliverySink): Operation<Result<void>> {
  return scoped(function* () {
    const outcome = withResolvers<Result<void>>("deliverWhole");
    let calledBack = false;
    let observed = false;
    let failure: Error | undefined;

    const settle = () => {
      if (!calledBack) {
        return;
      }
      // Identity, not presence: an error the stream was already holding before
      // this delivery has been emitted already, and waiting for it would wait
      // forever.
      if (!observed && failure !== undefined && sink.errored === failure) {
        return;
      }
      outcome.resolve(failure === undefined ? Ok() : Err(failure));
    };

    const record = (error?: Error | null) => {
      if (error && failure === undefined) {
        failure = error;
      }
    };

    yield* useErrorObserver(sink, (error) => {
      observed = true;
      record(error);
      settle();
    });

    try {
      sink.write(text, (error) => {
        calledBack = true;
        record(error);
        settle();
      });
    } catch (error) {
      // A stream that refuses the call outright never calls back, so nothing
      // else would settle this.
      return Err(error instanceof Error ? error : new Error(String(error)));
    }

    return yield* outcome.operation;
  });
}
