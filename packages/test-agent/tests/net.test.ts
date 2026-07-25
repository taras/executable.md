/**
 * Tier NR — line-socket adapter tests (packages/test-agent/src/net.ts): the
 * server/socket/client resources that bridge Node TCP into Effection. Covers
 * a line round-trip, abrupt peer closure settling the client, and server
 * teardown closing accepted connections and stopping the listener.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { each, ensure, race, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node";
import { connect } from "node:net";
import { useLineClient, useLineServer } from "../src/net.ts";
import type { LineSocket } from "../src/net.ts";

describe("Tier NR — line-socket adapter", () => {
  it("NR1: a line round-trips from client to server and back", function* () {
    const server = yield* useLineServer("127.0.0.1", function* (connection: LineSocket) {
      for (const line of yield* each(connection.lines)) {
        connection.send(`echo:${line}\n`);
        yield* each.next();
      }
    });
    const client = yield* useLineClient<string>("127.0.0.1", server.port, (line) => line);
    client.send("hello\n");
    expect(yield* client.next()).toBe("echo:hello");
  });

  it("NR2: an abrupt peer close settles the client — closed resolves and next() throws", function* () {
    const server = yield* useLineServer("127.0.0.1", function* (connection: LineSocket) {
      // Reply once, then return: the adapter destroys the socket, an
      // abrupt close with no graceful FIN that fromReadable never ends.
      for (const line of yield* each(connection.lines)) {
        connection.send(`ack:${line}\n`);
        return;
      }
    });
    const client = yield* useLineClient<string>("127.0.0.1", server.port, (line) => line);
    client.send("ping\n");
    expect(yield* client.next()).toBe("ack:ping");

    // The server dropped the connection; the client settles rather than
    // blocking on the next reply.
    yield* client.closed;
    let threw = false;
    try {
      yield* client.next();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("NR3: server teardown halts accepted connections before closing the listener", function* () {
    const portRef = withResolvers<number>();
    let connectionTornDown = false;
    const serverTask = yield* spawn(function* () {
      yield* scoped(function* () {
        const server = yield* useLineServer("127.0.0.1", function* (connection: LineSocket) {
          yield* ensure(() => {
            connectionTornDown = true;
          });
          connection.send("ready\n"); // signals the handler (and its ensure) is live
          yield* connection.closed; // hold the connection open
        });
        portRef.resolve(server.port);
        yield* suspend();
      });
    });
    const port = yield* portRef.operation;

    const client = yield* useLineClient<string>("127.0.0.1", port, (line) => line);
    expect(yield* client.next()).toBe("ready"); // the accepted connection is live

    yield* serverTask.halt();
    // The accepted connection was halted (its ensure ran) and the client
    // observed the close — connections go down before the listener.
    yield* client.closed;
    expect(connectionTornDown).toBe(true);

    // The listener is gone: a fresh connection is refused.
    const socket = connect(port, "127.0.0.1");
    const outcome = yield* race([
      (function* (): Operation<string> {
        yield* once(socket, "connect");
        socket.destroy();
        return "connected";
      })(),
      (function* (): Operation<string> {
        yield* once(socket, "error");
        return "refused";
      })(),
    ]);
    expect(outcome).toBe("refused");
  });
});
