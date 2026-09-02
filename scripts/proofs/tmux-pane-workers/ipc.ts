/**
 * The invocation-private channel between the parent and one pane worker.
 *
 * One Unix socket per pane, inside a mode-0700 directory that exists for one
 * invocation. The worker proves which pane it is with a token the parent wrote
 * to a mode-0600 file only that worker reads and removes; a connection that
 * does not open with the right `hello` is closed, and a second connection to a
 * pane already admitted is closed too. Nothing here reaches argv or the
 * environment of any process: the pane command names the directory and the
 * ordinal, and tmux's command parser sees only those.
 *
 * Messages are newline-delimited JSON and parsed with zod on both ends, so a
 * value is what its schema says or the frame is a protocol error.
 *
 * The socket directory is short by necessity, not taste: a Unix socket path is
 * limited to 104 bytes on macOS, which a temporary directory named after a
 * repository path exceeds.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import {
  createQueue,
  createSignal,
  ensure,
  race,
  resource,
  sleep,
  spawn,
  until,
  withResolvers,
} from "effection";
import type { Operation, Queue } from "effection";
import { z } from "zod";

export const HelloSchema = z.object({
  type: z.literal("hello"),
  ordinal: z.number().int().nonnegative(),
  token: z.string(),
  pid: z.number().int(),
  ppid: z.number().int(),
  pgid: z.number().int(),
  tty: z.string(),
  isatty: z.tuple([z.boolean(), z.boolean(), z.boolean()]),
});

const DescendantOutcomeSchema = z.object({
  pid: z.number().int(),
  command: z.string(),
  inGroup: z.boolean(),
  delivery: z.enum(["delivered", "absent", "refused"]),
  gone: z.boolean(),
});

export const QuiescenceProofSchema = z.object({
  method: z.enum(["exited", "interrupted", "killed"]),
  childPid: z.number().int().optional(),
  childGone: z.boolean(),
  descendants: z.array(DescendantOutcomeSchema),
  survivors: z.array(z.number().int()),
});

export const FromWorkerSchema = z.discriminatedUnion("type", [
  HelloSchema,
  z.object({ type: z.literal("displayed"), seq: z.number().int() }),
  z.object({ type: z.literal("ready"), id: z.string(), pid: z.number().int() }),
  z.object({ type: z.literal("startup-failed"), id: z.string(), reason: z.string() }),
  z.object({ type: z.literal("refused"), id: z.string(), reason: z.string() }),
  z.object({
    type: z.literal("exited"),
    id: z.string(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
  }),
  z.object({
    type: z.literal("quiescent"),
    id: z.string().optional(),
    proof: QuiescenceProofSchema,
  }),
  z.object({
    type: z.literal("bye"),
    /** Processes that still held the pane's terminal at shutdown, and whether they are gone. */
    ttyHolders: z.array(z.object({ pid: z.number().int(), gone: z.boolean() })),
  }),
]);

export const ToWorkerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome") }),
  z.object({ type: z.literal("display"), seq: z.number().int(), text: z.string() }),
  z.object({
    type: z.literal("launch"),
    id: z.string(),
    argv: z.array(z.string()).min(1),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal("cancel"), id: z.string() }),
  z.object({ type: z.literal("shutdown") }),
]);

export type Hello = z.infer<typeof HelloSchema>;
export type FromWorker = z.infer<typeof FromWorkerSchema>;
export type ToWorker = z.infer<typeof ToWorkerSchema>;
export type QuiescenceProof = z.infer<typeof QuiescenceProofSchema>;

export function socketPath(directory: string, ordinal: number): string {
  return join(directory, `p${ordinal}.sock`);
}

export function tokenPath(directory: string, ordinal: number): string {
  return join(directory, `p${ordinal}.token`);
}

