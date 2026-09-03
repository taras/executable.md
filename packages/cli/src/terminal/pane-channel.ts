/**
 * The parent's end of one grid's private worker channels
 * (architecture.md §Interactive terminal grids).
 *
 * One directory per grid, mode 0700, under `$TMPDIR` so the socket paths stay
 * inside the 104-byte cap a Unix socket has. Inside it, one socket and one
 * mode-0600 token per pane, both written *before* any pane exists — a worker
 * that starts finds its socket already listening rather than racing it.
 *
 * Admission is the whole security boundary. A connection is admitted when its
 * first frame is a `hello` naming this pane's ordinal and carrying this pane's
 * token; a connection that says anything else, says it too late, names another
 * ordinal, or arrives after that pane is already admitted is closed without
 * being answered. The token is single-use by construction — the worker removes
 * the file as it reads it — so a second reader finds nothing to present.
 *
 * Everything here dies with the scope: sockets destroyed, servers closed, and
 * the directory with its tokens removed, whichever way the grid ended.
 */

import { randomBytes } from "node:crypto";
import net from "node:net";
import type { Server, Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensure,
  createSignal,
  race,
  resource,
  sleep,
  spawn,
  until,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import {
  FromWorkerSchema,
  paneSocketPath,
  paneTokenPath,
  readFrames,
  writeFrame,
} from "./pane-protocol.ts";
import type { FromWorker, Hello, ToWorker } from "./pane-protocol.ts";

/** How long a connection has to present its `hello` before it is dropped. */
const HELLO_GRACE_MS = 10_000;

/** The parent's end of one admitted worker. */
export interface PaneLink {
  readonly ordinal: number;
  /** What the worker said about the pane it woke up in. */
  readonly hello: Hello;
  send(message: ToWorker): Operation<void>;
  /** The next frame, or `undefined` once the worker's connection closed. */
  next(): Operation<FromWorker | undefined>;
  connected(): boolean;
}

export interface PaneChannels {
  /** The private directory, which tmux is told and nothing else learns. */
  readonly directory: string;
  /** The admitted worker for `ordinal`; waits for its `hello`. */
  link(ordinal: number): Operation<PaneLink>;
  /** Connections closed without admission, for a diagnostic to name. */
  refusals(): readonly string[];
}

interface Slot {
  readonly waiting: ReturnType<typeof withResolvers<PaneLink>>;
  admitted: boolean;
}

/**
 * Open one grid's private directory and listen for `count` workers.
 *
 * The directory is created 0700 and removed with the scope. A host whose
 * temporary directory is world-writable still gets a private grid, because the
 * mode is set on the directory this creates rather than inherited from it.
 */
export function usePaneChannels(
  count: number,
  options: {
    onClosed?: () => void;
    /**
     * Called as the directory is removed, with how many of the sockets and
     * servers had actually reported closing by then.
     *
     * Counted from their own `close` events rather than from having asked, so a
     * caller can tell "closed" from "told to close".
     */
    onRemoved?: (facts: { closed: number; total: number }) => void;
  } = {},
): Operation<PaneChannels> {
  return resource(function* (provide) {
    // Directly under `$TMPDIR`: a socket path is capped at 104 bytes, and a
    // directory named after a repository path spends most of that before the
    // socket name begins.
    const directory = path.join(os.tmpdir(), `xmd-grid-${randomBytes(6).toString("hex")}`);
    yield* ensureDir(directory);
    yield* until(chmod(directory, 0o700));
    // Registered first, so it runs last: the directory goes only after every
    // socket and server below has actually closed. Removing it while a server
    // still listened would leave a socket bound to a path nothing can name.
    yield* ensure(function* () {
      options.onRemoved?.({ closed: closedCount, total: closable });
      yield* rm(directory, { recursive: true, force: true });
    });

    const tokens = new Map<number, string>();
    const slots = new Map<number, Slot>();
    const servers: Server[] = [];
    const live = new Set<Socket>();
    const refusals: string[] = [];
    const arrivals = createSignal<{ ordinal: number; socket: Socket }, never>();
    /** Closures that have actually happened, by their own events. */
    let closedCount = 0;
    let closable = 0;

    // Awaited, not asked for. `destroy()` and `close()` are requests; what the
    // directory's removal has to wait for is the closures themselves.
    yield* ensure(function* () {
      const closings: Operation<void>[] = [];
      for (const socket of live) {
        closings.push(closed(socket));
        socket.destroy();
      }
      for (const server of servers) {
        closings.push(shut(server));
        server.close();
      }
      for (const closing of closings) {
        yield* closing;
      }
      options.onClosed?.();
    });

    // Subscribed before a single server listens, so no arrival is missed.
    const incoming = yield* arrivals;

    for (let ordinal = 0; ordinal < count; ordinal++) {
      const token = randomBytes(16).toString("hex");
      tokens.set(ordinal, token);
      slots.set(ordinal, { waiting: withResolvers<PaneLink>(), admitted: false });
      yield* writeTextFile(paneTokenPath(directory, ordinal), token);
      yield* until(chmod(paneTokenPath(directory, ordinal), 0o600));

      const server = net.createServer((socket) => {
        live.add(socket);
        closable++;
        socket.once("close", () => {
          live.delete(socket);
          closedCount++;
        });
        arrivals.send({ ordinal, socket });
      });
      servers.push(server);
      closable++;
      server.once("close", () => {
        closedCount++;
      });
      const listening = withResolvers<void>();
      server.once("error", (error: Error) => listening.reject(error));
      server.listen(paneSocketPath(directory, ordinal), () => listening.resolve());
      yield* listening.operation;
    }

    function* admit(ordinal: number, socket: Socket): Operation<void> {
      const slot = slots.get(ordinal);
      const token = tokens.get(ordinal);
      const frames = readFrames(socket, (value) => FromWorkerSchema.parse(value));
      const first = yield* race([frames.next(), silence()]);
      if (slot === undefined || token === undefined || first.done || first.value.type !== "hello") {
        refusals.push(`pane ${ordinal}: a connection that did not say hello`);
        socket.destroy();
        return;
      }
      const hello = first.value;
      if (slot.admitted) {
        refusals.push(`pane ${ordinal}: a second connection to an admitted pane`);
        socket.destroy();
        return;
      }
      if (hello.ordinal !== ordinal || hello.token !== token) {
        // Deliberately one message for both: an attacker learns nothing from
        // which half was wrong.
        refusals.push(`pane ${ordinal}: a connection that could not prove it is this pane`);
        socket.destroy();
        return;
      }
      slot.admitted = true;
      slot.waiting.resolve({
        ordinal,
        hello,
        send: (message) => writeFrame(socket, message),
        *next() {
          const next = yield* frames.next();
          return next.done ? undefined : next.value;
        },
        connected: () => !socket.destroyed,
      });
    }

    yield* spawn(function* () {
      while (true) {
        const next = yield* incoming.next();
        if (next.done) {
          return;
        }
        const { ordinal, socket } = next.value;
        yield* spawn(() => admit(ordinal, socket));
      }
    });

    yield* provide({
      directory,
      *link(ordinal) {
        const slot = slots.get(ordinal);
        if (slot === undefined) {
          throw new Error(`this grid has no pane ${ordinal}`);
        }
        return yield* slot.waiting.operation;
      },
      refusals: () => [...refusals],
    });
  });
}

/** Settle once this socket has closed, whether or not it already had. */
function closed(socket: Socket): Operation<void> {
  const done = withResolvers<void>();
  if (socket.destroyed) {
    done.resolve();
  } else {
    socket.once("close", () => done.resolve());
  }
  return done.operation;
}

/** Settle once this server has stopped listening. */
function shut(server: Server): Operation<void> {
  const done = withResolvers<void>();
  if (!server.listening) {
    done.resolve();
  } else {
    server.once("close", () => done.resolve());
  }
  return done.operation;
}

/** A connection that has said nothing for long enough to be nobody. */
function* silence(): Operation<IteratorResult<FromWorker, void>> {
  yield* sleep(HELLO_GRACE_MS);
  return { done: true, value: undefined };
}
