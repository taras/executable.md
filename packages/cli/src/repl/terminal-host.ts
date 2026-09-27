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
  createSignal,
  ensure,
  type Operation,
  resource,
  type Stream,
  type Subscription,
  until,
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
  /** The size right now. */
  size(): ReplTerminalSize;
  /**
   * Hand bytes to the terminal, resolving once it has them.
   *
   * A promise rather than a fire-and-forget call, so a slow terminal slows the
   * renderer down instead of queueing frames the user will never see.
   */
  write(bytes: Uint8Array): Promise<void>;
  /** Hand bytes over with no suspension point inside the call. */
  writeNow(bytes: Uint8Array): void;
  /** Turn raw mode on or off. */
  setRaw(raw: boolean): void;
  /**
   * Open the byte source.
   *
   * Called once per subscriber and closed when that subscriber's scope ends,
   * which is what releases the terminal's input for whatever runs next.
   */
  bytes(): AsyncIterable<Uint8Array>;
  /** Watch for size changes; the returned function stops watching. */
  onResize(listener: () => void): () => void;
}

/** Install one runtime's terminal for the calling scope. */
export function installReplTerminal(host: ReplTerminalCapabilities): Operation<void> {
  return ReplTerminal.around(
    {
      // deno-lint-ignore require-yield
      *size(): Operation<ReplTerminalSize> {
        return host.size();
      },
      *write([bytes]: [Uint8Array]): Operation<void> {
        yield* until(host.write(bytes));
      },
      writeNow([bytes]: [Uint8Array]): void {
        host.writeNow(bytes);
      },
      // deno-lint-ignore require-yield
      *setRaw([raw]: [boolean]): Operation<void> {
        host.setRaw(raw);
      },
      input(): Stream<Uint8Array, void> {
        return byteStream(host);
      },
      resizes(): Stream<ReplTerminalSize, never> {
        return sizeStream(host);
      },
    },
    { at: "min" },
  );
}

/**
 * The host's bytes, pulled one chunk at a time.
 *
 * Pulled, not pushed: the subscriber's `next()` is what asks the host for more,
 * so an input burst cannot outrun whatever is decoding it and nothing has to
 * buffer on its behalf.
 */
function byteStream(host: ReplTerminalCapabilities): Stream<Uint8Array, void> {
  return resource<Subscription<Uint8Array, void>>(function* (provide) {
    // Declared first, released second, opened third. Opening the source before
    // its release was registered leaves a window where a cancellation abandons a
    // reader holding the terminal's input, and nothing is left that knows to
    // close it.
    let iterator: AsyncIterator<Uint8Array> | undefined;
    yield* ensure(function* () {
      const open = iterator;
      if (open === undefined) {
        return;
      }
      const close = open.return;
      if (close !== undefined) {
        // Releasing the source is what lets the next thing to run read the
        // terminal; a reader left open holds input away from it.
        yield* until(close.call(open));
      }
    });
    iterator = host.bytes()[Symbol.asyncIterator]();

    const reading = iterator;
    yield* provide({
      *next(): Operation<IteratorResult<Uint8Array, void>> {
        const result = yield* until(reading.next());
        if (result.done === true) {
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
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
export function writeAllTo(
  sink: (chunk: Uint8Array) => Promise<number>,
  bytes: Uint8Array,
): Promise<void> {
  let written = 0;
  const step = (): Promise<void> => {
    if (written >= bytes.length) {
      return Promise.resolve();
    }
    return sink(bytes.subarray(written)).then((count) => {
      if (count <= 0) {
        return Promise.reject(new Error("the terminal accepted none of the bytes it was given"));
      }
      written += count;
      return step();
    });
  };
  return step();
}

/**
 * The same sink for a host whose write takes a callback instead of returning.
 *
 * Node-shaped streams report completion rather than a count and handle partial
 * writes themselves, so there is nothing to loop over — only a callback to turn
 * into the promise the capability promises.
 */
export function writeThrough(
  sink: (chunk: Uint8Array, done: (error?: Error | null) => void) => unknown,
  bytes: Uint8Array,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sink(bytes, (error) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/**
 * A byte source built from one that may hand back text.
 *
 * Node-shaped standard input yields strings when an encoding was set on it, and
 * the decoder downstream reads bytes; converting here keeps that difference out
 * of the shared input path. Written with promise combinators rather than `async
 * function*`, which this repository does not use.
 */
export function decodedChunks(
  source: AsyncIterable<string | Uint8Array>,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iterator = source[Symbol.asyncIterator]();
      const close = iterator.return;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          return iterator.next().then((result) => {
            if (result.done === true) {
              return { done: true, value: undefined };
            }
            const chunk = result.value;
            return {
              done: false,
              value: typeof chunk === "string" ? encoder.encode(chunk) : chunk,
            };
          });
        },
        ...(close === undefined
          ? {}
          : {
              return(): Promise<IteratorResult<Uint8Array>> {
                return close.call(iterator).then(() => ({ done: true, value: undefined }));
              },
            }),
      };
    },
  };
}
