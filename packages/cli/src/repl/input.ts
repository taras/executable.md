/**
 * Turning terminal bytes into the events the tree already understands.
 *
 * Framed paste is text, including bytes that otherwise name keyboard commands.
 * Its payload waits for the closing marker so UTF-8 and line separators can
 * cross reads without becoming partial text or submission keys.
 *
 * The tty scanner decodes ordinary input; this decides which decoded events the
 * composition layer has a meaning for and hands them over in its own closed
 * shape. Nothing here knows an action name: a normalized event says what
 * happened and where, and what it means is decided by whichever mounted node
 * handles it.
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

import {
  createInput,
  type Input,
  type InputEvent,
  type ScanResult,
} from "../../generated/tty/mod.js";
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
  readonly wheel?: { readonly direction: "up" | "down"; readonly at: ReplPointerAt };
}

export type ReplPhysicalInput =
  | { readonly kind: "input"; readonly event: ReplInputEvent }
  | { readonly kind: "pointer"; readonly at: ReplPointerAt }
  | { readonly kind: "wheel"; readonly direction: "up" | "down"; readonly at: ReplPointerAt };

/**
 * The keys this composition layer has a meaning for.
 *
 * Everything else a terminal can send is decoded and then dropped here rather
 * than invented into an action: a key nothing handles is not an event the tree
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
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
]);

/**
 * The two Alt chords that are keys rather than letters.
 *
 * Alt+Up and Alt+Down step to the neighbouring control from inside a field,
 * whose plain arrows move its caret. They carry no text, so naming them cannot
 * type the letter a chord was pressed with.
 */
const ALT_KEYS: ReadonlyMap<string, ReplKey> = new Map([
  ["ArrowUp", "Alt+ArrowUp"],
  ["ArrowDown", "Alt+ArrowDown"],
]);

/**
 * The physical key an unframed LF arrives as.
 *
 * An unframed newline arrives as `LF`, and the decoder reports `LF` as
 * Control-J with no text of its own. Pasting a multi-line document is the whole
 * point of an XMD draft, so this one chord is text — and it is the only chord
 * that is.
 */
const NEWLINE_CHORD = "j";

/**
 * Whether this press is an Enter a terminal sent to mean a newline.
 *
 * Terminal.app sends Shift+Return as `ESC CR`, which the decoder reports as
 * Enter with both Alt and Control held, so Control+Alt+Enter is the same
 * newline wherever a terminal can send it. Under progressive keyboard input a
 * shifted Enter arrives as Enter carrying only a shift. Plain Enter stays the
 * submission key.
 */
function newlineEnter(event: Extract<InputEvent, { type: "keydown" | "keyrepeat" }>): boolean {
  if (event.code !== "Enter") {
    return false;
  }
  if (event.alt === true && event.ctrl === true) {
    return event.shift !== true;
  }
  return event.shift === true && event.alt !== true && event.ctrl !== true;
}

/**
 * The physical key an interrupt arrives as.
 *
 * Raw mode clears `ISIG`, so Control-C raises no signal and the byte is the only
 * notice this command gets that somebody asked it to stop. Dropping it with the
 * other chords left the reflex every terminal program answers doing nothing at
 * all, with nothing on screen saying why.
 *
 * It is named as a key rather than decided here, because what a keystroke means
 * is not this module's to say. `Interrupt` is what was pressed; the focused
 * Message clears with it, and anywhere else the program leaves.
 */
const INTERRUPT_CHORD = "c";

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
 * Control-Shift-Tab stays a chord nothing handles rather than becoming a way to
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
 *
 * Control-J and Control+Alt+Enter supply newline text. Control-C, Control-G,
 * Alt+Up and Alt+Down supply named keys. Other Control or Alt combinations
 * are dropped whole.
 */
