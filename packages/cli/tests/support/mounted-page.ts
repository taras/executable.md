/**
 * The running REPL as a page a test drives and reads.
 *
 * Every act is terminal input: keystrokes, and pointer presses at the cell a
 * control was placed in. Every reading is one presented frame: the cells
 * Termless shows once that frame's bytes reached the terminal, beside the
 * control keys, region rectangles, windows and focus the command reported
 * for the same frame through `ReplFrameWitness`. A control is found by its
 * key and a pane by its region, so two `[send]`s are two keys and nothing
 * here reads a border, a prompt column or a focus glyph.
 *
 * External gates — a held append, a held provider turn, a held cancellation —
 * stay with the case, on `page.repl`.
 *
 * This file is the API: the primitives above the frame, and nothing about any
 * particular pane. A pane, rail, drawer or field of this product is composed
 * from `page.field`, `frame().area` and `frame().control` in
 * `repl-page-adapters.ts`, which is where a new one belongs.
 */

import { action, race, sleep } from "effection";
import type { Operation } from "effection";

import { ReplFrameWitness } from "../../src/repl/frame-witness.ts";
import type { ReplPresentedControl, ReplPresentedFrame } from "../../src/repl/frame-witness.ts";
import type { ReplBounds } from "../../src/repl/layout.ts";
import type { ReplTerminalSize } from "../../src/repl/terminal.ts";
import { MOUNTED_DEADLINE_MS, useMountedRepl } from "./mounted-repl.ts";
import type { MountedRepl } from "./mounted-repl.ts";

/** A rectangle of one frame, read as the cells inside it. */
export interface PageArea {
  readonly bounds: ReplBounds;
  /** Each row inside the rectangle, with trailing spaces removed. */
  rows(): string[];
  shows(text: string): boolean;
  /** Whether this control was placed wholly inside the rectangle. */
  contains(key: string): boolean;
  /** The keys of the controls placed inside the rectangle, in draw order. */
  controls(): string[];
}

/** One placed control, with the text drawn in its own cells. */
export interface PageControl extends ReplPresentedControl {
  readonly text: string;
}

/** One presented frame: what the command reported and what the terminal showed. */
export interface PageFrame extends ReplPresentedFrame {
  /** The sequence number of this presentation, from one. */
  readonly index: number;
  /** The visible rows as Termless showed them once this frame was written. */
  readonly rows: readonly string[];
  keys(): string[];
  has(key: string): boolean;
  control(key: string): PageControl | undefined;
  /** A region, viewport or band row by its id, or none where this frame did not place it. */
  area(id: string): PageArea | undefined;
  /** The cells inside any rectangle. */
  within(bounds: ReplBounds): PageArea;
}

/** An editable control and the region its value is drawn in, below its own row. */
export interface PageField {
  readonly key: string;
  /** The value as drawn: the region's rows below the control, trimmed. */
  text(): string;
  focus(): Operation<void>;
  /** Focus the field, type, and wait until the value shows what was typed. */
  type(text: string): Operation<void>;
}

export type PageKey = "Enter" | "Escape" | "Tab" | "Backtab" | "Backspace";

const KEYS: Readonly<Record<PageKey, string>> = Object.freeze({
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backtab: "\x1b[Z",
  Backspace: "\x7f",
});

export interface ReplPage {
  /** The mounted command: its terminal, scripted agent, gates and outcome. */
  readonly repl: MountedRepl;
  /** The latest presented frame. */
  frame(): PageFrame;
  /**
   * Wait for a presented frame this holds of, asking the latest one first.
   *
   * Fails with the frame it last saw when the command ends or the deadline
   * passes first.
   */
  until(what: string, holds: (frame: PageFrame) => boolean): Operation<PageFrame>;
  /** Press Tab until this key holds focus. Refuses a key the frame did not place. */
  focus(key: string): Operation<void>;
  /** Press the pointer on this control's first cell. Waits for nothing. */
  press(key: string): Operation<void>;
  /** Send one named key. Waits for nothing. */
  key(name: PageKey): Operation<void>;
  /** Send text to whatever holds focus. Waits for nothing. */
  type(text: string): Operation<void>;
  /** Resize the terminal and wait for the first frame of that size. */
  resize(size: ReplTerminalSize): Operation<PageFrame>;
  /**
   * An editable control, with its value read from the region that draws it.
   *
   * The one composition a pane adapter needs and cannot write itself: typing
   * is finished by the value showing what was typed, which is a question about
   * the frames after the keystroke.
   */
  field(key: string, region: string): PageField;
  /** What `until` reports a frame as, for an adapter's own refusal message. */
  describe(): string;
}

