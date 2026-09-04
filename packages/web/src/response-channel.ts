/**
 * The part of an HTTP response this server drives, behind one small interface.
 *
 * The server resolves a submission only after the 204 confirming it has actually
 * been sent — otherwise teardown can destroy the connection before the browser
 * learns its answer was accepted. That ordering is invisible from outside the
 * process: an empty 204 finishes the instant its header flushes, so no test can
 * withhold the event, and a test that submits and then tears down stays green
 * even against an implementation that never waited, because the kernel has
 * usually delivered the bytes anyway.
 *
 * Naming the lifecycle is what makes it testable. Production wraps
 * `http.ServerResponse`; a test substitutes a channel that releases `finished`
 * when it chooses.
 */

import { ensure, resource, withResolvers } from "effection";
import type { Operation } from "effection";
import type { ServerResponse } from "node:http";

export interface ResponseChannel {
  head(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
  /**
   * Resolves on `finish`, and only on `finish`.
   *
   * A `close` arriving first means the connection died with the response
   * incomplete, so it rejects. Treating that as success is the precise mistake
   * this interface exists to prevent: it would confirm a submission the browser
   * never received.
   */
  finished: Operation<void>;
}

/** A response whose connection died before it was fully sent. */
export class ResponseClosedError extends Error {
  override name = "ResponseClosedError";
  constructor() {
    super("the connection closed before the response finished sending");
  }
}

/**
 * Wrap a Node response, for as long as the request task that acquires it runs.
 *
 * The listeners are armed on acquisition, before anything is written, rather
 * than when `finished` is first awaited. `finish` can fire between `end()` and
 * the `yield*` that observes it, and a listener attached after the fact would
 * wait for an event that already happened. Arming once removes that window
 * without depending on `writableFinished` being reported the same way by every
 * runtime.
 *
 * Both handlers come off when the task ends, however it ends. The first
 * settlement is the answer — a `close` after a `finish` changes nothing — so
 * the two no longer need to remove each other, and a request abandoned before
 * either event leaves nothing attached to a response the server is about to
 * destroy.
 */
export function nodeResponseChannel(res: ServerResponse): Operation<ResponseChannel> {
  return resource(function* (provide) {
    const settled = withResolvers<void>();

    const onFinish = (): void => settled.resolve();
    const onClose = (): void => settled.reject(new ResponseClosedError());

    // A lexical finalizer rather than `ensure()`: entering the `try` is
    // synchronous, so there is no instant at which this response is observed
    // and the release is not yet armed.
    try {
      res.on("finish", onFinish);
      res.on("close", onClose);

      yield* provide({
        head(status: number, headers: Record<string, string>): void {
          res.writeHead(status, headers);
        },
        end(body?: string): void {
          res.end(body);
        },
        finished: settled.operation,
      });
    } finally {
      res.off("finish", onFinish);
      res.off("close", onClose);
    }
  });
}
