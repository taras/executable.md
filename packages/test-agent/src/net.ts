/**
 * The Node↔Effection boundary for line-framed TCP (specs/test-agent-spec.md
 * §Controller and worker). A server that owns its listener and dispatches
 * connections, a socket whose inbound lines are an Effection stream, and a
 * client that shares the same socket adapter — so callers work with
 * operations and streams, never raw `.on`/`.once`/Promise plumbing.
 */

import { createChannel, each, ensure, race, resource, spawn, withResolvers } from "effection";
import type { Operation, Stream, Task } from "effection";
import { fromReadable, on } from "@effectionx/node";
import { once } from "@effectionx/node/events";
import { lines } from "@effectionx/stream-helpers";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

export interface LineSocket {
  /** Inbound newline-framed lines; closes when the socket ends. */
  lines: Stream<string, unknown>;
  /** Write one already-framed line. */
  send(line: string): void;
  /** Graceful half-close: flush pending writes, then send FIN. */
  end(): void;
  /**
   * Resolves when the socket closes — EOF, error, or teardown. Consumers
   * race their line loop against this: `fromReadable` closes the line
   * stream on `end` but not on an abrupt reset, so without it an
   * `each(lines)` loop would block forever on a peer that vanishes.
   */
  closed: Operation<void>;
}

/** Adapt a connected socket: inbound bytes become a line stream; the socket
 * is destroyed on teardown. */
export function useLineSocket(socket: Socket): Operation<LineSocket> {
  return resource(function* (provide) {
    const closed = withResolvers<void>();
    const onClose = (): void => closed.resolve();

    // A lexical finalizer rather than `ensure()`: entering the `try` is
    // synchronous, so there is no instant at which this socket is observed and
    // the release is not yet armed. Detached first, because the destroy below
    // emits the event this was observing.
    try {
      socket.on("close", onClose);
      yield* provide({
        lines: lines()(fromReadable(socket)),
        send(line) {
          socket.write(line);
        },
        end() {
          socket.end();
        },
        closed: closed.operation,
      });
    } finally {
      socket.off("close", onClose);
      socket.destroy();
      closed.resolve(); // settle on cancellation even if no 'close' follows
    }
  });
}

export interface LineServer {
  port: number;
}

/**
 * A localhost line-protocol server as a resource. It listens, then accepts
 * each connection, adapts it with {@link useLineSocket}, and runs
 * `onConnection` for it in its own task — so a caller never spawns or
 * touches a raw socket. The per-connection task is what lets simultaneous
 * connections run concurrently (`each` itself is sequential).
 */
export function useLineServer(
  host: string,
  onConnection: (connection: LineSocket) => Operation<void>,
): Operation<LineServer> {
  return resource(function* (provide) {
    const server = createServer();
    let acceptor: Task<void> | undefined;

    // Installed before listen so a setup failure is torn down too. The
    // acceptor's spawned per-connection handlers are its children, so halting
    // it awaits their full teardown — each socket destroyed by useLineSocket's
    // ensure — and nothing holds the listener open when we close it.
    yield* ensure(function* () {
      if (acceptor) {
        yield* acceptor.halt();
      }
      // Attach the close listener before close() (no missed-event race), and
      // only when the server actually came up, so a never-started or
      // already-closed server leaves no pending operation. It stays attached
      // through the wait — it is what the wait is for — and comes off
      // synchronously afterwards, whether that wait settled or was halted.
      if (server.listening) {
        const closed = withResolvers<void>();
        const onClose = (): void => closed.resolve();

        server.on("close", onClose);
        try {
          server.close();
          yield* closed.operation;
        } finally {
          server.off("close", onClose);
        }
      }
    });

    // Raced inline, in the same synchronous run as `listen`, so both arms are
    // attached before either event can be delivered — `listen` never emits in
    // the turn it was called in, and a spawned race would attach a turn late.
    // The loser is halted, which is what detaches it.
    server.listen(0, host);
    yield* race([
      once(server, "listening"),
      (function* (): Operation<never> {
        const [error] = yield* once(server, "error");
        throw error instanceof Error ? error : new Error(String(error));
      })(),
    ]);

    const address = server.address();
    if (!address || typeof address !== "object") {
      throw new Error("useLineServer: unexpected server address");
    }
    const port = address.port;

    acceptor = yield* spawn(function* () {
      for (const [socket] of yield* each(on<[Socket]>(server, "connection"))) {
        yield* spawn(function* () {
          const connection = yield* useLineSocket(socket);
          yield* onConnection(connection);
        });
        yield* each.next();
      }
    });

    yield* provide({ port });
  });
}

export interface LineClient<T> {
  send(line: string): void;
  /** The next parsed inbound message; throws once the connection closes. */
  next(): Operation<T>;
  /** Resolves when the connection closes. */
  closed: Operation<void>;
}

/**
 * Connect to a line-protocol server. Shares {@link useLineSocket}, adds the
 * connect handshake and a parsed inbound queue behind `next()` — all as
 * operations. `parse` returning `undefined` drops an unparseable line.
 */
export function useLineClient<T>(
  host: string,
  port: number,
  parse: (line: string) => T | undefined,
): Operation<LineClient<T>> {
  return resource(function* (provide) {
    const socket = connect(port, host);
    // Owned before the handshake is awaited: a connect that fails has to leave
    // no socket behind, and `useLineSocket` cannot take ownership of one until
    // the handshake has settled.
    yield* ensure(() => {
      socket.destroy();
    });

    // Raced inline, in the same synchronous run as `connect`, for the reason
    // given in `useLineServer`.
    yield* race([
      once(socket, "connect"),
      (function* (): Operation<never> {
        const [error] = yield* once(socket, "error");
        throw error instanceof Error ? error : new Error(String(error));
      })(),
    ]);

    const connection = yield* useLineSocket(socket);

    const inbound = createChannel<T, void>();
    const subscription = yield* inbound; // subscribe before the pump: no loss
    yield* spawn(function* () {
      // Close inbound on every exit — EOF, abrupt socket close, or
      // cancellation — so a pending next() always settles.
      yield* ensure(function* () {
        yield* inbound.close();
      });
      yield* race([
        connection.closed,
        (function* () {
          for (const line of yield* each(connection.lines)) {
            const message = parse(line);
            if (message !== undefined) {
              yield* inbound.send(message);
            }
            yield* each.next();
          }
        })(),
      ]);
    });

    yield* provide({
      send(line) {
        connection.send(line);
      },
      closed: connection.closed,
      *next() {
        const result = yield* subscription.next();
        if (result.done) {
          throw new Error("connection closed before a reply");
        }
        return result.value;
      },
    });
  });
}
