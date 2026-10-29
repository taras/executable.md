/**
 * The panes, fields and drawers of this product, named for a test author.
 *
 * Each adapter is composed from the page API's primitives: a control key, a
 * region id, and `page.field` where a value is typed. They hold the product's
 * identities — `footer:input`, `box:draft`, `sidekick:send`, `box:inspection`,
 * `box:drawer:layer` — so a case says `draft(page).type(...)` rather than
 * repeating them, and a layout change that renames one is edited here.
 *
 * This is where a new adapter belongs: a History rail, the catalog, the
 * transcript, a form field. An adapter reads `frame().area`, `frame().control`
 * and `page.field` only. It never reads a border, a prompt column or a focus
 * glyph, and it never builds a view or a state.
 */

import { race, sleep, withResolvers } from "effection";
import type { Operation } from "effection";

import { ReplFrameWitness } from "../../src/repl/frame-witness.ts";
import { MOUNTED_DEADLINE_MS } from "./mounted-repl.ts";
import type { PageArea, PageField, PageFrame, ReplPage } from "./mounted-page.ts";

/** Whether any visible row of this frame contains the text. */
export function shows(frame: PageFrame, text: string): boolean {
  return frame.rows.some((line) => line.includes(text));
}

/** Whether the screen shows this utterance, attributed to a person here. */
export function saidByPerson(frame: PageFrame, text: string): boolean {
  return shows(frame, `[U] ${text}`);
}

/** Whether the screen shows this utterance, attributed to the Sidekick. */
export function saidBySidekick(frame: PageFrame, text: string): boolean {
  return shows(frame, `[S] ${text}`);
}

/** The mark the History rail gives an outcome, in the rail's own words for it. */
const RAIL_MARKS: Readonly<Record<string, string>> = Object.freeze({
  ok: "\u2713",
  err: "\u00d7",
  cancelled: "-",
  unfinished: "\u25cf",
});

/** The mark the History rail gives one entry, or none where this frame names none. */
export function railMark(frame: PageFrame, order: number): string | undefined {
  const band = frame.area("box:history")?.rows().join(" ") ?? "";
  const rail = band.split("\u2500\u2500")[0] ?? "";
  return new RegExp(`(?:^|\\s)${order}\\s*([\\u2713\\u00d7\\u25cf\\u002dU])`).exec(rail)?.[1];
}

/** Wait until the rail marks this entry with the mark this outcome has. */
export function entrySettles(
  page: ReplPage,
  order: number,
  outcome: keyof typeof RAIL_MARKS,
): Operation<PageFrame> {
  return page.until(
    `entry ${order} reaching ${outcome}`,
    (frame) => railMark(frame, order) === RAIL_MARKS[outcome],
  );
}

/** The entry Draft: the field a submission is typed into, and its own pane. */
export function draft(page: ReplPage): PageField {
  return page.field("footer:input", "box:draft");
}

/** A floating layer, opened by some control and closed with Escape. */
export interface PageDrawer {
  isOpen(): boolean;
  /** The layer's own rectangle, or a refusal naming the frame that has none. */
  area(): PageArea;
  /** Focus the drawer control whose text includes this label and press Enter on it. */
  choose(label: string): Operation<string>;
  /** Press Escape and wait for the layer to go. */
  dismiss(): Operation<void>;
}

/** The Sidekick's pane: its column, its composer, its own Send and Stop. */
export interface PageSidekick {
  /** The pane's rectangle, or none at a size that does not place it. */
  area(): PageArea | undefined;
  readonly composer: PageField;
  /** Its own Stop placed and its own Send not. */
  working(): boolean;
  /** Type into the composer, press the pane's own Send once it is offered, and wait for the composer to empty. */
  send(text: string): Operation<void>;
  /**
   * Press the pane's own Stop, or the one its open question form wears.
   * Waits for nothing: what Stop does is the case's question.
   */
  stop(): Operation<void>;
  /** Its own Send offered and its own Stop gone. */
  idle(): boolean;
}

const LAYER = "box:drawer:layer";

const ENCODER = new TextEncoder();

/** Paste into a field as one chunk and wait until the last line shows in its region. */
export function* paste(page: ReplPage, field: PageField, text: string): Operation<void> {
  const flat = (words: string): string => words.replace(/\s+/g, " ").trim();
  const last = flat(text.trim().split("\n").at(-1) ?? "");
  yield* field.focus();
  page.repl.terminal.bytes(ENCODER.encode(text));
  yield* page.until(`${field.key} holding the pasted text`, () =>
    flat(field.text()).includes(last),
  );
}