/** Feed socket bytes into a queue of parsed frames; close the queue on EOF. */
export function frames<T>(socket: Socket, parse: (value: unknown) => T): Queue<T, void> {
  const queue = createQueue<T, void>();
  let remainder = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const lines = (remainder + chunk).split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      try {
        queue.add(parse(JSON.parse(line)));
      } catch {
        // A frame that is not the protocol ends the conversation.
        socket.destroy();
      }
    }
  });
  socket.on("close", () => queue.close());
  socket.on("error", () => socket.destroy());
  return queue;
}

export function send(socket: Socket, message: unknown): Operation<void> {
  const written = withResolvers<void>();
  if (socket.destroyed) {
    written.resolve();
    return written.operation;
  }
  socket.write(JSON.stringify(message) + "\n", () => written.resolve());
  return written.operation;
}

/** The parent's end of one admitted worker. */
export interface PaneLink {
  ordinal: number;
  hello: Hello;
  send(message: ToWorker): Operation<void>;
  /** The next frame, or `undefined` once the worker's connection closed. */
  next(): Operation<FromWorker | undefined>;
  connected(): boolean;
}

export interface PaneSockets {
  directory: string;
  /** The admitted worker for `ordinal`; waits for its `hello`. */
  link(ordinal: number): Operation<PaneLink>;
  /** Connections that were closed without admission, for the evidence. */
  refusals(): string[];
}

interface Slot {
  resolvers: ReturnType<typeof withResolvers<PaneLink>>;
  settled: boolean;
}

const HELLO_TIMEOUT_MS = 10_000;

function* helloTimeout(): Operation<IteratorResult<FromWorker, void>> {
  yield* sleep(HELLO_TIMEOUT_MS);
  return { done: true, value: undefined };
}

/**
 * Listen for `count` workers. Sockets and tokens exist before any pane is
 * created, so a worker that starts finds its socket already there, and are
 * removed with the directory whatever way the scope ends.
 */
export function usePaneSockets(directory: string, count: number): Operation<PaneSockets> {
  return resource(function* (provide) {
    const tokens = new Map<number, string>();
    const slots = new Map<number, Slot>();
    const servers: Server[] = [];
    const sockets = new Set<Socket>();
    const refusals: string[] = [];
    const connections = createSignal<{ ordinal: number; socket: Socket }, never>();

    yield* ensure(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      for (const server of servers) {
        server.close();
      }
    });

    // Subscribed before any server listens, so no connection is dropped.
    const incoming = yield* connections;

    for (let ordinal = 0; ordinal < count; ordinal++) {
      const token = randomBytes(16).toString("hex");
      tokens.set(ordinal, token);
      slots.set(ordinal, { resolvers: withResolvers<PaneLink>(), settled: false });
      yield* until(writeFile(tokenPath(directory, ordinal), token, { mode: 0o600 }));
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        connections.send({ ordinal, socket });
      });
      servers.push(server);
      const listening = withResolvers<void>();
      server.once("error", (error: Error) => listening.reject(error));
      server.listen(socketPath(directory, ordinal), () => listening.resolve());
      yield* listening.operation;
    }

    function* admit(ordinal: number, socket: Socket): Operation<void> {
      const slot = slots.get(ordinal);
      const token = tokens.get(ordinal);
      const queue = frames(socket, (value) => FromWorkerSchema.parse(value));
      const first = yield* race([queue.next(), helloTimeout()]);
      if (slot === undefined || token === undefined || first.done || first.value.type !== "hello") {
        refusals.push(`pane ${ordinal}: connection without hello`);
        socket.destroy();
        return;
      }
      const hello = first.value;
      if (hello.ordinal !== ordinal || hello.token !== token || slot.settled) {
        refusals.push(
          `pane ${ordinal}: refused ordinal ${hello.ordinal} ${slot.settled ? "(already admitted)" : "(bad token)"}`,
        );
        socket.destroy();
        return;
      }
      slot.settled = true;
      slot.resolvers.resolve({
        ordinal,
        hello,
        send: (message) => send(socket, message),
        *next() {
          const next = yield* queue.next();
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
          throw new Error(`no pane ${ordinal}`);
        }
        return yield* slot.resolvers.operation;
      },
      refusals: () => [...refusals],
    });
  });
}