function inside(outer: ReplBounds, inner: ReplBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The facts and cells of one presentation, with the readers a case asks them through. */
function pageFrame(facts: ReplPresentedFrame, index: number, cells: string[][]): PageFrame {
  const rows = cells.map((line) => line.join("").trimEnd());
  const within = (bounds: ReplBounds): PageArea => {
    const read = (): string[] =>
      cells.slice(bounds.y, bounds.y + bounds.height).map((line) =>
        line
          .slice(bounds.x, bounds.x + bounds.width)
          .join("")
          .trimEnd(),
      );
    return {
      bounds,
      rows: read,
      shows: (text) => read().some((line) => line.includes(text)),
      contains: (key) => {
        const placed = facts.controls.find((one) => one.key === key);
        return placed !== undefined && inside(bounds, placed.bounds);
      },
      controls: () =>
        facts.controls.filter((one) => inside(bounds, one.bounds)).map((one) => one.key),
    };
  };
  return {
    ...facts,
    index,
    rows,
    keys: () => facts.controls.map((one) => one.key),
    has: (key) => facts.controls.some((one) => one.key === key),
    control: (key) => {
      const placed = facts.controls.find((one) => one.key === key);
      return placed === undefined
        ? undefined
        : { ...placed, text: within(placed.bounds).rows().join("\n").trim() };
    },
    area: (id) => {
      const bounds = facts.regions.get(id);
      return bounds === undefined ? undefined : within(bounds);
    },
    within,
  };
}

function described(frame: PageFrame | undefined): string {
  if (frame === undefined) {
    return "no frame was presented";
  }
  const { columns, rows } = frame.size;
  return (
    `frame ${frame.index} at ${columns}x${rows} (${frame.profile}), focus ${frame.focused}, ` +
    `controls ${JSON.stringify(frame.keys())}, rows ` +
    JSON.stringify(frame.rows.map((line) => line.trim()).filter((line) => line.length > 0))
  );
}

/**
 * Mount the real command and wait for its first frame whose focus is placed.
 *
 * Takes the same options as `useMountedRepl`. The witness is installed in this
 * scope before the command is spawned, so every frame it presents is seen.
 */
export function* useReplPage(
  options: Parameters<typeof useMountedRepl>[0] = {},
): Operation<ReplPage> {
  let latest: PageFrame | undefined;
  let count = 0;
  const wakers = new Set<() => void>();
  let terminal: MountedRepl["terminal"] | undefined;

  yield* ReplFrameWitness.around({
    *presented([facts], next) {
      const screen = terminal?.screen;
      if (screen !== undefined) {
        count += 1;
        latest = pageFrame(facts, count, screen.cells());
        for (const wake of Array.from(wakers)) {
          wake();
        }
      }
      yield* next(facts);
    },
  });

  const repl = yield* useMountedRepl(options);
  terminal = repl.terminal;

  const presentedAfter = (seen: number): Operation<void> =>
    action<void>((resolve) => {
      if (count > seen) {
        resolve();
        return () => {};
      }
      const one = (): void => resolve();
      wakers.add(one);
      return () => {
        wakers.delete(one);
      };
    });
  function* ended(): Operation<void> {
    while (repl.terminal.ending === undefined) {
      yield* repl.terminal.after(repl.terminal.drawn);
    }
  }
  const after = (seen: number): Operation<void> => race([presentedAfter(seen), ended()]);

  const frame = (): PageFrame => {
    if (latest === undefined) {
      throw new Error("the command has presented no frame yet");
    }
    return latest;
  };

  function* until(what: string, holds: (frame: PageFrame) => boolean): Operation<PageFrame> {
    return yield* race([
      (function* (): Operation<PageFrame> {
        while (true) {
          const seen = count;
          if (latest !== undefined && holds(latest)) {
            return latest;
          }
          const ending = repl.terminal.ending;
          if (ending !== undefined) {
            throw (
              ending.failure ?? new Error(`the command ended before ${what}. ${described(latest)}`)
            );
          }
          yield* after(seen);
        }
      })(),
      (function* (): Operation<PageFrame> {
        yield* sleep(MOUNTED_DEADLINE_MS);
        throw new Error(
          `${what} was never presented within ${MOUNTED_DEADLINE_MS}ms. ${described(latest)}`,
        );
      })(),
    ]);
  }

  const placed = (key: string): ReplPresentedControl => {
    const found = latest?.controls.find((one) => one.key === key);
    if (found === undefined) {
      throw new Error(`no control ${key} is placed. ${described(latest)}`);
    }
    return found;
  };

  function* focus(key: string): Operation<void> {
    const limit = frame().controls.length + 1;
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      const now = frame();
      if (now.focused === key) {
        return;
      }
      placed(key);
      repl.terminal.feed(KEYS.Tab);
      yield* until(`focus moving toward ${key}`, (one) => one.focused !== now.focused);
    }
    throw new Error(`focus never reached ${key} in ${limit} presses. ${described(latest)}`);
  }

  function* press(key: string): Operation<void> {
    const { bounds } = placed(key);
    repl.terminal.feed(`\x1b[<0;${bounds.x + 1};${bounds.y + 1}M`);
  }

  function* sendKey(name: PageKey): Operation<void> {
    repl.terminal.feed(KEYS[name]);
  }

  function* type(text: string): Operation<void> {
    repl.terminal.feed(text);
  }

  function* resize(size: ReplTerminalSize): Operation<PageFrame> {
    const from = count;
    repl.terminal.resized(size);
    return yield* until(
      `a frame at ${size.columns}x${size.rows}`,
      (one) => one.index > from && one.size.columns === size.columns && one.size.rows === size.rows,
    );
  }

  const field = (fieldKey: string, region: string): PageField => {
    const text = (): string => {
      const now = frame();
      const area = now.area(region);
      const control = now.control(fieldKey);
      if (area === undefined || control === undefined) {
        return "";
      }
      const below = control.bounds.y + control.bounds.height - area.bounds.y;
      return area.rows().slice(below).join("\n").trim();
    };
    return {
      key: fieldKey,
      text,
      focus: () => focus(fieldKey),
      *type(typed) {
        yield* focus(fieldKey);
        const held = text();
        repl.terminal.feed(typed);
        yield* until(`${fieldKey} holding ${JSON.stringify(held + typed)}`, () =>
          text().includes(held + typed),
        );
      },
    };
  };

  yield* until(
    "a first frame with its focus placed",
    (one) => one.profile === "too-small" || one.controls.some((c) => c.key === one.focused),
  );

  return {
    repl,
    frame,
    until,
    focus,
    press,
    key: sendKey,
    type,
    resize,
    field,
    describe: () => described(latest),
  };
}
