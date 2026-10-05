/**
 * Turning terminal bytes into the events the tree already understands.
 *
 * The tty scanner does the decoding; this decides which decoded events the
 * composition layer has a meaning for and hands them over in its own closed
 * shape. Nothing here knows an action name: a normalized event says what
 * happened and where, and what it means is decided by whichever mounted node
 * claims it.
 *
 * ## A lone Escape is not yet Escape
 *
 * `ESC` begins most of the sequences a terminal sends, so a scanner that saw
 * one and nothing else cannot know whether a person pressed Escape or an arrow
 * key is still arriving. It says so, with a latency to wait. Two things can
 * happen next. More bytes arrive, and they are rescanned *with the pending
 * prefix still held*, so one sequence is never split into a false Escape
 * followed by text — that one the scanner does itself. Or the latency expires
 * with nothing following, and the held byte was the Escape key.
 *
 * The scanner in `@bomb.sh/tty` 0.9.0 does not resolve that second case:
 * rescanning with no bytes, as its documentation describes, returns the same
 * pending report and no event, however many times it is called. So the decision
 * is made here, where it is a normalization decision rather than a decoding
 * one: a scan with nothing new that still reports a held Escape *is* the
 * Escape, because "pending" means the scanner is holding a lone `ESC` and
 * nothing followed it within the latency it asked for.
 *
 * Emitting it leaves the spent `ESC` in the scanner's buffer, where it would
 * join the next keystroke and turn an `a` into an Alt-`a`. There is no way to
 * clear that buffer, so the decoder is replaced instead. That costs one
 * instantiation, and only when somebody actually presses Escape by itself.
 *
 * ## One scan is not one chunk
 *
 * The same scanner returns at most 128 events per call and keeps the rest of the
 * bytes buffered, so a pasted document arrives over several scans. A host that
 * scanned once per chunk would silently drop everything past the 128th
 * character of a paste — which for this REPL means most of an entry. So a scan
 * here means "scan until the buffer stops producing", and the events of all
 * those passes are one result in the order the terminal sent them.
 */

import { createInput, type Input, type InputEvent, type ScanResult } from "@bomb.sh/tty";
import { type Operation, resource, until } from "effection";

import type { ReplInputEvent, ReplKey } from "./description.ts";

/** Where a pointer event landed, before any frame has been consulted. */
export interface ReplPointerAt {
  readonly column: number;
  readonly row: number;
}

/** A normalized event together with where a pointer one landed. */
export interface ReplNormalized {
  readonly event: ReplInputEvent | undefined;
  readonly at: ReplPointerAt | undefined;
}

/**
 * The keys this composition layer has a meaning for.
 *
 * Everything else a terminal can send is decoded and then dropped here rather
 * than invented into an action: a key nothing claims is not an event the tree
 * should be asked about.
 *
 * `Backspace` is the terminal's `DEL` (`0x7f`), which is what a keyboard's
 * Backspace key actually sends. `0x08` decodes as Control-H and is a chord, not
 * this key.
 */
const KEYS: ReadonlyMap<string, ReplKey> = new Map([
  ["Enter", "Enter"],
  ["Escape", "Escape"],
  ["Tab", "Tab"],
  ["Backtab", "Backtab"],
  ["Backspace", "Backspace"],
]);

/**
 * The physical key a pasted newline arrives as.
 *
 * A terminal sends `LF` inside a paste, and the decoder reports `LF` as
 * Control-J with no text of its own. Pasting a multi-line document is the whole
 * point of an XMD draft, so this one chord is text — and it is the only chord
 * that is.
 */
const NEWLINE_CHORD = "j";

/**
 * Whether this press is a shifted Tab, which is the same keystroke as Backtab.
 *
 * A terminal has two ways to say it. Legacy mode sends `ESC [ Z`, which the
 * decoder reports as its own `Backtab` code. Under the progressive keyboard
 * input this screen asks for, the same key arrives as `Tab` carrying a shift,
 * because that protocol reports a physical key and its modifiers rather than a
 * sequence naming the pair. Both are a reader asking to go back, so both say
 * so here, where the spelling stops mattering.
 *
 * Control is not consulted: a chord is dropped before this is asked, so
 * Control-Shift-Tab stays a chord nothing claims rather than becoming a way to
 * traverse.
 */
function backward(event: Extract<InputEvent, { type: "keydown" | "keyrepeat" }>): boolean {
  return event.code === "Tab" && event.shift === true;
}

/**
 * Normalize one decoded event.
 *
 * A pointer event carries where it landed but no target: which node is there is
 * the committed frame's answer, and asking the decoder to know it would put the
 * frame's geometry in two places.
 *
 * Text comes from the payload the decoder produced, never from the physical key
 * code. A chord's code is a letter — Control-C is `c`, Alt-a is `a` — so reading
 * the code would type the letter somebody pressed Control with, which is how an
 * editor ends up inserting a `c` when a person asked it to stop.
 */
