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
import type { ReplTerminalSize } from "../../src/repl/terminal.ts";
import { MOUNTED_DEADLINE_MS } from "./mounted-repl.ts";
import type { PageArea, PageField, PageFrame, ReplPage } from "./mounted-page.ts";

/** Whether any visible row of this frame contains the text. */
export function shows(frame: PageFrame, text: string): boolean {
  return frame.rows.some((line) => line.includes(text));
}

/** How many visible rows of this frame contain the text. */
export function occurrences(frame: PageFrame, text: string): number {
  return frame.rows.filter((line) => line.includes(text)).length;
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

/** How many entries the History rail names, whatever mark each wears. */
export function railEntries(frame: PageFrame): number {
  const band = frame.area("box:history")?.rows().join(" ") ?? "";
  const rail = band.split("──")[0] ?? "";
  return [...rail.matchAll(/(?:^|\s)\d+\s*[✓×●U-]/g)].length;
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

/** Select the Sidekick by its tab, which also gives its message box the focus. */
export function* routeToSidekick(page: ReplPage): Operation<void> {
  yield* selectPane(page, "sidekick");
  yield* page.until(
    "the message box taking the focus its tab claimed",
    (frame) => frame.focused === "sidekick:message",
  );
}

/** Press the Sidekick pane's own Send once it is offered. Waits for nothing more. */
export function* pressSidekickSend(page: ReplPage): Operation<void> {
  yield* page.until("the Sidekick offering its own Send", (frame) => frame.has("sidekick:send"));
  yield* page.press("sidekick:send");
}

/** The latest frame where the terminal is already this size, else the first frame after resizing to it. */
export function* frameAt(page: ReplPage, size: ReplTerminalSize): Operation<PageFrame> {
  const now = page.frame();
  if (now.size.columns === size.columns && now.size.rows === size.rows) {
    return now;
  }
  return yield* page.resize(size);
}

/** The pane the conversation is read in: the inspection column, or the whole body where one outlet is routed. */
export function conversationArea(frame: PageFrame): PageArea | undefined {
  return frame.area("box:inspection") ?? frame.area("box:body");
}

/** The composer's value rows, trimmed, with blank rows kept: the cells below its name. */
export function composerRows(frame: PageFrame): string[] {
  const area = frame.area("box:tray");
  const control = frame.control("sidekick:message");
  if (area === undefined || control === undefined) {
    return [];
  }
  const below = control.bounds.y + control.bounds.height - area.bounds.y;
  return area
    .rows()
    .slice(below)
    .map((line) => line.trim());
}

/** Whether the Entries catalog is the drawer this frame shows. */
export function catalogOpen(frame: PageFrame): boolean {
  return (
    frame
      .area(LAYER)
      ?.rows()
      .some((line) => /^\s*Entries\b/.test(line)) ?? false
  );
}

/** Open the Entries catalog the way a person does: focus its heading and press Enter. */
export function* openCatalog(page: ReplPage): Operation<void> {
  if (catalogOpen(page.frame())) {
    return;
  }
  yield* page.focus("entries:heading");
  yield* page.key("Enter");
  yield* page.until("the catalog opening", catalogOpen);
}

/** Put the catalog away with its own Close, which chooses nothing. */
export function* closeCatalog(page: ReplPage): Operation<void> {
  if (!catalogOpen(page.frame())) {
    return;
  }
  yield* page.press("drawer:close");
  yield* page.until("the catalog closing", (frame) => !catalogOpen(frame));
}

/** Whether the catalog row for this entry key wears the mark of the entry being read. */
export function entryMarked(frame: PageFrame, entry: string): boolean {
  return frame.control(`entry:${entry}`)?.text.startsWith("* ") ?? false;
}

/**
 * Whether these rows show the text, or show it with the title ahead of ` · ` cut to fit.
 *
 * A Transcript row gives up its title before its status when the column is too
 * narrow, marking the cut with an ellipsis. A title shorter than `floor`
 * characters is not accepted cut, so a row that shares only its first letters
 * does not count.
 */
export function showsCut(rows: readonly string[], text: string, floor = 4): boolean {
  if (rows.some((line) => line.includes(text))) {
    return true;
  }
  const at = text.indexOf(" · ");
  const title = at === -1 ? text : text.slice(0, at);
  const tail = at === -1 ? "" : text.slice(at);
  for (let kept = title.length - 1; kept >= Math.min(floor, title.length); kept -= 1) {
    if (rows.some((line) => line.includes(`${title.slice(0, kept)}…${tail}`))) {
      return true;
    }
  }
  return false;
}

/** The Transcript column's rows in this frame, trimmed. */
export function transcriptRows(frame: PageFrame): string[] {
  return frame.area("box:sidebar")?.rows() ?? [];
}

/** Whether the Transcript column shows the text, with a long title cut to fit. */
export function transcriptShows(frame: PageFrame, text: string, floor = 4): boolean {
  return showsCut(transcriptRows(frame), text, floor);
}

/** How many Transcript rows show the text, whole or with the title cut. */
export function transcriptCount(frame: PageFrame, text: string, floor = 4): number {
  return transcriptRows(frame).filter((line) => showsCut([line], text, floor)).length;
}

/** The key of the Transcript control whose own cells show this text. */
export function transcriptRow(frame: PageFrame, text: string): string | undefined {
  const column = frame.area("box:sidebar");
  return column?.controls().find((key) => frame.control(key)?.text.includes(text));
}

/**
 * Press a scroll control until the frame holds what the case is after.
 *
 * Each press is done when the window has moved, so a window that cannot move
 * that way fails here with the frame rather than being pressed for ever.
 */
export function* scrollUntil(
  page: ReplPage,
  scroll: {
    readonly window: string;
    readonly control: string;
    readonly toward: "less" | "more";
  },
  holds: (frame: PageFrame) => boolean,
  limit = 80,
): Operation<PageFrame> {
  for (let press = 0; press <= limit; press += 1) {
    const now = page.frame();
    if (holds(now)) {
      return now;
    }
    const window = now.windows.get(scroll.window);
    if (window === undefined || !window[scroll.toward]) {
      throw new Error(
        `the ${scroll.window} window cannot move ${scroll.toward} and the frame still lacks it. ${page.describe()}`,
      );
    }
    yield* page.press(scroll.control);
    yield* page.until(
      `the ${scroll.window} window moving`,
      (one) => one.windows.get(scroll.window)?.from !== window.from || holds(one),
    );
  }
  throw new Error(`${scroll.control} was pressed ${limit} times without the frame holding it`);
}

/**
 * The controls Tab (or Shift+Tab) visits, in order, until focus is back where it began.
 *
 * Every stop is the key the presented frame reported as focused after the press,
 * so a control the frame did not place is not a stop whatever the reading holds.
 */
export function* focusCycle(
  page: ReplPage,
  direction: "Tab" | "Backtab",
): Operation<readonly string[]> {
  const start = page.frame().focused;
  const visited: string[] = [];
  let previous = start;
  for (let step = 0; step <= page.frame().controls.length; step += 1) {
    yield* page.key(direction);
    const moved: PageFrame = yield* page.until(
      `focus leaving ${previous} on ${direction}`,
      (frame) => frame.focused !== previous,
    );
    previous = moved.focused;
    if (previous === undefined) {
      throw new Error(`focus was lost on ${direction}. ${page.describe()}`);
    }
    visited.push(previous);
    if (previous === start) {
      return visited;
    }
  }
  throw new Error(`${direction} never came back to ${start}. ${page.describe()}`);
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

/** Whether the Sidekick's own pane in this frame shows the text, as the transcript beside it may too. */
export function sidekickShows(frame: PageFrame, text: string): boolean {
  return frame.area("box:inspection")?.shows(text) ?? false;
}

/** A field's value with the line breaks its width forced turned back into single spaces. */
export function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

/** The agent field of the Configure drawer: the name a replacement would start another conversation with. */
export interface PageConfigureAgent {
  readonly key: string;
  /** The name as drawn after the field's prompt. A name wider than the field is clipped. */
  text(): string;
  focus(): Operation<void>;
  /** Press Backspace more times than any name here is long, as one chunk, and wait for the field to be empty. */
  clear(): Operation<void>;
  /** Focus the field and type. Waits for nothing: the case asks what the name caused. */
  enter(text: string): Operation<void>;
  /** Clear the field, type the name, and wait until the field shows it. */
  replace(name: string): Operation<void>;
}

/** The Configure drawer the Sidekick pane opens: its sections, its choices and its agent field. */
export interface PageConfigure {
  isOpen(): boolean;
  /** The drawer's own rectangle, or a refusal naming the frame that has none. */
  area(): PageArea;
  /** Whether the drawer, where one is open, shows this text in its own cells. */
  shows(text: string): boolean;
  /** Press the pane's header control and wait for the drawer's own Refresh to be placed. */
  open(): Operation<void>;
  /** Press Close and wait for the drawer to go. */
  close(): Operation<void>;
  /** Wait for the drawer to go, however it was asked to. */
  closed(): Operation<void>;
  /** Wait for the provider's choice of this model to be placed. */
  offered(model: string): Operation<void>;
  /** Whether this model's choice wears the selected mark. */
  modelMarked(id: string): boolean;
  /** Whether this effort level's choice wears the selected mark. */
  effortMarked(id: string): boolean;
  /** Press this model's choice, by the id the provider gave it, and wait for its mark. */
  chooseModel(id: string): Operation<void>;
  /** Press this effort level's choice and wait for its mark. */
  chooseEffort(id: string): Operation<void>;
  /** Press Refresh. Waits for nothing: what the read does is the case's question. */
  refresh(): Operation<void>;
  /** Press Apply, or the control that replaces it while a replacement is what it does. Waits for nothing. */
  apply(): Operation<void>;
  /** Press the drawer's scroll-down control until this control is placed. */
  scrollTo(key: string): Operation<void>;
  readonly agent: PageConfigureAgent;
}

export function configure(page: ReplPage): PageConfigure {
  const open = (): PageArea => {
    const area = page.frame().area(LAYER);
    if (area === undefined) {
      throw new Error(`no drawer is open. ${page.describe()}`);
    }
    return area;
  };
  const marked = (key: string): boolean => page.frame().control(key)?.text.includes("(x)") ?? false;
  const agentKey = "drawer:configure:agent";
  const agentText = (): string =>
    (page.frame().control(agentKey)?.text ?? "").replace(/^>*\s*Agent:\s?/, "");
  const agent: PageConfigureAgent = {
    key: agentKey,
    text: agentText,
    focus: () => page.focus(agentKey),
    *clear() {
      yield* page.focus(agentKey);
      page.repl.terminal.feed("\x7f".repeat(200));
      yield* page.until("the agent field empty", () => agentText() === "");
    },
    *enter(typed) {
      yield* page.focus(agentKey);
      page.repl.terminal.feed(typed);
    },
    *replace(name) {
      yield* agent.clear();
      yield* agent.enter(name);
      yield* page.until(`the agent field holding ${JSON.stringify(name)}`, () =>
        agentText().includes(name),
      );
    },
  };
  function* choose(key: string): Operation<void> {
    yield* page.press(key);
    yield* page.until(`${key} marked`, () => marked(key));
  }
  function* gone(): Operation<void> {
    yield* page.until("Configure closing", (one) => one.area(LAYER) === undefined);
  }
  return {
    isOpen: () => page.frame().has("drawer:configure:refresh"),
    area: open,
    shows: (text) => page.frame().area(LAYER)?.shows(text) ?? false,
    *open() {
      yield* page.press("sidekick:configure");
      yield* page.until("Configure opening", (one) => one.has("drawer:configure:refresh"));
    },
    *close() {
      yield* page.press("drawer:close");
      yield* gone();
    },
    closed: gone,
    *offered(model) {
      yield* page.until(`the choice of ${model}`, (one) =>
        one.has(`drawer:configure:model:${model}`),
      );
    },
    modelMarked: (id) => marked(`drawer:configure:model:${id}`),
    effortMarked: (id) => marked(`drawer:configure:effort:${id}`),
    chooseModel: (id) => choose(`drawer:configure:model:${id}`),
    chooseEffort: (id) => choose(`drawer:configure:effort:${id}`),
    refresh: () => page.press("drawer:configure:refresh"),
    apply: () => page.press("drawer:configure:apply"),
    *scrollTo(key) {
      for (let press = 0; press < 60 && !page.frame().has(key); press += 1) {
        const from = page.frame().windows.get("drawer")?.from;
        yield* page.press("drawer:scroll:down");
        yield* page.until(
          "the drawer's window moving",
          (one) => one.has(key) || one.windows.get("drawer")?.from !== from,
        );
      }
      yield* page.until(`${key} placed`, (one) => one.has(key));
    },
    agent,
  };
}

const MARKER = "drawer:marker:";

/** The retained positions the History drawer offers, each as its control draws it, in order. */
export function historyMarkers(frame: PageFrame): string[] {
  return frame
    .keys()
    .filter((key) => key.startsWith(MARKER))
    .map((key) => frame.control(key)?.text ?? "");
}

/** Open the History drawer with its footer control and wait for it to offer positions. */
export function* openHistory(page: ReplPage): Operation<void> {
  yield* page.press("footer:history");
  yield* page.until(
    "the History drawer offering positions",
    (frame) => historyMarkers(frame).length > 0,
  );
}

/** Whether the open drawer's own cells show this text. */
export function drawerShows(frame: PageFrame, text: string): boolean {
  return frame.area(LAYER)?.shows(text) ?? false;
}

/** Put the drawer away with its own Close and wait for the layer to go. */
export function* closeDrawer(page: ReplPage): Operation<void> {
  yield* page.press("drawer:close");
  yield* page.until("the drawer closing", (frame) => frame.area(LAYER) === undefined);
}

/**
 * Press the History position whose row shows this label, from the live head,
 * and wait for the reading to move to it.
 *
 * Input that arrives before the reading has moved is handled against a model
 * that is not yet projected at the new position, and the screen is left on an
 * error line.
 */
export function* chooseMarker(page: ReplPage, label: string): Operation<void> {
  const now = page.frame();
  if (readingRetained(now)) {
    throw new Error(`the reading is already at a retained position. ${page.describe()}`);
  }
  const chosen = now
    .keys()
    .find((key) => key.startsWith(MARKER) && now.control(key)?.text.includes(label));
  if (chosen === undefined) {
    throw new Error(`no History position shows ${JSON.stringify(label)}. ${page.describe()}`);
  }
  yield* page.press(chosen);
  yield* page.until("the reading moving to that position", readingRetained);
}

/** Whether the reading is a retained position rather than the live head. */
export function readingRetained(frame: PageFrame): boolean {
  return frame.has("footer:live");
}

const ALL_SESSIONS = "All sessions";
const OFFERED = "sessions:conversation:";

/** The conversation the Transcript is filtered to as its selector names it, or none when unfiltered. */
export function conversationFilter(frame: PageFrame): string | undefined {
  const named = (frame.control("transcript:selector")?.text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*▾$/, "")
    .trim();
  return named === "" || named === ALL_SESSIONS ? undefined : named;
}

/** The provider session key of every conversation the open selector offers, in order. */
export function offeredConversations(frame: PageFrame): string[] {
  return frame
    .keys()
    .filter((key) => key.startsWith(OFFERED))
    .map((key) => key.slice(OFFERED.length));
}

/** Each turn row of the Transcript as its control draws it, in order. */
export function sessionTurns(frame: PageFrame): string[] {
  return frame
    .keys()
    .filter((key) => key.startsWith("sessions:turn:"))
    .map((key) => frame.control(key)?.text ?? "");
}

/** Open the conversation selector, whatever it currently says, and wait for its choices. */
export function* openSelector(page: ReplPage): Operation<void> {
  if (page.frame().has("sessions:all")) {
    return;
  }
  yield* page.press("transcript:selector");
  yield* page.until("the conversation selector opening", (frame) => frame.has("sessions:all"));
}

/** Put the selector's choices away, which chooses nothing. */
export function* closeSelector(page: ReplPage): Operation<void> {
  if (!page.frame().has("sessions:all")) {
    return;
  }
  yield* page.press("transcript:selector");
  yield* page.until("the conversation selector closing", (frame) => !frame.has("sessions:all"));
}

/** Choose one offered conversation by its provider session key. */
export function* chooseConversation(page: ReplPage, sessionKey: string): Operation<void> {
  yield* page.press(`${OFFERED}${sessionKey}`);
  yield* page.until(
    "the Transcript filtered to that conversation",
    (frame) => conversationFilter(frame) !== undefined && !frame.has("sessions:all"),
  );
}

/** Choose the reading that filters nothing. */
export function* chooseEveryConversation(page: ReplPage): Operation<void> {
  yield* page.press("sessions:all");
  yield* page.until(
    "the Transcript filtered to nothing",
    (frame) => conversationFilter(frame) === undefined && !frame.has("sessions:all"),
  );
}

/**
 * Press the catalog row of an entry or scope that shows this label.
 *
 * The catalog is a drawer, and choosing a row closes it.
 */
export function* chooseCatalogRow(page: ReplPage, label: string): Operation<void> {
  const now = page.frame();
  const chosen = now
    .keys()
    .find(
      (key) =>
        (key.startsWith("scope:") || key.startsWith("entry:")) &&
        now.control(key)?.text.includes(label),
    );
  if (chosen === undefined) {
    throw new Error(`no catalog row shows ${JSON.stringify(label)}. ${page.describe()}`);
  }
  yield* page.press(chosen);
  yield* page.until("the catalog closing", (frame) => !catalogOpen(frame));
}

/** Wait for the waiting question to announce itself, activate it, and wait for its form. */
export function* openQuestion(page: ReplPage): Operation<void> {
  yield* page.until(
    "the waiting question announcing itself",
    (frame) => frame.has("footer:asked") && !frame.has("drawer:form:submit"),
  );
  yield* page.press("footer:asked");
  yield* page.until("the question's form opening", (frame) => frame.has("drawer:form:submit"));
}

/** Press one offered value of a form field. Waits for nothing: choosing may submit the form. */
export function* chooseOption(page: ReplPage, field: string, option: string): Operation<void> {
  yield* page.press(`drawer:choice:${field}:${option}`);
}

/**
 * Select a form field by pointing at its name, type, and wait for its value to show.
 *
 * Pointing is what directs typed text at a field of a form with several: Tab
 * moves the reported focus to a field's value line and typed text still lands
 * in the field the form last selected.
 */
export function* answerField(page: ReplPage, name: string, text: string): Operation<void> {
  yield* page.press(`drawer:field:${name}`);
  yield* page.type(text);
  yield* page.until(`${name} holding ${JSON.stringify(text)}`, () =>
    form(page).value(name).text().includes(text),
  );
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
