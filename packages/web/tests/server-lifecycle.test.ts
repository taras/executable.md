import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { connect } from "node:net";
import type { Socket } from "node:net";

import type { ResponseChannel } from "../src/response-channel.ts";
import { useFormServer } from "../src/server.ts";
import type { FormServer } from "../src/server.ts";
import { addressOf, formInput, portRefuses, watchSubmission } from "./server-support.ts";
import { requestText, useConnection } from "./http-client.ts";

/** A channel whose completion the test releases, so ordering is observable. */
interface HeldChannel {
  ends: () => { status: number; body: string | undefined }[];
  /** Fires when a response has been handed over but not yet completed. */
  ended: Operation<void>;
  finish: () => void;
  closeWithoutFinish: () => void;
}

function heldChannel(): { seam: () => ResponseChannel; held: HeldChannel } {
  const ends: { status: number; body: string | undefined }[] = [];
  const releases: { finish: () => void; fail: (error: Error) => void }[] = [];
  const firstEnd = withResolvers<void>();

  return {
    seam: () => {
      const settled = withResolvers<void>();
      let status = 0;
      releases.push({
        finish: () => settled.resolve(),
        fail: (error: Error) => settled.reject(error),
      });
      return {
        head(next: number): void {
          status = next;
        },
        end(body?: string): void {
          ends.push({ status, body });
          firstEnd.resolve();
        },
        finished: settled.operation,
      };
    },
    held: {
      ends: () => ends,
      ended: firstEnd.operation,
      finish: () => releases.at(-1)?.finish(),
      closeWithoutFinish: () =>
        releases.at(-1)?.fail(new Error("the connection closed before the response finished")),
    },
  };
}

/**
 * Send a valid submission and keep its connection open.
 *
 * The connection has to outlive the call: closing it straight after writing
 * would race the server reading the body, and with a held channel there is no
 * response to wait for. The caller's scope owns it, so it closes with the test.
 */
function* submitValid(server: FormServer): Operation<void> {
  const { port, origin, prefix } = addressOf(server.url);
  const connection = yield* useConnection(port);
  connection.write(
    requestText({
      method: "POST",
      path: `${prefix}submit`,
      host: `127.0.0.1:${port}`,
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    }),
  );
}

describe("form server: the submission resolves only after its response is sent", () => {
  /**
   * The ordering this proves is invisible from outside the process: an empty 204
   * finishes the moment its header flushes, so a test that submits and then tears
   * the server down passes even against an implementation that never waited. The
   * channel is what makes the two events separable.
   */
  it("stays pending until the response finishes, then resolves", function* () {
    const { seam, held } = heldChannel();
    const server = yield* useFormServer(formInput(), { responseChannel: seam });
    const state = yield* watchSubmission(server);

    yield* submitValid(server);
    yield* held.ended;

    // The 204 has been handed to the channel and not yet completed.
    expect(held.ends().at(-1)).toEqual({ status: 204, body: undefined });
    expect(state().kind).toBe("pending");

    held.finish();
    expect(yield* server.submission).toEqual({ decision: "approve" });
  });

  /**
   * A close before finish means the connection died with the response
   * incomplete — the browser was never told it succeeded. Treating that as
   * completion would confirm a submission nobody received, so it fails instead.
   */
  it("fails rather than resolving when the response closes before finishing", function* () {
    let refusedPort = 0;
    let leftover: KeepAlive | undefined;

    yield* scoped(function* () {
      const { seam, held } = heldChannel();
      const server = yield* useFormServer(formInput(), { responseChannel: seam });
      const state = yield* watchSubmission(server);
      refusedPort = addressOf(server.url).port;

      // A keep-alive connection that must not survive teardown.
      leftover = yield* openKeepAlive(refusedPort);

      yield* submitValid(server);
      yield* held.ended;
      expect(state().kind).toBe("pending");

      held.closeWithoutFinish();
      expect(yield* failureOf(server)).toContain("closed before the response finished");
    });

    // Reaching here is itself the proof that the keep-alive connection was
    // destroyed: teardown awaits the listener's `close`, which a listener emits
    // only once every established connection has ended.
    if (!leftover) {
      throw new Error("the keep-alive connection was never opened");
    }
    expect(leftover.establishedWith).toBe("127.0.0.1");
    expect(yield* portRefuses(refusedPort)).toBe(true);
  });
});

