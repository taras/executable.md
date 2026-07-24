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
    socket.once("close", () => closed.resolve());
    yield* ensure(() => {
      socket.destroy();
      closed.resolve(); // settle on cancellation even if no 'close' follows
    });
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
      // already-closed server leaves no pending operation.
      if (server.listening) {
        const closed = withResolvers<void>();
        server.once("close", () => closed.resolve());
        server.close();
        yield* closed.operation;
      }
    });

    // Attach the readiness listeners before listen, so the event is never
    // missed by a later subscription.
    const listening = withResolvers<void>();
    server.once("listening", () => listening.resolve());
    server.once("error", (error) => {
      listening.reject(error instanceof Error ? error : new Error(String(error)));
    });
    server.listen(0, host);
    yield* listening.operation;

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
    // Attach connect/error listeners before yielding, so neither is missed.
    const connected = withResolvers<void>();
    socket.once("connect", () => connected.resolve());
    socket.once("error", (error) => {
      connected.reject(error instanceof Error ? error : new Error(String(error)));
    });
    const connection = yield* useLineSocket(socket);
    yield* connected.operation;

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
