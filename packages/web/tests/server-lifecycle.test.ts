import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node/events";
import { when } from "@effectionx/converge";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { nodeResponseChannel } from "../src/response-channel.ts";
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

function heldChannel(): { seam: () => Operation<ResponseChannel>; held: HeldChannel } {
  const ends: { status: number; body: string | undefined }[] = [];
  const releases: { finish: () => void; fail: (error: Error) => void }[] = [];
  const firstEnd = withResolvers<void>();

  return {
    seam: () =>
      resource(function* (provide) {
        const settled = withResolvers<void>();
        let status = 0;
        releases.push({
          finish: () => settled.resolve(),
          fail: (error: Error) => settled.reject(error),
        });
        yield* provide({
          head(next: number): void {
            status = next;
          },
          end(body?: string): void {
            ends.push({ status, body });
            firstEnd.resolve();
          },
          finished: settled.operation,
        });
      }),
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
    const keepAlives = yield* useKeepAlives();

    yield* scoped(function* () {
      const { seam, held } = heldChannel();
      const server = yield* useFormServer(formInput(), { responseChannel: seam });
      const state = yield* watchSubmission(server);
      refusedPort = addressOf(server.url).port;

      // A keep-alive connection that must not survive teardown.
      leftover = yield* keepAlives.open(refusedPort);

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
    const keepAlives = yield* useKeepAlives();

    yield* scoped(function* () {
      try {
        yield* useFormServer(formInput(), {
          *afterListen(address) {
            recordedPort = address.port;
            keepAlive = yield* keepAlives.open(address.port);
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
    const keepAlives = yield* useKeepAlives();

    yield* scoped(function* () {
      const server = yield* useFormServer(formInput());
      port = addressOf(server.url).port;
      keepAlive = yield* keepAlives.open(port);
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
    const keepAlives = yield* useKeepAlives();

    const owner = yield* spawn(function* () {
      const server = yield* useFormServer(formInput());
      const port = addressOf(server.url).port;
      ready.resolve({ port, keepAlive: yield* keepAlives.open(port) });
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

/**
 * A loopback that hands the test the live `ServerResponse` of one request.
 *
 * The response channel's listeners are what this measures, and they can only
 * be counted on a response Node itself made.
 */
function useResponseUnderTest(): Operation<ServerResponse> {
  return resource(function* (provide) {
    const arrived = withResolvers<ServerResponse>();
    const server = createServer((incoming, outgoing) => {
      incoming.resume();
      arrived.resolve(outgoing);
    });

    const listening = withResolvers<void>();
    const onError = (error: Error): void => listening.reject(error);

    yield* ensure(() => {
      server.off("error", onError);
    });
    server.on("error", onError);

    server.listen(0, "127.0.0.1", () => listening.resolve());
    yield* listening.operation;

    yield* ensure(function* () {
      server.closeAllConnections();
      const closed = withResolvers<void>();
      const onClose = (): void => closed.resolve();

      server.on("close", onClose);
      try {
        server.close();
        yield* closed.operation;
      } finally {
        server.off("close", onClose);
      }
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the response fixture did not listen on a TCP port");
    }

    const connection = yield* useConnection(address.port);
    connection.write(requestText({ method: "GET", path: "/", host: `127.0.0.1:${address.port}` }));

    yield* provide(yield* arrived.operation);
  });
}

describe("form server: a response channel belongs to its request task", () => {
  /**
   * A request abandoned before it answered is the case `finish` never comes
   * for, so the channel cannot be relying on it to let go. The counts are read
   * on the response itself, and the one after the halt is read before the
   * event is emitted: a handler that removed itself when `finish` finally
   * arrived would leave the same count behind as one that was never there.
   */
  it("detaches from the response when the task is halted, and a later finish changes nothing", function* () {
    const res = yield* useResponseUnderTest();
    const counts = (): number[] => [res.listenerCount("finish"), res.listenerCount("close")];
    const before = counts();

    const owner = yield* spawn(function* () {
      yield* nodeResponseChannel(res);
      yield* suspend();
    });
    yield* sleep(0);

    // Anchored to what was live, not to a delta from the baseline: how many
    // handlers a runtime keeps on its own `ServerResponse`, and when it adds
    // them, is the runtime's business — Bun attaches one to `finish` that the
    // others do not. What this case owns is the pair the channel added.
    const live = counts();
    expect(live[0]).toBeGreaterThan(before[0]);
    expect(live[1]).toBeGreaterThan(before[1]);

    yield* owner.halt();

    expect(counts()).toEqual([live[0] - 1, live[1] - 1]);

    res.emit("finish");

    expect(counts()).toEqual([live[0] - 1, live[1] - 1]);
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
/**
 * Somewhere to open keep-alive connections whose error observers outlive the
 * server that destroys them.
 *
 * The reset a destroyed connection delivers must still reach a listener, and
 * it arrives *during* the server's teardown. A connection acquired inside the
 * server's own scope would have its observer removed first — destructors run
 * in reverse order of registration — and the reset would surface as an
 * uncaught error. So the holder is acquired before the server, which is what
 * puts its cleanup after the server's.
 */
function useKeepAlives(): Operation<{
  open(port: number): Operation<KeepAlive>;
  count(): number;
  listeners(socket: Socket): number;
}> {
  return resource(function* (provide) {
    const observers = new Map<Socket, () => void>();

    yield* ensure(() => {
      for (const [socket, onError] of observers) {
        socket.off("error", onError);
      }
      observers.clear();
    });

    // Declared here rather than inside `open` below, so the subscription and
    // the teardown that walks it belong to the same owner: a nested generator
    // is a scope of its own, and it ends long before this resource does.
    const observe = (socket: Socket): void => {
      const onError = (): void => {};

      socket.on("error", onError);
      observers.set(socket, onError);
    };

    yield* provide({
      *open(port: number): Operation<KeepAlive> {
        const socket = connect(port, "127.0.0.1");

        observe(socket);
        // Flowing rather than paused, so the connection behaves like a real
        // client's and never holds unread bytes against teardown.
        socket.resume();

        // Interpreted in the same synchronous run as `connect`, so the event
        // cannot land before the wait is attached.
        yield* once(socket, "connect");

        return { socket, establishedWith: socket.remoteAddress };
      },
      count: () => observers.size,
      listeners: (socket: Socket) => socket.listenerCount("error"),
    });
  });
}

/** What a raw client's own socket is carrying. */
function clientCounts(socket: Socket): number[] {
  return [
    socket.listenerCount("data"),
    socket.listenerCount("error"),
    socket.listenerCount("close"),
  ];
}

describe("form server: accepted sockets and raw clients", () => {
  /**
   * One close handler per accepted socket, and a raw client's own three, both
   * cancelled while they are live. Each count is measured against what the
   * runtime was already holding, read once while the owner runs, again after
   * it is torn down and before the events are replayed, and once more
   * afterwards — together with what the client had received, so a late chunk
   * reaching a still-accumulating buffer would show.
   */
  it("releases the accepted socket's close handler and the client's own on cancellation", function* () {
    const accepted: { socket: Socket; before: number }[] = [];
    let client: Socket | undefined;
    let clientBefore: number[] = [];
    let acceptedLive = 0;
    let clientLive: number[] = [];
    let received: () => string = () => "";
    let callbacks: () => number = () => 0;

    const owner = yield* spawn(function* () {
      const server = yield* useFormServer(formInput(), {
        observeSocket: (socket) => accepted.push({ socket, before: socket.listenerCount("close") }),
      });
      const { port } = addressOf(server.url);
      const connection = yield* useConnection(port, (socket) => {
        client = socket;
        clientBefore = clientCounts(socket);
      });

      received = () => connection.receivedSoFar();
      callbacks = () => connection.callbacks();
      connection.write(requestText({ method: "GET", path: "/", host: `127.0.0.1:${port}` }));
      yield* connection.response();

      acceptedLive = accepted[0]?.socket.listenerCount("close") ?? 0;
      clientLive = client ? clientCounts(client) : [];
      yield* suspend();
    });

    // Synchronized on the exchange having happened, so both owners are live
    // with everything attached when the halt lands.
    yield* when(function* () {
      expect(clientLive.length).toBeGreaterThan(0);
    });

    const first = accepted[0];
    if (!first || !client) {
      throw new Error("no connection was accepted");
    }

    // At least what each owner attached, not exactly it: how many handlers a
    // runtime keeps on its own sockets, and when it adds them, is the
    // runtime's business — Bun on Linux holds one the others do not. What
    // these cases own is the pair each added, so the release below is measured
    // against what was live rather than against the baseline.
    expect(acceptedLive).toBeGreaterThanOrEqual(first.before + 1);
    clientLive.forEach((count, index) => {
      expect(count).toBeGreaterThanOrEqual(clientBefore[index] + 1);
    });

    // Empty, because the exchange above consumed it — which is what makes the
    // replayed chunk below visible if anything is still appending. The
    // callback count is not: the exchange ran the client's handlers, and a
    // replayed event reaching one would move it again.
    const seen = received();
    const ran = callbacks();

    expect(ran).toBeGreaterThan(0);

    yield* owner.halt();

    const released = clientLive.map((count) => count - 1);

    expect(first.socket.listenerCount("close")).toBe(acceptedLive - 1);
    expect(clientCounts(client)).toEqual(released);

    first.socket.emit("close");
    client.emit("data", Buffer.from("after the client was cancelled"));
    client.emit("close");

    expect(first.socket.listenerCount("close")).toBe(acceptedLive - 1);
    expect(clientCounts(client)).toEqual(released);
    expect(received()).toBe(seen);
    expect(callbacks()).toBe(ran);
  });
});