describe("form server: failure reaches the caller", () => {
  /**
   * A failure after the listener is up but before the resource is provided. The
   * seam receives the live address, so the test can reach the server — and leave
   * a connection open on it — before breaking it.
   */
  it("fails acquisition and still closes the port and its sockets", function* () {
    let recordedPort = 0;
    let keepAlive: KeepAlive | undefined;
    let acquired = false;

    yield* scoped(function* () {
      try {
        yield* useFormServer(formInput(), {
          *afterListen(address) {
            recordedPort = address.port;
            keepAlive = yield* openKeepAlive(address.port);
            throw new Error("setup failed after the listener came up");
          },
        });
        acquired = true;
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        expect(error.message).toContain("setup failed");
      }
    });

    expect(acquired).toBe(false);
    expect(recordedPort).toBeGreaterThan(0);
    if (!keepAlive) {
      throw new Error("the keep-alive connection was never opened");
    }
    // The connection really was established before the failure, so teardown had
    // something to destroy.
    expect(keepAlive.establishedWith).toBe("127.0.0.1");
    expect(yield* portRefuses(recordedPort)).toBe(true);
  });

  /**
   * A request task that dies is the server failing, not one request failing.
   * Nothing else observes that task, so without routing it to the caller the
   * submission would simply never settle.
   */
  it("rejects the submission when a request task fails, rather than hanging", function* () {
    let recordedPort = 0;

    yield* scoped(function* () {
      const server = yield* useFormServer(formInput(), {
        // deno-lint-ignore require-yield
        *beforeDispatch() {
          throw new Error("the request handler failed");
        },
      });
      recordedPort = addressOf(server.url).port;
      const state = yield* watchSubmission(server);

      yield* submitValid(server);
      expect(yield* failureOf(server)).toContain("the request handler failed");
    });

    expect(yield* portRefuses(recordedPort)).toBe(true);
  });
});

describe("form server: teardown", () => {
  it("closes the port and its connections after a successful submission", function* () {
    let port = 0;
    let keepAlive: KeepAlive | undefined;

    yield* scoped(function* () {
      const server = yield* useFormServer(formInput());
      port = addressOf(server.url).port;
      keepAlive = yield* openKeepAlive(port);
      yield* submitValid(server);
      yield* server.submission;
    });

    expect(keepAlive?.establishedWith).toBe("127.0.0.1");
    expect(yield* portRefuses(port)).toBe(true);
  });

  /**
   * Cancellation, not completion.
   *
   * Returning from a `scoped()` block exercises the ordinary path — the body
   * finished and the scope unwound because there was nothing left to do. A form
   * server is normally torn down the other way: the workflow around it is halted
   * while the form is still open and a browser is still connected. Those reach
   * teardown differently, and only the second proves that a halt mid-wait
   * releases the listener.
   *
   * The halt is observed with `yield* task.halt()`, so the assertions run after
   * teardown has actually finished rather than after it was merely requested.
   */
  it("releases the listener when the owning task is halted mid-wait", function* () {
    const ready = withResolvers<{ port: number; keepAlive: KeepAlive }>();

    const owner = yield* spawn(function* () {
      const server = yield* useFormServer(formInput());
      const port = addressOf(server.url).port;
      ready.resolve({ port, keepAlive: yield* openKeepAlive(port) });
      // Still waiting for a submission that never comes when the halt lands.
      yield* server.submission;
    });

    // Synchronized on the listener being live and a connection established.
    const { port, keepAlive } = yield* ready.operation;
    expect(keepAlive.establishedWith).toBe("127.0.0.1");
    expect(yield* portRefuses(port)).toBe(false);

    // `halt()` is observed, and observing it is what makes the assertions below
    // meaningful: it returns once the task and everything it owned have finished
    // tearing down, so no second signal is needed to know cleanup ran.
    yield* owner.halt();

    expect(yield* portRefuses(port)).toBe(true);
  });
});

/** The message `submission` fails with; throws if it succeeds instead. */
function* failureOf(server: FormServer): Operation<string> {
  try {
    yield* server.submission;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the submission to fail");
}

export interface KeepAlive {
  socket: Socket;
  /**
   * The peer address, captured while the socket was connected. Node clears it
   * on destroy, so reading it after teardown would answer `undefined` — which
   * is exactly when a test wants to say the connection had been established.
   */
  establishedWith: string | undefined;
}

/**
 * A connection the server has accepted and is holding open across teardown.
 *
 * Nothing here observes the connection closing, and that is deliberate. Two
 * client-side signals looked like the obvious assertion and neither is portable:
 * `socket.destroyed` flips only once this end has processed the peer's close, so
 * reading it straight after teardown passes on Deno and fails on Node; waiting
 * for the `close` event never fires at all for a paused socket under Bun on
 * Linux, which turns the test into a five-minute timeout.
 *
 * Neither is needed. Teardown awaits the listener's `close`, and a listener emits
 * that only once every established connection has ended — so a keep-alive socket
 * the server failed to destroy would hang teardown outright. The test returning
 * is the evidence, and `portRefuses` confirms the port went with it.
 */
function* openKeepAlive(port: number): Operation<KeepAlive> {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  // Flowing rather than paused, so the connection behaves like a real client's
  // and never holds unread bytes against teardown.
  socket.resume();

  const opened = withResolvers<void>();
  socket.once("connect", () => opened.resolve());
  yield* opened.operation;

  return { socket, establishedWith: socket.remoteAddress };
}
