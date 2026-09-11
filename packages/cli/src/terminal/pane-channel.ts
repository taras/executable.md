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
  suspend,
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
  /**
   * Close every socket and server, and wait for them.
   *
   * Callable by a teardown that has to put this in a particular place in its
   * order; the scope runs it too, so a caller that never gets there still
   * leaves nothing open. Idempotent.
   */
  close(): Operation<void>;
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
    /** Handed each accepted socket, so a suite can ask what it still holds. */
    onSocket?: (socket: Socket) => void;
    /** Handed each listening server, for the same reason. */
    onServer?: (server: Server) => void;
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
    let closing: ReturnType<typeof withResolvers<void>> | undefined;
    /** Handles that have actually closed, so a retry does not close them twice. */
    const shut = new Set<Socket | Server>();

    function* closeAll(): Operation<void> {
      if (closing !== undefined) {
        // Published before anything is closed, so a second caller arriving
        // mid-close waits for this one rather than starting its own or being
        // told it had already finished.
        return yield* closing.operation;
      }
      closing = withResolvers<void>();
      let failure: Error | undefined;
      const failed = (error: unknown): void => {
        failure = failure ?? (error instanceof Error ? error : new Error(String(error)));
      };
      const waits: Operation<void>[] = [];

      // The requests are inside the same failure boundary as the waits: asking
      // a handle to close is as capable of failing as waiting for it, and a
      // request that threw must not stop the others being asked. The watch for
      // one that threw is abandoned rather than awaited — nothing is going to
      // close it — and the handle is left out of `shut`, so a later call asks
      // again.
      for (const socket of [...live]) {
        if (shut.has(socket)) {
          continue;
        }
        const watch = closedSocket(socket, () => {
          closedCount++;
          shut.add(socket);
        });
        try {
          socket.destroy();
          waits.push(watch.wait);
        } catch (error) {
          watch.abandon();
          failed(error);
        }
      }
      for (const server of servers) {
        if (shut.has(server)) {
          continue;
        }
        const watch = closedServer(server, () => {
          closedCount++;
          shut.add(server);
        });
        try {
          server.close();
          waits.push(watch.wait);
        } catch (error) {
          watch.abandon();
          failed(error);
        }
      }
      for (const wait of waits) {
        try {
          yield* wait;
        } catch (error) {
          failed(error);
        }
      }
      if (failure !== undefined) {
        // Cleared, so a later call retries the handles that did not close and
        // leaves the ones that did alone.
        closing.reject(failure);
        closing = undefined;
        throw failure;
      }
      options.onClosed?.();
      closing.resolve();
    }

    yield* ensure(function* () {
      yield* closeAll();
    });

    // Subscribed before a single server listens, so no arrival is missed.
    const incoming = yield* arrivals;

    for (let ordinal = 0; ordinal < count; ordinal++) {
      const token = randomBytes(16).toString("hex");
      tokens.set(ordinal, token);
      slots.set(ordinal, { waiting: withResolvers<PaneLink>(), admitted: false });
      yield* writeTextFile(paneTokenPath(directory, ordinal), token);
      yield* until(chmod(paneTokenPath(directory, ordinal), 0o600));

      // Named, every one of them. `createServer(cb)` and `listen(cb)` both
      // register anonymous listeners that nothing can take off again.
      const server = net.createServer();
      const onConnection = (socket: Socket): void => {
        live.add(socket);
        closable++;
        const onSocketClose = (): void => {
          live.delete(socket);
          socket.off("close", onSocketClose);
        };
        socket.on("close", onSocketClose);
        options.onSocket?.(socket);
        arrivals.send({ ordinal, socket });
      };
      server.on("connection", onConnection);
      servers.push(server);
      options.onServer?.(server);
      closable++;
      yield* ensure(() => {
        server.off("connection", onConnection);
      });

      const listening = withResolvers<void>();
      const onListening = (): void => listening.resolve();
      const onListenError = (error: Error): void => listening.reject(error);
      server.on("listening", onListening);
      server.on("error", onListenError);
      server.listen(paneSocketPath(directory, ordinal));
      try {
        // Both stay installed through the wait they resolve.
        yield* listening.operation;
      } finally {
        // And come off synchronously once it is over, however it ended.
        server.off("listening", onListening);
        server.off("error", onListenError);
      }
    }

    function* admit(ordinal: number, socket: Socket): Operation<void> {
      const slot = slots.get(ordinal);
      const token = tokens.get(ordinal);
      const frames = yield* readFrames(socket, (value) => FromWorkerSchema.parse(value));
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
        yield* spawn(function* () {
          yield* admit(ordinal, socket);
          // The frame reader is this task's, so this task has to outlive the
          // admission: a reader torn down at the handshake would leave a link
          // that never hears another word.
          yield* suspend();
        });
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
      close: closeAll,
    });
  });
}

/** Settle once this socket has closed, whether or not it already had. */
function closedSocket(socket: Socket, onClosed: () => void): CloseWatch {
  // Attached now, awaited later. The caller asks for this *before* destroying
  // the socket, so a listener attached lazily would miss the close it is
  // waiting for — and the directory would go while the socket was still open.
  const done = withResolvers<void>();
  const onClose = (): void => {
    onClosed();
    done.resolve();
  };
  if (socket.destroyed) {
    onClosed();
    done.resolve();
  } else {
    socket.on("close", onClose);
  }
  return {
    wait: (function* (): Operation<void> {
      try {
        yield* done.operation;
      } finally {
        // Removed synchronously when the wait is over, however it ends.
        socket.off("close", onClose);
      }
    })(),
    abandon: () => socket.off("close", onClose),
  };
}

/**
 * A closure this code is already listening for.
 *
 * Two halves because asking a handle to close can fail: the listener has to be
 * on before the request, and a request that threw leaves nothing to wait for.
 * `abandon` takes the listener off without claiming the handle closed, so the
 * handle stays retryable rather than being counted or waited on forever.
 */
interface CloseWatch {
  readonly wait: Operation<void>;
  abandon(): void;
}

/** Settle once this server has stopped listening. */
function closedServer(server: Server, onClosed: () => void): CloseWatch {
  const done = withResolvers<void>();
  const onClose = (): void => {
    onClosed();
    done.resolve();
  };
  if (!server.listening) {
    onClosed();
    done.resolve();
  } else {
    server.on("close", onClose);
  }
  return {
    wait: (function* (): Operation<void> {
      try {
        yield* done.operation;
      } finally {
        server.off("close", onClose);
      }
    })(),
    abandon: () => server.off("close", onClose),
  };
}

/** A connection that has said nothing for long enough to be nobody. */
function* silence(): Operation<IteratorResult<FromWorker, void>> {
  yield* sleep(HELLO_GRACE_MS);
  return { done: true, value: undefined };
}
