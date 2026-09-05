/**
 * What the parent and one pane worker say to each other, and how
 * (architecture.md §Interactive terminal grids).
 *
 * The channel is invocation-private: one Unix socket per pane, inside a
 * mode-0700 directory that exists for one grid. A worker proves which pane it
 * is with a token the parent wrote to a mode-0600 file that only that worker
 * reads — and removes, so the token is spent the moment it is used.
 *
 * Everything a launch actually consists of crosses here rather than through
 * tmux: the exact argv vector, the working directory and the environment. tmux
 * has a command parser, and a command parser is a place where an argument can
 * become two arguments, or a quote, or a `;`. What tmux is told instead is a
 * directory and an ordinal, which is all its parser ever sees.
 *
 * Frames are newline-delimited JSON, parsed with a schema on both ends. A frame
 * that is not the protocol ends the conversation rather than being interpreted:
 * this socket is how one process is asked to start a program with inherited
 * terminal streams, so "close to what I expected" is not good enough.
 */

import { join } from "node:path";
import type { Socket } from "node:net";
import { createQueue, ensure, resource, withResolvers } from "effection";
import type { Operation, Queue } from "effection";
import { z } from "zod";

/**
 * The wire format, written out.
 *
 * Declared rather than inferred from the schemas below, and the schemas are
 * then annotated with these types so the compiler holds the two together — a
 * schema that stopped producing its declared frame stops compiling, so there is
 * no drift to keep an eye on.
 *
 * Written out because this package is published: an inferred zod type has no
 * explicit form to publish, and the frames are the one part of this adapter
 * whose shape a reader of the package genuinely needs. The schemas themselves
 * stay private — how a frame is validated is nobody else's business, and
 * `parseFromWorker`/`parseToWorker` are the seam.
 */

/** What one worker says about the pane it woke up in. */
export interface Hello {
  type: "hello";
  ordinal: number;
  token: string;
  pid: number;
  pgid: number;
  /** `ttys003`, or `??` when the worker has no controlling terminal. */
  tty: string;
  /** Whether stdin, stdout and stderr are terminals. All three must be. */
  isatty: [boolean, boolean, boolean];
}

/** One process the settlement reached, and what reaching it established. */
export interface Swept {
  pid: number;
  gone: boolean;
}

/**
 * What a settlement established, in the order it established it.
 *
 * `quiet` is the only field a caller may act on, and it is true only when the
 * child, everything the snapshot said was below or beside it, and every holder
 * of the pane's terminal are gone. The rest is what a diagnostic says when it
 * is not.
 */
export interface Settlement {
  method: "exited" | "interrupted" | "killed";
  quiet: boolean;
  child?: number;
  /** Snapshot members reached during the escalation. */
  swept: Swept[];
  /** Anything still holding the pane's terminal after the sweep. */
  holders: Swept[];
}

/** Everything a worker may say. */
export type FromWorker =
  | Hello
  | { type: "displayed"; seq: number }
  /** The runtime's spawn event, and nothing earlier. */
  | { type: "started"; id: string; pid: number }
  | { type: "start-failed"; id: string; reason: string }
  /** A launch asked for while one is live. */
  | { type: "busy"; id: string }
  | {
      type: "exited";
      id: string;
      exitCode?: number;
      signal?: string;
      /** The settlement that preceded this; the pane is free once it arrives. */
      settlement: Settlement;
    }
  | { type: "quiet"; id?: string; settlement: Settlement }
  | { type: "bye"; holders: Swept[] };

/** Everything the parent may say. */
export type ToWorker =
  | { type: "welcome" }
  | { type: "display"; seq: number; text: string }
  | { type: "launch"; id: string; argv: string[]; cwd: string; env: Record<string, string> }
  | { type: "cancel"; id: string }
  | { type: "shutdown" };

/** What one worker says about the pane it woke up in. */
const HelloSchema = z.object({
  type: z.literal("hello"),
  ordinal: z.number().int().nonnegative(),
  token: z.string(),
  pid: z.number().int(),
  pgid: z.number().int(),
  /** `ttys003`, or `??` when the worker has no controlling terminal. */
  tty: z.string(),
  /** Whether stdin, stdout and stderr are terminals. All three must be. */
  isatty: z.tuple([z.boolean(), z.boolean(), z.boolean()]),
});

/** One process the settlement reached, and what reaching it established. */
const SweptSchema = z.object({
  pid: z.number().int(),
  gone: z.boolean(),
});

/**
 * What a settlement established, in the order it established it.
 *
 * `quiet` is the only field a caller may act on, and it is true only when the
 * child, everything the snapshot said was below or beside it, and every holder
 * of the pane's terminal are gone. The rest is what a diagnostic says when it
 * is not.
 */
