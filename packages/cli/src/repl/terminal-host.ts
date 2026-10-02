/**
 * The portable half of a REPL terminal, over capabilities a runtime supplies.
 *
 * `terminal.ts` says what the REPL needs; this says how to build it
 * once a host has handed over five things it alone can do. Everything that is
 * the same on every runtime — turning an async byte source into a stream with
 * real backpressure, turning a resize notification into a stream of sizes,
 * ending both when the scope ends — lives here, so the runtime-named factories
 * contain nothing but their own runtime's spelling of those five capabilities.
 *
 * Nothing registers this. A runtime entrypoint installs it when the REPL
 * command exists; until then it is a factory nobody calls, which is what keeps
 * `@bomb.sh/tty` and raw mode off the path of every other command.
 */

import {
  action,
  createSignal,
  ensure,
  type Operation,
  resource,
  sleep,
  type Stream,
  type Subscription,
  until,
  withResolvers,
} from "effection";
import { ReplTerminal, type ReplTerminalSize } from "./terminal.ts";

/**
 * What a runtime has to provide, stated structurally.
 *
 * No host global appears in this module's types: a factory passes its own
 * runtime's functions in by value, the same way the standard-input adapter
 * takes a stream (Code Rule 12).
 */
export interface ReplTerminalCapabilities {
  /**
   * Whether both ends of this terminal are a terminal.
   *
   * Required rather than assumed: a host that cannot say is a host whose
   * answer would have to be guessed, and the guess that costs something is the
   * optimistic one — it creates a history file and then fails on raw mode.
   */
  interactive(): boolean;
  /** The size right now. */
  size(): ReplTerminalSize;
  /**
   * Hand bytes to the terminal, returning once it has them.
   *
   * An operation rather than a fire-and-forget call, so a slow terminal slows
   * the renderer down instead of queueing frames the user will never see — and
   * an operation rather than a promise, because the wait belongs to the scope
   * doing it. Whatever the host's own write is shaped like, it is converted
   * where it crosses into this one.
   */
  write(bytes: Uint8Array): Operation<void>;
  /** Hand bytes over with no suspension point inside the call. */
  writeNow(bytes: Uint8Array): void;
  /** Turn raw mode on or off. */
  setRaw(raw: boolean): void;
  /**
   * The byte source, as a stream whose resource owns the native reader.
   *
   * A stream rather than an async iterable, because releasing the terminal has
   * to be something a scope can *do* rather than something it can only ask for.
   * An iterator's `return()` is queued behind its own pending `next()`, so a
   * command that decided to leave while a read was outstanding waited for the
   * next keystroke before it finished — the person had already left.
   *
   * The resource is therefore the contract: it registers its cleanup before it
   * acquires anything, and that cleanup actively cancels the outstanding read
   * and waits for the cancellation, so teardown needs no further input. Closing
   * normally means end of input; a read that fails raises.
   */
  input(): Stream<Uint8Array, void>;
  /** Watch for size changes; the returned function stops watching. */
  onResize(listener: () => void): () => void;
}

/** Install one runtime's terminal for the calling scope. */
export function installReplTerminal(host: ReplTerminalCapabilities): Operation<void> {
  return ReplTerminal.around(
    {
      // deno-lint-ignore require-yield
      *interactive(): Operation<boolean> {
        return host.interactive();
      },
      // deno-lint-ignore require-yield
      *size(): Operation<ReplTerminalSize> {
        return host.size();
      },
      *write([bytes]: [Uint8Array]): Operation<void> {
        yield* host.write(bytes);
      },
      writeNow([bytes]: [Uint8Array]): void {
        host.writeNow(bytes);
      },
      // deno-lint-ignore require-yield
      *setRaw([raw]: [boolean]): Operation<void> {
        host.setRaw(raw);
      },
      input(): Stream<Uint8Array, void> {
        // The host's own stream, passed through rather than wrapped: the thing
        // that owns the native reader is the thing that has to be able to cancel
        // it, and that is the runtime adapter.
        return host.input();
      },
      resizes(): Stream<ReplTerminalSize, never> {
        return sizeStream(host);
      },
    },
    { at: "min" },
  );
}

/**
 * A Node-shaped standard input, stated structurally.
 *
 * By value, like every other capability here: this module names no runtime, and
 * two runtimes that happen to spell their standard input the same way may share
 * the code that reads it without either of them being detected.
 */