/** The pane the inspection column is reading: the Sidekick when its composer is placed. */
export function shownPane(frame: PageFrame): "sidekick" | "bindings" {
  return frame.has("sidekick:message") ? "sidekick" : "bindings";
}

/** Choose a pane by its tab, the way a person does: focus it and press Enter. */
export function* selectPane(page: ReplPage, pane: "sidekick" | "bindings"): Operation<void> {
  yield* page.focus(`tab:${pane}`);
  yield* page.key("Enter");
  yield* page.until(`the ${pane} pane being read`, (frame) => shownPane(frame) === pane);
}

/** One field of the form a question or Configure opens in the drawer. */
export interface PageFormValue {
  readonly key: string;
  /** The value as drawn after the field's `=`. */
  text(): string;
  focus(): Operation<void>;
  /** Focus the field, type, and wait until its value shows what was typed. */
  type(text: string): Operation<void>;
}

/** The form a question opens in the drawer. */
export interface PageForm {
  isOpen(): boolean;
  value(name: string): PageFormValue;
  submit(): Operation<void>;
  close(): Operation<void>;
}

export function form(page: ReplPage): PageForm {
  return {
    isOpen: () => page.frame().has("drawer:form:submit"),
    value(name) {
      const key = `drawer:value:${name}`;
      const text = (): string =>
        (page.frame().control(key)?.text ?? "").replace(/^[^=]*=\s?/, "").trim();
      return {
        key,
        text,
        focus: () => page.focus(key),
        *type(typed) {
          yield* page.focus(key);
          const held = text();
          page.repl.terminal.feed(typed);
          yield* page.until(`${key} holding ${JSON.stringify(held + typed)}`, () =>
            text().includes(held + typed),
          );
        },
      };
    },
    submit: () => page.press("drawer:form:submit"),
    close: () => page.press("drawer:close"),
  };
}

/** Whether the Sidekick's own Send is offered and its own Stop is gone. */
export function sidekickIdle(frame: PageFrame): boolean {
  return frame.has("sidekick:send") && !frame.has("sidekick:stop");
}

export function sidekick(page: ReplPage): PageSidekick {
  const composer = page.field("sidekick:message", "box:tray");
  return {
    area: () => page.frame().area("box:inspection"),
    composer,
    working: () => page.frame().has("sidekick:stop") && !page.frame().has("sidekick:send"),
    *send(text) {
      yield* composer.type(text);
      yield* page.until("the Sidekick offering its own Send", (one) => one.has("sidekick:send"));
      yield* page.press("sidekick:send");
      const flat = (words: string): string => words.replace(/\s+/g, " ").trim();
      yield* page.until(
        `the Sidekick taking ${JSON.stringify(text)}`,
        () => !flat(composer.text()).includes(flat(text)),
      );
    },
    stop: () =>
      page.press(page.frame().has("sidekick:stop") ? "sidekick:stop" : "drawer:sidekick:stop"),
    idle: () => sidekickIdle(page.frame()),
  };
}

export function drawer(page: ReplPage): PageDrawer {
  const open = (): PageArea => {
    const area = page.frame().area(LAYER);
    if (area === undefined) {
      throw new Error(`no drawer is open. ${page.describe()}`);
    }
    return area;
  };
  return {
    isOpen: () => page.frame().area(LAYER) !== undefined,
    area: open,
    *choose(label) {
      const now = page.frame();
      const chosen = open()
        .controls()
        .find((one) => now.control(one)?.text.includes(label));
      if (chosen === undefined) {
        throw new Error(`no drawer control shows ${JSON.stringify(label)}. ${page.describe()}`);
      }
      yield* page.focus(chosen);
      yield* page.key("Enter");
      return chosen;
    },
    *dismiss() {
      yield* page.key("Escape");
      yield* page.until("the drawer closing", (one) => one.area(LAYER) === undefined);
    },
  };
}

/**
 * Watch for the first frame a command presents with its focus placed.
 *
 * For a case that runs `runReplProgram` itself because it passes an option the
 * page does not mount, such as an ACP endpoint. Install it before the command
 * is spawned, then yield the returned operation where the screen must be up.
 */
export function* firstPresentation(): Operation<Operation<void>> {
  const first = withResolvers<void>();
  yield* ReplFrameWitness.around({
    *presented([frame], next) {
      if (frame.controls.some((one) => one.key === frame.focused)) {
        first.resolve();
      }
      yield* next(frame);
    },
  });
  return race([
    first.operation,
    (function* (): Operation<void> {
      yield* sleep(MOUNTED_DEADLINE_MS);
      throw new Error(
        `no frame with its focus placed was presented within ${MOUNTED_DEADLINE_MS}ms`,
      );
    })(),
  ]);
}
