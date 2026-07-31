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

import { withResolvers } from "effection";
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
 * Wrap a Node response.
 *
 * The listeners are armed here, when the channel is built, rather than when
 * `finished` is first awaited. `finish` can fire between `end()` and the
 * `yield*` that observes it, and a listener attached after the fact would wait
 * for an event that already happened. Arming once, before anything is written,
 * removes that window without depending on `writableFinished` being reported the
 * same way by every runtime.
 */
export function nodeResponseChannel(res: ServerResponse): ResponseChannel {
  const settled = withResolvers<void>();

  const onFinish = (): void => {
    res.removeListener("close", onClose);
    settled.resolve();
  };
  const onClose = (): void => {
    res.removeListener("finish", onFinish);
    settled.reject(new ResponseClosedError());
  };

  res.once("finish", onFinish);
  res.once("close", onClose);

  return {
    head(status: number, headers: Record<string, string>): void {
      res.writeHead(status, headers);
    },
    end(body?: string): void {
      res.end(body);
    },
    finished: settled.operation,
  };
}