export interface NodeShapedInput {
  // Deliberately loose in the listener's own parameters: what each event carries
  // is checked where it arrives, and a narrower signature here only makes the
  // real `EventEmitter` fail to match a shape it satisfies.
  // oxlint-disable-next-line typescript/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // oxlint-disable-next-line typescript/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * One owned stream over a Node-shaped standard input.
 *
 * Push-based, because that is what the source is: there is no outstanding read
 * to cancel, only listeners to remove, and removing them is synchronous — so
 * teardown settles without another byte by construction. What arrives before a
 * subscriber asks for it is held rather than dropped: a paste is hundreds of
 * bytes in a few chunks, and a reading that lost the ones nobody had asked for
 * yet would lose most of somebody's entry.
 *
 * The removal is registered before the listeners exist, so a scope cancelled
 * between the two leaves nothing attached: an `ensure` yielded afterwards has
 * established nothing at the moment it is needed.
 */
export function nodeInputStream(stdin: NodeShapedInput): Stream<Uint8Array, void> {
  return resource<Subscription<Uint8Array, void>>(function* (provide) {
    const held: Uint8Array[] = [];
    const encoder = new TextEncoder();
    let ended = false;
    let failure: Error | undefined;
    let ready = withResolvers<void>();
    const wake = (): void => {
      ready.resolve();
    };

    const onData = (chunk: string | Uint8Array): void => {
      held.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      wake();
    };
    const onEnd = (): void => {
      ended = true;
      wake();
    };
    const onError = (cause?: unknown): void => {
      failure = cause instanceof Error ? cause : new Error(String(cause));
      wake();
    };

    let attached = false;
    yield* ensure(() => {
      if (attached) {
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", onError);
        stdin.pause();
        attached = false;
      }
      // Whoever is suspended on the next chunk is being torn down with this
      // resource, and a wait nothing will ever settle is a teardown that hangs.
      ended = true;
      wake();
    });

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    attached = true;
    stdin.resume();

    yield* provide({
      *next(): Operation<IteratorResult<Uint8Array, void>> {
        while (true) {
          if (failure !== undefined) {
            // A live terminal that failed mid-read is a failure, not an ending:
            // the difference decides whether the command ends or raises.
            throw failure;
          }
          const head = held.shift();
          if (head !== undefined) {
            // One suspension per chunk whether it was buffered or not: whoever
            // reads this turns one chunk into many decoded events, and a reader
            // that drained the buffer without yielding would hand them over
            // faster than they are taken and lose the tail. `sleep(0)` because
            // the suspension has to be real — an already-settled resolver reads
            // like a yield point and is completed synchronously, which is no
            // yield point at all.
            yield* sleep(0);
            return { done: false, value: head };
          }
          if (ended) {
            yield* sleep(0);
            return { done: true, value: undefined };
          }
          yield* ready.operation;
          ready = withResolvers<void>();
        }
      },
    });
  });
}

/**
 * Each size the terminal becomes.
 *
 * The size is read when the notification arrives rather than carried by it,
 * because a resize that happens twice in quick succession should deliver where
 * the terminal actually ended up.
 */
function sizeStream(host: ReplTerminalCapabilities): Stream<ReplTerminalSize, never> {
  return resource<Subscription<ReplTerminalSize, never>>(function* (provide) {
    const sizes = createSignal<ReplTerminalSize, never>();
    // Removal registered before the listener exists, for the same reason: a
    // listener attached in a window with no teardown behind it outlives whoever
    // wanted it and sends into a signal nobody is reading.
    let stop: (() => void) | undefined;
    yield* ensure(() => {
      stop?.();
    });
    stop = host.onResize(() => {
      sizes.send(host.size());
    });
    yield* provide(yield* sizes);
  });
}

/**
 * Write every byte through a sink that may take fewer than it was given.
 *
 * A partial write that nobody continued leaves a frame half drawn, which on a
 * terminal means escape sequences cut in the middle. Portable because it is the
 * same loop on every runtime whose write returns a count.
 */
export function* writeAllTo(
  sink: (chunk: Uint8Array) => Operation<number>,
  bytes: Uint8Array,
): Operation<void> {
  let written = 0;
  while (written < bytes.length) {
    const count = yield* sink(bytes.subarray(written));
    if (count <= 0) {
      throw new Error("the terminal accepted none of the bytes it was given");
    }
    written += count;
  }
}

/**
 * The same sink for a host whose write takes a callback instead of returning.
 *
 * Node-shaped streams report completion rather than returning a count, and they
 * handle partial writes themselves — so there is nothing to loop over, only a
 * callback to adapt. `action` is the adapter: the callback settles the operation,
 * and a caller cancelled while waiting stops waiting without the stream being
 * told anything, which is all this can honestly promise about a write already
 * handed to a stream.
 */
export function writeThrough(
  sink: (chunk: Uint8Array, done: (error?: Error | null) => void) => unknown,
  bytes: Uint8Array,
): Operation<void> {
  return action<void>((resolve, reject) => {
    sink(bytes, (error) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
    // Nothing to undo. The bytes are with the stream and the callback is its own
    // one-shot: a cancelled caller stops waiting, and nobody can unsend a write.
    return noop;
  });
}

/** The one thing a write has to undo, which is nothing. */
function noop(): void {}
