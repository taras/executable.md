/**
 * Everything the REPL has to give back, and the one place that gives it back.
 *
 * Opening a terminal for a full-screen interface changes things that belong to
 * whoever ran the command: raw mode, the alternate buffer, the cursor, mouse
 * reporting, the keyboard protocol. Every one of those has to be undone on
 * every way out — the run finishing, a refusal, a failure, a cancellation, and
 * the person closing the input. So there is exactly one owner of all of it, it
 * registers the undo **before** it does the do, and the final reset is written
 * once whatever happened.
 *
 * ## Cleanup before capability
 *
 * Each step here registers its teardown first and only then takes the thing it
 * is undoing. A cancellation that lands between the two orders would otherwise
 * leave a raw terminal with no cursor and nobody left who knows to fix it —
 * which is not a crash, it is a shell the person has to blindly type `reset`
 * into.
 *
 * ## What comes out
 *
 * Normalized events and nothing else. The screen decodes bytes, reads the
 * terminal's size and reports both; it does not know what any of it means. A
 * key is a key, a pointer is a column and a row, a resize is a size, and end of
 * input is a lifecycle outcome rather than a keystroke.
 */

import {
  createSignal,
  ensure,
  type Operation,
  resource,
  spawn,
  type Stream,
  type Subscription,
  type Task,
} from "effection";
import {
  alternateBuffer,
  cursor,
  mouseTracking,
  progressiveInput,
  type Setting,
  settings,
} from "@bomb.sh/tty";
import { ReplTerminal, type ReplTerminalSize } from "./terminal.ts";
import { ReplClock } from "./frame.ts";
import { type ReplPointerAt, useReplDecoder } from "./input.ts";
import type { ReplInputEvent } from "./description.ts";

/** What the screen reports. */
export type ReplScreenEvent =
  | { readonly kind: "input"; readonly event: ReplInputEvent }
  | { readonly kind: "pointer"; readonly at: ReplPointerAt }
  | { readonly kind: "resize"; readonly size: ReplTerminalSize }
  /** Input ended. A lifecycle outcome, not a key. */
  | { readonly kind: "eof" };

/** The open terminal, for as long as its scope lives. */
export interface ReplScreen {
  /** The size as it stands. */
  size(): Operation<ReplTerminalSize>;
  /** Put one rendered frame on the terminal. */
  present(bytes: Uint8Array): Operation<void>;
  /**
   * Everything that happened, in order, from the moment the screen opened.
   *
   * One consumer. The subscription is taken when the screen opens rather than
   * when the caller gets around to reading, so nothing that arrives in between
   * is lost.
   */
  events(): Stream<ReplScreenEvent, void>;
}

/**
 * The modes a full-screen REPL takes, and therefore has to give back.
 *
 * One `Setting`, so there is one `apply` and one `revert` and no way to restore
 * three of four things.
 */
export function replModes(): Setting {
  return settings(
    alternateBuffer({ clear: true }),
    cursor(false),
    mouseTracking(),
    // Level 1: disambiguated escape codes, which is what makes a lone Escape
    // decidable at all on terminals that support it.
    progressiveInput(1),
  );
}