export function normalize(event: InputEvent): ReplNormalized {
  if (event.type === "keydown" || event.type === "keyrepeat") {
    if (event.ctrl === true && event.alt !== true && event.code === NEWLINE_CHORD) {
      return { event: Object.freeze({ kind: "text", text: "\n" }), at: undefined };
    }
    if (event.ctrl === true || event.alt === true) {
      // A chord nothing here claims. Dropped whole, payload included.
      return { event: undefined, at: undefined };
    }
    const key = KEYS.get(backward(event) ? "Backtab" : event.code);
    if (key !== undefined) {
      return { event: Object.freeze({ kind: "key", key }), at: undefined };
    }
    const text = event.text;
    if (text !== undefined && text.length > 0) {
      // As decoded: shifted, accented and multi-byte text all arrive here
      // already assembled, and a string cannot be changed by whoever receives it.
      return { event: Object.freeze({ kind: "text", text }), at: undefined };
    }
    return { event: undefined, at: undefined };
  }
  if (event.type === "mousedown" && event.button === "left") {
    // The target is filled in by whoever holds the current frame; until then
    // this is a position and nothing more.
    return { event: undefined, at: { column: event.x, row: event.y } };
  }
  return { event: undefined, at: undefined };
}

/** What one scan of the terminal's bytes produced. */
export interface ReplInputScan {
  /** Normalized keys and text, in the order the terminal sent them. */
  readonly events: readonly ReplInputEvent[];
  readonly pointers: readonly ReplPointerAt[];
  readonly resized: boolean;
  /**
   * Milliseconds to wait before rescanning with no bytes, when a lone Escape is
   * held. Absent when nothing is pending.
   */
  readonly pendingFor: number | undefined;
}

/**
 * Scan bytes, or rescan with none to settle a pending Escape.
 *
 * Resize arrives here because the scanner decodes it, and leaves again as a
 * flag rather than an event: it is a host fact about the terminal, not
 * something a mounted node claims.
 */
export function scanInput(input: Input, bytes?: Uint8Array): ReplInputScan {
  const result: ScanResult = bytes === undefined ? input.scan() : input.scan(bytes);
  const events: ReplInputEvent[] = [];
  const pointers: ReplPointerAt[] = [];
  let resized = false;

  for (const event of result.events) {
    if (event.type === "resize") {
      resized = true;
      continue;
    }
    const normalized = normalize(event);
    if (normalized.event !== undefined) {
      events.push(normalized.event);
    }
    if (normalized.at !== undefined) {
      pointers.push(normalized.at);
    }
  }

  return Object.freeze({
    events: Object.freeze(events),
    pointers: Object.freeze(pointers),
    resized,
    pendingFor: result.pending?.delay,
  });
}

/** The one Escape a flush can decide on. */
const ESCAPE: ReplInputEvent = Object.freeze({ kind: "key", key: "Escape" });

/** A scanner that also settles a held Escape. */
export interface ReplDecoder {
  /**
   * Scan bytes, or settle a held Escape by scanning with none.
   *
   * An operation because settling one replaces the scanner, and replacing it
   * means building one.
   */
  scan(bytes?: Uint8Array): Operation<ReplInputScan>;
}

/** Open a decoder owned by the calling scope. */
export function useReplDecoder(
  options: { readonly escLatency?: number } = {},
): Operation<ReplDecoder> {
  const settings = options.escLatency === undefined ? {} : { escLatency: options.escLatency };
  return resource<ReplDecoder>(function* (provide) {
    let input: Input = yield* until(createInput(settings));
    yield* provide({
      *scan(bytes?: Uint8Array): Operation<ReplInputScan> {
        const drained = drain(input, bytes);
        const settling =
          bytes === undefined &&
          drained.pendingFor !== undefined &&
          drained.events.length === 0 &&
          drained.pointers.length === 0;
        if (!settling) {
          return drained;
        }
        // Nothing followed the held ESC, so it was the key. A fresh scanner,
        // because the spent byte is still in this one's buffer and would
        // otherwise become the first byte of whatever is typed next.
        input = yield* until(createInput(settings));
        return Object.freeze({
          events: Object.freeze([ESCAPE]),
          pointers: Object.freeze([]),
          resized: drained.resized,
          pendingFor: undefined,
        });
      },
    });
  });
}

/**
 * Everything the scanner has, not just the first 128 of it.
 *
 * Each pass after the first is a scan with no new bytes, which is how the
 * scanner hands over what it still holds. Draining stops when a pass produces
 * nothing, and the last pass's pending report is the one that is still true.
 */
function drain(input: Input, bytes?: Uint8Array): ReplInputScan {
  const events: ReplInputEvent[] = [];
  const pointers: ReplPointerAt[] = [];
  let resized = false;
  let pendingFor: number | undefined;
  let first = true;

  while (true) {
    const pass = first && bytes !== undefined ? scanInput(input, bytes) : scanInput(input);
    first = false;
    events.push(...pass.events);
    pointers.push(...pass.pointers);
    resized = resized || pass.resized;
    pendingFor = pass.pendingFor;
    if (pass.events.length === 0 && pass.pointers.length === 0 && !pass.resized) {
      return Object.freeze({
        events: Object.freeze(events),
        pointers: Object.freeze(pointers),
        resized,
        pendingFor,
      });
    }
  }
}