const SettlementSchema = z.object({
  method: z.enum(["exited", "interrupted", "killed"]),
  quiet: z.boolean(),
  child: z.number().int().optional(),
  /** Snapshot members reached during the escalation. */
  swept: z.array(SweptSchema),
  /** Anything still holding the pane's terminal after the sweep. */
  holders: z.array(SweptSchema),
});

const FromWorkerSchema = z.discriminatedUnion("type", [
  HelloSchema,
  z.object({ type: z.literal("displayed"), seq: z.number().int() }),
  /** The runtime's spawn event, and nothing earlier. */
  z.object({ type: z.literal("started"), id: z.string(), pid: z.number().int() }),
  z.object({ type: z.literal("start-failed"), id: z.string(), reason: z.string() }),
  /** A launch asked for while one is live. */
  z.object({ type: z.literal("busy"), id: z.string() }),
  z.object({
    type: z.literal("exited"),
    id: z.string(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    /** The settlement that preceded this; the pane is free once it arrives. */
    settlement: SettlementSchema,
  }),
  z.object({
    type: z.literal("quiet"),
    id: z.string().optional(),
    settlement: SettlementSchema,
  }),
  z.object({ type: z.literal("bye"), holders: z.array(SweptSchema) }),
]);

const ToWorkerSchema = z.discriminatedUnion("type", [
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

// The schemas are held to the declared frames rather than the frames being
// read off the schemas. A change to either that the other does not match is a
// type error here, at the one place both are in view.
const _hello: z.ZodType<Hello> = HelloSchema;
const _settlement: z.ZodType<Settlement> = SettlementSchema;
const _fromWorker: z.ZodType<FromWorker> = FromWorkerSchema;
const _toWorker: z.ZodType<ToWorker> = ToWorkerSchema;

/**
 * Read one frame in each direction, or refuse it.
 *
 * The seam is the parse rather than the schema. A schema is how this module
 * happens to decide what a frame is; what a caller — including this adapter's
 * own tests — actually needs is "turn these bytes into a frame or throw", and
 * a function saying exactly that keeps the shape of the wire format private.
 * It also keeps it out of the published API, where an inferred zod type has no
 * explicit form to publish.
 */
export function parseFromWorker(value: unknown): FromWorker {
  return FromWorkerSchema.parse(value);
}

export function parseToWorker(value: unknown): ToWorker {
  return ToWorkerSchema.parse(value);
}

/**
 * Where one pane's socket and token live.
 *
 * Short by necessity rather than taste: a Unix socket path is capped at 104
 * bytes, which a temporary directory named after a repository path exceeds.
 */
export function paneSocketPath(directory: string, ordinal: number): string {
  return join(directory, `p${ordinal}.sock`);
}

export function paneTokenPath(directory: string, ordinal: number): string {
  return join(directory, `p${ordinal}.token`);
}

/**
 * Feed one socket's bytes into a queue of parsed frames.
 *
 * A frame that does not parse destroys the socket. There is no partial credit
 * on this channel.
 */
export function readFrames<T>(
  socket: Socket,
  parse: (value: unknown) => T,
): Operation<Queue<T, void>> {
  return resource<Queue<T, void>>(function* (provide) {
    const queue = createQueue<T, void>();
    let remainder = "";
    socket.setEncoding("utf8");

    /** Take all three off at once. This reader is over. */
    const detach = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    function onData(chunk: string): void {
      const lines = (remainder + chunk).split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        try {
          queue.add(parse(JSON.parse(line)));
        } catch {
          // A frame that is not the protocol ends the conversation. This socket
          // is how one process is asked to start a program with inherited
          // terminal streams; "close to what I expected" is not good enough.
          // The reader is done, so it comes off now rather than at scope exit
          // — and its consumers are told, or they would wait for frames from a
          // conversation that has ended.
          detach();
          queue.close();
          socket.destroy();
          return;
        }
      }
    }
    function onClose(): void {
      // Terminal: nothing follows a close, so nothing stays listening for one.
      detach();
      queue.close();
    }
    function onError(): void {
      detach();
      queue.close();
      socket.destroy();
    }

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
    // Still the resource's, for the paths that terminate nothing: a cancelled
    // scope, and a socket that simply never says anything.
    yield* ensure(detach);

    yield* provide(queue);
  });
}

/** Write one frame, and settle once the socket has taken it. */
export function writeFrame(socket: Socket, message: unknown): Operation<void> {
  const written = withResolvers<void>();
  if (socket.destroyed) {
    written.resolve();
    return written.operation;
  }
  socket.write(JSON.stringify(message) + "\n", () => written.resolve());
  return written.operation;
}
