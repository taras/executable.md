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

/** What one worker says about the pane it woke up in. */
export const HelloSchema = z.object({
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
export const SettlementSchema = z.object({
  method: z.enum(["exited", "interrupted", "killed"]),
  quiet: z.boolean(),
  child: z.number().int().optional(),
  /** Snapshot members reached during the escalation. */
  swept: z.array(SweptSchema),
  /** Anything still holding the pane's terminal after the sweep. */
  holders: z.array(SweptSchema),
});

export const FromWorkerSchema = z.discriminatedUnion("type", [
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
export type Settlement = z.infer<typeof SettlementSchema>;

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

    // Named, and all three removed together: on delivery, on a frame that does
    // not parse, on the socket erroring, on cancellation, and on ordinary scope
    // exit. A reader left attached to a socket its scope has finished with is a
    // reader answering for somebody else's conversation.
    const onData = (chunk: string): void => {
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
          socket.destroy();
        }
      }
    };
    const onClose = (): void => queue.close();
    const onError = (): void => {
      socket.destroy();
    };

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
    yield* ensure(() => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    });

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