/** Open the terminal for the calling scope. */
export function useReplScreen(options?: { readonly escLatency?: number }): Operation<ReplScreen> {
  return resource<ReplScreen>(function* (provide) {
    const decoder = yield* useReplDecoder(
      options?.escLatency === undefined ? {} : { escLatency: options.escLatency },
    );
    const modes = replModes();

    let restored = false;
    // Registered before the modes are applied, so a cancellation in between
    // still restores. Written once: the flag is what makes "exactly once" true
    // across a teardown that runs after an earlier failure already reset.
    yield* ensure(function* (): Operation<void> {
      if (restored) {
        return;
      }
      restored = true;
      yield* ReplTerminal.operations.setRaw(false);
      yield* ReplTerminal.operations.writeNow(modes.revert);
    });
    yield* ReplTerminal.operations.setRaw(true);
    yield* ReplTerminal.operations.write(modes.apply);

    const events = createSignal<ReplScreenEvent, void>();
    // Subscribed here, not in `events()`: a subscription taken later would miss
    // whatever arrived first, and the first thing that arrives is usually the
    // size the renderer needs.
    const reported: Subscription<ReplScreenEvent, void> = yield* events;

    // Bytes, or nothing at all — which means "the pending Escape's latency
    // expired, scan again with no new input". One queue and therefore one place
    // the scanner ever waits: a scanner waiting on two things would have to race
    // them, and the loser of that race is a read that was already in flight.
    const chunks = createSignal<Uint8Array | undefined, void>();
    const incoming: Subscription<Uint8Array | undefined, void> = yield* chunks;

    let delivered: ReplTerminalSize | undefined;
    function deliverResize(size: ReplTerminalSize): void {
      if (
        delivered !== undefined &&
        delivered.columns === size.columns &&
        delivered.rows === size.rows
      ) {
        // The same size twice is the same frame twice. Terminals report a
        // resize both in band and out of band, and either one is enough.
        return;
      }
      delivered = size;
      events.send({ kind: "resize", size });
    }

    /** Publish what one scan produced. */
    function* publish(bytes?: Uint8Array): Operation<number | undefined> {
      const scan = yield* decoder.scan(bytes);
      for (const event of scan.events) {
        events.send({ kind: "input", event });
      }
      for (const at of scan.pointers) {
        events.send({ kind: "pointer", at });
      }
      if (scan.resized) {
        deliverResize(yield* ReplTerminal.operations.size());
      }
      return scan.pendingFor;
    }

    yield* spawn(function* reader(): Operation<void> {
      const source = yield* ReplTerminal.operations.input();
      while (true) {
        const next = yield* source.next();
        if (next.done === true) {
          chunks.close();
          return;
        }
        chunks.send(next.value);
      }
    });

    yield* spawn(function* scanner(): Operation<void> {
      // The one-shot task that turns a held Escape into an Escape. It exists for
      // exactly as long as the Escape is undecided.
      let latency: Task<void> | undefined;

      while (true) {
        const next = yield* incoming.next();
        if (next.done === true) {
          // Flush first: a held Escape is something the person pressed, and
          // losing it because the stream then ended would be a lost keystroke.
          yield* publish();
          events.send({ kind: "eof" });
          events.close();
          return;
        }

        const waiting = latency;
        latency = undefined;
        if (waiting !== undefined) {
          // Either it fired and sent this, or bytes beat it. Either way it is
          // done, and leaving it running would flush an Escape that the bytes
          // just now decided was part of a sequence.
          yield* waiting.halt();
        }

        // `undefined` is the flush: rescanning with no bytes emits the Escape.
        // Bytes are rescanned with the held prefix still in the decoder, so one
        // sequence is never split into a false Escape followed by text.
        const pending = yield* publish(next.value);
        if (pending !== undefined) {
          latency = yield* spawn(function* (): Operation<void> {
            yield* ReplClock.operations.wait(pending / 1000);
            chunks.send(undefined);
          });
        }
      }
    });

    // Subscribed before the task that reads it, because a task starts a turn
    // after it is spawned and a terminal resized during that turn would be a
    // resize nobody was listening for.
    const sizes: Subscription<ReplTerminalSize, never> = yield* ReplTerminal.operations.resizes();
    yield* spawn(function* watcher(): Operation<void> {
      while (true) {
        const next = yield* sizes.next();
        if (next.done === true) {
          return;
        }
        deliverResize(next.value);
      }
    });

    deliverResize(yield* ReplTerminal.operations.size());

    yield* provide({
      size(): Operation<ReplTerminalSize> {
        return ReplTerminal.operations.size();
      },
      present(bytes: Uint8Array): Operation<void> {
        return ReplTerminal.operations.write(bytes);
      },
      events(): Stream<ReplScreenEvent, void> {
        return {
          // deno-lint-ignore require-yield
          *[Symbol.iterator]() {
            return reported;
          },
        };
      },
    });
  });
}