export function normalize(event: InputEvent): ReplNormalized {
  if (event.type === "keydown" || event.type === "keyrepeat") {
    if (
      (event.ctrl === true && event.alt !== true && event.code === NEWLINE_CHORD) ||
      newlineEnter(event)
    ) {
      return { event: Object.freeze({ kind: "text", text: "\n" }), at: undefined };
    }
    if (event.ctrl === true && event.alt !== true && event.code === INTERRUPT_CHORD) {
      return { event: Object.freeze({ kind: "key", key: "Interrupt" }), at: undefined };
    }
    if (event.ctrl === true && event.alt !== true && event.shift !== true && event.code === "g") {
      return { event: Object.freeze({ kind: "key", key: "Ctrl+G" }), at: undefined };
    }
    const neighbour = event.ctrl === true ? undefined : ALT_KEYS.get(event.code);
    if (event.alt === true && neighbour !== undefined) {
      return { event: Object.freeze({ kind: "key", key: neighbour }), at: undefined };
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
  if (event.type === "wheel") {
    return {
      event: undefined,
      at: undefined,
      wheel: { direction: event.direction, at: { column: event.x, row: event.y } },
    };
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
  readonly ordered: readonly ReplPhysicalInput[];
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
 * something a mounted node handles.
 */
export function scanInput(input: Input, bytes?: Uint8Array): ReplInputScan {
  const result: ScanResult = bytes === undefined ? input.scan() : input.scan(bytes);
  const events: ReplInputEvent[] = [];
  const ordered: ReplPhysicalInput[] = [];
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
      ordered.push({ kind: "input", event: normalized.event });
    }
    if (normalized.at !== undefined) {
      pointers.push(normalized.at);
      ordered.push({ kind: "pointer", at: normalized.at });
    }
    if (normalized.wheel !== undefined) {
      ordered.push({ kind: "wheel", ...normalized.wheel });
    }
  }

  return Object.freeze({
    ordered: Object.freeze(ordered),
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
  const settings = { escLatency: options.escLatency ?? 25 };
  return resource<ReplDecoder>(function* (provide) {
    let input: Input = yield* until(createInput(settings));
    let prefix: number[] = [];
    let paste: number[] | undefined;
    const opening = new TextEncoder().encode("\x1b[200~");
    const closing = new TextEncoder().encode("\x1b[201~");

    function* keys(bytes?: Uint8Array): Operation<ReplInputScan> {
      const drained = drain(input, bytes);
      const settling =
        bytes === undefined && drained.pendingFor !== undefined && drained.ordered.length === 0;
      if (!settling) {
        return drained;
      }
      // The spent ESC otherwise joins the next keystroke as an Alt modifier.
      input = yield* until(createInput(settings));
      return Object.freeze({
        ordered: Object.freeze([{ kind: "input", event: ESCAPE } satisfies ReplPhysicalInput]),
        events: Object.freeze([ESCAPE]),
        pointers: Object.freeze([]),
        resized: drained.resized,
        pendingFor: undefined,
      });
    }

    yield* provide({
      *scan(bytes?: Uint8Array): Operation<ReplInputScan> {
        const passes: ReplInputScan[] = [];
        let ordinary: number[] = [];
        if (bytes === undefined) {
          if (paste === undefined && prefix.length > 0) {
            passes.push(yield* keys(Uint8Array.from(prefix)));
            prefix = [];
          }
          passes.push(yield* keys());
        } else {
          for (const byte of bytes) {
            if (paste !== undefined) {
              paste.push(byte);
              if (
                paste.length >= closing.length &&
                closing.every(
                  (one, index) => paste?.[paste.length - closing.length + index] === one,
                )
              ) {
                const text = new TextDecoder()
                  .decode(Uint8Array.from(paste.slice(0, -closing.length)))
                  .replace(/\r\n|\r/g, "\n");
                const event: ReplInputEvent = Object.freeze({ kind: "text", text });
                passes.push({
                  ordered: [{ kind: "input", event }],
                  events: [event],
                  pointers: [],
                  resized: false,
                  pendingFor: undefined,
                });
                paste = undefined;
              }
              continue;
            }
            if (prefix.length > 0 && byte !== opening[prefix.length]) {
              ordinary.push(...prefix);
              prefix = [];
            }
            if (byte === opening[prefix.length]) {
              prefix.push(byte);
              if (prefix.length === opening.length) {
                passes.push(yield* keys(Uint8Array.from(ordinary)));
                ordinary = [];
                prefix = [];
                paste = [];
              }
            } else {
              ordinary.push(byte);
            }
          }
          passes.push(yield* keys(Uint8Array.from(ordinary)));
        }
        return Object.freeze({
          ordered: Object.freeze(passes.flatMap((pass) => pass.ordered)),
          events: Object.freeze(passes.flatMap((pass) => pass.events)),
          pointers: Object.freeze(passes.flatMap((pass) => pass.pointers)),
          resized: passes.some((pass) => pass.resized),
          pendingFor:
            prefix.length === 1
              ? settings.escLatency
              : prefix.length > 1 || paste !== undefined
                ? undefined
                : passes.at(-1)?.pendingFor,
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
  const ordered: ReplPhysicalInput[] = [];
  const pointers: ReplPointerAt[] = [];
  let resized = false;
  let pendingFor: number | undefined;
  let first = true;

  while (true) {
    const pass = first && bytes !== undefined ? scanInput(input, bytes) : scanInput(input);
    first = false;
    ordered.push(...pass.ordered);
    events.push(...pass.events);
    pointers.push(...pass.pointers);
    resized = resized || pass.resized;
    pendingFor = pass.pendingFor;
    if (pass.ordered.length === 0 && !pass.resized) {
      return Object.freeze({
        ordered: Object.freeze(ordered),
        events: Object.freeze(events),
        pointers: Object.freeze(pointers),
        resized,
        pendingFor,
      });
    }
  }
}
