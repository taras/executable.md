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

import type { Operation } from "effection";

import type { PageArea, PageField, ReplPage } from "./mounted-page.ts";

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
  /** Type into the composer and press the pane's own Send once it is offered. */
  send(text: string): Operation<void>;
  /** Press the pane's own Stop. Waits for nothing: what Stop does is the case's question. */
  stop(): Operation<void>;
}

const LAYER = "box:drawer:layer";

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
    },
    stop: () => page.press("sidekick:stop"),
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
