/**
 * The one-entry product journey (#848 J1, S1, D1).
 *
 * A real terminal's worth of bytes in, a real terminal's worth of bytes out, and
 * a real durable execution in between. The terminal is injected, so the same
 * corpus runs under Deno, Node and Bun; everything else — the repository, the
 * session, the keyed tree, the layout, the renderer — is the production assembly
 * the command uses.
 *
 * Output is asserted as the text the screen shows, with escape sequences
 * stripped. What a terminal's cursor addressing looks like is the renderer's
 * business and changes when it optimizes; what a person can read on the screen
 * is the product.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  type Operation,
  type Result,
  scoped,
  sleep,
  spawn,
  withResolvers,
} from "effection";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { until } from "effection";

import { API } from "@executablemd/runtime";
import { DEFAULT_AGENT_NAME } from "@executablemd/acp";
import { Elicitation, Execution, useTempFileCompiler } from "@executablemd/core";
import { RootMetadata } from "@executablemd/core/api";
import { ordinaryGeneratedSelection } from "../src/evaluation-profile.ts";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { installReplHost } from "../src/repl-assembly.ts";
import { ENTRIES_FILE, PAIRED_DIRECTORY } from "../src/repl/sidekick/history.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { ReplClock } from "../src/repl/frame.ts";
import {
  describeApplication,
  initialState,
  NO_AGENT,
  reduceRepl,
  refusedView,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { readDescription } from "../src/repl/description.ts";
import { runReplProgram } from "../src/repl/program.ts";
// The terminal harness and the keyboard helpers these rows drive the product
// with. They live in the fixture so the mounted Sidekick rows reach the same
// screen the same way rather than through a second account of it.
import {
  activate,
  draftRow,
  draftText,
  focusDraft,
  focusedOn,
  focusOn,
  recordingTerminal,
  replay,
  saysAcross,
  screenOf,
  settled,
  statusOn,
  shows,
  untilDrawn,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import type { Terminal } from "./fixtures/repl/issue-883/mounted-program.ts";
import { entryVocabulary } from "../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import { NO_PLUGINS } from "../src/plugin-host.ts";
import type { ReplOutcome } from "../src/repl/program.ts";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import {
  drawerRect,
  FOOTER_ROWS,
  HISTORY_ROWS,
  inspectionWidth,
  NARROW,
  sidebarWidth,
} from "../src/repl/layout.ts";
import { HISTORY_TITLE } from "../src/repl/history-rail.ts";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { decodeLocation, encodeLocation } from "../src/repl/route.ts";
import type { ReplRoute } from "../src/repl/route.ts";
import {
  REFERENCE_DIRECTORY,
  referenceEvents,
  referenceSource,
} from "./fixtures/repl/reference.ts";
import { measuringContext } from "./fixtures/repl/presentation.ts";
import { sidekickAssembly } from "../src/repl/sidekick/assembly.ts";

const BYTES = new TextEncoder();

/** A model with nothing in it, which is what a fresh execution projects. */
const EMPTY_MODEL_FOR_TEST = Object.freeze({
  selection: undefined,
  head: true,
  entries: Object.freeze([]),
  settled: false,
  terminal: undefined,
  checkpoints: Object.freeze([]),
  transcript: Object.freeze([]),
  turns: Object.freeze([]),
  sessions: Object.freeze([]),
});

/**
 * What this host installs around the reference entry.
 *
 * Nothing. What a generated fragment may write is on the profile beside this,
 * as the selection the session offers in each entry's own execution scope.
 */
const INSTALLATIONS: readonly ExecutionInstallation[] = [];

/**
 * The profile this suite's REPL runs under.
 *
 * One value rather than two arguments, because the program takes one: what an
 * execution may resolve and how it answers a permission request are settled by a
 * command before a terminal exists. This suite runs no Agent, so the mode is the
 * one an unconfigured command settles.
 */
const PROFILE: ReplExecutionProfile = {
  includes: [REFERENCE_DIRECTORY],
  installations: INSTALLATIONS,
  entryComponents: [],
  generated: ordinaryGeneratedSelection(),
  permissionMode: "deny-all",
  // No row here opens a Sidekick conversation, so the selection is the one an
  // unconfigured command settles.
  sidekickAgent: DEFAULT_AGENT_NAME,
  // Declared because a profile carries one, and never installed: no row here
  // opens a Sidekick conversation.
  sidekickAssembly: sidekickAssembly(DEFAULT_AGENT_NAME, {}),
  // This suite installs no Plugin, which the snapshot reports as `none`.
  plugins: NO_PLUGINS.plugins.map((plugin) => plugin.name),
  vocabulary: entryVocabulary([REFERENCE_DIRECTORY], NO_PLUGINS),
};

/** What the reference entry's eval publishes, as the model retains it. */
const PLAN = { title: "Ship the REPL", steps: 2 };

/** The normalized schema the reference entry's question is judged against. */
const SCHEMA = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "decline"] } },
  required: ["decision"],
  additionalProperties: false,
};

/** The answer this journey gives it. */
const ANSWER = { decision: "approve" };

/** A clock the test moves, so nothing in this suite waits on real time. */
function immediateClock(): Operation<void> {
  return ReplClock.around(
    {
      // deno-lint-ignore require-yield
      *now(): Operation<number> {
        return 0;
      },
      // deno-lint-ignore require-yield
      *wait(): Operation<void> {
        // Returns at once: this product draws when something changed, so the
        // frame interval is the only thing being skipped.
      },
    },
    { at: "min" },
  );
}

/** A clock that records what was scheduled and releases it only when told. */
interface CountingClock {
  waits: number;
  install(): Operation<void>;
  release(): void;
}

function countingClock(): CountingClock {
  let pending: (() => void)[] = [];
  const clock: CountingClock = {
    waits: 0,
    install(): Operation<void> {
      return ReplClock.around(
        {
          // deno-lint-ignore require-yield
          *now(): Operation<number> {
            return 0;
          },
          *wait(): Operation<void> {
            clock.waits += 1;
            const waiter = withResolvers<void>();
            pending.push(() => waiter.resolve());
            yield* waiter.operation;
          },
        },
        { at: "min" },
      );
    },
    release(): void {
      const releasing = pending;
      pending = [];
      for (const one of releasing) {
        one();
      }
    },
  };
  return clock;
}

/** A REPL host over a temporary directory nothing else uses. */
function* useTemporaryHost(): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
  yield* installReplHost({
    dataRoot: () => root,
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });
  return root;
}

/** What a run really performed, as opposed to what it restored. */
interface Performed {
  /** Component sources actually read from disk. */
  reads: string[];
  /** Eval blocks actually compiled, which is where a block really runs. */
  compiles: number;
  /** Questions a provider was actually asked. */
  asked: number;
}

/**
 * Count the work a run performs, at the seams where performing it happens.
 *
 * Not at the durable operations: replay enters those and hands back what was
 * recorded, so counting them would count restoration as work. A component's
 * source is read inside the recorded selection and an eval block is compiled
 * inside the recorded evaluation, so these counts are zero for anything a cold
 * open restored rather than ran.
 */
function* countPerformed(): Operation<Performed> {
  const performed: Performed = { reads: [], compiles: 0, asked: 0 };
  yield* API.Fs.around({
    *readTextFile([path], next) {
      performed.reads.push(path);
      return yield* next(path);
    },
  });
  yield* API.Env.around({
    *compile([source, options], next) {
      performed.compiles++;
      return yield* next(source, options);
    },
  });
  yield* Elicitation.around({
    *elicit([request], next) {
      performed.asked++;
      return yield* next(request);
    },
  });
  return performed;
}

/**
 * The canonical location this command returns when it ends.
 *
 * The one place a route is still published to someone outside the process. The
 * screen does not draw it any more, and this suite sees only what the screen
 * draws — so a scenario whose final state *is* a route asserts it here, after an
 * orderly exit, and asserts what it can see for everything before that.
 */
interface ExitRoute {
  settle(outcome: ReplOutcome): void;
  /** The returned location, or a failure saying the command has not ended yet. */
  location(): string;
  /** The same location, decoded into the fields a scenario compares. */
  route(): ReplRoute;
}

function exitRoute(): ExitRoute {
  let ended: ReplOutcome | undefined;
  const location = (): string => {
    if (ended === undefined) {
      throw new Error("this command has not ended, so it has returned no location");
    }
    return ended.location;
  };
  return {
    settle(outcome: ReplOutcome) {
      ended = outcome;
    },
    location,
    route() {
      const decoded = decodeLocation(location());
      if (!decoded.ok) {
        throw decoded.error;
      }
      return decoded.value;
    },
  };
}

/** Whether this reading is a retained position rather than the live head. */
function historicalOn(terminal: Terminal): boolean {
  return screenOf(terminal).some((line) => line.includes("[live]"));
}

/** What the draft row is called, which is how this suite finds it. */

/**
 * The left column of every row: the sidebar, or the whole row where there is none.
 *
 * A row of this screen crosses three columns, and the panes are parted by a real
 * drawn edge — so the catalog's own text is everything before the first one. A
 * narrow frame draws no edge and no column, and there the whole row is the outlet.
 */
function leftColumn(terminal: Terminal): string[] {
  return screenOf(terminal).map((line) => line.split("\u2502")[0] ?? "");
}

/**
 * What the draft row shows for one source: its last line under a count of the
 * rest, which is the whole of what a one-row field can say about many lines.
 */
function draftPreview(source: string): string {
  const lines = source.split("\n");
  const shown =
    lines.length === 1 ? source : `[${lines.length - 1} lines] ${lines[lines.length - 1]}`;
  return shown.trimEnd();
}

/** Whether the draft row says the next keystroke reaches it. */
function draftFocused(terminal: Terminal): boolean {
  return draftRow(terminal).trimStart().startsWith(">>");
}

/**
 * Every entry the catalog is showing, by the identity it draws.
 *
 * The outcome is part of the row this product promises, so a row without one is
 * the empty placeholder rather than an entry. Markers are stripped: whether a row
 * is selected or focused is a different question from whether it exists.
 */
function entriesOn(terminal: Terminal): string[] {
  const found: string[] = [];
  for (const line of leftColumn(terminal)) {
    const match = /^[\s>*]*(\d+)\.\s+\[([a-z]+)\]\s+(\S.*?)\s*$/.exec(line);
    if (match !== null) {
      found.push(`${match[1]}. ${match[3]}`);
    }
  }
  return found;
}

/** The catalog row this reading has selected, if it is showing one. */
function selectedEntryOn(terminal: Terminal): string | undefined {
  for (const line of leftColumn(terminal)) {
    const match = /^[\s>]*\*\s*(\d+)\.\s+\[([a-z]+)\]\s+(\S.*?)\s*$/.exec(line);
    if (match !== null) {
      return `${match[1]}. ${match[3]}`;
    }
  }
  return undefined;
}

/** Which surface the frame is routed to, read from the marked heading. */
function routedSurfaceOn(terminal: Terminal): string | undefined {
  for (const line of leftColumn(terminal)) {
    const match = /^[\s>]*\*\s*(Sessions|Entries)\s*$/.exec(line);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Where the waiting-question control is, once this process is asking.
 *
 * A question announces itself on one row and opens nothing: the drawer is what
 * activating that row does. So reaching the question is two acts, and a helper
 * that waited for a drawer to appear on its own would wait for ever.
 */
function askedRow(
  terminal: Terminal,
): { readonly column: number; readonly row: number } | undefined {
  for (const [row, line] of screenOf(terminal).entries()) {
    // The footer's one action row, found by the control that is on it in every
    // state. The announcement is one fixed spelling rather than the question's
    // own words: a control as wide as somebody's message is one the narrowest
    // frame drops.
    if (!line.includes("[exit]")) {
      continue;
    }
    const column = line.indexOf("[answer]");
    if (column !== -1) {
      return { column, row };
    }
  }
  return undefined;
}

/**
 * Open the waiting question's drawer, the way a person does.
 *
 * Waits for the announcement, activates it, and waits for the form it opens.
 * Activation is by pointer because it needs no traversal, and a pointer on a
 * control asks for exactly what Enter on it asks for.
 */
function* openQuestion(terminal: Terminal): Operation<void> {
  // Bounded by real time, not by a count of turns: reaching the question compiles
  // an eval block, and a compile is work off this interpreter rather than a turn
  // on it. Said loudly when it never arrives, because a wait that gave up quietly
  // would go on to click nothing and blame the drawer.
  yield* awaiting(
    terminal,
    "the waiting question announcing itself",
    (one) => askedRow(one) !== undefined,
  );
  const at = askedRow(terminal);
  if (at === undefined) {
    throw new Error("the waiting question's control left the screen before it was activated");
  }
  yield* clickAt(terminal, at);
  yield* awaiting(terminal, "the question's form", (one) => formShowing(one));
}

/** Whether a question's form is drawn, whichever of these suites' questions it is. */
/**
 * The contextual guidance row, as drawn.
 *
 * Row 0, which is where a narrow frame puts it: these rows are all at `72x20`,
 * where the guidance has the row to itself rather than sharing it with a sidebar.
 */
function guidanceRow(terminal: Terminal): string {
  return (screenOf(terminal)[0] ?? "").trimEnd();
}

function formShowing(terminal: Terminal): boolean {
  return (
    shows(terminal, "decision: approve | decline") ||
    shows(terminal, "decision: go") ||
    shows(terminal, "[submit]")
  );
}

/**
 * Open the question's drawer and dismiss it again.
 *
 * A modal owns focus while it is up, so anything that means to reach a control
 * beneath it has to close it first — and dismissing one answers nothing, so the
 * question is still waiting afterwards and can be opened again.
 */
function* dismissQuestion(terminal: Terminal): Operation<void> {
  yield* openQuestion(terminal);
  terminal.feed("\x1b");
  yield* settled(30);
}

/**
 * Click one control, by finding it on the screen and pressing there.
 *
 * The other way in, and the fast one: activating a control by pointer needs no
 * focus traversal, so it can reach a control while an execution is still moving.
 * The protocol counts from one and the screen counts from zero.
 */
function* click(terminal: Terminal, label: string): Operation<void> {
  const at = coordinateOf(terminal, label);
  if (at === undefined) {
    throw new Error(`no control labelled ${label} is on the screen`);
  }
  yield* clickAt(terminal, at);
}

/** The transcript reading's own way down, by the label the window draws. */
const READING_LATER = "[\u2193 later]";

/**
 * Where one label is *inside the transcript column*, if it is drawn there.
 *
 * By the column it lands in rather than by the label alone: the sidebar's two
 * readings and the right-hand pane each draw a `[\u2193 later]` of their own,
 * and the first one on a screen belongs to the sidebar. The transcript is
 * whatever lies between the sidebar and the right pane, both of which state
 * their own widths.
 */
function transcriptControl(
  terminal: Terminal,
  label: string,
): { readonly column: number; readonly row: number } | undefined {
  const left = sidebarWidth(terminal.size) ?? 0;
  const right = terminal.size.columns - (inspectionWidth(terminal.size) ?? 0);
  for (const [row, line] of screenOf(terminal).entries()) {
    for (let at = line.indexOf(label); at !== -1; at = line.indexOf(label, at + 1)) {
      if (at >= left && at < right) {
        return { column: at, row };
      }
    }
  }
  return undefined;
}

/**
 * Whether the Transcript's column holds this text once its rows are rejoined.
 *
 * For a token with no spaces in it. `saysAcross` rejoins a block at its cuts and
 * puts a space where each one was, which is right for a sentence wrapped at
 * words — but a 35-character identifier in a column with fewer than that many
 * columns of source room is cut at a code unit, and a space inserted there is a
 * space the document never had. So these rows are rejoined with nothing between
 * them, inside the Transcript's own column alone: joining across the row would
 * splice the pane beside it into the token.
 *
 * Only for a distinctive unbroken string. Rejoining without a separator can in
 * principle splice two adjacent rows into something neither says, which is why
 * `saysAcross` is the question for anything made of words.
 */
function saysJoined(terminal: Terminal, expected: string): boolean {
  const left = sidebarWidth(terminal.size) ?? 0;
  const right = terminal.size.columns - (inspectionWidth(terminal.size) ?? 0);
  const joined = screenOf(terminal)
    // Past the column's own divider, its body gutter and the rails an
    // enclosure draws beside a nested reading: those are decoration this
    // column puts in front of a row, and a token cut across two rows has
    // them between its halves.
    .map((line) =>
      line
        .slice(left, right)
        .replace(/^[\s\u2502]+/, "")
        .trimEnd(),
    )
    .join("");
  return joined.includes(expected);
}

/**
 * Scroll the transcript's own reading window until it is showing this text.
 *
 * The accepted row of space above each column heading costs every column one
 * row, so the last row of a reading that used to fill its window is now one
 * press away rather than drawn. This reaches it the way a person does, through
 * the window's own control: pressing it moves the viewport and writes nothing,
 * so what is asserted afterwards is still this screen's own reading rather than
 * anything read out of the journal.
 */
function* scrollReadingTo(terminal: Terminal, text: string, limit = 60): Operation<void> {
  for (let press = 0; press <= limit; press += 1) {
    if (shows(terminal, text)) {
      return;
    }
    const at = transcriptControl(terminal, READING_LATER);
    if (at === undefined) {
      throw new Error(
        `the transcript reading drew no ${READING_LATER} to reach ${text} with. rows=` +
          JSON.stringify(
            screenOf(terminal)
              .map((line) => line.trimEnd())
              .filter((line) => line.length > 0)
              .slice(0, 12),
          ),
      );
    }
    yield* clickAt(terminal, at);
  }
  throw new Error(`the transcript reading never reached ${text} in ${limit} presses`);
}

/** More than any label this REPL puts in a drawer, and less than any box. */
const LABEL_ROOM = 48;

/** Where on the screen one label is, if it is there. */
function coordinateOf(
  terminal: Terminal,
  label: string,
): { readonly column: number; readonly row: number } | undefined {
  for (const [row, line] of screenOf(terminal).entries()) {
    const column = line.indexOf(label);
    if (column !== -1) {
      return { column, row };
    }
  }
  return undefined;
}

/** Press at exactly this cell. The protocol counts from one; the screen from zero. */
function* clickAt(
  terminal: Terminal,
  at: { readonly column: number; readonly row: number },
): Operation<void> {
  terminal.feed(`\x1b[<0;${at.column + 1};${at.row + 1}M`);
  yield* settled(30);
}

/** Wait until the screen says what it is asked about, in real time. */
function* until_(
  terminal: Terminal,
  what: string,
  says: (terminal: Terminal) => boolean,
): Operation<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (says(terminal)) {
      return;
    }
    yield* sleep(10);
    yield* settled(20);
  }
  throw new Error(
    `the screen never said ${what}. footer=` +
      JSON.stringify(
        screenOf(terminal)
          .slice(-9)
          .map((line) => line.trim()),
      ),
  );
}

/**
 * How much of a row belongs to the surface carrying the location, at one size.
 *
 * Read from the one place those column widths are declared. This suite sees only
 * a terminal, so interpreting its rows means knowing where the next column
 * starts; it is not a second opinion about where anything was placed.
 */
function surfaceWidthOf(size: ReplTerminalSize): number {
  return size.columns - (sidebarWidth(size) ?? 0) - (inspectionWidth(size) ?? 0);
}

/**
 * The rectangle the drawer is placed in, at one size.
 *
 * Read from the one place that rectangle is declared rather than worked out
 * again here. This suite sees only a terminal, so it needs to know which cells
 * belong to the modal — but a second opinion about where they are would agree
 * with itself while the product drew the drawer somewhere else.
 */
function drawerBox(terminal: Terminal): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const size = terminal.size;
  const rect = drawerRect(size);
  if (rect === undefined) {
    throw new Error(`${size.columns}x${size.rows} draws no drawer`);
  }
  const left = rect.x;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  // Where this frame actually put the top, which the size alone no longer says.
  // A route drawer now begins below the whole fitted guidance block, and that
  // block is as many rows as its words need — so the top is found by the rule
  // the drawer draws across its own rectangle rather than recomputed here. The
  // horizontal bounds and the bottom are the ones the size states, because the
  // accepted envelope keeps both.
  //
  // Searched downward from the rectangle the size states, never upward: the new
  // top is at or below the old one, and a pane's own header edge is a run of the
  // same character one row higher at the medium profile.
  const rows = screenOf(terminal);
  for (let row = rect.y; row < bottom; row += 1) {
    const text = (rows[row] ?? "").slice(left, right).trim();
    if (text.length > 0 && /^\u2500+$/.test(text)) {
      return { top: row, bottom, left, right };
    }
  }
  return { top: rect.y, bottom, left, right };
}

/**
 * Every position the open drawer lists, read out of the drawer's own rectangle.
 *
 * In the order the drawer lists them, read from the drawer rather than from the
 * compact band: the band shares labels when space is short, and what is being
 * compared is the exact set.
 *
 * Found by where the layout put it rather than by a word it contains. The
 * guidance row legitimately says "History" now — it is the state at a frozen
 * position (#870 UI15) — and a helper that searched the screen for that string
 * read the sentence about the position instead of the list of positions, from the
 * wrong column, and answered with fragments of the transcript behind it. Prose a
 * row may say is not an anchor; a placed rectangle is.
 */
function drawerMarkers(terminal: Terminal): string[] {
  const found: string[] = [];
  const rows = screenOf(terminal);
  const box = drawerBox(terminal);
  let title = false;
  for (let row = box.top; row < box.bottom; row += 1) {
    // Trimmed both ends, because a drawer's rows start one column in from its
    // rectangle: a focus marker read from the rectangle's own left edge has a
    // space in front of it, and the strip below would leave it on the label.
    const text = (rows[row] ?? "").slice(box.left, box.right).trim();
    // The drawer's own top rule, which is decoration rather than a reading: it
    // is the first row of the rectangle, so a walk that took it for the title
    // would read the title as a position and every position as the one after it.
    if (text.length > 0 && /^\u2500+$/.test(text)) {
      continue;
    }
    const label = text.replace(/^>\s*/, "").trim();
    if (label.length === 0) {
      // Before the drawer's first row there is nothing of it to read; after its
      // last, the box is taller than what it drew.
      if (title) {
        break;
      }
      continue;
    }
    if (!title) {
      // Its own heading, which names the drawer rather than a position in it.
      title = true;
      continue;
    }
    if (label === "[close]" || label === "[↓ later]") {
      break;
    }
    if (label === "[↑ earlier]") {
      // How the window moves, not a position in it. Both window controls stay
      // outside the content they scroll, so neither is one of these.
      continue;
    }
    found.push(label);
  }
  return found;
}

/**
 * Every content row the open drawer can show, gathered by scrolling it.
 *
 * Through `[↓ later]`, the way a person reaches the rest of a long record:
 * pressing it moves the window by a row, and what the window holds is what is
 * mounted. Stops when a press adds nothing new, which is the end of the reading.
 */
function* drawerContent(
  terminal: Terminal,
  limit = 120,
): Operation<{ readonly first: string[]; readonly reached: string[] }> {
  const seen: string[] = [];
  const take = (): number => {
    for (const row of drawerMarkers(terminal)) {
      if (!seen.includes(row)) {
        seen.push(row);
      }
    }
    return seen.length;
  };
  // What one frame holds, before anything has been scrolled.
  const first = drawerMarkers(terminal);
  take();
  yield* focusOn(terminal, "[↓ later]");
  // Stopped when the window itself stops moving, not when a press reveals no
  // label this walk had not already collected. A serialized value repeats rows —
  // `}` closes every object — so a press that only brought a duplicate into view
  // would end the walk with the rows after it never read.
  let previous = first.join("\n");
  for (let press = 0; press < limit; press += 1) {
    terminal.feed("\r");
    yield* settled(20);
    const shown = drawerMarkers(terminal).join("\n");
    take();
    if (shown === previous) {
      return { first, reached: seen };
    }
    previous = shown;
  }
  return { first, reached: seen };
}

/**
 * Every execution the repository holds, by identifier.
 *
 * By identifier rather than by filename, because an execution's entry history
 * now lives in one of two places: an older single-file one is
 * `<execution>.jsonl`, and a published pair keeps its entries inside
 * `v1/<execution>/`. The identifier is the thing these cases are actually
 * about — it is what a location names — so the layout is resolved by
 * `historyPath` below rather than spelled out at forty call sites.
 */
function* histories(root: string): Operation<string[]> {
  const directory = join(root, "xmd", "repl");
  const found: string[] = [];
  for (const name of yield* until(readdir(directory))) {
    if (name.endsWith(".jsonl")) {
      found.push(name.slice(0, -".jsonl".length));
      continue;
    }
    if (name !== PAIRED_DIRECTORY) {
      continue;
    }
    for (const execution of yield* until(readdir(join(directory, name)))) {
      found.push(execution);
    }
  }
  return found.sort();
}

/** Where one execution's entry history is, in whichever shape holds it. */
function* historyPath(root: string, execution: string): Operation<string> {
  const directory = join(root, "xmd", "repl");
  const paired = join(directory, PAIRED_DIRECTORY, execution, ENTRIES_FILE);
  return (yield* until(
    stat(paired).then(
      () => true,
      () => false,
    ),
  ))
    ? paired
    : join(directory, `${execution}.jsonl`);
}

/**
 * The Transcript column's own rows, as the columns of the screen they occupy.
 *
 * Sliced between the two headings that name the columns either side of it, so
 * what comes back is this pane's text and not the sidebar's or the Bindings
 * column's. Never trimmed: the padding between one row's text and the next is
 * what a wrapped line's break became, and dropping it would join two words the
 * reading kept apart.
 */
function transcriptColumn(terminal: Terminal): string[] {
  const rows = screenOf(terminal);
  const header = rows.findIndex((line) => line.includes("Transcript"));
  if (header < 0) {
    throw new Error(`this screen has no Transcript column; it has ${JSON.stringify(rows)}`);
  }
  const left = rows[header].indexOf("Transcript");
  const right = rows[header].indexOf("Bindings");
  // The pane's edge and the reading's rail become spaces: they are the frame
  // saying where a row is, not part of what the row says, and a wrapped line's
  // break is the whitespace either side of them.
  return rows.map((line) =>
    line.slice(left, right < 0 ? undefined : right).replace(/[\u2502\u2500]/g, " "),
  );
}

/** One string with every run of whitespace as one space, for comparing two. */
function flattened(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One history file's lines, projected as the model reads them. */
function* projectionOf(root: string, execution: string): Operation<ReplModel> {
  const projected = projectRepl(
    (yield* records(root, execution)).map((line) => {
      const parsed = parseDurableEvent(line);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    }),
  );
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

/** One history file's lines, without the trailing empty one. */
function* records(root: string, execution: string): Operation<string[]> {
  const text = yield* until(readFile(yield* historyPath(root, execution), "utf8"));
  return text.split("\n").filter((line) => line.length > 0);
}

describe("REPL journey: one entry, from raw bytes", () => {
  // The same compiler an entrypoint installs: an eval block is compiled, and a
  // host that supplies none refuses rather than evaluating nothing.
  beforeAll(() => useTempFileCompiler());

  it("J1: pasting the reference entry puts all of it in the draft and the location", function* () {
    const { terminal, install } = recordingTerminal();
    const source = yield* referenceSource();

    let outcome: ReplOutcome | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      // Pasted, as a terminal delivers a paste: one burst of bytes carrying
      // every line, including the newlines between them. The scanner hands over
      // 128 events per call and buffers the rest, so proving the whole document
      // arrived is proving the host drained it.
      const before = terminal.presented.length;
      terminal.bytes(BYTES.encode(source));
      yield* settled(60);

      // One burst is one frame, not one frame per character.
      expect(terminal.presented.length - before).toBeLessThan(4);
      // The field is one line and says how many precede it.
      expect(shows(terminal, `[${source.split("\n").length - 1} lines]`)).toBe(true);
      // Nothing durable yet: a draft is this process's, and the file is empty.
      expect(yield* records(root, files[0])).toEqual([]);

      terminal.end();
      yield* running;
    });

    // The canonical location carries the draft exactly — every line, every
    // character — which is what makes a draft reopenable before it is durable.
    const location = outcome?.location;
    expect(location).toBeDefined();
    const decoded = decodeLocation(location ?? "");
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.draft).toBe(source);
      expect(decoded.value.surface).toBe("entries");
      expect(decoded.value.at).toBeUndefined();
    }
  });

  it("J1: submitting admits exactly that source, and the run settles", function* () {
    const { terminal, install } = recordingTerminal();
    const source = yield* referenceSource();

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");
      yield* settled(400);

      const lines = yield* records(root, files[0]);
      expect(lines.length).toBeGreaterThan(0);
      // Every line is an ordinary durable record. There is no REPL record type,
      // no manifest and no cache: the file and the URL are the whole state.
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        expect(typeof parsed).toBe("object");
        if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
          expect(["yield", "close"]).toContain(parsed.type);
        }
      }

      // The entry is admitted and it has not settled, and the question it
      // reaches is being asked.
      //
      // Read from the history rather than from the screen. The footer used to
      // report admission, because the draft was replaced by a notice once an
      // entry existed; a draft is now execution-wide and goes on being typed
      // while an entry runs (#827 Slice C), so what says an entry exists is its
      // catalog row — and that row is in the sidebar, behind the open drawer.
      const admittedModel = yield* projectionOf(root, files[0]);
      expect(admittedModel.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(admittedModel.entries[0]?.source).toBe(source);
      expect(admittedModel.entries[0]?.settled).toBe(false);
      expect(askedRow(terminal)).toBeDefined();

      terminal.end();
      yield* running;
    });

    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
  });

  it("J1: the question is answered through the terminal, and the answer settles", function* () {
    const { terminal, install } = recordingTerminal();
    const source = yield* referenceSource();
    let location: string | undefined;

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        location = ran.value.location;
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");
      yield* settled(400);
      expect(askedRow(terminal)).toBeDefined();

      // The question announces itself and opens nothing. Activating that
      // announcement is what opens the drawer, and the drawer then shows the
      // retained schema as a form: one field, its choices.
      expect(shows(terminal, "decision: approve | decline")).toBe(false);
      yield* openQuestion(terminal);
      expect(shows(terminal, "decision: approve | decline")).toBe(true);

      // Typed, as a person types it, into the field the drawer focused.
      terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      terminal.feed("\r");
      yield* settled(400);

      // The answer is recorded as an ordinary elicit event, and what the document
      // rendered after it changed because of the stored answer.
      const lines = yield* records(root, files[0]);
      const recorded = lines.filter((line) => line.includes("elicit"));
      expect(recorded.length).toBeGreaterThan(0);
      // Reached through the reading's own window, for the accepted body gutter:
      // the same retained output pays out over more rows in an inset column.
      yield* scrollReadingTo(terminal, "Decision: approve");
      expect(shows(terminal, "Decision: approve")).toBe(true);
      // Settled: the root closed, so the answer is in the history and the
      // entry's catalog row carries the outcome it closed with.
      expect(shows(terminal, "[ok]")).toBe(true);

      terminal.end();
      yield* running;
    });

    // The Sessions surface is still there, and both of its sections are still
    // explicitly empty. Two sections rather than one placeholder since #883
    // PR 2: this command has a Sidekick, so Sessions has two owners and each
    // one says what it holds.
    expect(shows(terminal, "Entry agents")).toBe(true);
    expect(shows(terminal, "No entry turns.")).toBe(true);
    expect(shows(terminal, "No Sidekick turns.")).toBe(true);
    expect(location).toBeDefined();
    expect(terminal.resets).toBe(1);
  });

  it("J1: a second process reconstructs the view from the URL and the journal alone", function* () {
    const source = yield* referenceSource();
    const first = recordingTerminal();
    let root: string | undefined;
    let files: string[] = [];

    // One complete journey, then the process is over.
    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* settled();
      files = yield* histories(root);

      first.terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      first.terminal.feed("\r");
      yield* settled(400);
      // The question announces itself; activating that announcement is what opens
      // the form the answer is typed into.
      yield* openQuestion(first.terminal);
      first.terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      first.terminal.feed("\r");
      yield* settled(400);

      first.terminal.end();
      yield* running;
    });
    // Halted completely: no session, no provider, no observer, no view cache.
    expect(first.terminal.resets).toBe(1);
    expect(first.terminal.readers).toBe(0);

    const retained = root;
    expect(retained).toBeDefined();
    if (retained === undefined) {
      throw new Error("the first process created a repository");
    }
    const execution = files[0].replace(/\.jsonl$/, "");
    const lines = yield* records(retained, files[0]);

    // A location that selects something meaningful: a structural scope inside the
    // entry, a historical position, and a recorded drawer.
    const projected = projectRepl(
      lines.map((line) => {
        const parsed = parseDurableEvent(line);
        if (!parsed.ok) {
          throw parsed.error;
        }
        return parsed.value;
      }),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    const entry = projected.value.entries[0]?.scope;
    expect(entry).toBeDefined();
    const nested = entry?.scopes[0];
    expect(nested).toBeDefined();
    const binding = entry?.bindings[0];
    expect(binding).toBeDefined();
    const marker = projected.value.checkpoints[projected.value.checkpoints.length - 1]?.marker;
    expect(marker).toBeDefined();
    if (
      entry === undefined ||
      nested === undefined ||
      binding === undefined ||
      marker === undefined
    ) {
      throw new Error("the retained history holds an entry, a nested scope, a binding and markers");
    }

    // A drawer names something inside the scope the location selects, which is
    // why this selects the entry: the binding is the entry's, and a location that
    // opened it beside a nested scope would be describing two different places.
    const location = encodeLocation({
      execution,
      surface: "entries",
      scopes: [entry.key],
      drawers: [{ kind: "binding", name: binding.name }],
      at: marker,
      inspect: true,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    // A fresh host: a new terminal, a new repository handle, and nothing carried
    // over but that URL and the file it names.
    const second = recordingTerminal();
    let performed: Performed | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* installReplHost({
        dataRoot: () => retained,
        identify: () => {
          throw new Error("a reopened execution mints no identifier");
        },
        createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
        appendRecord: (path, record) => appendFile(path, record),
      });
      performed = yield* countPerformed();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({
          location,
          profile: PROFILE,
        });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(second.terminal);

      // The same topology, the same binding value, the same transcript and the
      // same recorded answer — read from the file, not re-run.
      // The drawer the location named is open on the retained value — named as
      // that binding, and holding the value the file retained for it.
      expect(shows(second.terminal, "[close]")).toBe(true);
      expect(shows(second.terminal, `Binding \u00b7 ${binding.name}`)).toBe(true);
      expect(shows(second.terminal, '"title": "Ship the REPL"')).toBe(true);

      // Out from under the drawer first: a modal covers what it is in front of, so
      // the columns beneath it are read once it is closed.
      //
      // Waited for, not counted: a modal closes when the next frame is built,
      // and a frame is measured work rather than a number of turns.
      second.terminal.feed("\x1b");
      yield* until_(second.terminal, "the drawer closing", (one) => !shows(one, "[close]"));

      // The same topology: the entry, and the nested component occurrence beneath
      // it, at the exact keys the first process recorded.
      expect(shows(second.terminal, entry.name)).toBe(true);
      expect(shows(second.terminal, nested.name)).toBe(true);
      // The binding value is asserted above, in the drawer this location named.
      //
      // Re-anchored for #883. It was asserted here as a `plan = ` row, which is
      // the Bindings column's own spelling — and this location carries no right
      // pane, so the reconstruction selects the Sidekick and that column is
      // never drawn in this frame. The row it matched was left on the
      // reconstructed screen by an earlier frame, which the accepted header
      // edges happen to overwrite. The claim is unchanged and is now read where
      // the retained value is actually drawn.
      // The same transcript, including the answer the first process gave and the
      // output that answer produced. Reached through the reading's own window:
      // the accepted row of space above each column heading costs this column a
      // row, so the last row of a full reading is a press away rather than
      // drawn. The string is the whole of what was retained either way, and
      // scrolling moved the viewport and wrote nothing.
      yield* scrollReadingTo(second.terminal, "Decision: approve");
      expect(shows(second.terminal, "Decision: approve")).toBe(true);

      second.terminal.end();
      yield* running;
    });

    // No completed work was performed again: no component source was read, no
    // eval block was compiled, and nobody was asked anything.
    expect(performed?.reads ?? ["unmeasured"]).toEqual([]);
    expect(performed?.compiles).toBe(0);
    expect(performed?.asked).toBe(0);
    // And nothing was appended: the file is exactly what the first process left.
    expect(yield* records(retained, files[0])).toEqual(lines);
    expect(second.terminal.resets).toBe(1);
  });

  it("J1: starting with no location creates one execution and focuses an empty draft", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      let outcome: ReplOutcome | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* settled();

      // One retained execution, created exclusively, and named opaquely.
      const files = yield* histories(root);
      expect(files).toHaveLength(1);
      const execution = files[0].replace(/\.jsonl$/, "");
      expect(execution).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
      // Nothing is in it yet: no entry, so no record.
      expect(yield* records(root, files[0])).toEqual([]);

      // The screen says where it is, what it holds and what it is waiting for.
      // Both Sessions sections say they hold nothing, which is what a mounted
      // command with a Sidekick draws since #883 PR 2.
      expect(shows(terminal, "Sessions")).toBe(true);
      expect(shows(terminal, "No entry turns.")).toBe(true);
      expect(shows(terminal, "No Sidekick turns.")).toBe(true);
      expect(shows(terminal, "Entries")).toBe(true);
      expect(shows(terminal, "(not submitted)")).toBe(true);

      terminal.end();
      yield* running;
      expect(outcome?.location).toBe(`xmd://repl/${execution}/entries`);
      expect(outcome?.refusal).toBeUndefined();
    });

    // And it gave the terminal back.
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
    expect(terminal.raw[terminal.raw.length - 1]).toBe(false);
  });
});

describe("REPL journey: leaving", () => {
  const DRAFT = "# queued behind an interrupt";

  it("J1: Control-C ends the command and prints the location", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      let outcome: ReplOutcome | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* settled();
      const files = yield* histories(root);
      const execution = files[0].replace(/\.jsonl$/, "");

      // The interrupt and nothing else. The stream is deliberately left open:
      // closing it would end the command by EOF and prove that instead.
      terminal.bytes(new Uint8Array([0x03]));
      yield* running;

      // The same ending every other way of leaving produces, location included.
      expect(outcome?.location).toBe(`xmd://repl/${execution}/entries`);
      expect(outcome?.refusal).toBeUndefined();
    });

    // And it gave the terminal back, exactly once.
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
    expect(terminal.raw[terminal.raw.length - 1]).toBe(false);
  });

  it("J1: Control-C leaves a refusal, and it is still a refusal", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      // A file that is not a projectable history, so the command mounts the
      // refusal screen instead of a session.
      const directory = join(root, "xmd", "repl");
      yield* until(mkdir(directory, { recursive: true }));
      yield* until(writeFile(join(directory, "broken.jsonl"), "{not a record}\n"));

      let refused: boolean | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({
          location: "xmd://repl/broken/entries",
          profile: PROFILE,
        });
        refused = !ran.ok;
      });
      yield* settled(20);
      expect(saysAcross(terminal, "cannot read")).toBe(true);

      // The interrupt, with the stream left open: the refusal screen is its own
      // loop, so a key that ends the main loop proves nothing about this one.
      terminal.bytes(new Uint8Array([0x03]));
      yield* running;

      // Left, and still refused: how a person leaves a location this command
      // cannot show does not turn it into one it could.
      expect(refused).toBe(true);
    });

    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
  });

  it("J1: input queued behind Control-C starts nothing and appends nothing", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      let outcome: ReplOutcome | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* settled();

      terminal.bytes(BYTES.encode(DRAFT));
      yield* settled();

      // One chunk carrying the interrupt and a submission behind it, which is
      // what a terminal delivers when both were typed before either was read.
      // The Enter is input that arrived before leaving was decided, so it must
      // reach nothing: a batch is not a licence to act after the decision.
      terminal.bytes(new Uint8Array([0x03, 0x0d]));
      yield* running;

      // Nothing was submitted, so the one history file this execution created
      // holds no record at all.
      const files = yield* histories(root);
      expect(files).toHaveLength(1);
      expect(yield* records(root, files[0])).toEqual([]);

      // And what was being typed survived, because the location is read off the
      // state as it stood when leaving was decided.
      const decoded = decodeLocation(outcome?.location ?? "");
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.draft).toBe(DRAFT);
      }
    });

    // Teardown still happens exactly once, on the way out of one decision.
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
    expect(terminal.raw[terminal.raw.length - 1]).toBe(false);
  });

  it("J1: a cold reopen restores the selection, the history position and the draft", function* () {
    const first = recordingTerminal();
    let root = "";
    let execution = "";

    // One process that admits an entry and ends, leaving only the file behind.
    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      root = yield* useTemporaryHost();
      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* settled();
      first.terminal.bytes(BYTES.encode("# cold reopen"));
      yield* settled();
      first.terminal.feed("\r");
      yield* settled(30);
      first.terminal.end();
      yield* running;
      execution = exited.route().execution;
    });

    const files = yield* histories(root);
    expect(files).toHaveLength(1);
    const path = yield* historyPath(root, files[0]!);
    const before = yield* until(readFile(path, "utf8"));

    // The three route members this row is about, read out of the file the first
    // process left rather than invented: an entry to select, and a position in
    // its history to be reading at.
    const projected = projectRepl(
      (yield* records(root, files[0])).map((line) => {
        const parsed = parseDurableEvent(line);
        if (!parsed.ok) {
          throw parsed.error;
        }
        return parsed.value;
      }),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    const entry = projected.value.entries[0]?.scope;
    const marker = projected.value.checkpoints[projected.value.checkpoints.length - 1]?.marker;
    if (entry === undefined || marker === undefined) {
      throw new Error("the retained history holds an entry and at least one position");
    }

    const location = encodeLocation({
      execution,
      surface: "entries",
      scopes: [entry.key],
      drawers: [],
      at: marker,
      inspect: false,
      draft: "# what comes next",
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    // A fresh host carrying nothing but that location and the file it names.
    const second = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      // Pointed at the file the first process left, and structurally unable to
      // mint an identifier or create one: a reopen that did either would be
      // starting an execution rather than reading one.
      yield* installReplHost({
        dataRoot: () => root,
        identify: () => {
          throw new Error("a reopened execution mints no identifier");
        },
        createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
        appendRecord: (path, record) => appendFile(path, record),
      });
      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE, location });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* settled();

      // On the screen, not merely in the route: the entry the location named is
      // the marked one, and what was being typed is in the draft row.
      expect(routedSurfaceOn(second.terminal)).toBe("Entries");
      expect(selectedEntryOn(second.terminal)).toBeDefined();
      expect(draftText(second.terminal)).toBe("# what comes next");

      second.terminal.end();
      yield* running;

      // And it ends where it was opened. One equality covers all three members,
      // because a location that lost the selection, the position or the draft
      // could not spell itself back the same way.
      expect(exited.location()).toBe(location);
    });

    // A cold process reads; it does not write.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(second.terminal.resets).toBe(1);
  });

  it("J1: no other chord ends it, so what leaves is the key and not the modifier", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      let outcome: ReplOutcome | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* settled();

      // Alt-a, Control-H and F5: still dropped whole. Without this the test
      // above would pass just as well had every chord been made to leave.
      terminal.bytes(BYTES.encode("\x1ba"));
      terminal.bytes(new Uint8Array([0x08]));
      terminal.bytes(BYTES.encode("\x1b[15~"));
      yield* settled(30);
      expect(outcome).toBeUndefined();

      terminal.end();
      yield* running;
      expect(outcome?.location).toBeDefined();
    });
  });
});

describe("REPL journey: what it refuses, and what it leaves alone", () => {
  it("J1: an invalid navigation leaves the standing route, tree, focus and targets", function* () {
    const { terminal, install } = recordingTerminal();
    const source = yield* referenceSource();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      // This one runs the document for real, so it needs the compiler an
      // entrypoint installs.
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");
      yield* settled(400);
      yield* dismissQuestion(terminal);

      // A standing, meaningful selection, reached through the product: the nested
      // component occurrence, which exists only after the run admitted it.
      yield* activate(terminal, "component Checklist");
      // Selected, and visibly so: the reading on screen is that scope's own.
      yield* until_(terminal, "the Checklist scope being read", (one) =>
        shows(one, "component Checklist"),
      );
      const before = screenOf(terminal);
      const admitted = yield* records(root, files[0]);

      // Now a history position from *before* that scope was admitted. Both
      // controls are ordinary mounted controls, and the combination is a view that
      // cannot exist: the route selects a scope the prefix does not hold.
      yield* activate(terminal, "[history]");
      yield* focusOn(terminal, "Entry 1 admitted");
      // What holds focus at the moment of the refused navigation, so the claim
      // afterwards is about the same control rather than about there being one.
      const focusedBefore = "Entry 1 admitted";
      expect(focusedOn(terminal, focusedBefore)).toBe(true);
      // And where its close control is, recorded now.
      const closeAt = coordinateOf(terminal, "[close]");
      terminal.feed("\r");
      yield* settled(60);

      // The route that stands is the one that worked. The drawer it was asked
      // from is still open — the navigation did not happen, so nothing it would
      // have changed changed — and the file is untouched.
      // The drawer it was asked from is still open, and no frozen position was
      // taken: a refused navigation changes nothing it would have changed.
      expect(shows(terminal, "History")).toBe(true);
      expect(historicalOn(terminal)).toBe(false);
      expect(yield* records(root, files[0])).toEqual(admitted);
      // And the screen says why, which is the only difference from before.
      expect(shows(terminal, "!")).toBe(true);

      // The same control still holds focus, in the same place.
      expect(focusedOn(terminal, focusedBefore)).toBe(true);
      // And the same pointer target is still the same reachable node: the exact
      // coordinate recorded *before* the refusal still reaches the same control
      // and still does what it did. Sent to that coordinate rather than to
      // wherever the control is now, because "the target moved" and "the target
      // survived" are different answers.
      expect(closeAt).toBeDefined();
      if (closeAt === undefined) {
        throw new Error("the open drawer has a close control");
      }
      yield* clickAt(terminal, closeAt);
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "[close]"));
      expect(before.length).toBeGreaterThan(0);

      terminal.end();
      yield* running;
      // The route that stands is the one that worked: the scope the product
      // really selected, and no frozen position.
      expect(exited.location()).toContain("/Checklist-1");
      expect(exited.route().at).toBeUndefined();
    });
  });

  it("J1: a document that cannot be admitted leaves the draft and an empty journal", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      // A component nothing supplies: refused before anything is admitted.
      terminal.bytes(BYTES.encode("<Nowhere />"));
      yield* settled(30);
      terminal.feed("\r");
      yield* settled(80);

      // The journal is empty, and the draft is exactly what was typed.
      expect(yield* records(root, files[0])).toEqual([]);
      expect(shows(terminal, "<Nowhere />")).toBe(true);
      // And the refusal says so rather than the keystroke seeming to do nothing.
      expect(screenOf(terminal).some((line) => line.includes("!"))).toBe(true);

      terminal.end();
      yield* running;
    });
    expect(terminal.resets).toBe(1);
  });

  it("J1: a second entry is refused, and history does not change", function* () {
    const { terminal, install } = recordingTerminal();
    const source = yield* referenceSource();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      // This one runs the document for real, so it needs the compiler an
      // entrypoint installs.
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");
      yield* settled(400);
      const admitted = yield* records(root, files[0]);
      expect(admitted.length).toBeGreaterThan(0);

      // The question's drawer owns focus while it is up, so typing would reach its
      // answer field rather than the draft. Dismissed first, and focus put back on
      // the draft, so what follows really is an attempt to submit a second entry.
      yield* dismissQuestion(terminal);
      yield* focusDraft(terminal);

      terminal.bytes(BYTES.encode("<Json value={1} />"));
      yield* settled(30);
      terminal.feed("\r");
      yield* settled(120);

      // The submission path itself refused, history did not change, and the
      // screen says why rather than appearing to do nothing.
      //
      // Superseded: this used to assert the one-entry ceiling. That ceiling is
      // gone — what refuses here is the lifecycle, because the entry before
      // this one is still running (#827 Slice C). The draft the refusal left is
      // exactly what was typed, which is the other half of the contract.
      expect(yield* records(root, files[0])).toEqual(admitted);
      expect(shows(terminal, "has not finished")).toBe(true);
      // A refused submission keeps what was typed, on the row a person is
      // looking at while they type it.
      expect(draftText(terminal)).toContain("<Json value={1} />");

      terminal.end();
      yield* running;
      // And the route it leaves still carries that draft, byte for byte.
      expect(exited.route().draft).toBe("<Json value={1} />");
    });
  });

  it("J1: a corrupt history refuses atomically, with no append and no session", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();
      const performed = yield* countPerformed();

      // A file that is not a projectable history.
      const directory = join(root, "xmd", "repl");
      yield* until(mkdir(directory, { recursive: true }));
      const path = join(directory, "broken.jsonl");
      yield* until(writeFile(path, "{not a record}\n"));
      const before = yield* until(readFile(path, "utf8"));

      // The refusal is a screen, so it is held until the person leaves it.
      let refused: boolean | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({
          location: "xmd://repl/broken/entries",
          profile: PROFILE,
        });
        refused = !ran.ok;
      });
      yield* settled(20);
      // What it says, rather than a crash: the command cannot show this history.
      expect(saysAcross(terminal, "cannot read")).toBe(true);
      terminal.end();
      yield* running;

      // Refused, not thrown: a location this command cannot show is an outcome.
      expect(refused).toBe(true);
      // Nothing ran, nothing was asked, and nothing was appended.
      expect(performed.reads).toEqual([]);
      expect(performed.compiles).toBe(0);
      expect(performed.asked).toBe(0);
      expect(yield* until(readFile(path, "utf8"))).toBe(before);
    });
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
  });

  it("J1: a malformed location reaches no path, no file and no terminal", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const ran = yield* runReplProgram({ location: "xmd://repl//repl", profile: PROFILE });
      expect(ran.ok).toBe(false);

      // No directory was formed, no file was created, and the terminal's modes
      // were never touched.
      expect(yield* until(readdir(root))).toEqual([]);
      expect(terminal.raw).toEqual([]);
      expect(terminal.resets).toBe(0);
      expect(terminal.readers).toBe(0);
    });
  });

  it("J1: a control chord inserts nothing into the draft", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      let outcome: ReplOutcome | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        outcome = ran.value;
      });
      yield* settled();

      // Alt-a, Control-H and F5: each decodes to a letter or a key this product
      // has no meaning for, and none of them is text. Control-C is deliberately
      // not among them — it ends the command, so leaving it here would depart on
      // the first byte and the three after it would never be delivered. What it
      // does instead is "REPL journey: leaving".
      terminal.bytes(BYTES.encode("\x1ba"));
      terminal.bytes(new Uint8Array([0x08]));
      terminal.bytes(BYTES.encode("\x1b[15~"));
      yield* settled(30);
      terminal.end();
      yield* running;

      // The draft is still empty, so the canonical location carries none.
      const decoded = decodeLocation(outcome?.location ?? "");
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.draft).toBeUndefined();
      }
    });
  });

  it("J1: a terminal below the minimum refuses, and recovers when it grows", function* () {
    const { terminal, install } = recordingTerminal({ columns: 40, rows: 10 });
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* settled(20);

      // The one refusal with a remedy the person already has.
      expect(shows(terminal, "at least 72x20")).toBe(true);
      // And nothing behind it: no control was drawn, so none can be pointed at.
      expect(shows(terminal, "Sessions")).toBe(false);

      terminal.resized({ columns: 160, rows: 36 });
      yield* settled(30);
      // Recovered without restarting anything.
      expect(shows(terminal, "Sessions")).toBe(true);

      terminal.end();
      yield* running;
    });
    expect(terminal.resets).toBe(1);
  });
});

describe("REPL journey: the whole of it, from raw bytes", () => {
  it("J1: run, hold at a gate, inspect a prefix, return live, continue, answer, settle", function* () {
    const source = yield* referenceSource();
    const first = recordingTerminal();
    let root: string | undefined;
    let files: string[] = [];
    let captured: string | undefined;
    let liveMarkers: string[] = [];

    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();
      const terminal = first.terminal;

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      files = yield* histories(root);

      // 1. The draft, as the one row it is drawn on: the last line of what was
      // pasted, under a count of the rest. That every byte arrived is proved at
      // admission below, against the Journal — a row this wide cannot show it,
      // and reading it off a clipped preview would prove less than it looks.
      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      expect(draftText(terminal)).toBe(draftPreview(source));

      // 2. Admitted, and then held before it can reach the question.
      //
      // Pause has to be *requested* before the document gets as far as the
      // question, because the provider's outstanding request is work that keeps a
      // walk from ever becoming satisfied — a pause asked for then is a request
      // that never becomes a hold. So focus is put on the control that will sit
      // directly above Pause first, and the submit is followed immediately by the
      // two keystrokes that reach it: no screen is read in between, and nothing
      // waits.
      // Enter activates whatever holds focus, and what holds it is the draft — so
      // the submit goes first, and Pause is reached by walking *backwards* from
      // the draft: while expansion is playing nothing is held, so Continue is not
      // mounted and Pause is the one control before the draft. All of it in one
      // burst, so nothing is read and nothing waits.
      expect(draftFocused(terminal)).toBe(true);
      expect(draftText(terminal)).toBe(draftPreview(source));
      terminal.feed("\r");
      terminal.feed("\x1b[Z\r");

      // Exactly paused: expansion reached a gate and stopped there. `pausing` is a
      // request that has not been met, and continuing one of those continues
      // nothing.
      yield* until_(terminal, "expansion paused", (t) => shows(t, "[pause] paused"));

      // 3. Held: over many turns and clock releases, neither the file nor the
      // screen moves.
      const heldRecords = yield* records(root, files[0]);
      const heldScreen = screenOf(terminal);
      for (let turn = 0; turn < 6; turn += 1) {
        yield* sleep(10);
        yield* settled(30);
      }
      expect(yield* records(root, files[0])).toEqual(heldRecords);
      expect(screenOf(terminal)).toEqual(heldScreen);
      // And it is still held rather than having drifted on.
      expect(shows(terminal, "[pause] paused")).toBe(true);
      expect(askedRow(terminal)).toBeUndefined();

      // 4. An earlier prefix, chosen through History.
      yield* activate(terminal, "[history]");
      // The drawer is really up: it draws the positions and the way out of them.
      expect(shows(terminal, "[close]")).toBe(true);
      expect(shows(terminal, "Entry 1 admitted")).toBe(true);
      yield* focusOn(terminal, "Entry 1 admitted");
      terminal.feed("\r");
      yield* settled(40);

      // Frozen at a recorded position, which the screen says by offering the way
      // back to the head — a control that exists only while one is being read.
      expect(historicalOn(terminal)).toBe(true);
      // Read only, and nothing of the present in it.
      expect(shows(terminal, "[pause]")).toBe(false);
      expect(screenOf(terminal).some((line) => line.trim().startsWith("…"))).toBe(false);

      // 5. Back to the head, and Continue — once — releases the hold.
      terminal.feed("\x1b");
      yield* settled(30);
      yield* activate(terminal, "[live]");
      expect(historicalOn(terminal)).toBe(false);
      expect(askedRow(terminal)).toBeUndefined();

      yield* activate(terminal, "[continue]");
      yield* until_(terminal, "the question", (t) => askedRow(t) !== undefined);

      // 6. The same execution takes the typed answer and settles, once the
      // waiting announcement has been activated.
      yield* openQuestion(terminal);
      terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      terminal.feed("\r");
      // Waited for in the model first and then reached on screen: the gap above
      // each column heading costs the transcript a row, so this output is one
      // press down its own window rather than drawn with the rest.
      yield* until_(terminal, "the entry settling", (t) => shows(t, "[ok]"));
      yield* scrollReadingTo(terminal, "Decision: approve");
      expect(shows(terminal, "Decision: approve")).toBe(true);
      expect(shows(terminal, "[ok]")).toBe(true);

      // The generated fragment's source is on screen, inside the enclosure its
      // author wrote. Which text that is comes from the model rather than from a
      // guess at its wording; where it sits comes from the screen.
      //
      // Re-anchored for #881 PR 2. This used to assert that the fragment's
      // source row came above the effect row admitting it, both of which were
      // transcript records. The reading replaces that with the stronger claim:
      // the fragment is shown *where its producer was written*, between the
      // opening and closing tags the author typed.
      const settledModel = yield* projectionOf(root, files[0]);
      const at = settledModel.transcript.findIndex((row) => row.kind === "generated");
      expect(at).toBeGreaterThanOrEqual(0);
      const sourceRow = settledModel.transcript[at];
      if (sourceRow?.kind !== "generated" || sourceRow.source === undefined) {
        throw new Error("the settled history holds an admitted generated fragment");
      }
      // Recovered from the rows it was wrapped into, because the reading wraps
      // rather than clips: the whole of it is on the screen, across as many rows
      // as the pane needed, and concatenating the pane's own rows is what gets
      // it back.
      const column = transcriptColumn(terminal).join("");
      expect(flattened(column)).toContain(flattened(sourceRow.source));

      // 7. The complete binding value, from the drawer that holds it.
      yield* activate(terminal, "1. [ok] entry-1");
      // Through the tab, because the command's accepted default right pane is
      // the Sidekick: a person reading their bindings asks for them, and this
      // row is about what the binding's own drawer holds once they have.
      yield* activate(terminal, "Bindings");
      yield* activate(terminal, "plan");
      // The binding's own drawer, which is what naming it in a route opens.
      expect(shows(terminal, "[close]")).toBe(true);
      for (const line of JSON.stringify(PLAN, undefined, 2).split("\n")) {
        expect(shows(terminal, line)).toBe(true);
      }
      terminal.feed("\x1b");
      yield* settled(30);

      // 8. The complete ordered set of History positions, as the drawer lists them.
      yield* activate(terminal, "[history]");
      liveMarkers = drawerMarkers(terminal);
      expect(liveMarkers.length).toBeGreaterThan(4);

      // 9. The historical state a reader would want back: the terminal position,
      // read only, with the recorded question's drawer open on it.
      const terminalMarker = liveMarkers[liveMarkers.length - 1];
      yield* focusOn(terminal, terminalMarker);
      terminal.feed("\r");
      yield* settled(40);
      terminal.feed("\x1b");
      yield* settled(30);
      yield* activate(terminal, "answered");

      // The reading this state *is*, said on the screen: an entry selected, a
      // recorded position being read, and the retained answer's drawer over it.
      //
      // The first two are read with the layer out of the way and the third with
      // it back. A route drawer begins an eighth of the screen in — column 20
      // at this size — and the accepted body gutter moved the catalog's rows two
      // cells right, so the last character of `entry-1` now lands exactly on
      // that edge. Behind a modal this row reads `entry-`, and a claim about
      // which entry is selected cannot be made of six of its seven characters.
      // Closing keeps the position and the selection; only the layer moves.
      terminal.feed("\x1b");
      yield* settled(30);
      expect(selectedEntryOn(terminal)).toContain("entry-1");
      expect(historicalOn(terminal)).toBe(true);
      yield* activate(terminal, "answered");
      expect(shows(terminal, "[close]")).toBe(true);
      // The whole retained schema and the whole retained answer, reached through
      // the drawer's own window.
      //
      // This drawer scrolls (#875). It used to describe every row at once and
      // let the layout clip whatever did not fit, which put the tail of a long
      // record in no cell, no target and no focus stop while still claiming to
      // show it — and cost this drawer its own `[close]`. So the claim is no
      // longer "every line is on screen together" but the stronger one: every
      // line is **reachable**, and the rows that are not visible are not mounted.
      const { first: firstFrame, reached } = yield* drawerContent(terminal);
      const retainedRows = [
        ...JSON.stringify(SCHEMA, undefined, 2).split("\n"),
        ...JSON.stringify(ANSWER, undefined, 2).split("\n"),
      ].map((line) => line.trim());
      for (const line of retainedRows) {
        expect(reached).toContain(line);
      }
      // And it really was a window rather than one tall drawer. This record is
      // longer than the drawer can hold — schema and answer together are more
      // rows than its rectangle has — so the rows on screen at the end are not
      // the rows that were on screen at the start. Without this, `toContain`
      // above would also pass on a drawer that described every row at once and
      // let the layout clip whatever did not fit.
      const content =
        2 +
        JSON.stringify(SCHEMA, undefined, 2).split("\n").length +
        JSON.stringify(ANSWER, undefined, 2).split("\n").length;
      expect(firstFrame.length).toBeLessThan(content);
      expect(drawerMarkers(terminal)).not.toEqual(firstFrame);

      terminal.end();
      yield* running;
      // The canonical route that reading came to, taken where it is still
      // published: what the command returns on its way out. This is the string
      // the cold process below is given, so it is also what proves the route
      // survived the whole journey.
      captured = exited.location();
      const decoded = decodeLocation(captured);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.scopes).toEqual(["entry-1"]);
        expect(decoded.value.at).toBeDefined();
        expect(decoded.value.inspect).toBe(true);
        expect(decoded.value.drawers.map((one) => one.kind)).toEqual(["recorded-elicit"]);
      }
    });

    const retained = root;
    if (retained === undefined || captured === undefined) {
      throw new Error("the first process ran and reported a location");
    }
    const lines = yield* records(retained, files[0]);
    expect(lines.length).toBeGreaterThan(0);

    // 10. A fresh host, with nothing but that location and the file.
    const second = recordingTerminal();
    let performed: Performed | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* installReplHost({
        dataRoot: () => retained,
        identify: () => {
          throw new Error("a reopened execution mints no identifier");
        },
        createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
        appendRecord: (path, record) => appendFile(path, record),
      });
      performed = yield* countPerformed();

      const reopenedRoute = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({
          location: captured,
          profile: PROFILE,
        });
        if (!ran.ok) {
          throw ran.error;
        }
        reopenedRoute.settle(ran.value);
      });
      yield* untilDrawn(second.terminal);

      // The same reading, rebuilt from the URL and the file alone — read with
      // the drawer the location restored closed, for the reason above: this
      // layer's left edge falls on the last character of the catalog's row, so
      // behind it the name is `entry-`. Closing moves the layer and nothing
      // else; the drawer is reopened below for its own content.
      second.terminal.feed("\x1b");
      yield* settled(30);
      expect(selectedEntryOn(second.terminal)).toContain("entry-1");
      expect(historicalOn(second.terminal)).toBe(true);
      yield* activate(second.terminal, "answered");
      yield* until_(second.terminal, "the retained drawer again", (one) => shows(one, "[close]"));

      // The same retained question: the whole schema and the whole answer, not a
      // label that happens to contain the word. Reached through the drawer's own
      // window, which a reopened process opens at its first row — how far a
      // window is scrolled is process-local and no location carries it.
      const reopened = yield* drawerContent(second.terminal);
      for (const line of [
        ...JSON.stringify(SCHEMA, undefined, 2).split("\n"),
        ...JSON.stringify(ANSWER, undefined, 2).split("\n"),
      ]) {
        expect(reopened.reached).toContain(line.trim());
      }

      // Then out from under the drawer, for the rest of what the file holds.
      second.terminal.feed("\x1b");
      yield* settled(30);
      expect(shows(second.terminal, "component Checklist")).toBe(true);
      // Re-anchored for #881 PR 2: the transcript's `generated admitted:`
      // record row became the entry's reading, and the fragment this cold
      // process reconstructed is the catalog row that names it. The claim is
      // unchanged — a reopened process shows the generated region the first one
      // admitted.
      expect(shows(second.terminal, "generated generated")).toBe(true);
      // The last of that reading, reached through its own window: the accepted
      // row of space above each column heading costs this column a row, so the
      // output the answer produced is a press down rather than drawn with the
      // rest of it. The retained string is unchanged.
      yield* scrollReadingTo(second.terminal, "Decision: approve");
      expect(shows(second.terminal, "Decision: approve")).toBe(true);

      // The same complete binding value, asked for the same way.
      yield* activate(second.terminal, "Bindings");
      yield* activate(second.terminal, "plan");
      for (const line of JSON.stringify(PLAN, undefined, 2).split("\n")) {
        expect(shows(second.terminal, line)).toBe(true);
      }
      second.terminal.feed("\x1b");
      yield* settled(30);

      // And the same History positions, in the same order.
      yield* activate(second.terminal, "[history]");
      expect(drawerMarkers(second.terminal)).toEqual(liveMarkers);

      second.terminal.end();
      yield* running;
      // The route came back out of the cold process the way it went in: the same
      // execution, the same selected scope and the same frozen position. The
      // drawer differs because this reading ends with History open, which is a
      // thing this process did rather than a thing the route carried in.
      const reopenedFields = reopenedRoute.route();
      const original = decodeLocation(captured ?? "");
      if (!original.ok) {
        throw original.error;
      }
      expect(reopenedFields.execution).toBe(original.value.execution);
      expect(reopenedFields.scopes).toEqual(original.value.scopes);
      expect(reopenedFields.at).toBe(original.value.at);
      expect(reopenedFields.inspect).toBe(original.value.inspect);
    });

    // Nothing was performed again, and nothing was written.
    expect(performed?.reads ?? ["unmeasured"]).toEqual([]);
    expect(performed?.compiles).toBe(0);
    expect(performed?.asked).toBe(0);
    expect(yield* records(retained, files[0])).toEqual(lines);
    expect(second.terminal.resets).toBe(1);
    expect(second.terminal.readers).toBe(0);
    expect(second.terminal.listeners).toBe(0);
  });
});

describe("REPL journey: when a frame counts as applied", () => {
  it("J1: a frame is not acknowledged until it has been presented", function* () {
    const { terminal, install } = recordingTerminal();
    const clock = countingClock();

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* clock.install();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });

      // Let the first frames through, then block inside the next presentation.
      for (let turn = 0; turn < 30; turn += 1) {
        clock.release();
        yield* settled(6);
      }
      // Counted before the frame is drawn, so what is measured is what *this*
      // frame caused rather than whatever had already happened.
      const before = clock.waits;
      terminal.holdNextPresent();
      // A resize, because it causes exactly one frame: a keystroke that moves
      // focus causes a second one to redraw the marker, and a count has to have a
      // baseline it can name.
      terminal.resized({ columns: 150, rows: 34 });
      for (let turn = 0; turn < 20 && terminal.holdPresent === undefined; turn += 1) {
        clock.release();
        yield* settled(6);
      }
      const held = terminal.holdPresent;
      expect(held).toBeDefined();
      if (held === undefined) {
        throw new Error("a presentation was blocked so the frame stream could be read");
      }

      // The bytes are being written. The tick this frame is drawing with came from
      // a wait already counted, and because the frame has not been *applied* yet,
      // the stream has scheduled nothing behind it.
      yield* settled(20);
      clock.release();
      yield* settled(20);
      expect(clock.waits).toBe(before);

      // Released, and only now does the stream move on.
      held.release();
      yield* settled(20);
      clock.release();
      yield* settled(20);
      expect(clock.waits).toBeGreaterThan(before);

      terminal.end();
      yield* running;
    });
  });
});

describe("REPL journey: resizing while a frame is being prepared", () => {
  it("J2: a window dragged while a frame is being prepared keeps the command", function* () {
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    const clock = countingClock();

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* clock.install();
      const host = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });

      /** Let as many frames through as the program asks for. */
      function* drawing(turns = 24): Operation<void> {
        for (let turn = 0; turn < turns; turn += 1) {
          clock.release();
          yield* settled(6);
        }
      }

      // Settled wide, with something typed: a draft is state this product holds
      // nowhere but in the run, so it is the sharpest thing a rebuilt frame can
      // be shown to have kept.
      yield* drawing();
      terminal.feed("resize me");
      yield* drawing();
      const wide = screenOf(terminal);
      expect(wide.length).toBe(36);
      expect(shows(terminal, "resize me")).toBe(true);
      expect(shows(terminal, "Sessions")).toBe(true);
      /** The execution this run opened, named by the file it created for it. */
      const execution = (yield* histories(host))[0]?.replace(/\.jsonl$/, "");
      expect(execution).toBeDefined();

      // Dragged between the read this frame's measurement was taken against and
      // the read that revalidates it. Which read of the wake that is was measured
      // against this program rather than promised by it — what the row asserts is
      // that the measured frame and the terminal were out of step, and the two
      // controls for it are what keep that honest.
      //
      // Three, because that is where the boundary is. One keystroke reads the
      // size at the too-small check, again to resolve the frame, a third time
      // for the measurement the frame is built from, and a fourth to
      // revalidate it. The third is the measurement, so a drag armed there
      // answers it with the old size and leaves the new one for the
      // revalidation to find. It was four while every action also measured a
      // frame before reducing; typing no longer does, and the read that
      // preparation performed is gone.
      const from = terminal.presented.length;
      terminal.resizeAfterRead(3, { columns: 72, rows: 20 });
      terminal.feed("!");
      yield* drawing();

      // Alive, and still drawing.
      expect(terminal.presented.length).toBeGreaterThan(from);
      expect(terminal.size).toEqual({ columns: 72, rows: 20 });
      // The *first* frame after the drag is already the new size: the one
      // measured for 160x36 was abandoned before it could be mounted, not drawn
      // and then corrected.
      expect(replay([terminal.presented[from]]).length).toBe(20);
      const after = replay(terminal.presented.slice(from));

      // Drawn for the terminal that is there now: twenty rows, none of them
      // wider than seventy-two columns. A frame that kept the measurement it
      // took at 160x36 would place rows this screen does not have.
      expect(after.length).toBe(20);
      expect(after.filter((line) => line.length > 72)).toEqual([]);

      // And it is the product, not a refusal — the routed surface it had, and the
      // draft it was carrying, on the row a person types on.
      expect(after.some((line) => line.includes("at least 72x20"))).toBe(false);
      expect(after.some((line) => line.includes("* Entries"))).toBe(true);
      expect(after.some((line) => line.includes(">> Draft: resize me!"))).toBe(true);

      // And the same again, but dragged for longer than one frame is allowed to
      // rebuild for. Every size read answers with the size that was there and
      // leaves a different one behind it, so every preparation — well past the
      // eight a single frame may spend — is invalidated before it can
      // revalidate, and the drag settles back at 72x20 at the end of it.
      const churned = terminal.presented.length;
      terminal.churnSize(60, { columns: 72, rows: 20 });
      terminal.feed("?");
      for (let turn = 0; turn < 200 && terminal.churning() > 0; turn += 1) {
        clock.release();
        yield* settled(6);
      }
      // The drag really did run its course, which is what says more than eight
      // consecutive preparations were taken and abandoned.
      // Nothing presented while the terminal was moving wrote past the row the
      // settled terminal ends at. A frame measured for any of the sizes the drag
      // passed through would have — every one of them is taller than twenty rows
      // — so this is the assertion that says no stale geometry reached the
      // screen. Asserted before the drag is known to have drained, because a
      // frame presented from a measurement the terminal invalidated is the
      // defect whether or not the drag got to the end.
      const during = terminal.presented.slice(churned).map((bytes) => replay([bytes]).length);
      expect(during.filter((rows) => rows > 20)).toEqual([]);
      // Sixty size reads, and at most one frame out of all of them — the one the
      // drag settled on. Two reads go into every preparation, so this is far past
      // the eight a single frame may spend: the rest were abandoned before they
      // were mounted, and none of them was acknowledged.
      expect(during.length).toBeLessThanOrEqual(1);
      expect(terminal.churning()).toBe(0);

      // Settled, the command draws the valid frame for the size that is there.
      yield* drawing();
      expect(terminal.presented.length).toBeGreaterThan(churned);
      expect(terminal.size).toEqual({ columns: 72, rows: 20 });
      // The *first* frame after the drag is the settled size, not any of the
      // sizes the drag passed through.
      expect(replay([terminal.presented[churned]]).length).toBe(20);
      const settledScreen = replay(terminal.presented.slice(churned));
      expect(settledScreen.length).toBe(20);
      expect(settledScreen.filter((line) => line.length > 72)).toEqual([]);
      // With the state it had before any of it: same execution, same route,
      // same draft — now carrying the second keystroke.
      expect(settledScreen.some((line) => line.includes("at least 72x20"))).toBe(false);
      expect(settledScreen.some((line) => line.includes("* Entries"))).toBe(true);
      expect(settledScreen.some((line) => line.includes(">> Draft: resize me!?"))).toBe(true);
      // A whole frame again, not a fragment: the footer's own rows are all back,
      // which a narrow frame draws beneath the one outlet it routes.
      expect(settledScreen.some((line) => line.includes("[history]"))).toBe(true);
      expect(settledScreen.some((line) => line.includes(HISTORY_TITLE))).toBe(true);
      expect((execution ?? "").length).toBeGreaterThan(0);

      terminal.end();
      yield* running;
    });
  });
});

describe("REPL journey: the same product at every size", () => {
  it("J1: a long draft stays exact and usable at medium, and no row crosses its region", function* () {
    const source = yield* referenceSource();
    // Medium: a narrower content surface than wide, and an inspection column
    // beside it — so a location row written at the wide width would run into it.
    const { terminal, install } = recordingTerminal({ columns: 120, rows: 30 });

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);

      // One row, and it says how many lines it is not showing. A draft this long
      // is read on the row it is typed on; its exact bytes are asserted at exit,
      // where the route still carries them, rather than off a clipped preview.
      expect(draftText(terminal)).toBe(draftPreview(source));

      // And no row of the reading reaches past the surface it was placed in: the
      // columns to its right belong to the inspection column, and the layout
      // gave them to something else.
      const surface = surfaceWidthOf(terminal.size);
      expect(surface).toBeGreaterThan(0);
      for (const line of screenOf(terminal)) {
        const edges = [...line.matchAll(/\u2502/g)].map((one) => one.index ?? -1);
        for (const edge of edges) {
          // A pane edge is a column of its own, so nothing is written over it.
          expect(line[edge]).toBe("\u2502");
        }
      }

      terminal.end();
      yield* running;
      // Every byte of it, where the route still publishes them.
      expect(exited.route().draft).toBe(source);
    });
  });

  it("J1: a drawer covers what it is in front of, at medium and at wide", function* () {
    const source = yield* referenceSource();

    for (const size of [
      { columns: 120, rows: 30 },
      { columns: 160, rows: 36 },
    ]) {
      const { terminal, install } = recordingTerminal(size);
      yield* scoped(function* (): Operation<void> {
        yield* install();
        yield* immediateClock();
        yield* useTempFileCompiler();
        yield* useTemporaryHost();

        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(terminal);

        terminal.bytes(BYTES.encode(source));
        yield* settled(60);
        terminal.feed("\r");
        yield* dismissQuestion(terminal);
        // Across the rows this reading was cut into, not on one of them. The
        // source column reserves the rail, the separators and the status badge
        // out of the body, and the accepted body gutter takes two more cells
        // from each side — so a line of somebody's document is paid out over
        // more rows than it used to be. The text is the whole of what it was.
        yield* until_(terminal, "the transcript", (t) => saysAcross(t, "About to evaluate:"));

        // A transcript with something in it — recorded before anything covers it,
        // so what follows is a claim about coverage rather than about absence.
        // Texts that belong to the transcript and to nothing the drawer lists, so
        // finding one inside the drawer means it showed through.
        // Re-anchored for #881 PR 2: the transcript's record rows became the
        // entry's reading, so these are two lines of what that reading shows.
        // Both belong to it and to nothing this drawer lists — the retained
        // positions name `summarySource` and `<Checklist /> admitted`, so
        // neither `Source` nor `Checklist` would discriminate anything.
        const underneath = ["### Ship the REPL", "2 steps remain."];
        for (const text of underneath) {
          // Across the rows this column cut it into. The Transcript reserves
          // the rail, its separators and the status badge out of its body
          // before any source is cut, and the accepted sidebar width and body
          // gutter leave that body narrower — so a line of somebody's document
          // is paid out over more rows than it was. `saysAcross` rejoins a
          // block inside its own column, so the text is the whole of what it
          // was. The coverage claims below are positional and unaffected.
          expect([text, saysAcross(terminal, text)]).toEqual([text, true]);
        }

        // And then a drawer over it.
        yield* activate(terminal, "[history]");
        expect(shows(terminal, "History")).toBe(true);

        // None of it shows through: every row of the drawer's box reaches the
        // box's own right edge, so what it is in front of is behind it.
        const rows = screenOf(terminal);
        // The placed rectangle, for the same reason `drawerMarkers` uses it: the
        // guidance row says "History" at a frozen position, so searching the
        // screen for that word can find the sentence rather than the drawer.
        const box = drawerBox(terminal);
        const title = box.top;
        const { left, right } = box;
        // The drawer's own rows: its title, one per position it lists, and its
        // close control. A drawer draws rows rather than filling its box, so the
        // rows below its last one are the transcript and are meant to be.
        const drawn = drawerMarkers(terminal).length + 2;
        expect(drawn).toBeGreaterThan(4);
        for (let row = title; row < title + drawn; row += 1) {
          const inside = (rows[row] ?? "").slice(left, right);
          for (const text of underneath) {
            expect(inside.includes(text)).toBe(false);
          }
          // And positionally: no label this drawer lists is anywhere near this
          // long, so every column past it belongs to the drawer and must have
          // been painted by it. A drawer that stopped short would leave whatever
          // the transcript has out there exactly where it was. The drawer's own
          // top rule reaches that edge too, and is the drawer painting it.
          expect((inside.slice(LABEL_ROOM) ?? "").replace(/\u2500/g, "").trim()).toBe("");
        }

        terminal.end();
        yield* running;
      });
    }
  });

  it("J1: narrow still routes one surface, with the location above it", function* () {
    const { terminal, install } = recordingTerminal(NARROW);

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // The routed surface, and the location above it — both, at the smallest
      // size this REPL draws at.
      expect(shows(terminal, "Entries")).toBe(true);
      expect(routedSurfaceOn(terminal)).toBe("Entries");
      expect(surfaceWidthOf(terminal.size)).toBe(NARROW.columns);
      // Narrow draws no dedicated location, at this size or any other.
      expect(screenOf(terminal).some((line) => line.includes("xmd://"))).toBe(false);

      terminal.end();
      yield* running;
      // The route it was at is still the base reading, published on the way out.
      expect(exited.location()).toMatch(/^xmd:\/\/repl\/[A-Za-z0-9_-]+\/entries$/);
    });
  });
});

/**
 * What this command settles before it is allowed to do anything.
 *
 * Each of these is about *order*. The command's refusals are cheap only while
 * nothing has happened yet: a terminal that is not one, a URL that names
 * something the file never held, a question that has already been answered.
 * Discovered late, each of them costs something that cannot be taken back — an
 * empty history nobody asked for, records a typo caused, a location naming a
 * drawer that is not there.
 */
describe("REPL journey: what it settles before it acts", () => {
  beforeAll(() => useTempFileCompiler());

  it("J1: a piped invocation refuses before a history file exists", function* () {
    // The one thing that differs from every other test here: this host's
    // standard streams are not a terminal.
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 }, false);
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      // Spawned rather than awaited, so that a command which *fails* to refuse
      // is caught as a command still running instead of as a hanging test.
      let ran: Result<ReplOutcome> | undefined;
      const running = yield* spawn(function* (): Operation<void> {
        ran = yield* runReplProgram({ profile: PROFILE });
      });
      yield* settled(60);

      // It came straight back. No screen was opened, so there is nothing to
      // drive and nothing to wait for.
      expect(ran).toBeDefined();
      expect(ran?.ok).toBe(false);
      if (ran !== undefined && !ran.ok) {
        expect(ran.error.message).toContain("not available over a pipe");
      }
      // Nothing was created. Not an empty history file, not the directory that
      // would hold one — the refusal happened before the repository did.
      expect(yield* until(readdir(root))).toEqual([]);
      // And nothing touched the terminal: no raw mode, no alternate screen, and
      // so nothing to reset.
      expect(terminal.raw).toEqual([]);
      expect(terminal.presented).toEqual([]);
      expect(terminal.resets).toBe(0);

      terminal.end();
      yield* running;
    });
  });

  it("J1: a route naming a scope the history never had refuses before anything replays", function* () {
    const source = yield* referenceSource();
    const first = recordingTerminal();
    let retained = "";
    let files: string[] = [];
    let entryKey = "";

    // A history that is deliberately *unfinished*: the entry is admitted and
    // the run is holding at its question. Replaying one of these has somewhere
    // to go — it resumes, asks again and appends — which is exactly what a
    // route that cannot resolve must not be allowed to cause.
    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      retained = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(first.terminal);
      files = yield* histories(retained);

      first.terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      first.terminal.feed("\r");
      yield* until_(first.terminal, "the question", (t) => askedRow(t) !== undefined);

      // Left unanswered on purpose.
      first.terminal.end();
      yield* running;
    });

    const model = yield* projectionOf(retained, files[0]);
    expect(model.entries[0]?.scope).toBeDefined();
    entryKey = model.entries[0]?.key ?? "";
    expect(model.settled).toBe(false);
    const lines = yield* records(retained, files[0]);

    // A URL a person could plausibly type: the execution is real, the entry is
    // real, and one segment of the path is a typo.
    const mistyped = encodeLocation({
      execution: files[0].replace(/\.jsonl$/, ""),
      surface: "entries",
      scopes: [entryKey, "Nowhere-9"],
      drawers: [],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    const second = recordingTerminal();
    let performed: Performed | undefined;
    let outcome: Result<ReplOutcome> | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* installReplHost({
        dataRoot: () => retained,
        identify: () => {
          throw new Error("a reopened execution mints no identifier");
        },
        createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
        appendRecord: (path, record) => appendFile(path, record),
      });
      performed = yield* countPerformed();

      const running = yield* spawn(function* (): Operation<void> {
        outcome = yield* runReplProgram({
          location: mistyped,
          profile: PROFILE,
        });
      });
      // A refusal screen, not a reconstruction: waited for by what it says
      // rather than by a full frame, because a refusal *is* one row.
      yield* until_(second.terminal, "the refusal", (t) => shows(t, "Nowhere-9"));

      // It names the segment it could not follow, rather than showing a view
      // of something the URL did not ask for.
      expect(shows(second.terminal, "holds no Nowhere-9")).toBe(true);

      second.terminal.end();
      yield* running;
    });

    expect(outcome?.ok).toBe(false);
    // Nothing replayed. Nobody was asked the question a resumed run would have
    // asked again, no eval block was compiled, and the file is byte for byte
    // what the first process left behind.
    expect(performed?.asked).toBe(0);
    expect(performed?.compiles).toBe(0);
    expect(yield* records(retained, files[0])).toEqual(lines);
  });

  it("J1: a stale live-question URL refuses against a finished execution", function* () {
    const source = yield* referenceSource();
    const first = recordingTerminal();
    let retained = "";
    let files: string[] = [];

    // A history that ran to the end: the question was asked, answered and
    // recorded, and the root closed.
    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      retained = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(first.terminal);
      files = yield* histories(retained);

      first.terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      first.terminal.feed("\r");
      yield* openQuestion(first.terminal);
      first.terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      first.terminal.feed("\r");
      // Reached through the reading's own window, for the accepted body gutter.
      yield* scrollReadingTo(first.terminal, "Decision: approve");
      yield* until_(first.terminal, "the answer", (t) => shows(t, "Decision: approve"));

      first.terminal.end();
      yield* running;
    });

    const model = yield* projectionOf(retained, files[0]);
    expect(model.settled).toBe(true);
    const lines = yield* records(retained, files[0]);

    // The URL somebody kept from while the question was up. The execution it
    // names is real and the drawer it names was real — and the question is gone,
    // which no history records, so nothing this file holds could say otherwise.
    const stale = encodeLocation({
      execution: files[0].replace(/\.jsonl$/, ""),
      surface: "entries",
      scopes: [model.entries[0]?.key ?? ""],
      drawers: [{ kind: "live-elicit" }],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });
    expect(stale).toContain("+elicit");

    const second = recordingTerminal();
    let performed: Performed | undefined;
    let outcome: Result<ReplOutcome> | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* installReplHost({
        dataRoot: () => retained,
        identify: () => {
          throw new Error("a reopened execution mints no identifier");
        },
        createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
        appendRecord: (path, record) => appendFile(path, record),
      });
      performed = yield* countPerformed();

      const running = yield* spawn(function* (): Operation<void> {
        outcome = yield* runReplProgram({
          location: stale,
          profile: PROFILE,
        });
      });
      yield* until_(second.terminal, "the refusal", (t) => shows(t, "nothing is being asked"));

      second.terminal.end();
      yield* running;
    });

    // A refusal rather than a success with nothing on the screen, and the run it
    // would have replayed never happened.
    expect(outcome?.ok).toBe(false);
    expect(performed?.asked).toBe(0);
    expect(performed?.compiles).toBe(0);
    expect(yield* records(retained, files[0])).toEqual(lines);
  });

  it("J1: an answered history with its root still open refuses the same URL", function* () {
    // The shape `settled` cannot speak for: the question was asked *and
    // answered*, and only the root close is missing. Reopening it asks nobody
    // anything — it finishes the root and stops — so a route that resolved its
    // live drawer here would replay, append that close, and only then discover
    // there was no drawer to mount.
    const events = yield* referenceEvents();
    const unclosed = events.slice(0, -1);
    expect(events[events.length - 1]?.type).toBe("close");

    const { terminal, install } = recordingTerminal();
    let outcome: Result<ReplOutcome> | undefined;
    let performed: Performed | undefined;
    let before = "";
    let path = "";

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();
      const directory = join(root, "xmd", "repl");
      yield* until(mkdir(directory, { recursive: true }));
      path = join(directory, "unclosed.jsonl");
      yield* until(writeFile(path, unclosed.map((event) => serializeDurableEvent(event)).join("")));
      before = yield* until(readFile(path, "utf8"));
      performed = yield* countPerformed();

      const model = yield* projectionOf(root, "unclosed");
      expect(model.settled).toBe(false);
      expect(model.entries[0]?.scope.elicitations[0].answer).toEqual({ decision: "approve" });

      const running = yield* spawn(function* (): Operation<void> {
        outcome = yield* runReplProgram({
          location: `xmd://repl/unclosed/entries/${model.entries[0]?.key ?? ""}/+elicit`,
          profile: PROFILE,
        });
      });
      yield* until_(terminal, "the refusal", (t) => shows(t, "nothing is being asked"));

      terminal.end();
      yield* running;
    });

    expect(outcome?.ok).toBe(false);
    // Nothing replayed, and the close this reopen would have written is not
    // there: the file is exactly the prefix that was handed to it.
    expect(performed?.asked).toBe(0);
    expect(performed?.compiles).toBe(0);
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
  });

  it("J1: an accepted answer closes the drawer and clears it from the location", function* () {
    const { terminal, install } = recordingTerminal();
    const source = yield* referenceSource();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");
      yield* until_(terminal, "the question", (t) => askedRow(t) !== undefined);

      // Activating the announcement opens the drawer, and the drawer's own
      // controls are what say it is up.
      yield* openQuestion(terminal);
      yield* until_(terminal, "the question's drawer", (t) => shows(t, "[close]"));
      expect(shows(terminal, "[close]")).toBe(true);

      terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      terminal.feed("\r");
      // Reached through the reading's own window, for the accepted body gutter.
      yield* scrollReadingTo(terminal, "Decision: approve");
      yield* until_(terminal, "the answer", (t) => shows(t, "Decision: approve"));

      // The question is over, so the drawer is over: its controls are off the
      // screen, and nothing it mounted is left behind.
      expect(shows(terminal, "[close]")).toBe(false);
      // And the form it was typed into is gone with it, rather than standing
      // there still offering the choices.
      expect(shows(terminal, "decision: approve | decline")).toBe(false);

      expect((yield* records(root, files[0])).length).toBeGreaterThan(0);
      terminal.end();
      yield* running;
    });
  });

  it("J1: Continue is mounted only while a continuation is held", function* () {
    const { terminal, install } = recordingTerminal();
    const source = yield* referenceSource();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      expect(draftFocused(terminal)).toBe(true);
      // Submit, then reach Pause by walking backwards one control — which is
      // the whole claim: while expansion is playing, Pause is the control
      // immediately before the draft because Continue is not mounted at all.
      terminal.feed("\r");
      terminal.feed("\x1b[Z\r");

      yield* until_(terminal, "expansion paused", (t) => shows(t, "[pause] paused"));
      // Now a continuation is held, so the control that releases it exists.
      expect(shows(terminal, "[continue]")).toBe(true);

      terminal.end();
      yield* running;
    });
  });

  it("J1: Continue is refused while a pause is still being taken", function* () {
    // The state between asking and holding. A Continue accepted here would
    // withdraw the pause instead of releasing anything, so the reduction
    // refuses it — and says which of the two it is.
    const pausing = reduceRepl(initialState("abc"), { kind: "continue" }, EMPTY_MODEL_FOR_TEST, {
      output: "",
      question: undefined,
      expansion: "pausing",
      pausable: true,
      running: true,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    });
    expect(pausing.intent.kind).toBe("none");
    expect(pausing.state.refusal).toContain("not paused");

    const held = reduceRepl(initialState("abc"), { kind: "continue" }, EMPTY_MODEL_FOR_TEST, {
      output: "",
      question: undefined,
      expansion: "paused",
      pausable: true,
      running: true,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    });
    expect(held.intent.kind).toBe("continue");
    expect(held.state.refusal).toBe(undefined);
  });
});

/**
 * Pause during submission preparation (#883 PPA2–PPA5).
 *
 * The window these cases are about is the one between pressing Run and the
 * entry existing. Preflight validates the document — which reads the Markdown
 * definition of every component it names — and that read can suspend for as
 * long as a disk, an import or a provider takes. Submission is off the input
 * loop so that the person keeps their keyboard throughout it, and Pause is
 * offered from the moment the slot is reserved so that what they can do with
 * that keyboard includes stopping the entry they just asked for.
 *
 * The hold is proved against the real seam. One actual `validateDocument` read
 * is held through the runtime's own `API.Fs` middleware, the program is the
 * production assembly, and readiness comes from latches and the frames the
 * renderer actually presented. A fake `session.submit` would prove that this
 * suite can describe the behaviour, not that the product has it.
 */
describe("REPL journey: Pause reaches a submission before its entry exists", () => {
  /** The sizes this evidence covers, which are the three the product supports. */
  const SIZES: readonly ReplTerminalSize[] = [
    { columns: 160, rows: 36 },
    { columns: 120, rows: 30 },
    { columns: 72, rows: 20 },
  ];

  /** The Markdown definition the reference entry's first element names. */
  const DEFINITION = "Checklist.md";

  /**
   * Hold the one definition read a preflight makes, and release it on demand.
   *
   * The first read of that one path and no other, so what is held is the
   * validation and not the event loop: the screen keeps drawing, the draft keeps
   * taking bytes, and every other read — including the same component's import
   * once the entry really runs — goes straight through. Installed on the test's
   * own scope, which is outside the command, so it wraps the reads the command
   * makes without being part of what it installs.
   */
  function heldDefinition(path: string): {
    install(): Operation<void>;
    /** Resolves once the preflight is actually standing in that read. */
    readonly reached: Operation<void>;
    release(): void;
    readonly holding: boolean;
  } {
    const entered = withResolvers<void>();
    const gate = withResolvers<void>();
    let holding = false;
    let held = 0;
    return {
      get holding() {
        return holding;
      },
      reached: entered.operation,
      release(): void {
        gate.resolve();
      },
      *install(): Operation<void> {
        // Registered before anything waits on the gate, so a scope torn down
        // while the read is held releases it rather than joining a suspend
        // nobody is going to resolve.
        yield* ensure(() => gate.resolve());
        yield* API.Fs.around({
          *readTextFile([one], next) {
            if (held > 0 || !one.endsWith(path)) {
              return yield* next(one);
            }
            held += 1;
            holding = true;
            entered.resolve();
            try {
              yield* gate.operation;
            } finally {
              holding = false;
            }
            return yield* next(one);
          },
        });
      },
    };
  }

  /**
   * Hold the first runtime execution before its document is delegated.
   *
   * The window this opens is the one the early-live route was reachable
   * through: the entry has a task and the session says work is in flight, but
   * the record that gives the entry a position has not been written, so there
   * is nothing yet for a hold to hold. Only the first one, so the successor an
   * entry is followed by runs ordinarily.
   */
  function heldStartup(): {
    install(): Operation<void>;
    /** Resolves once a real execution is standing in front of its document. */
    readonly reached: Operation<void>;
    release(): void;
  } {
    const entered = withResolvers<void>();
    const gate = withResolvers<void>();
    let held = 0;
    return {
      reached: entered.operation,
      release(): void {
        gate.resolve();
      },
      *install(): Operation<void> {
        yield* ensure(() => gate.resolve());
        yield* Execution.around({
          *document([request], next): Operation<void> {
            if (held > 0) {
              return yield* next(request);
            }
            held += 1;
            entered.resolve();
            yield* gate.operation;
            return yield* next(request);
          },
        });
      },
    };
  }

  /**
   * Refuse one runtime root metadata composition, once.
   *
   * Installed *inside* `Execution.document`, so it belongs to the runtime
   * invocation and not to the preflight that validated it: refusing the
   * preflight would be the ordinary refusal PPA3(a) already covers, and the
   * interval this is about is the one after the entry has been admitted. Root
   * metadata and the document envelope are composed there, before the body
   * expands and before any gate is crossed — which is the one place an entry
   * can be armed, hold nothing, and then fail.
   *
   * Composition is synchronous, so the seam cannot be held open and `at` is
   * called in it rather than waited for. What a caller can read there is
   * whatever it can read without suspending.
   */
  function refusedRootMetadata(at: () => void): { install(): Operation<void> } {
    let refused = 0;
    return {
      *install(): Operation<void> {
        yield* Execution.around({
          *document([request], next): Operation<void> {
            yield* RootMetadata.around({
              metadata(args, delegate) {
                if (refused > 0) {
                  return delegate(...args);
                }
                refused += 1;
                at();
                throw new Error("runtime metadata refusal after root import");
              },
            });
            return yield* next(request);
          },
        });
      },
    };
  }

  /** The footer's one action row, at whatever size this terminal is. */
  function actionRow(terminal: Terminal): string {
    return screenOf(terminal)[terminal.size.rows - FOOTER_ROWS] ?? "";
  }

  /**
   * Count how often the reference entry's first authored step actually runs.
   *
   * The first thing its author wrote is the eval block at the top of
   * `fixtures/repl/entry.md`, and a hold that is early enough has to be earlier
   * than that. Counting the *invocation* rather than the compilation is the
   * whole point: a block is compiled before it is run, so a compile count would
   * go up at a hold that was working correctly. Counting the drawn row or the
   * later question would be looser still — a row that has not been painted yet
   * and a step that never ran look the same from the terminal.
   *
   * Wrapped around the real compiler rather than replacing it: the block that
   * runs is the one the production compiler produced, and only the first one is
   * wrapped, so a later block cannot add to this entry's count.
   */
  function* countFirstEval(): Operation<{ readonly invoked: number }> {
    const counted = { invoked: 0 };
    let wrapped = false;
    yield* API.Env.around({
      *compile([source, options], next) {
        const block = yield* next(source, options);
        if (wrapped) {
          return block;
        }
        wrapped = true;
        return (env: Record<string, unknown>) => {
          counted.invoked++;
          return block(env);
        };
      },
    });
    return counted;
  }

  for (const size of SIZES) {
    const at = `${size.columns}x${size.rows}`;

    it(`PPA2/PPA5: Pause is offered, requested and applied to the exact entry at ${at}`, function* () {
      const source = yield* referenceSource();
      const { terminal, install } = recordingTerminal(size);
      const preflight = heldDefinition(DEFINITION);

      yield* scoped(function* (): Operation<void> {
        yield* install();
        yield* immediateClock();
        yield* useTempFileCompiler();
        const root = yield* useTemporaryHost();
        const performed = yield* countPerformed();
        // Installed after the compiler it wraps, so what it counts is the block
        // the production compiler returned.
        const authored = yield* countFirstEval();
        yield* preflight.install();

        const exited = exitRoute();
        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
          exited.settle(ran.value);
        });
        yield* untilDrawn(terminal);
        const files = yield* histories(root);

        terminal.bytes(BYTES.encode(source));
        yield* settled(60);
        expect(draftFocused(terminal)).toBe(true);

        // 1. Run. The slot is reserved and the preflight is already suspended in
        // the definition read, so this is the whole window the amendment is
        // about: the entry does not exist and will not for as long as that read
        // is held.
        terminal.feed("\r");
        yield* preflight.reached;
        yield* until_(terminal, "the submission preparing", (one) =>
          shows(one, "[pause] preparing"),
        );
        expect(preflight.holding).toBe(true);
        // Nothing is admitted and nothing is held: there is no entry, so there
        // is no continuation, so there is nothing for Continue to release.
        expect(shows(terminal, "[continue]")).toBe(false);
        expect(yield* records(root, files[0] ?? "")).toEqual([]);

        // PPA5. The button, the state and nothing else, in the accepted order —
        // and the state is text. Backtab from the draft reaches Pause, because
        // the word beside it is not a focus stop and Continue is not mounted.
        const preparing = actionRow(terminal);
        expect(preparing.indexOf("[pause]")).toBeLessThan(preparing.indexOf("preparing"));
        expect(screenOf(terminal).length).toBe(size.rows);
        terminal.feed("\x1b[Z");
        yield* settled(30);
        expect(focusedOn(terminal, "[pause]")).toBe(true);
        expect(focusedOn(terminal, "preparing")).toBe(false);

        // 2. Activate it. The request stands against this exact submission and
        // stops nothing yet, so the word changes and Continue stays away.
        terminal.feed("\r");
        yield* until_(terminal, "the request standing", (one) => shows(one, "[pause] pausing"));
        expect(shows(terminal, "[continue]")).toBe(false);
        // Still the same control, still holding focus: one mounted identity
        // across the whole of this, which is what keeps a person's place.
        expect(focusedOn(terminal, "[pause]")).toBe(true);
        // And still nothing admitted — asking an entry to stop is not starting
        // it, and it is not cancelling the preparation either.
        expect(yield* records(root, files[0] ?? "")).toEqual([]);
        expect(performed.asked).toBe(0);

        // 3. Release the validation. The entry starts, is admitted, and holds —
        // before anything its author wrote has taken effect.
        preflight.release();
        yield* until_(terminal, "the exact entry held", (one) => shows(one, "[pause] paused"));
        expect(shows(terminal, "[continue]")).toBe(true);
        // The first thing this document's author wrote that anything outside it
        // can see is its question, and it has not been asked. Counted at the
        // seam that performs it as well as read off the screen: a row that has
        // not been drawn yet and a question that was never asked look the same
        // from the terminal alone.
        expect(askedRow(terminal)).toBeUndefined();
        expect(performed.asked).toBe(0);
        // And the first thing the author wrote has not run. The question is the
        // last of four authored steps, so a hold that stopped anywhere among
        // them would still show no question; this says the hold is earlier than
        // all of them.
        expect(authored.invoked).toBe(0);
        // The entry it holds is the one that was submitted, admitted under the
        // source that was reserved. The request changed neither.
        const admitted = yield* projectionOf(root, files[0] ?? "");
        expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
        expect(admitted.entries[0]?.source).toBe(source);

        // PPA5 again, now that a continuation is held: the state word sits
        // between the button and Continue, and is still not a focus stop.
        const paused = actionRow(terminal);
        expect(paused.indexOf("[pause]")).toBeLessThan(paused.indexOf("paused"));
        expect(paused.indexOf("paused")).toBeLessThan(paused.indexOf("[continue]"));
        expect(screenOf(terminal).length).toBe(size.rows);
        expect(focusedOn(terminal, "[pause]")).toBe(true);

        // 4. Continue releases the hold, and the effect it was held before
        // happens once.
        yield* activate(terminal, "[continue]");
        yield* until_(terminal, "the authored question", (one) => askedRow(one) !== undefined);
        expect(performed.asked).toBe(1);
        // Released, not replayed: the step the hold stood before has now run,
        // and run once. A hold that re-ran what it released would show two.
        expect(authored.invoked).toBe(1);
        yield* settled(60);
        expect(performed.asked).toBe(1);
        expect(authored.invoked).toBe(1);
        // One entry, one source, start to finish.
        const after = yield* projectionOf(root, files[0] ?? "");
        expect(after.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
        expect(after.entries[0]?.source).toBe(source);

        terminal.end();
        yield* running;
      });
    });
  }

  /**
   * Clear the draft the way a person does, one key at a time.
   *
   * There is no host call that empties it: the draft is a field, and what
   * empties a field is the key that deletes a character. A scenario that reached
   * past the field would be a scenario proving the field was never involved.
   */
  function* erase(terminal: Terminal, characters: number): Operation<void> {
    yield* focusDraft(terminal);
    for (let press = 0; press < characters; press += 1) {
      terminal.feed("\x7f");
    }
    yield* settled(40);
  }

  it("PPA1: one burst submits and requests the pause, with no frame in between", function* () {
    // The two J1 rows feed Run and the Backtab that reaches Pause as separate
    // writes, and a batch boundary falls between them — so the frame at the end
    // of the first batch is what mounts Pause for the second. This row removes
    // that help: both keys arrive in one write, so they are one batch, and the
    // tree that answers the Backtab is the one Run left behind. Without a mount
    // inside the batch the Backtab reaches `[exit]` and Enter ends the command.
    const source = yield* referenceSource();
    const { terminal, install } = recordingTerminal();
    const preflight = heldDefinition(DEFINITION);

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();
      yield* preflight.install();

      const exited = exitRoute();
      let ended = false;
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = true;
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      expect(draftFocused(terminal)).toBe(true);

      // Submit, walk back one control, activate it. One write, so nothing is
      // read and nothing waits.
      terminal.feed("\r\x1b[Z\r");
      yield* preflight.reached;
      yield* until_(terminal, "the request standing", (one) => shows(one, "[pause] pausing"));
      // The command is still running: the Backtab reached Pause, not the way out.
      expect(ended).toBe(false);
      expect(shows(terminal, "[continue]")).toBe(false);

      // And it was this submission's request: the entry it names holds.
      preflight.release();
      yield* until_(terminal, "the exact entry held", (one) => shows(one, "[pause] paused"));
      expect(shows(terminal, "[continue]")).toBe(true);
      const admitted = yield* projectionOf(root, files[0] ?? "");
      expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);

      terminal.end();
      yield* running;
    });
  });

  it("PPA3(a): a refused preflight discards its pause request, and the next entry plays", function* () {
    // Invalid, and invalid *after* the definition it names: the component is
    // resolved — which is the read this holds — and then nothing supplies the
    // second one, so the refusal is an ordinary preflight refusal rather than a
    // document that was never read.
    const refusedSource = '<Checklist title="held" steps={1} />\n\n<Nowhere />';
    const valid = yield* referenceSource();
    const { terminal, install } = recordingTerminal();
    const preflight = heldDefinition(DEFINITION);

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();
      const performed = yield* countPerformed();
      yield* preflight.install();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(refusedSource));
      yield* settled(40);
      terminal.feed("\r");
      yield* preflight.reached;
      yield* until_(terminal, "the submission preparing", (one) => shows(one, "[pause] preparing"));

      // Armed against a submission that is about to be refused.
      yield* activate(terminal, "[pause]");
      yield* until_(terminal, "the request standing", (one) => shows(one, "[pause] pausing"));

      preflight.release();
      // Refused, and said so. Nothing was admitted and the draft is the one
      // thing a person needs back.
      yield* until_(terminal, "the refusal", (one) =>
        screenOf(one).some((line) => line.includes("!")),
      );
      expect(yield* records(root, files[0] ?? "")).toEqual([]);
      expect(shows(terminal, "<Nowhere />")).toBe(true);
      // The request went with the submission it belonged to. There is no
      // preparation and no live entry, so there is no Pause at all.
      yield* until_(terminal, "no preparation left", (one) => !shows(one, "[pause]"));
      expect(shows(terminal, "[continue]")).toBe(false);

      // The successor, submitted into the same session and the same controller.
      // It plays: the refused request did not survive to be applied to it.
      yield* erase(terminal, refusedSource.length);
      terminal.bytes(BYTES.encode(valid));
      yield* settled(60);
      terminal.feed("\r");
      yield* until_(terminal, "the successor's question", (one) => askedRow(one) !== undefined);
      expect(performed.asked).toBe(1);
      // Never held, so never continued: the effect happened without anybody
      // releasing anything.
      expect(shows(terminal, "[continue]")).toBe(false);
      expect(shows(terminal, "[pause] paused")).toBe(false);
      expect(shows(terminal, "[pause] pausing")).toBe(false);
      const admitted = yield* projectionOf(root, files[0] ?? "");
      expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(admitted.entries[0]?.source).toBe(valid);

      terminal.end();
      yield* running;
    });
  });

  it("PPA3(b): an entry armed with no hold is disarmed by its own failure", function* () {
    const source = yield* referenceSource();
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    const preflight = heldDefinition(DEFINITION);
    /** What the refusal could see of this entry's authored work, from inside it. */
    let atSeam: number | undefined;

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();
      const performed = yield* countPerformed();
      const authored = yield* countFirstEval();
      yield* preflight.install();
      yield* refusedRootMetadata(() => {
        atSeam = authored.invoked;
      }).install();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);

      // Pause asked for before the entry exists, which is the request this row
      // is about: it is still only a request when the thing that fails happens.
      terminal.feed("\r");
      yield* preflight.reached;
      yield* until_(terminal, "the submission preparing", (one) => shows(one, "[pause] preparing"));
      yield* activate(terminal, "[pause]");
      yield* until_(terminal, "the request standing", (one) => shows(one, "[pause] pausing"));

      // The entry starts, is admitted, takes the request — and then fails while
      // its root metadata is composed, before the body expands. The failure is
      // the entry's own and reaches the screen.
      preflight.release();
      // Failed as an entry, not refused as a submission: it was admitted, so it
      // has a position of its own to carry its failure.
      yield* until_(terminal, "the failed entry", (one) => shows(one, "[err] entry-1"));
      // Read from inside the refusal: by the time it fails the entry is armed,
      // and nothing its author wrote has run. The body was never reached, so
      // the hold it was asked for had nothing to be early for.
      expect(atSeam).toBe(0);
      expect(performed.asked).toBe(0);
      // Disarmed by the cleanup the entry registered before it was armed, and
      // disarmed without releasing a hold nobody is standing in: once the entry
      // is gone there is no preparation and no live expansion, so there is no
      // Pause at all and nothing ever offered Continue.
      yield* until_(terminal, "no mode left behind", (one) => !shows(one, "[pause]"));
      expect(shows(terminal, "[continue]")).toBe(false);
      // Readable, and readable as one failed entry rather than as wreckage.
      const failed = yield* projectionOf(root, files[0] ?? "");
      expect(failed.entries.map((entry) => entry.key)).toEqual(["entry-1"]);

      // The successor, into the same session and the same controller. It plays:
      // the mode the failed entry asked for is not waiting for it, so its first
      // authored step happens with nobody releasing anything.
      //
      // Back to the draft first: the last thing activated was Pause, and the
      // control it was is not there any more.
      yield* focusDraft(terminal);
      expect(draftFocused(terminal)).toBe(true);
      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");
      yield* until_(terminal, "the successor's question", (one) => askedRow(one) !== undefined);
      expect(authored.invoked).toBe(1);
      expect(performed.asked).toBe(1);
      expect(shows(terminal, "[continue]")).toBe(false);
      expect(shows(terminal, "[pause] paused")).toBe(false);
      expect(shows(terminal, "[pause] pausing")).toBe(false);
      const after = yield* projectionOf(root, files[0] ?? "");
      expect(after.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

      terminal.end();
      yield* running;
    });
  });

  it("PPA3(c): Pause during startup waits for the entry it names", function* () {
    const source = yield* referenceSource();
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    const startup = heldStartup();

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();
      const performed = yield* countPerformed();
      const authored = yield* countFirstEval();
      yield* startup.install();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);

      // Run, and let the preflight through. What is held is further in than
      // PPA2's window: the entry has a task, the session is doing work, and the
      // execution is standing in front of its own document — and still nothing
      // has been admitted.
      terminal.feed("\r");
      yield* startup.reached;
      expect(yield* records(root, files[0] ?? "")).toEqual([]);

      // Pause now, through the mounted control. There is no entry to stop, so
      // there is nothing to offer a controller for: the request stands against
      // the reservation exactly as it would have during the preflight.
      yield* until_(terminal, "the submission preparing", (one) => shows(one, "[pause] preparing"));
      expect(shows(terminal, "[continue]")).toBe(false);
      yield* activate(terminal, "[pause]");
      yield* until_(terminal, "the request standing", (one) => shows(one, "[pause] pausing"));
      // Pending, and pending because there is nothing it could have taken: no
      // continuation is held, so Continue is absent, and the file still says
      // nothing was submitted. A hold taken here would be a hold on the import
      // that gives the entry its position.
      expect(shows(terminal, "[continue]")).toBe(false);
      expect(shows(terminal, "[pause] paused")).toBe(false);
      expect(yield* records(root, files[0] ?? "")).toEqual([]);
      expect(authored.invoked).toBe(0);

      // Release the startup. Now the entry is admitted, and the request it has
      // been holding reaches it — before its author's first step.
      startup.release();
      yield* until_(terminal, "the exact entry held", (one) => shows(one, "[pause] paused"));
      expect(shows(terminal, "[continue]")).toBe(true);
      expect(authored.invoked).toBe(0);
      expect(performed.asked).toBe(0);
      const admitted = yield* projectionOf(root, files[0] ?? "");
      expect(admitted.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(admitted.entries[0]?.source).toBe(source);

      // And Continue runs the step the hold stood before, once.
      yield* activate(terminal, "[continue]");
      yield* until_(terminal, "the authored question", (one) => askedRow(one) !== undefined);
      expect(authored.invoked).toBe(1);
      expect(performed.asked).toBe(1);
      yield* settled(60);
      expect(authored.invoked).toBe(1);
      expect(performed.asked).toBe(1);

      terminal.end();
      yield* running;
    });
  });

  it("PPA3(d): walking away from the head while a preflight is held admits nothing", function* () {
    // Two entries' worth of draft, because freezing the view needs a recorded
    // position to freeze at — so the first one is admitted ordinarily and the
    // second is the one this row is about.
    const first = "<Output>one</Output>";
    const second = '<Checklist title="second" steps={1} />';
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    const preflight = heldDefinition(DEFINITION);

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();
      yield* preflight.install();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      // One recorded entry, admitted the ordinary way. Its source names no
      // component, so the held definition read is not reached by it.
      terminal.bytes(BYTES.encode(first));
      yield* settled(60);
      terminal.feed("\r");
      yield* until_(terminal, "the first entry settled", (one) => shows(one, "entry-1"));
      expect(preflight.holding).toBe(false);

      // The second, which does name it — so submitting suspends in the
      // validation and the keyboard is still the person's throughout.
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(second));
      yield* settled(60);
      terminal.feed("\r");
      yield* preflight.reached;
      expect(preflight.holding).toBe(true);

      // And while it is held, they walk back to the recorded position. Nothing
      // about this is a withdrawal: they did not press Stop and they did not
      // edit anything — they are reading their own history.
      yield* activate(terminal, "[history]");
      yield* focusOn(terminal, "Entry 1 admitted");
      terminal.feed("\r");
      yield* settled(40);
      expect(historicalOn(terminal)).toBe(true);

      // Released. The preflight succeeds, and the submission is refused at the
      // entry's actual start rather than admitted: the route it was reserved
      // against is not the route anybody is standing at any more.
      preflight.release();
      yield* until_(terminal, "the refusal at the start", (one) =>
        shows(one, "moved away from the live head"),
      );
      // One entry, which is the one that was admitted before any of this.
      const after = yield* projectionOf(root, files[0] ?? "");
      expect(after.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(after.entries[0]?.source).toBe(first);
      // And the draft they never got to submit is still theirs.
      terminal.feed("\x1b");
      yield* settled(30);
      yield* activate(terminal, "[live]");
      expect(shows(terminal, second)).toBe(true);

      terminal.end();
      yield* running;
    });
  });

  it("PPA4: the keyboard still works while a preflight is held, and closing discards the request", function* () {
    // One line, so what the draft row says is the draft itself rather than a
    // count of lines — and naming the definition this holds, so submitting it
    // is what suspends in the read.
    const held = '<Checklist title="held" steps={1} />';
    const typed = " and more";
    const first = recordingTerminal();
    const preflight = heldDefinition(DEFINITION);
    let root = "";
    let execution = "";
    let location = "";

    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();
      const performed = yield* countPerformed();
      yield* preflight.install();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(first.terminal);
      const files = yield* histories(root);

      first.terminal.bytes(BYTES.encode(held));
      yield* settled(40);
      first.terminal.feed("\r");
      yield* preflight.reached;
      yield* until_(first.terminal, "the submission preparing", (one) =>
        shows(one, "[pause] preparing"),
      );
      yield* activate(first.terminal, "[pause]");
      yield* until_(first.terminal, "the request standing", (one) => shows(one, "[pause] pausing"));

      // The whole point of taking submission off the loop: the read is still
      // suspended, and the keyboard still reaches the draft. Asserted *before*
      // the release, so what is proved is that the edit was processed while the
      // validation was held rather than after it finished.
      yield* focusDraft(first.terminal);
      first.terminal.bytes(BYTES.encode(typed));
      yield* settled(40);
      expect(preflight.holding).toBe(true);
      expect(draftText(first.terminal)).toBe(draftPreview(held + typed));

      // And Exit reaches the command while it is still held. This cancels and
      // joins the work the submission owns; nothing is admitted, and no
      // terminal is invented for an entry that never existed.
      yield* activate(first.terminal, "[exit]");
      yield* running;
      // Joined, not abandoned: the read the submission was standing in unwound
      // with the task that owned it, so the command did not return while work
      // it started was still suspended somewhere.
      expect(preflight.holding).toBe(false);
      expect(yield* records(root, files[0] ?? "")).toEqual([]);
      expect(performed.asked).toBe(0);

      // The location it prints carries the newer draft, not the source that was
      // reserved: what was prepared was never admitted, and what the person has
      // is what they typed.
      location = exited.location();
      execution = exited.route().execution;
      expect(exited.route().draft).toBe(held + typed);
    });

    // A cold reopen of exactly that location, structurally unable to start an
    // execution. Nothing of the preparation comes back: it was this process's,
    // and no record carries it.
    const second = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* installReplHost({
        dataRoot: () => root,
        identify: () => {
          throw new Error("a reopened execution mints no identifier");
        },
        createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
        appendRecord: (path, record) => appendFile(path, record),
      });
      const performed = yield* countPerformed();
      const reopened = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE, location });
        if (!ran.ok) {
          throw ran.error;
        }
        reopened.settle(ran.value);
      });
      yield* untilDrawn(second.terminal);
      yield* settled(60);

      // The draft is restored and nothing else is: no preparation, no request,
      // and no Pause, because there is no submission and no live entry.
      expect(draftText(second.terminal)).toBe(draftPreview(held + typed));
      expect(shows(second.terminal, "[pause]")).toBe(false);
      expect(shows(second.terminal, "preparing")).toBe(false);
      expect(shows(second.terminal, "pausing")).toBe(false);
      expect(shows(second.terminal, "[continue]")).toBe(false);
      // And no work started on its own: a reopened location is something to
      // read, not something to run.
      expect(performed.asked).toBe(0);
      expect(performed.compiles).toBe(0);
      expect(yield* records(root, execution)).toEqual([]);

      second.terminal.end();
      yield* running;
    });
  });
});

/**
 * What a held run has already printed is on the screen while it is held.
 *
 * The elicitation provider is stopped before it registers its question, so the
 * run is inside the document with nothing pending: no question to show, no
 * answer to append, and the last thing it did was print. What it printed has
 * to be readable *then* rather than when the run finishes, because the overlay
 * exists precisely to show what the Journal has not settled yet.
 *
 * This pins the product's behaviour, not the wake that delivers it: expansion
 * moves around every element, so a frame is owed at nearly the same instant
 * for a second reason. `repl-execution.test.ts` covers the overlay's own
 * report of its output, which is the part that has no other announcer.
 */
describe("REPL journey: output nothing records still reaches the screen", () => {
  beforeAll(() => useTempFileCompiler());

  /** Distinctive, so finding it on the screen cannot be finding something else. */
  const PRINTED = "the-last-thing-this-document-prints";

  it("J1: text the Journal has not settled is drawn while the run is held", function* () {
    const { terminal, install } = recordingTerminal();
    const gate = withResolvers<void>();
    let held = 0;
    // One durable record, then plain text, then the question. The text is the
    // last thing this document does before it blocks, so no record follows it
    // and nothing but the text itself can ask for the frame that shows it.
    const source =
      "```js eval\n" +
      'const schema = { type: "object", properties: ' +
      '{ decision: { type: "string", enum: ["yes"] } }, ' +
      'required: ["decision"], additionalProperties: false };\n' +
      "```\n\n" +
      `${PRINTED}\n\n` +
      '<Elicit schema={schema} as="answer">Decide?</Elicit>\n';

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      // Held *before* the question is registered, so nothing about it has
      // reached this process yet: no pending question, no wake.
      yield* Elicitation.around({
        *elicit([request], next) {
          held += 1;
          yield* gate.operation;
          return yield* next(request);
        },
      });

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");

      // Wait for the run to reach the question and stop there.
      yield* until_(terminal, "the run reaching its question", () => held > 0);
      // Then let it sit, with nothing else able to move.
      for (let turn = 0; turn < 4; turn += 1) {
        yield* sleep(10);
        yield* settled(30);
      }

      // No question is pending, so nothing but output has woken this screen.
      //
      // Re-anchored for #881 PR 2: the Transcript now shows the entry's own
      // source, and `Decide?` is written in it — so the absence of a question
      // is asserted as the absence of a question rather than as the absence of
      // its words. That is the stronger claim and the one the reading makes:
      // source on the screen never proves anything is waiting.
      expect(askedRow(terminal)).toBeUndefined();
      // The text after the last record this document writes. Nothing recorded
      // it, nothing reprojected because of it, and it is on the screen — across
      // the rows the Transcript's own body cut it into. This one has no spaces
      // to wrap at, so the column cuts it at a code unit and the rows are
      // rejoined with nothing between them.
      expect(saysJoined(terminal, PRINTED)).toBe(true);

      gate.resolve();
      yield* until_(terminal, "the question", (t) => askedRow(t) !== undefined);
      expect((yield* records(root, files[0])).length).toBeGreaterThan(0);

      terminal.end();
      yield* running;
    });
  });
});

/**
 * Type one source into the draft and admit it as an entry.
 *
 * What says the entry exists is the catalog gaining a row the screen did not
 * have, beside a draft that has emptied — the draft is the thing this helper
 * just put there, so both halves are about this submission and no other.
 */
function* submitted(terminal: Terminal, source: string): Operation<void> {
  yield* focusDraft(terminal);
  const before = submitting(terminal);
  terminal.bytes(BYTES.encode(source));
  yield* settled(60);
  terminal.feed("\r");
  yield* admittedDraft(terminal, before);
}

/**
 * The history action against a prefix the selected entry predates (#827 ER1).
 *
 * Through the running command, because the clearing is a decision the loop
 * makes with a model it has just reprojected: the view the standing route asks
 * for does not resolve at the chosen position, and what the loop does about
 * that is the behavior. Driving the reducer alone would prove the decision and
 * not that anything calls it.
 */
describe("REPL journey: a position earlier than the entry being read", () => {
  it("ER1: the invalid entry clears, and the draft, surface and position stand", function* () {
    const { terminal, install } = recordingTerminal();

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      // Two entries, one after the other, through the one command. The second
      // is submitted without reopening anything, which is the Story's point.
      yield* submitted(terminal, "One.\n");
      yield* submitted(terminal, "Two.\n");
      const head = yield* projectionOf(root, files[0]);
      expect(head.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

      // Standing on the second entry, with the next one already being typed.
      yield* activate(terminal, "2. [ok] entry-2");
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode("Three."));
      yield* settled(40);
      expect(draftText(terminal)).toBe("Three.");

      // A position from before the second entry was ever admitted.
      yield* activate(terminal, "[history]");
      const markers = drawerMarkers(terminal);
      expect(markers.length).toBeGreaterThan(1);
      yield* activate(terminal, markers[0] ?? "");
      // The drawer is read through, so it is closed before the location is.
      terminal.feed("\x1b");
      yield* settled(40);

      // The selection that prefix cannot hold is gone from the catalog, and the
      // position asked for stands.
      expect(selectedEntryOn(terminal)).toBeUndefined();
      expect(historicalOn(terminal)).toBe(true);

      // And the catalog is the one that prefix holds, rather than the head's.
      // Which entries the prefix holds, whatever they had settled to by then —
      // at this position the first one has not closed.
      expect(shows(terminal, "] entry-1")).toBe(true);
      expect(shows(terminal, "] entry-2")).toBe(false);
      // The draft stands through all of it, on the row it is typed on.
      expect(draftText(terminal)).toBe("Three.");

      terminal.end();
      yield* running;
      const after = decodeLocation(exited.location());
      expect(after.ok).toBe(true);
      if (after.ok) {
        // The entry that prefix never admitted is gone, and nothing was
        // guessed in its place.
        expect(after.value.scopes).toEqual([]);
        // The position is what was asked for, and it stands.
        expect(after.value.at).toBeDefined();
        expect(after.value.inspect).toBe(true);
        // So do the draft and the surface.
        expect(after.value.draft).toBe("Three.");
        expect(after.value.surface).toBe("entries");
      }
    });
  });
});

/**
 * One entry that publishes a value and then holds at a question.
 *
 * The hold is what makes "a draft typed while an entry runs" a fact rather than
 * a race: an ordinary document settles whenever it settles, and a question is
 * the one place one stops and waits for somebody.
 */
const JOURNEY_ONE = [
  "```js eval",
  'const token = "alpha";',
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Ready?</Elicit>',
  "",
  "One: {token}/{answer.decision}",
  "",
].join("\n");

/** One entry that reads what the first published, renders it, and then fails. */
const JOURNEY_TWO = [
  "```js eval",
  "const seen = `${token}-two`;",
  "```",
  "",
  "Two: {seen}",
  "",
  "```js eval",
  "const lost = nothingDeclaredAnywhere;",
  "```",
  "",
].join("\n");

/** One entry that follows the failure and still reads the first entry's value. */
const JOURNEY_THREE = [
  "```js eval",
  "const after = `${token}-three`;",
  "```",
  "",
  "Three: {after}",
  "",
].join("\n");

/**
 * How long one of these waits may go unmet before it is a failure.
 *
 * Never reached by a passing run. It bounds the failure mode only, so a defect
 * says which wait went unmet instead of hanging.
 */
const JOURNEY_DEADLINE_MS = 10_000;

/**
 * Wait until the screen says something, bounded by real time.
 *
 * Real time rather than a count of attempts: what these wait for is work *off*
 * this interpreter — an eval block compiling, an entry settling, a record
 * appending — so a loop bounded by turns is really bounded by how busy the
 * machine is, and a run beside a heavy one reports a wrong answer rather than a
 * slow one.
 */
function* awaiting(
  terminal: Terminal,
  what: string,
  says: (terminal: Terminal) => boolean,
): Operation<void> {
  const deadline = Date.now() + JOURNEY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (says(terminal)) {
      return;
    }
    yield* sleep(10);
    yield* settled(20);
  }
  throw new Error(
    `${what} never happened within ${JOURNEY_DEADLINE_MS}ms. rows=` +
      JSON.stringify(
        screenOf(terminal)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
  );
}

/**
 * Reach the waiting question's drawer, and wait until it draws this line.
 *
 * Two acts, because a question announces itself and opens nothing: waiting for a
 * drawer to appear on its own would wait until the deadline.
 */
function* awaitingDrawer(terminal: Terminal, line: string): Operation<void> {
  yield* awaiting(
    terminal,
    "the waiting question announcing itself",
    (one) => askedRow(one) !== undefined,
  );
  const at = askedRow(terminal);
  if (at === undefined) {
    throw new Error("the waiting question's control left the screen before it could be activated");
  }
  yield* clickAt(terminal, at);
  yield* awaiting(terminal, `the drawer drawing ${line}`, (one) => shows(one, line));
}

/**
 * Install a host over a repository that already exists.
 *
 * A reopen mints no identifier and creates no file, so both are refusals rather
 * than values: a cold open that quietly made either would not be a cold open.
 */
function* reopening(root: string): Operation<void> {
  yield* installReplHost({
    dataRoot: () => root,
    identify: () => {
      throw new Error("a reopened execution mints no identifier");
    },
    createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
    appendRecord: (path, record) => appendFile(path, record),
  });
}

/**
 * Whether this row carries the selection marker.
 *
 * Read off the rendered row rather than from the route, because what is under
 * test is that the frame says it. The marker sits in its own two columns before
 * the label, beside the focus marker and independent of it.
 */
function marked(terminal: Terminal, label: string): boolean {
  for (const line of screenOf(terminal)) {
    const at = line.indexOf(label);
    // The two columns immediately before the label, so a focus marker beside
    // them changes nothing: the two channels are independent.
    if (at >= 2 && line.slice(at - 2, at) === "* ") {
      return true;
    }
  }
  return false;
}

/**
 * Every rendered row, as the screen leaves it.
 *
 * Named for what it used to leave out: the rows the canonical location was drawn
 * on, which this product no longer draws. A comparison of two readings is now a
 * comparison of the whole screen.
 */
function without(terminal: Terminal): string[] {
  return screenOf(terminal).map((line) => line.trimEnd());
}

/**
 * Wait until a submitted draft has become an entry.
 *
 * Two facts, and neither of them alone. The catalog has gained a row it did not
 * have before, *and* the draft that produced it is empty. An entry that was
 * already there beside a draft that was already empty is the state before a
 * submission, so either half on its own would be satisfied by nothing happening.
 */
function admittedDraft(terminal: Terminal, before: Submitting): Operation<void> {
  return awaiting(terminal, "the draft becoming an entry", (one) => {
    if (draftText(one) !== "") {
      return false;
    }
    const now = entriesOn(one);
    if (now.length > before.entries.length && now.some((e) => !before.entries.includes(e))) {
      return true;
    }
    // A narrow frame routed to Sessions draws no catalog at all, so what says an
    // entry was admitted there is the status row naming one it did not name.
    return now.length === 0 && statusOn(one) !== before.status;
  });
}

/** What the screen held before a submission, so the change can be read off it. */
interface Submitting {
  readonly entries: readonly string[];
  readonly status: string | undefined;
}

function submitting(terminal: Terminal): Submitting {
  return { entries: entriesOn(terminal), status: statusOn(terminal) };
}

/** Wait until this entry's catalog row carries this outcome. */
function settledEntry(terminal: Terminal, order: number, outcome: string): Operation<void> {
  return awaiting(terminal, `entry ${order} reaching ${outcome}`, (one) =>
    shows(one, `${order}. [${outcome}]`),
  );
}

describe("REPL journey: three entries, one command", () => {
  it("EJ1: a draft survives a refusal, inherits, fails, and is followed", function* () {
    const { terminal, install } = recordingTerminal();
    let ended: ReplOutcome | undefined;

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      // 1. Entry 1, which publishes a value and then stops at its question.
      yield* submitted(terminal, JOURNEY_ONE);
      yield* awaitingDrawer(terminal, "decision: go");
      const held = yield* records(root, files[0]);
      expect(held.length).toBeGreaterThan(0);

      // 2. The next entry is drafted while that one is still running. The
      //    drawer owns focus while it is up, so it is dismissed first — the
      //    question stays open, which is what keeps Entry 1 live.
      terminal.feed("\x1b");
      yield* settled(30);
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(JOURNEY_TWO));
      yield* settled(60);
      expect(draftText(terminal).length).toBeGreaterThan(0);
      terminal.feed("\r");
      yield* settled(120);

      // Refused, because Entry 1 has not finished. Nothing was admitted, the
      // history did not move, and the draft is exactly where it was.
      expect(shows(terminal, "has not finished")).toBe(true);
      expect(yield* records(root, files[0])).toEqual(held);
      // The draft is exactly where it was, on the row it is typed on: the last
      // of its lines under a count of the rest.
      expect(draftText(terminal)).toBe(draftPreview(JOURNEY_TWO));

      // 3. Answer the question, and Entry 1 settles.
      yield* activate(terminal, "[answer]");
      yield* awaitingDrawer(terminal, "decision: go");
      terminal.bytes(BYTES.encode("go"));
      yield* settled(30);
      terminal.feed("\r");
      yield* settledEntry(terminal, 1, "ok");
      expect(shows(terminal, "One: alpha/go")).toBe(true);

      // 4. The same draft, still carrying every character, becomes Entry 2.
      yield* focusDraft(terminal);
      const beforeTwo = submitting(terminal);
      terminal.feed("\r");
      yield* admittedDraft(terminal, beforeTwo);
      yield* settledEntry(terminal, 2, "err");

      // It read what Entry 1 published, and it failed after publishing its own.
      const afterTwo = yield* projectionOf(root, files[0]);
      expect(afterTwo.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      expect(afterTwo.entries[1]?.source).toBe(JOURNEY_TWO);
      expect(afterTwo.entries[1]?.terminal?.status).toBe("err");
      expect(afterTwo.entries[1]?.bindings.find((binding) => binding.name === "seen")?.value).toBe(
        "alpha-two",
      );
      // Entry 1's own values are untouched by the failure beside them.
      expect(afterTwo.entries[0]?.bindings.find((binding) => binding.name === "token")?.value).toBe(
        "alpha",
      );

      // 5. Entry 3 follows the failure, and still reads Entry 1's value.
      yield* submitted(terminal, JOURNEY_THREE);
      yield* settledEntry(terminal, 3, "ok");
      // Read under its own entry. Answering Entry 1's question selected the entry
      // that was asking, and a selected entry is a transcript locus — so Entry 3's
      // output appears where Entry 3 is, which is what selecting it shows.
      yield* activate(terminal, "3. [ok] entry-3");
      yield* awaiting(terminal, "entry 3's own transcript", (one) =>
        shows(one, "Three: alpha-three"),
      );
      expect(shows(terminal, "Three: alpha-three")).toBe(true);

      // Three entries, in admission order, with the outcomes they reached —
      // which is not the order their outcomes would sort in.
      const settledModel = yield* projectionOf(root, files[0]);
      expect(settledModel.entries.map((entry) => entry.key)).toEqual([
        "entry-1",
        "entry-2",
        "entry-3",
      ]);
      expect(settledModel.entries.map((entry) => entry.terminal?.status)).toEqual([
        "ok",
        "err",
        "ok",
      ]);
      for (const [at, outcome] of ["ok", "err", "ok"].entries()) {
        expect([at, shows(terminal, `${at + 1}. [${outcome}]`)]).toEqual([at, true]);
      }

      // 6. The first entry is still selectable, and selecting it is a locus.
      yield* activate(terminal, "1. [ok] entry-1");
      expect(selectedEntryOn(terminal)).toContain("entry-1");
      yield* awaiting(terminal, "entry 1's own transcript", (one) => shows(one, "One: alpha/go"));
      expect(shows(terminal, "Three: alpha-three")).toBe(false);

      terminal.end();
      yield* running;
    });

    expect(ended?.location).toBeDefined();
    expect(terminal.resets).toBe(1);
  });
});

/**
 * One entry whose two children run together: one asks, the other fails.
 *
 * The failing child waits on a fetch the test holds, so the question is open and
 * its drawer is mounted before anything fails — which is the only arrangement in
 * which a *mounted* drawer can be observed going away.
 */
const SIBLING_FAILS = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  "<All>",
  "<Spawn>",
  '<Elicit schema={schema} as="answer">Ready?</Elicit>',
  "</Spawn>",
  "<Spawn>",
  "```js eval",
  'yield* fetch("https://held.invalid/sibling");',
  "```",
  "</Spawn>",
  "</All>",
  "",
].join("\n");

/** One entry whose question is far wider than the narrowest supported frame. */
/** One short question, so the whole drawer — its control included — is drawn. */
const SHORT_QUESTION = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Go?</Elicit>',
  "",
  "Decision: {answer.decision}",
  "",
].join("\n");

const LONG_QUESTION = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">' +
    "Would you like to approve the plan that was drafted for this execution, " +
    "including every file it proposes to write and every command it proposes to run?" +
    "</Elicit>",
  "",
  "Decision: {answer.decision}",
  "",
].join("\n");

/** Two entries, the second reading what the first published, with no question. */
const COLD_ONE = ["```js eval", 'const token = "alpha";', "```", "", "One: {token}", ""].join("\n");

const COLD_TWO = [
  "```js eval",
  "const carried = `${token}-again`;",
  "```",
  "",
  "Two: {carried}",
  "",
].join("\n");

describe("REPL journey: what an open drawer covers, through the terminal", () => {
  /** Every cell of one rectangle that is not blank, as `column,row=character`. */
  const insideOf = (
    rows: readonly string[],
    box: { top: number; bottom: number; left: number; right: number },
  ): string[] => {
    const found: string[] = [];
    for (let row = box.top; row < box.bottom; row += 1) {
      const line = rows[row] ?? "";
      for (let column = box.left; column < box.right; column += 1) {
        const cell = line[column] ?? " ";
        if (cell !== " ") {
          found.push(`${column},${row}=${cell}`);
        }
      }
    }
    return found;
  };

  /** The text of one rectangle's rows, joined, which is what a reader sees in it. */
  const textOf = (
    rows: readonly string[],
    box: { top: number; bottom: number; left: number; right: number },
  ): string =>
    Array.from({ length: box.bottom - box.top }, (_unused, at) =>
      (rows[box.top + at] ?? "").slice(box.left, box.right),
    ).join("\n");

  it("TL6: narrow from the start, and through a resize round trip, it obscures what it covers", function* () {
    const { terminal, install } = recordingTerminal({ columns: 72, rows: 20 });

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // A settled entry, so the body behind the drawer has a reading in it. A
      // narrow frame draws no transcript column, so what is behind the rectangle
      // there is the location and the catalog rather than the output — which is
      // why the rows covered are read off the screen rather than named here.
      yield* submitted(terminal, COLD_ONE);
      yield* settledEntry(terminal, 1, "ok");

      /**
       * What the drawer covers, and what it must leave alone, at this size.
       *
       * The rows are the accumulated screen rather than one frame's bytes,
       * because this renderer writes diffs: one frame holds only what changed,
       * and what is being asked about is what a person is looking at. Every size
       * change redraws the whole terminal, so inside this rectangle the
       * accumulated screen is current at whatever size it is read at.
       */
      function* covering(label: string): Operation<void> {
        const box = drawerBox(terminal);
        yield* settled(30);
        const body = screenOf(terminal);
        // Pre-assert: the rectangle the drawer is about to be placed in really
        // has text in it. Without this the assertion below would pass on an
        // empty screen.
        const behind = insideOf(body, box);
        expect(behind.length).toBeGreaterThan(0);
        const covered = textOf(body, box);
        expect(covered.trim().length).toBeGreaterThan(0);

        yield* activate(terminal, "[history]");
        // Waited for in the rectangle, because the drawer covers the row the
        // location is drawn on: there is no readable location to ask while it is
        // open, which is itself the coverage being tested.
        yield* until_(terminal, `the drawer at ${label}`, (one) =>
          textOf(screenOf(one), box).includes("History"),
        );
        yield* settled(30);
        const open = screenOf(terminal);
        const inside = textOf(open, box);
        // Its own rows are in the rectangle instead — including its heading, so
        // this is the drawer and not an empty hole.
        expect(inside).toContain("History");
        // And none of the lines it covered is anywhere inside it. Read as cells
        // rather than as descriptions: the blank interior of a short modal line
        // is exactly where a drawer without a background lets text through.
        // A window control the drawer offers *itself* cannot discriminate: both
        // panes spell `[^ earlier]` and `[v later]` the same way, so finding one
        // inside the rectangle says the drawer has its own, not that something
        // behind it showed through. Narrow routes one outlet holding the catalog
        // and the entry's reading, each with its own pair, so a fragment of one
        // of those labels is now among the covered lines.
        const shared = ["[\u2191 earlier]", "[\u2193 later]", "[close]"];
        for (const line of covered.split("\n").map((one) => one.trim())) {
          if (line.length < 4 || shared.some((control) => control.includes(line))) {
            continue;
          }
          expect([label, line, inside.includes(line)]).toEqual([label, line, false]);
        }
        // The footer is never covered: the draft owns the last row and shares it
        // with nothing.
        expect(box.bottom).toBeLessThanOrEqual(terminal.size.rows - 7);
        expect(open[terminal.size.rows - 1]?.includes(">")).toBe(true);

        terminal.feed("\x1b");
        yield* until_(terminal, `the drawer closing at ${label}`, (one) => !shows(one, "[close]"));
      }

      // Narrow from the start, which is not the same screen as one that was
      // resized down to it.
      yield* covering("72x20");

      // Then a round trip, because a diffing renderer leaves stale text exactly
      // where a rectangle moved.
      terminal.resized({ columns: 160, rows: 36 });
      yield* until_(terminal, "the wide frame", (one) => one.size.columns === 160);
      yield* covering("160x36");
      terminal.resized({ columns: 72, rows: 20 });
      yield* until_(terminal, "the narrow frame again", (one) => one.size.columns === 72);
      yield* covering("72x20 again");

      terminal.end();
      yield* running;
    });
  });
});

describe("REPL journey: a selection, a position and a draft across a resize", () => {
  it("TL10: wide to narrow and back keeps the whole reading, and a cold open restores it", function* () {
    const first = recordingTerminal({ columns: 160, rows: 36 });
    let root: string | undefined;
    let files: string[] = [];
    let ended: ReplOutcome | undefined;
    let standing: string | undefined;

    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();
      const terminal = first.terminal;

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);
      files = yield* histories(root);

      // Two settled entries, so there is a catalog to select from and positions
      // to read at.
      yield* submitted(terminal, COLD_ONE);
      yield* settledEntry(terminal, 1, "ok");
      yield* submitted(terminal, COLD_TWO);
      yield* settledEntry(terminal, 2, "ok");

      // 1. An entry selected by pointing at the cell its row is drawn in, which
      //    is the production input path for a selection.
      yield* click(terminal, "2. [ok] entry-2");
      yield* until_(terminal, "entry-2 being the locus", (one) =>
        (selectedEntryOn(one) ?? "").includes("entry-2"),
      );
      expect(marked(terminal, "2. [ok] entry-2")).toBe(true);

      // 2. A History position, chosen through the drawer the footer control
      //    opens. Entry 2's own admission, so the entry selected above still
      //    exists at it.
      yield* activate(terminal, "[history]");
      expect(shows(terminal, "[close]")).toBe(true);
      yield* focusOn(terminal, "Entry 2 admitted");
      terminal.feed("\r");
      yield* until_(terminal, "a frozen position", (one) => historicalOn(one));
      // Choosing a position does not close the drawer it was chosen in, so it is
      // dismissed the way a person dismisses it — and the position stands.
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "[close]"));
      expect(historicalOn(terminal)).toBe(true);

      // 3. A non-empty draft, typed into the field Tab reaches.
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(DRAFTED));
      yield* until_(
        terminal,
        "the draft reaching the row it is typed on",
        (one) => draftText(one) === DRAFTED,
      );

      // The whole semantic reading, as the screen shows it: the entry selected,
      // a recorded position being read, and the draft on its own row.
      expect(selectedEntryOn(terminal)).toContain("entry-2");
      expect(historicalOn(terminal)).toBe(true);
      expect(draftFocused(terminal)).toBe(true);
      expect(shows(terminal, `>> Draft: ${DRAFTED}`)).toBe(true);
      // At entry 2's own admission the catalog says what that position says: the
      // entry is there and has settled nothing yet.
      expect(marked(terminal, READING)).toBe(true);

      // 4. Narrow. The routed surface is one column wide now, and what a reader
      //    chose is still what the screen says: the draft is on its own row, the
      //    entry still carries the selection marker, and the catalog is still the
      //    catalog.
      // Read off the frames presented from the resize onward, because this
      // renderer writes diffs: a buffer that also held the wide frames would
      // answer with rows the narrow terminal no longer has.
      const from = terminal.presented.length;
      terminal.resized({ columns: 72, rows: 20 });
      yield* until_(
        terminal,
        "the narrow frame",
        (one) =>
          one.presented.length > from &&
          replay(one.presented.slice(from)).some((line) => line.includes("* Entries")),
      );
      const narrow = replay(terminal.presented.slice(from));
      expect(narrow.length).toBe(20);
      expect(narrow.filter((line) => line.trimEnd().length > 72)).toEqual([]);
      expect(narrow.some((line) => line.includes(`>> Draft: ${DRAFTED}`))).toBe(true);
      expect(markedIn(narrow, READING)).toBe(true);
      expect(narrow.some((line) => line.includes("1. [ok] entry-1"))).toBe(true);

      // 5. Wide again, and the reading is the one that went in: the same selected
      //    entry, the same frozen position, the same draft, on a screen that has
      //    been taken apart and rebuilt twice.
      const back = terminal.presented.length;
      terminal.resized({ columns: 160, rows: 36 });
      yield* until_(
        terminal,
        "the wide frame again",
        (one) => one.presented.length > back && replay(one.presented.slice(back)).length === 36,
      );
      expect(selectedEntryOn(terminal)).toContain("entry-2");
      expect(historicalOn(terminal)).toBe(true);
      expect(draftText(terminal)).toBe(DRAFTED);
      expect(marked(terminal, READING)).toBe(true);

      // 6. And the cells agree with the targets the frame published for them: a
      //    pointer at the row entry 1 is drawn in selects entry 1, and one at
      //    entry 2's row puts the reading back exactly as it was.
      yield* click(terminal, "1. [ok] entry-1");
      yield* until_(terminal, "entry-1 being the locus", (one) =>
        (selectedEntryOn(one) ?? "").includes("entry-1"),
      );
      expect(marked(terminal, "1. [ok] entry-1")).toBe(true);
      yield* click(terminal, READING);
      yield* until_(terminal, "entry-2 again", (one) =>
        (selectedEntryOn(one) ?? "").includes("entry-2"),
      );
      expect(marked(terminal, READING)).toBe(true);
      expect(draftText(terminal)).toBe(DRAFTED);

      terminal.end();
      yield* running;
    });

    // The whole reading, in the one string the command publishes on its way out:
    // route, surface, selected entry, frozen position, inspect and draft.
    standing = ended?.location;
    expect(standing).toContain("/entry-2");
    expect(standing).toContain("at=");
    expect(standing).toContain("inspect");
    const stood = decodeLocation(standing ?? "");
    expect(stood.ok).toBe(true);
    if (stood.ok) {
      expect(stood.value.draft).toBe(DRAFTED);
    }

    const retained = root;
    if (retained === undefined || standing === undefined) {
      throw new Error("the first process created a repository and showed a location");
    }
    const path = yield* historyPath(retained, files[0]!);
    const before = yield* until(readFile(path, "utf8"));

    // A cold process over that exact location: the same reading, with no work
    // performed and nothing appended.
    const second = recordingTerminal({ columns: 160, rows: 36 });
    let performed: Performed | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* reopening(retained);
      performed = yield* countPerformed();

      const coldRoute = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ location: standing, profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        coldRoute.settle(ran.value);
      });
      yield* untilDrawn(second.terminal);

      expect(shows(second.terminal, "1. [ok] entry-1")).toBe(true);
      // The position this location names, not the head: entry 2 is there and has
      // settled nothing at its own admission.
      expect(shows(second.terminal, READING)).toBe(true);
      expect(marked(second.terminal, READING)).toBe(true);
      expect(shows(second.terminal, `>> Draft: ${DRAFTED}`)).toBe(true);
      expect(selectedEntryOn(second.terminal)).toContain("entry-2");
      expect(historicalOn(second.terminal)).toBe(true);

      second.terminal.end();
      yield* running;
      // The same reading came back out of the cold process, byte for byte.
      expect(coldRoute.location()).toBe(standing);
    });

    // No entry source compiled, no component source read, nobody asked.
    expect(performed?.compiles).toBe(0);
    expect(performed?.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    expect(performed?.asked).toBe(0);
    // And the Journal is byte-identical: a cold process reads, it does not write.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(second.terminal.resets).toBe(1);
  });
});

/**
 * Whether one of these rows carries the selection marker before this label.
 *
 * The same reading as `marked`, over rows a caller has already chosen — which is
 * what an assertion about one size needs, since the accumulated buffer still holds
 * the rows the other size drew.
 */
function markedIn(rows: readonly string[], label: string): boolean {
  return rows.some((line) => {
    const at = line.indexOf(label);
    return at >= 2 && line.slice(at - 2, at) === "* ";
  });
}

/** The draft this reading carries across every size, with a space in it. */
const DRAFTED = "keep this draft";

/**
 * Entry 2's catalog row, as the position being read says it.
 *
 * At entry 2's own admission nothing of entry 2 has settled, so its outcome row
 * is the unfinished one — which is a fact about the position rather than about
 * the entry, and is why this label is not the settled one.
 */
const READING = "2. [unfinished] entry-2";

/** Two more sources, so there are more positions than a narrow drawer holds. */
const COLD_THREE = [
  "```js eval",
  "const onward = `${carried}-again`;",
  "```",
  "",
  "Three: {onward}",
  "",
].join("\n");

const COLD_FOUR = [
  "```js eval",
  "const onto = `${onward}-once-more`;",
  "```",
  "",
  "Four: {onto}",
  "",
].join("\n");

/**
 * What each category of position is called, written out here on purpose.
 *
 * A second opinion about the wording. Reading it from `pointLabel()` would make
 * the comparison below say only that one function agrees with itself, and the requirement is that the drawer offers *these* words — a category and an order, with
 * nothing of the payload in them.
 */
const CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  entry: "Entry %E admitted",
  scope: "Component admitted",
  binding: "Bindings recorded",
  generated: "Generated XMD admitted",
  elicit: "Answer recorded",
  agent: "Agent turn recorded",
  terminal: "Entry outcome recorded",
});

/**
 * Every row this model's positions should put in the drawer, in order.
 *
 * Built from the projected checkpoints' kinds alone: the ordinal is the position
 * in the recorded order and the entry number is how many entry admissions have
 * been passed, both counted here rather than read out of the thing under test.
 */
function expectedRows(model: ReplModel): string[] {
  let entry = 0;
  return model.checkpoints.map((checkpoint, index) => {
    if (checkpoint.kind === "entry") {
      entry += 1;
    }
    const words = CATEGORIES[checkpoint.kind];
    if (words === undefined) {
      throw new Error(`no category is written down for ${checkpoint.kind}`);
    }
    return `${index + 1} · ${words.replace("%E", String(entry))}`;
  });
}

/**
 * The band's own five rows, at the size the terminal is now.
 *
 * By layout, out of the footer's fixed seven rows: one action row, five band
 * rows, one draft row. Not by the title the band writes — the guidance row says
 * "History" at a frozen position (#870 UI15), and a walk that aimed at that word
 * would read the sentence about the position instead of the rail.
 */
function bandOf(terminal: Terminal): string[] {
  return bandIn(screenOf(terminal), terminal.size);
}

/**
 * The same five rows, out of rows a caller has already chosen.
 *
 * What an assertion about one size needs: this renderer writes diffs, so the whole
 * accumulated buffer still holds the rows the size before it drew, and the
 * footer of a 36-row screen is not where a 20-row screen keeps its band.
 */
function bandIn(rows: readonly string[], size: ReplTerminalSize): string[] {
  const actions = size.rows - FOOTER_ROWS;
  return rows.slice(actions + 1, actions + 1 + HISTORY_ROWS).map((row) => row.trimEnd());
}

/**
 * The band this terminal draws at one size, read from that size's own frames.
 *
 * Resizes, waits for a whole frame of the new size, and reads the band out of
 * it. The wait is for the rows the band itself writes: a frame counted before
 * it was finished would answer with a half-drawn rail.
 */
function* bandAt(terminal: Terminal, size: ReplTerminalSize): Operation<string[]> {
  if (terminal.size.columns === size.columns && terminal.size.rows === size.rows) {
    // Already there. A window told it is the size it is draws nothing, so a
    // wait for a frame of this size would wait for one nothing will send.
    return bandOf(terminal);
  }
  const from = terminal.presented.length;
  terminal.resized(size);
  yield* until_(terminal, `the whole frame at ${size.columns}x${size.rows}`, (one) => {
    if (one.presented.length <= from) {
      return false;
    }
    const shown = replay(one.presented.slice(from));
    return (
      shown.length === size.rows && bandIn(shown, size).some((row) => row.includes(HISTORY_TITLE))
    );
  });
  return bandIn(replay(terminal.presented.slice(from)), size);
}

describe("REPL journey: every recorded position, and every admitted size", () => {
  it("H5: the drawer reaches them all, and four resizes keep the reading", function* () {
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    let listed: string[] = [];
    let ended: ReplOutcome | undefined;

    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);

      // Three entries, so the recorded order is longer than one drawer window:
      // reaching the end of it is then something the window controls have to do
      // rather than something the first frame already did.
      yield* submitted(terminal, COLD_ONE);
      yield* settledEntry(terminal, 1, "ok");
      yield* submitted(terminal, COLD_TWO);
      yield* settledEntry(terminal, 2, "ok");
      yield* submitted(terminal, COLD_THREE);
      yield* settledEntry(terminal, 3, "ok");
      yield* submitted(terminal, COLD_FOUR);
      yield* settledEntry(terminal, 4, "ok");

      const model = yield* projectionOf(root, (yield* histories(root))[0]);
      const expected = expectedRows(model);
      expect(expected.length).toBeGreaterThan(8);

      // 1. The exact set, in the recorded order, reached through `[↓ later]`.
      yield* activate(terminal, "[history]");
      expect(shows(terminal, "[close]")).toBe(true);
      // Wide enough to hold them all, so this is the whole exact set in one
      // window. That the window *controls* reach the rest of a set too long for
      // one is step 7's claim, at a size where it really is too long.
      expect((yield* drawerContent(terminal)).reached).toEqual(expected);

      // 2. What is visible holds focus, and the cell it is drawn in is its own
      //    target. Checked over the window as it stands, row by row, because a
      //    row drawn outside the rectangle the targets were published for is
      //    exactly the defect: visible, unfocusable, and answering a pointer
      //    with whatever is behind it.
      const box = drawerBox(terminal);
      const window = drawerMarkers(terminal);
      // A walk over nothing would agree with every claim below it.
      expect(window.length).toBeGreaterThan(0);
      for (const row of window) {
        yield* focusOn(terminal, row);
        expect(focusedOn(terminal, row)).toBe(true);
        const at = coordinateOf(terminal, row);
        if (at === undefined) {
          throw new Error(`${row} holds focus and is not on the screen`);
        }
        expect([row, at.row >= box.top && at.row < box.bottom]).toEqual([row, true]);
        expect([row, at.column >= box.left && at.column < box.right]).toEqual([row, true]);
      }

      // 3. One of those rows, chosen by pointing at it, is the position it
      //    names and not the group the rail draws it in.
      const last = drawerMarkers(terminal)[drawerMarkers(terminal).length - 1];
      yield* click(terminal, last);
      yield* until_(terminal, "a frozen position", (one) => historicalOn(one));
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "[close]"));

      // 4. A whole reading to carry across the sizes: an entry selected, that
      //    position being read, and a draft nobody has submitted.
      yield* click(terminal, "1. [ok] entry-1");
      yield* until_(terminal, "entry-1 being the locus", (one) =>
        (selectedEntryOn(one) ?? "").includes("entry-1"),
      );
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(DRAFTED));
      yield* until_(terminal, "the draft on its row", (one) => draftText(one) === DRAFTED);
      expect(historicalOn(terminal)).toBe(true);
      expect(draftFocused(terminal)).toBe(true);
      listed = bandOf(terminal);
      expect(listed.some((row) => row.includes(HISTORY_TITLE))).toBe(true);

      // 5. The four sizes, in order. Each one is a profile: wide, medium,
      //    narrow, and a window too small to draw in at all.
      for (const size of [{ columns: 120, rows: 30 }, NARROW, { columns: 60, rows: 15 }]) {
        const from = terminal.presented.length;
        terminal.resized(size);
        yield* until_(
          terminal,
          `the frame at ${size.columns}x${size.rows}`,
          (one) =>
            one.presented.length > from &&
            replay(one.presented.slice(from)).some((line) => line.trim().length > 0),
        );
        const shown = replay(terminal.presented.slice(from));
        // Nothing drawn past the window's own edge, at any of them.
        expect(shown.filter((line) => line.trimEnd().length > size.columns)).toEqual([]);
        if (size.columns < NARROW.columns || size.rows < NARROW.rows) {
          // Too small to draw in: the refusal and nothing else, which is the
          // admission rule rather than a reading of this state.
          expect(shown.some((line) => line.includes("Make the window larger"))).toBe(true);
          continue;
        }
        // At a size it can draw at, the reading is the one that went in.
        expect(markedIn(shown, "1. [ok] entry-1")).toBe(true);
        expect(shown.some((line) => line.includes(`>> Draft: ${DRAFTED}`))).toBe(true);
      }

      // 6. Wide again. The marker, the route, the draft and the focus are the
      //    ones the reader left, after a screen taken apart four times.
      const back = terminal.presented.length;
      terminal.resized({ columns: 160, rows: 36 });
      yield* until_(
        terminal,
        "the wide frame again",
        (one) => one.presented.length > back && replay(one.presented.slice(back)).length === 36,
      );
      expect(selectedEntryOn(terminal)).toContain("entry-1");
      expect(historicalOn(terminal)).toBe(true);
      expect(draftText(terminal)).toBe(DRAFTED);
      expect(draftFocused(terminal)).toBe(true);
      // And the band is the band that went in: the same rail, mark for mark.
      expect(bandOf(terminal)).toEqual(listed);

      // 7. Narrow, where the recorded order is longer than the window: the rest
      //    of it is reached through `[↓ later]`, and the set is the same one.
      //    The resize is not allowed to have cost a position either.
      terminal.resized(NARROW);
      yield* until_(terminal, "the narrow frame", (one) => one.size.columns === NARROW.columns);
      yield* activate(terminal, "[history]");
      const narrow = yield* drawerContent(terminal);
      expect(narrow.reached).toEqual(expected);
      // The control did the reaching: one window held less than the whole set.
      expect(narrow.first.length).toBeLessThan(expected.length);

      terminal.end();
      yield* running;
    });

    expect(ended?.refusal).toBeUndefined();
    expect(terminal.resets).toBe(1);
  });
});

describe("REPL journey: a cold process at an early position", () => {
  it("H6: the settled head, the prefix, the same rail, and no work at all", function* () {
    const first = recordingTerminal({ columns: 160, rows: 36 });
    const sizes = [{ columns: 160, rows: 36 }, { columns: 120, rows: 30 }, NARROW];
    let root: string | undefined;
    let files: string[] = [];
    let standing: string | undefined;
    let expected: string[] = [];
    let hot: string[][] = [];

    // A hot process: two entries, a position early in the recorded order, a
    // draft, and a History drawer scrolled away from its first row.
    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();
      const terminal = first.terminal;

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);
      files = yield* histories(root);

      // Four entries, so the first position is early in a long recorded order
      // and that order is longer than a narrow drawer's window.
      yield* submitted(terminal, COLD_ONE);
      yield* settledEntry(terminal, 1, "ok");
      yield* submitted(terminal, COLD_TWO);
      yield* settledEntry(terminal, 2, "ok");
      yield* submitted(terminal, COLD_THREE);
      yield* settledEntry(terminal, 3, "ok");
      yield* submitted(terminal, COLD_FOUR);
      yield* settledEntry(terminal, 4, "ok");
      expected = expectedRows(yield* projectionOf(root, files[0]));

      // The first position in the recorded order: entry 1's own admission, which
      // the whole of entry 2 comes after.
      yield* activate(terminal, "[history]");
      yield* focusOn(terminal, expected[0]);
      terminal.feed("\r");
      yield* until_(terminal, "a frozen position", (one) => historicalOn(one));
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "[close]"));

      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(DRAFTED));
      yield* until_(terminal, "the draft on its row", (one) => draftText(one) === DRAFTED);

      // The rail this reading draws, at each size, read from that size's frames.
      for (const size of sizes) {
        hot.push(yield* bandAt(terminal, size));
      }
      // Rails with marks on them, so the comparison in the cold process below
      // is between two drawn rails rather than between two sets of blank rows.
      for (const band of hot) {
        expect(band.some((row) => row.includes("\u2501"))).toBe(true);
        expect(band.some((row) => /[\u25c6\u25bc\u2503]/.test(row))).toBe(true);
      }
      // Back to the size the cold process will open at, so the comparison below
      // is between two processes and not between two sizes.
      yield* bandAt(terminal, sizes[0]);

      // And the drawer scrolled off its first row before this process leaves, so
      // none of where it was looking is in what it leaves behind: the location
      // names a position and a draft and says nothing about a window over a
      // list. Scrolled at the narrow size, which is where the recorded order is
      // longer than the window that shows it.
      yield* bandAt(terminal, NARROW);
      yield* activate(terminal, "[history]");
      const walked = yield* drawerContent(terminal);
      expect(walked.reached).toEqual(expected);
      expect(drawerMarkers(terminal)[0]).not.toBe(expected[0]);
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "[close]"));

      terminal.end();
      yield* running;
      standing = exited.location();
    });

    const retained = root;
    if (retained === undefined || standing === undefined) {
      throw new Error("the first process created a repository and showed a location");
    }
    // What the location names: the early position and the draft, and nothing
    // about how anything was being looked at.
    const stood = decodeLocation(standing);
    expect(stood.ok).toBe(true);
    if (stood.ok) {
      expect(stood.value.draft).toBe(DRAFTED);
      expect(stood.value.at).toBeDefined();
    }
    const path = yield* historyPath(retained, files[0]!);
    const before = yield* until(readFile(path, "utf8"));
    const retainedFiles = yield* histories(retained);

    const second = recordingTerminal({ columns: 160, rows: 36 });
    let performed: Performed | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* reopening(retained);
      performed = yield* countPerformed();
      const terminal = second.terminal;

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ location: standing, profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // 1. A settled head. Nothing is running in this process and nothing ever
      //    will, so the band says the execution is down — not live, and not a
      //    state inherited from the process that recorded it.
      expect(bandOf(terminal).some((row) => row.includes("HEAD · SETTLED"))).toBe(true);
      for (const live of ["HEAD · LIVE", "HEAD · SETTLING", "HEAD · EXPANSION PAUSED"]) {
        expect([live, bandOf(terminal).some((row) => row.includes(live))]).toEqual([live, false]);
      }

      // 2. The prefix this location names: entry 1 is there, and entry 2 — which
      //    the whole of this position predates — is not.
      expect(shows(terminal, "1. [")).toBe(true);
      expect(shows(terminal, "2. [")).toBe(false);
      expect(historicalOn(terminal)).toBe(true);
      expect(draftText(terminal)).toBe(DRAFTED);

      // 3. No badge of a live process on it: nothing to pause, nothing
      //    streaming, nothing to continue.
      for (const badge of ["[pause]", "[continue]"]) {
        expect([badge, shows(terminal, badge)]).toEqual([badge, false]);
      }
      expect(screenOf(terminal).some((line) => line.trim().startsWith("…"))).toBe(false);

      // 4. The same rail, mark for mark, at each of the same sizes: navigation
      //    is the whole recorded file, so a process that holds one prefix of it
      //    draws what the process that recorded all of it drew.
      const cold: string[][] = [];
      for (const size of sizes) {
        cold.push(yield* bandAt(terminal, size));
      }
      expect(cold).toEqual(hot);
      yield* bandAt(terminal, sizes[0]);

      // 5. The same positions, by category and order, with nothing of a payload
      //    in any of them. And the window opens on the first one: the process
      //    that recorded this left its own scrolled to the end, and where it was
      //    looking is not part of the reading it handed on.
      expect(shows(terminal, "[close]")).toBe(false);
      yield* activate(terminal, "[history]");
      expect(drawerMarkers(terminal)[0]).toBe(expected[0]);
      const walked = yield* drawerContent(terminal);
      expect(walked.reached).toEqual(expected);
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "[close]"));

      terminal.end();
      yield* running;
      // The same reading went back out, which is what makes the claims above
      // about this process's reading rather than about a frame it drew once.
      expect(exited.location()).toBe(standing);
    });

    // 6. No work was performed to produce any of it: nothing compiled, no
    //    component source read, nobody asked.
    expect(performed?.compiles).toBe(0);
    expect(performed?.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    expect(performed?.asked).toBe(0);
    // And nothing was written: the same files, byte for byte.
    expect(yield* histories(retained)).toEqual(retainedFiles);
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(second.terminal.resets).toBe(1);
  });
});

describe("REPL journey: a cold process over a multi-entry journal", () => {
  it("EC1: the same catalog and the same selected entry, with no work and no append", function* () {
    const first = recordingTerminal();
    let root: string | undefined;
    let files: string[] = [];

    // Two entries through one command, and then the process is over.
    yield* scoped(function* (): Operation<void> {
      yield* first.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(first.terminal);
      files = yield* histories(root);

      yield* submitted(first.terminal, COLD_ONE);
      yield* settledEntry(first.terminal, 1, "ok");
      yield* submitted(first.terminal, COLD_TWO);
      yield* settledEntry(first.terminal, 2, "ok");
      expect(shows(first.terminal, "Two: alpha-again")).toBe(true);

      first.terminal.end();
      yield* running;
    });
    expect(first.terminal.resets).toBe(1);
    expect(first.terminal.readers).toBe(0);

    const retained = root;
    if (retained === undefined) {
      throw new Error("the first process created a repository");
    }
    const path = yield* historyPath(retained, files[0]!);
    const before = yield* until(readFile(path, "utf8"));
    const execution = files[0].replace(/\.jsonl$/, "");

    const live = yield* projectionOf(retained, files[0]);
    expect(live.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

    // A location that names the *second* entry, so what comes back has to be a
    // catalog and a selection rather than whatever happens to be first.
    const location = encodeLocation({
      execution,
      surface: "entries",
      scopes: ["entry-2"],
      drawers: [],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
      view: undefined,
      right: undefined,
      sidekick: undefined,
    });

    const second = recordingTerminal();
    let performed: Performed | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* second.install();
      yield* immediateClock();
      yield* installReplHost({
        dataRoot: () => retained,
        identify: () => {
          throw new Error("a reopened execution mints no identifier");
        },
        createExclusive: () => Promise.reject(new Error("a reopened execution creates no file")),
        appendRecord: (appendPath, record) => appendFile(appendPath, record),
      });
      performed = yield* countPerformed();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ location, profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(second.terminal);

      // Both entries, in admission order, with the outcomes the file holds —
      // and the one the location named is the locus.
      expect(shows(second.terminal, "1. [ok] entry-1")).toBe(true);
      expect(shows(second.terminal, "2. [ok] entry-2")).toBe(true);
      expect(selectedEntryOn(second.terminal)).toContain("entry-2");
      expect(shows(second.terminal, "Two: alpha-again")).toBe(true);
      // Entry 2's locus, not the whole execution's: the first entry's output
      // belongs to the row above, and selecting one is selecting a transcript.
      expect(shows(second.terminal, "One: alpha")).toBe(false);

      // The value the first entry published is still what the second inherited,
      // read back from the file rather than from anything this process ran.
      const cold = yield* projectionOf(retained, files[0]);
      expect(cold.entries[1]?.bindings.find((binding) => binding.name === "carried")?.value).toBe(
        "alpha-again",
      );

      second.terminal.end();
      yield* running;
    });

    // Nothing was performed to do it: no entry source compiled, no component
    // source read, and no provider reached.
    expect(performed?.compiles).toBe(0);
    expect(performed?.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    // And the file is the file. A cold process reads; it does not append.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    expect(second.terminal.resets).toBe(1);
  });
});

/**
 * Story #870: the terminal teaches its own interaction, and can be left.
 *
 * Every row here drives the production command through real terminal bytes and
 * reads the frame that was presented, because what is under test is what a
 * person can see and reach. A reducer that would have answered correctly is not
 * evidence that anything was on the screen.
 */
/**
 * Each row is a test of its own rather than a step inside one.
 *
 * A `describe` stops at its first failing step, so a negative control that breaks
 * an early row leaves every later one unreported — and an unreported row is not
 * evidence about anything. Top level, each of these can be run, and reddened, on
 * its own.
 */
/** An entry of this many lines, for measuring what an interaction costs beside it. */
function longEntry(lines: number): string {
  return `${Array.from({ length: lines }, (_, at) =>
    at % 4 === 3
      ? ""
      : `<Json value={{ ordinal: ${at}, note: "line ${at} of a long entry" }} as="n${at}" />`,
  ).join("\n")}\n`;
}

/**
 * What one interaction costs in terminal size reads, through the real loop.
 *
 * The root reads the size at the too-small check, again to resolve the frame,
 * again for the measurement the frame is built from, and again to revalidate
 * it. A fifth read appears the moment an action is answered with a freshly
 * measured frame — which is what the gate exists to avoid for a keystroke.
 * The recording terminal counts those reads, so this is the production
 * dispatch, preparation and reconciliation path observed from outside.
 */
function* costOf(terminal: Terminal, send: () => void): Operation<number> {
  const from = terminal.sized;
  send();
  yield* settled(40);
  return terminal.sized - from;
}

describe("REPL responsiveness: an interaction beside a long reading", () => {
  for (const lines of [12, 222]) {
    it(`RS3: typing and traversing beside a ${lines}-line entry read the size a fixed number of times`, function* () {
      const { terminal, install } = recordingTerminal();
      yield* scoped(function* (): Operation<void> {
        yield* install();
        yield* immediateClock();
        yield* useTempFileCompiler();
        yield* useTemporaryHost();

        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(terminal);
        yield* submitted(terminal, longEntry(lines));
        yield* settledEntry(terminal, 1, "ok");
        // The long reading is the selected one, so it is what a frame would
        // have to fit if anything made it fit again.
        yield* click(terminal, "1. [ok] entry-1");
        yield* focusDraft(terminal);
        yield* settled(40);

        // Warmup: the first keystroke after a selection still measures the
        // reading once, because this is the first frame that reading is in.
        yield* costOf(terminal, () => terminal.feed("a"));

        const typed = [
          yield* costOf(terminal, () => terminal.feed("b")),
          yield* costOf(terminal, () => terminal.feed("c")),
        ];
        const erased = yield* costOf(terminal, () => terminal.feed("\x7f"));
        const forward = yield* costOf(terminal, () => terminal.feed("\t"));
        const backward = yield* costOf(terminal, () => terminal.feed("\x1b[Z"));

        // Four reads each: the too-small check, the resolution, the frame's
        // measurement and its revalidation. A fifth would be an action
        // answered with a frame measured before it ran — which a keystroke
        // does not need, and which is what this count is here to catch.
        expect([lines, typed]).toEqual([lines, [4, 4]]);
        expect([lines, erased]).toEqual([lines, 4]);
        // A traversal is answered by the tree, not the reducer, so it reads
        // the size for its one frame and nothing else.
        expect([lines, forward]).toEqual([lines, 4]);
        expect([lines, backward]).toEqual([lines, 4]);

        terminal.end();
        yield* running;
      });
    });
  }
});

describe("REPL responsiveness: a focus move is one frame", () => {
  it("RS1: Tab moves the cue and the focus, and presents once", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);
      // Something to traverse, and a settled screen to count from.
      yield* submitted(terminal, COLD_ONE);
      yield* settledEntry(terminal, 1, "ok");
      yield* focusDraft(terminal);
      yield* settled(40);

      // Where focus is now, read off the screen rather than from the program.
      const before = screenOf(terminal).findIndex((line) => line.includes(">> "));
      expect(before).toBeGreaterThanOrEqual(0);

      const from = terminal.presented.length;
      terminal.feed("\t");
      yield* settled(40);

      // The cue moved, so the traversal happened.
      expect(screenOf(terminal).findIndex((line) => line.includes(">> "))).not.toBe(before);
      // And it cost one frame. It used to cost two: the first drew the control
      // the reader had just left and the second corrected it, so the marker was
      // always one keystroke behind what the tree already held.
      expect(terminal.presented.length - from).toBe(1);

      // Back again, the same way and for the same price.
      const back = terminal.presented.length;
      terminal.feed("\x1b[Z");
      yield* settled(40);
      expect(screenOf(terminal).findIndex((line) => line.includes(">> "))).toBe(before);
      expect(terminal.presented.length - back).toBe(1);

      terminal.end();
      yield* running;
    });
  });
});
describe("REPL first use: UI2", () => {
  it("UI2: Enter on [exit] ends the command without touching the history", function* () {
    const { terminal, install } = recordingTerminal();
    let ended: ReplOutcome | undefined;
    let root = "";
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);

      const files = yield* histories(root);
      const before = yield* until(readFile(yield* historyPath(root, files[0]!), "utf8"));

      // Reached by traversal, from what the screen shows: no hidden key, and the
      // control says what it is.
      yield* focusOn(terminal, "[exit]");
      expect(focusedOn(terminal, "[exit]")).toBe(true);
      terminal.feed("\r");

      // The command is over. Joined rather than polled: the scope the program owns
      // holds the session, the observer, the reader and the frame subscription,
      // and this returns only once every one of them has been halted and joined.
      yield* running;

      // Nothing was appended for leaving. Leaving is the absence of further work,
      // not an outcome, so the file is byte-identical.
      expect(yield* until(readFile(yield* historyPath(root, files[0]!), "utf8"))).toBe(before);
    });

    // Ordinary success, with a location to come back to, and the terminal given
    // back exactly once.
    expect(ended?.refusal).toBeUndefined();
    expect(ended?.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
  });
});
describe("REPL first use: UI2", () => {
  it("UI2: a pointer on [exit] is the same act as Enter on it", function* () {
    const { terminal, install } = recordingTerminal();
    let ended: ReplOutcome | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);

      // No traversal at all: a pointer resolves against the drawn frame, so this
      // reaches the control exactly where the screen draws it.
      yield* click(terminal, "[exit]");
      yield* running;
    });

    expect(ended?.refusal).toBeUndefined();
    expect(ended?.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
  });
});
describe("REPL first use: UI1", () => {
  it("UI1: the guidance teaches the ring that is mounted, at both sizes", function* () {
    for (const size of [{ columns: 160, rows: 36 }, NARROW]) {
      const { terminal, install } = recordingTerminal(size);
      yield* scoped(function* (): Operation<void> {
        yield* install();
        yield* immediateClock();
        yield* useTemporaryHost();

        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(terminal);

        // Focus starts on the draft, and what the screen says is what Enter there
        // does. Not a legend: the words change with the control under the cursor.
        expect(shows(terminal, "Type here")).toBe(true);
        expect(shows(terminal, "Enter submits")).toBe(true);
        expect(saysAcross(terminal, "Tab/Shift+Tab move")).toBe(true);
        // And the state it says that about, which is what makes "Enter submits"
        // a fact rather than a legend (#870 UI10).
        expect(shows(terminal, "Ready for Entry 1")).toBe(true);
        // Escape closes a drawer, and there is no drawer. A legend naming it here
        // would advertise an action nothing mounts.
        expect(shows(terminal, "Esc closes")).toBe(false);

        // Both ways out of the draft. Enter does not submit from a control, at
        // either size, and the row says so by not saying otherwise.
        yield* focusOn(terminal, "[exit]");
        expect(shows(terminal, "Enter submits")).toBe(false);
        // What Enter does on this node, rather than what it does on controls in
        // general: `[exit]` leaves the command (#870 UI16).
        expect(shows(terminal, "Enter exits")).toBe(true);
        // The state survives moving focus, which is the whole point of putting it
        // first: it is the one fact a person cannot work out from the keys.
        expect(shows(terminal, "Ready for Entry 1")).toBe(true);
        // Both say what Enter does and both say how to get back to the draft.
        // The narrow row says each in fewer columns, because it is composed to
        // fit 72 rather than written once and cut (#870 UI10/UI16): pointer
        // equivalence and the longer way of saying "Tab to the draft" are what
        // the extra columns of a wide frame buy.
        if (size.columns > NARROW.columns) {
          expect(saysAcross(terminal, "Tab to the draft to type")).toBe(true);
        } else {
          expect(shows(terminal, "Tab to draft")).toBe(true);
        }
        // The generic spelling, on a control with nothing particular to say.
        yield* focusOn(terminal, "Sessions");
        expect(
          shows(
            terminal,
            size.columns > NARROW.columns ? "Enter or click activates" : "Enter activates",
          ),
        ).toBe(true);

        // With a drawer up, Escape is a thing that does something, and it says so.
        yield* activate(terminal, "[history]");
        yield* until_(terminal, "the History drawer", (one) => shows(one, "[close]"));
        expect(shows(terminal, "Esc closes")).toBe(true);

        terminal.end();
        yield* running;
      });
    }
  });
});
describe("REPL first use: UI1/UI5", () => {
  it("UI1/UI5: the footer holds the actions, the band and the draft, in that order", function* () {
    const { terminal, install } = recordingTerminal(NARROW);
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // Something for the band to hold, so its rows are rows with text in them.
      yield* submitted(terminal, COLD_ONE);
      yield* settledEntry(terminal, 1, "ok");
      const model = yield* projectionOf(root, (yield* histories(root))[0]);
      expect(model.checkpoints.length).toBeGreaterThan(0);

      const rows = screenOf(terminal);
      const actions = NARROW.rows - 7;

      // One action row, and every control is on it.
      expect(rows[actions]).toContain("[history]");
      expect(rows[actions]).toContain("[exit]");
      // Five band rows under it, each one a position this execution reached.
      const band = rows.slice(actions + 1, actions + 1 + HISTORY_ROWS);
      expect(band).toHaveLength(HISTORY_ROWS);
      // Re-anchored for #881 PR 3: the band listed checkpoint *labels* and now
      // draws a measured rail — its title, its rule and a mark per position.
      // What this case is about is the footer's order, and the band being
      // there is what it needs; what the band says is `repl-history`'s.
      expect(band.some((row) => row.includes(HISTORY_TITLE))).toBe(true);
      expect(band.some((row) => row.includes("\u2500"))).toBe(true);
      // The draft, on the last row, alone.
      expect(rows[NARROW.rows - 1].trim().startsWith(">")).toBe(true);

      // And nothing of the band at the top of the screen, which is where it used
      // to be drawn: the first row belongs to whatever the body put there.
      for (const checkpoint of model.checkpoints) {
        expect([checkpoint.label, rows[0].includes(checkpoint.label)]).toEqual([
          checkpoint.label,
          false,
        ]);
      }

      terminal.end();
      yield* running;
    });
  });
});
describe("REPL first use: UI9", () => {
  it("UI9: typing at a control never reaches the draft, and the screen says why", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // Something in the draft first, so "unchanged" is a claim about bytes rather
      // than about emptiness.
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode("the draft"));
      yield* settled(40);
      const before = draftText(terminal);
      expect(before).toBe("the draft");

      yield* focusOn(terminal, "[exit]");
      // The explanation is on the screen *before* the keystroke that needs it.
      expect(saysAcross(terminal, "Tab to the draft to type")).toBe(true);

      terminal.bytes(BYTES.encode("xyz"));
      yield* settled(40);
      // Byte for byte: a control that let text fall through to the draft would be
      // editing a field nobody is looking at.
      expect(draftText(terminal)).toBe(before);
      expect(shows(terminal, "xyz")).toBe(false);

      // And the draft takes them again as soon as focus comes back to it.
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode("more"));
      yield* settled(40);
      expect(draftText(terminal)).not.toBe(before);
      expect(shows(terminal, "the draftmore")).toBe(true);

      terminal.end();
      yield* running;
    });
  });
});
describe("REPL first use: UI2 too small", () => {
  it("UI2: below the minimum there is no exit to aim at, and Escape leaves", function* () {
    const TINY = { columns: 60, rows: 18 };

    // The semantic tree first: at a size this REPL cannot draw at, the control is
    // not described — so there is nothing to reconcile, nothing to focus and
    // nothing a pointer could be answered with. At a size it can draw at, it is.
    const tiny = describeApplication(
      refusedView(initialState("tiny"), "this history cannot be read.", TINY),
      measuringContext(TINY),
    ).map((one) => readDescription(one).key);
    expect(tiny).not.toContain("footer:exit");
    const roomy = describeApplication(
      refusedView(initialState("tiny"), "this history cannot be read.", {
        columns: 160,
        rows: 36,
      }),
      measuringContext({ columns: 160, rows: 36 }),
    ).map((one) => readDescription(one).key);
    expect(roomy).toContain("footer:exit");

    // And then the real command, in a window that size.
    const { terminal, install } = recordingTerminal(TINY);
    let ended: ReplOutcome | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });

      // The one screen with no control on it says both of the things it can:
      // that growing the window recovers, and that Escape leaves.
      yield* until_(terminal, "the refusal", (one) => shows(one, "60x18"));
      expect(shows(terminal, "larger")).toBe(true);
      expect(shows(terminal, "Escape")).toBe(true);
      // Nothing to aim at: no control is drawn, so none is in the target map.
      expect(shows(terminal, "[exit]")).toBe(false);
      expect(shows(terminal, "[history]")).toBe(false);

      // Enter does nothing. The command is still running afterwards, which is the
      // whole of what "no hidden exit target" means here.
      terminal.feed("\r");
      yield* settled(40);
      expect(ended).toBeUndefined();
      expect(terminal.resets).toBe(0);

      // Escape is the way out, and it is the same structured teardown.
      terminal.feed("\x1b");
      yield* running;
    });

    expect(ended?.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
  });
});

describe("REPL first use: UI3", () => {
  it("UI3: a question on Sessions moves nothing, and is reached by activating it", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // On Sessions, with something typed, before anything is asked.
      yield* activate(terminal, "Sessions");
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(JOURNEY_ONE));
      yield* settled(60);
      const beforeOne = submitting(terminal);
      terminal.feed("\r");
      yield* admittedDraft(terminal, beforeOne);
      expect(routedSurfaceOn(terminal)).toBe("Sessions");
      yield* focusOn(terminal, "[exit]");
      const standing = without(terminal);

      // The question arrives. It announces itself and does nothing else: the
      // surface, the focused control and the whole screen are where they were,
      // apart from the announcement itself.
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);
      expect(routedSurfaceOn(terminal)).toBe("Sessions");
      expect(focusedOn(terminal, "[exit]")).toBe(true);
      expect(shows(terminal, "decision: go")).toBe(false);
      expect(standing.length).toBeGreaterThan(0);

      // Activating it is what opens it, and that act crosses to the surface the
      // question belongs to and selects the entry that is asking.
      const at = askedRow(terminal);
      if (at === undefined) {
        throw new Error("the question announced itself");
      }
      yield* clickAt(terminal, at);
      yield* until_(terminal, "the question's form", (one) => shows(one, "decision: go"));
      // Activating it crossed to the surface the question belongs to, and
      // selected the entry that is asking.
      expect(routedSurfaceOn(terminal)).toBe("Entries");
      expect(selectedEntryOn(terminal)).toContain("entry-1");

      // Escape dismisses without answering, and the question is still waiting — so
      // it announces itself again and opens again.
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "decision: go"));
      yield* openQuestion(terminal);
      expect(shows(terminal, "decision: go")).toBe(true);

      terminal.end();
      yield* running;
    });
  });
});
describe("REPL first use: UI1 selection", () => {
  it("UI1: the active surface and the selected entry are marked in the frame", function* () {
    for (const size of [{ columns: 160, rows: 36 }, NARROW]) {
      const { terminal, install } = recordingTerminal(size);
      yield* scoped(function* (): Operation<void> {
        yield* install();
        yield* immediateClock();
        yield* useTempFileCompiler();
        yield* useTemporaryHost();

        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(terminal);

        yield* submitted(terminal, COLD_ONE);
        yield* settledEntry(terminal, 1, "ok");
        yield* submitted(terminal, COLD_TWO);
        yield* settledEntry(terminal, 2, "ok");

        // Entries is where the route starts, and the frame says so.
        expect(marked(terminal, "Entries")).toBe(true);
        expect(marked(terminal, "Sessions")).toBe(false);

        // Switching surfaces changes cells that are not the location: the URL
        // alone cannot satisfy this, because the location rows are excluded.
        const onEntries = without(terminal);
        yield* activate(terminal, "Sessions");
        const onSessions = without(terminal);
        expect(onSessions).not.toEqual(onEntries);
        expect(marked(terminal, "Sessions")).toBe(true);
        expect(marked(terminal, "Entries")).toBe(false);

        // By pointer too, and it means the same thing: the marker comes back to
        // Entries and the screen is no longer the Sessions one. Not byte-identical
        // to `onEntries`, because activating by pointer also moves focus there —
        // which is the other marker, and the point of their being two.
        yield* click(terminal, "Entries");
        expect(marked(terminal, "Entries")).toBe(true);
        expect(marked(terminal, "Sessions")).toBe(false);
        expect(without(terminal)).not.toEqual(onSessions);

        // Selecting one entry versus the other moves one marker and no other.
        yield* activate(terminal, "1. [ok] entry-1");
        expect(marked(terminal, "1. [ok] entry-1")).toBe(true);
        expect(marked(terminal, "2. [ok] entry-2")).toBe(false);
        const readingFirst = without(terminal);

        yield* activate(terminal, "2. [ok] entry-2");
        expect(marked(terminal, "2. [ok] entry-2")).toBe(true);
        expect(marked(terminal, "1. [ok] entry-1")).toBe(false);
        expect(without(terminal)).not.toEqual(readingFirst);

        // And the marker is the route's, not focus's: it stays where it is when
        // focus goes somewhere else entirely.
        yield* focusOn(terminal, "[exit]");
        expect(focusedOn(terminal, "[exit]")).toBe(true);
        expect(marked(terminal, "2. [ok] entry-2")).toBe(true);
        expect(marked(terminal, "Entries")).toBe(true);

        // Selecting an entry does not filter the agent work this execution has.
        // Both sections are still there and still say they hold none.
        yield* activate(terminal, "Sessions");
        expect(shows(terminal, "No entry turns.")).toBe(true);
        expect(shows(terminal, "No Sidekick turns.")).toBe(true);

        terminal.end();
        yield* running;
      });
    }
  });
});

/**
 * The narrow guidance row is composed, not cut (#870 UI10/UI16).
 *
 * Asserted by exact equality, because the assertion covers the whole row. A row
 * written long and left to the renderer loses its last fact with nothing to say
 * that it has — and the facts at the end are the way out of a modal and the way
 * back to the draft. Equality catches both the overflow and the silent cut.
 */
describe("REPL first use: UI10 narrow guidance", () => {
  it("UI10: at 72x20 the row says the state, what Enter does, and the way back, whole", function* () {
    const { terminal, install } = recordingTerminal(NARROW);
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // Focus starts in the draft. The state comes first, then what Enter does
      // there, then that typing goes to the draft, then movement.
      expect(guidanceRow(terminal)).toBe(
        "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move",
      );
      expect(guidanceRow(terminal).length).toBeLessThanOrEqual(NARROW.columns);

      // On a control, Enter activates the control rather than submitting, so the
      // row stops saying it submits and starts saying how to get back. `Sessions`
      // because it is a control with nothing particular to say about itself —
      // this is the generic spelling.
      yield* focusOn(terminal, "Sessions");
      expect(guidanceRow(terminal)).toBe(
        "Ready for Entry 1 · Enter activates · Tab/Shift+Tab move · Tab to draft",
      );
      expect(guidanceRow(terminal).length).toBeLessThanOrEqual(NARROW.columns);

      // And a control that does have something particular to say says it instead,
      // because a row naming an action the focused node does not perform is worse
      // than one naming none: the person presses the key it promised.
      yield* focusOn(terminal, "[exit]");
      expect(guidanceRow(terminal)).toBe(
        "Ready for Entry 1 · Enter exits · Tab/Shift+Tab move · Tab to draft",
      );
      yield* focusOn(terminal, "[history]");
      expect(guidanceRow(terminal)).toBe(
        "Ready for Entry 1 · Enter opens · Tab/Shift+Tab move · Tab to draft",
      );
      expect(guidanceRow(terminal).length).toBeLessThanOrEqual(NARROW.columns);

      terminal.end();
      yield* running;
    });
  });
});

/**
 * A drawer keeps the state and keeps the way out (#870 UI10/UI16).
 *
 * Inside a modal the order earns its keep: the drawer holds focus, so `Esc
 * closes` is the one key a person must be told about, and it is required ahead of
 * movement. The state stays because a question does not stop an entry from
 * running and a reader still needs to know that it is.
 */
describe("REPL first use: UI10 narrow drawer guidance", () => {
  it("UI10: at 72x20 a focused field and a focused drawer control each say state, action, Esc and movement", function* () {
    const { terminal, install } = recordingTerminal(NARROW);
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      yield* submitted(terminal, SHORT_QUESTION);
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);
      yield* activate(terminal, "[answer]");
      yield* until_(terminal, "the question's form", (one) => formShowing(one));

      // A field holds focus: Enter answers, and the entry is still named.
      const onField = guidanceRow(terminal);
      expect(onField).toBe("Entry 1 question · Enter answers · Esc closes · Tab/Shift+Tab move");

      // The question's submit: the same promise, because activating it is how the
      // question gets answered.
      yield* focusOn(terminal, "[submit]");
      const onSubmit = guidanceRow(terminal);
      expect(onSubmit).toBe("Entry 1 question · Enter answers · Esc closes · Tab/Shift+Tab move");

      // And a control in the same drawer that does something else entirely. It
      // moves the window over a message too long to draw at once, so the row says
      // that instead of promising an answer to somebody who is still reading.
      yield* focusOn(terminal, "[↓ later]");
      const onScroll = guidanceRow(terminal);
      expect(onScroll).toBe("Entry 1 question · Enter scrolls · Esc closes · Tab/Shift+Tab move");

      // Whichever node holds focus: the state, the action that node performs, the
      // way out, and movement — all four on one 72-column row, none of them cut.
      for (const row of [onField, onSubmit, onScroll]) {
        expect(row.startsWith("Entry 1 question · Enter ")).toBe(true);
        expect(row).toContain("Esc closes");
        expect(row).toContain("Tab/Shift+Tab move");
        expect(row.length).toBeLessThanOrEqual(NARROW.columns);
      }

      terminal.end();
      yield* running;
    });
  });
});

/** One entry that does not finish the instant it is admitted. */
const SLOW_ENTRY = ["```ts eval", "yield* sleep(800)", "```", ""].join("\n");

/**
 * A refused submission keeps the draft, and stops being shown when it stops
 * being true (#870 UI12).
 *
 * Driven through the running command, and — the part that matters — with no
 * keystroke between the refusal and the readiness changing. Every action clears
 * the refusal on its way through the reducer, so a row that pressed anything to
 * make the entry finish would prove that pressing a key clears refusals and
 * nothing about staleness. Here the entry finishes by itself and nobody touches
 * the terminal, which is also how a person meets this: they press Enter, read why
 * not, and watch the entry end.
 */
/**
 * The drawer is found by where it is, not by what it says (#870 UI15, adj 3).
 *
 * `drawerMarkers()` used to locate the History drawer by the first line holding
 * the word "History". The state sentence is that word at a frozen position, so
 * the helper read the sentence instead of the list — from the wrong column, and
 * answered with fragments of the transcript behind it. This row stands in exactly
 * that frame: the guidance says "History" outside the drawer while the drawer
 * lists positions inside it, and the helper has to answer with the positions.
 */
describe("REPL first use: UI15 drawer geometry", () => {
  it("UI15: guidance saying History does not move what reading the drawer answers", function* () {
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      yield* submitted(terminal, "one");
      yield* until_(terminal, "the entry settling", (one) => shows(one, "Ready for Entry 2"));

      // Into a position, so the state sentence becomes the word the old helper
      // searched for.
      yield* activate(terminal, "[history]");
      yield* until_(terminal, "the History drawer", (one) => shows(one, "[close]"));
      const listed = drawerMarkers(terminal);
      expect(listed.length).toBeGreaterThan(0);
      yield* activate(terminal, listed[0] ?? "");
      yield* until_(terminal, "the frozen position", (one) => historicalOn(one));

      // Reopened over a frozen position: now both are true at once.
      yield* activate(terminal, "[history]");
      yield* until_(terminal, "the History drawer again", (one) => shows(one, "[close]"));
      const saying = screenOf(terminal).findIndex((line) => line.includes("History ·"));
      expect(saying).toBeGreaterThanOrEqual(0);
      // Above the drawer's own rows — which is exactly what made the old anchor
      // read the wrong one. It shares columns with the box at this size, so the
      // row is the distinction and the column is not.
      const box = drawerBox(terminal);
      expect(saying).toBeLessThan(box.top);

      // And the helper still answers with the drawer's own rows: every one of
      // them is a position this history holds, and none is a piece of the
      // sentence or of the transcript behind the box.
      //
      // Re-anchored for #881 PR 3, in two ways. A row used to be a bare label
      // and now carries its place in the recorded order, so "holds no `\u00b7`" —
      // which is how this told a row from the guidance sentence — would reject
      // every row; the shape `N \u00b7 <category>` says the same thing and says
      // more. And the drawer at a frozen position now lists the *whole* order
      // rather than the prefix's share of it: the positions after the one being
      // read are where a reader can go next, which is the navigation exception
      // this slice exists for.
      const markers = drawerMarkers(terminal);
      expect(markers.length).toBeGreaterThan(0);
      expect(markers).toContain("1 \u00b7 Entry 1 admitted");
      expect(markers.length).toBe(listed.length);
      for (const marker of markers) {
        expect([marker, /^\d+ \u00b7 \S/.test(marker)]).toEqual([marker, true]);
        expect([marker, marker.startsWith("History")]).toEqual([marker, false]);
      }

      terminal.end();
      yield* running;
    });
  });
});

describe("REPL first use: UI12 refusal", () => {
  it("UI12: a lifecycle refusal keeps the draft and goes when the entry it named ends, untouched", function* () {
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // One entry that is still running, so there is something for the next
      // submission to be refused into.
      yield* submitted(terminal, SLOW_ENTRY);

      // A second document typed while the first is still going.
      const DRAFT_TEXT = "second entry, typed while the first is running";
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(DRAFT_TEXT));
      yield* settled(30);
      terminal.feed("\r");
      yield* until_(terminal, "the refusal", (one) => shows(one, "has not finished"));

      // Refused, with its reason, and nothing taken from the person: the draft is
      // exactly what they typed, and the history is exactly one entry.
      expect(shows(terminal, DRAFT_TEXT)).toBe(true);
      expect(shows(terminal, "2. ")).toBe(false);

      // Nothing is pressed from here. The entry ends on its own.
      yield* until_(terminal, "the next entry being ready", (one) =>
        shows(one, "Ready for Entry 2"),
      );

      // The refusal is gone, because it stopped being true — and what replaced it
      // says the opposite of what it said.
      expect(shows(terminal, "has not finished")).toBe(false);
      // And the draft is still theirs.
      expect(shows(terminal, DRAFT_TEXT)).toBe(true);

      terminal.end();
      yield* running;
    });
  });
});

describe("REPL first use: UI1 narrow question", () => {
  it("UI1: the longest question still has a placed, targetable control at 72x20", function* () {
    const { terminal, install } = recordingTerminal(NARROW);
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      // Asked from Sessions, so this row also proves the crossing, and asked with
      // a message far wider than the terminal.
      yield* activate(terminal, "Sessions");
      yield* submitted(terminal, LONG_QUESTION);
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);

      const at = askedRow(terminal);
      if (at === undefined) {
        throw new Error("the question announced itself");
      }
      const row = screenOf(terminal)[at.row];
      // Everything that belongs on the action row is on it, and the announcement
      // is placed rather than dropped: a control the row could not hold whole is
      // left out of the frame, and a waiting question left out is unreachable.
      expect(row).toContain("[history]");
      expect(row).toContain("[exit]");
      expect(row).toContain("[pause]");
      expect(row).toContain("[answer]");
      // Inside the terminal, so nothing of it is off the edge.
      expect(at.column + "[answer]".length).toBeLessThanOrEqual(NARROW.columns);

      // Activated by pointer: that is the target map answering for this column.
      yield* clickAt(terminal, at);
      yield* until_(terminal, "the question's form", (one) => formShowing(one));

      // Dismissed, so the rows the location is drawn on are readable again — a
      // drawer covers what it is in front of, and the crossing it performed
      // survives it being closed.
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !formShowing(one));
      expect(selectedEntryOn(terminal)).toContain("entry-1");
      expect(marked(terminal, "Entries")).toBe(true);
      expect(marked(terminal, "1. [unfinished] entry-1")).toBe(true);

      // And reached again by Enter this time, because dismissing answered nothing.
      yield* activate(terminal, "[answer]");
      yield* until_(terminal, "the question's form again", (one) => formShowing(one));

      terminal.end();
      yield* running;
    });
  });
});

describe("REPL first use: UI2 refusal", () => {
  it("UI2: a normal-sized refusal is left by its own visible control", function* () {
    const { terminal, install } = recordingTerminal();
    let outcome: Result<ReplOutcome> | undefined;
    let root = "";
    let before = "";
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      root = yield* useTemporaryHost();

      // One real execution to refuse a location against.
      const first = recordingTerminal();
      yield* scoped(function* (): Operation<void> {
        yield* first.install();
        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(first.terminal);
        first.terminal.end();
        yield* running;
      });

      const files = yield* histories(root);
      const path = yield* historyPath(root, files[0]!);
      before = yield* until(readFile(path, "utf8"));
      const execution = files[0].replace(/\.jsonl$/, "");

      const running = yield* spawn(function* (): Operation<void> {
        // A location this history cannot answer: an entry it never admitted.
        outcome = yield* runReplProgram({
          location: `xmd://repl/${execution}/entries/entry-9`,
          profile: PROFILE,
        });
      });
      // Not `untilDrawn`: a refusal draws no canonical location, because there is
      // no view for one to name.
      yield* until_(terminal, "the refusal", (one) => shows(one, "[exit]"));
      expect(shows(terminal, "admitted")).toBe(true);
      expect(shows(terminal, "[exit]")).toBe(true);
      // And nothing else: no draft, and no control this screen cannot honour.
      expect(screenOf(terminal).some((line) => line.includes("[history]"))).toBe(false);
      expect(screenOf(terminal).some((line) => line.trimEnd().endsWith(">"))).toBe(false);

      // Reached by pointer, which is the target map answering for that column.
      yield* click(terminal, "[exit]");
      yield* running;
    });

    // A refusal is still a refusal: the command reports it rather than reporting
    // success, and leaving it appended nothing.
    expect(outcome?.ok).toBe(false);
    expect(terminal.resets).toBe(1);
    const files = yield* histories(root);
    expect(yield* until(readFile(yield* historyPath(root, files[0]!), "utf8"))).toBe(before);
  });

  it("UI2: Enter on the refusal's control leaves it too", function* () {
    const { terminal, install } = recordingTerminal();
    let outcome: Result<ReplOutcome> | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const first = recordingTerminal();
      yield* scoped(function* (): Operation<void> {
        yield* first.install();
        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(first.terminal);
        first.terminal.end();
        yield* running;
      });
      const execution = (yield* histories(root))[0].replace(/\.jsonl$/, "");

      const running = yield* spawn(function* (): Operation<void> {
        outcome = yield* runReplProgram({
          location: `xmd://repl/${execution}/entries/entry-9`,
          profile: PROFILE,
        });
      });
      yield* until_(terminal, "the refusal", (one) => shows(one, "[exit]"));
      expect(shows(terminal, "admitted")).toBe(true);

      yield* activate(terminal, "[exit]");
      yield* running;
    });

    expect(outcome?.ok).toBe(false);
    expect(terminal.resets).toBe(1);
  });
});

describe("REPL first use: UI3", () => {
  it("UI3: a question that disappears takes its drawer, and answers nothing", function* () {
    const { terminal, install } = recordingTerminal();
    const held = withResolvers<void>();
    let root = "";
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();
      // The sibling's hold, and the failure that releases it. A deadline rather
      // than a race: the drawer has to be *mounted* before the question goes, so
      // the sibling waits for this row to say so.
      yield* API.Fetch.around({
        *fetch(): Operation<never> {
          yield* held.operation;
          throw new Error("the sibling could not finish");
        },
      });

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      yield* submitted(terminal, SIBLING_FAILS);

      // The question is asked and opened, the way a person opens it.
      yield* openQuestion(terminal);
      expect(shows(terminal, "[close]")).toBe(true);
      expect(shows(terminal, "decision: go")).toBe(true);

      // Now the sibling fails. The question goes with the expansion that was
      // asking it, while this process stays alive and keeps the screen.
      held.resolve();

      // The drawer and the form go together, and neither becomes an answer.
      yield* until_(terminal, "the drawer withdrawing", (one) => !shows(one, "decision: go"));
      expect(shows(terminal, "[close]")).toBe(false);
      // Focus is somewhere a person can use, not on a control that has gone.
      expect(screenOf(terminal).some((line) => line.includes(">>"))).toBe(true);

      // The entry keeps its own legitimate failure, and nothing recorded an
      // elicitation: a withdrawal is not a decision.
      yield* settledEntry(terminal, 1, "err");
      const files = yield* histories(root);
      expect((yield* records(root, files[0])).filter((line) => line.includes("elicit"))).toEqual(
        [],
      );

      // The draft still works, and the execution still takes another entry.
      yield* submitted(terminal, COLD_ONE);
      yield* settledEntry(terminal, 2, "ok");

      terminal.end();
      yield* running;
    });
  });
});
describe("REPL first use: UI4", () => {
  it("UI4: a live question's drawer is refused wherever it cannot belong", function* () {
    const { terminal, install } = recordingTerminal();
    let root = "";
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();

      const exited = exitRoute();
      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        exited.settle(ran.value);
      });
      yield* untilDrawn(terminal);

      yield* submitted(terminal, JOURNEY_ONE);
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);
      const standing = without(terminal);
      const before = yield* records(root, (yield* histories(root))[0]);

      // A historical position cannot answer the question this process is asking,
      // and asking it to says so instead of freezing a live drawer into a prefix.
      const focusRows = (): string[] =>
        screenOf(terminal)
          .filter((l) => l.includes(">"))
          .map((l) => l.trimEnd().slice(0, 48));
      console.log("P0 standing:", JSON.stringify(focusRows()));
      yield* activate(terminal, "[history]");
      console.log("P1 after [history]:", JSON.stringify(focusRows()));
      yield* until_(terminal, "the History drawer", (one) => shows(one, "[close]"));
      yield* click(terminal, "Entry 1 admitted");
      yield* settled(40);
      console.log("P2 after marker click:", JSON.stringify(focusRows()));
      expect(historicalOn(terminal)).toBe(true);
      // The announcement is gone with the live state it belonged to: a frozen view
      // fills nothing from the head.
      expect(askedRow(terminal)).toBeUndefined();
      yield* click(terminal, "[close]");
      yield* settled(30);
      console.log("P3 after close:", JSON.stringify(focusRows()));
      yield* activate(terminal, "[live]");
      yield* until_(terminal, "the waiting question again", (one) => askedRow(one) !== undefined);

      // Every refusal left the reading standing and the file alone. Focus is put
      // back where it was first, because closing a drawer leaves it wherever the
      // tree puts it when a branch unmounts — a fact about this tree rather than
      // about the refusals, and the two screens are only comparable from the same
      // place. The contextual row follows focus, so this is what makes the
      // comparison a claim about the reading.
      expect(historicalOn(terminal)).toBe(false);
      yield* focusDraft(terminal);
      expect(without(terminal)).toEqual(standing);
      expect(yield* records(root, (yield* histories(root))[0])).toEqual(before);

      terminal.end();
      yield* running;
    });
  });
});
describe("REPL first use: UI6", () => {
  it("UI6: the draft stays visible and intact under a drawer, and is not editable through it", function* () {
    for (const size of [{ columns: 160, rows: 36 }, NARROW]) {
      const { terminal, install } = recordingTerminal(size);
      yield* scoped(function* (): Operation<void> {
        yield* install();
        yield* immediateClock();
        yield* useTempFileCompiler();
        yield* useTemporaryHost();

        const running = yield* spawn(function* (): Operation<void> {
          const ran = yield* runReplProgram({ profile: PROFILE });
          if (!ran.ok) {
            throw ran.error;
          }
        });
        yield* untilDrawn(terminal);

        yield* submitted(terminal, JOURNEY_ONE);

        // Typed before the drawer is up, because it is the *next* entry's text and
        // an admitted entry is immutable.
        yield* focusDraft(terminal);
        terminal.bytes(BYTES.encode("next entry"));
        yield* settled(40);
        const kept = draftText(terminal);
        expect(kept).toBe("next entry");

        yield* openQuestion(terminal);

        // Still drawn, on its own footer row, which the drawer sits above rather
        // than across. The draft and the question are both readable at once, which
        // is exactly why the draft has a row of its own below the drawer.
        const row = size.rows - 1;
        expect(screenOf(terminal)[row]).toContain("next entry");
        expect(shows(terminal, "decision: go")).toBe(true);
        const drawn = screenOf(terminal)[row];

        // The modal owns the keystrokes: the draft is visible and not editable, so
        // text reaches the field the drawer focused and the draft keeps its bytes.
        terminal.bytes(BYTES.encode("go"));
        yield* settled(40);
        expect(screenOf(terminal)[row]).toBe(drawn);

        // Dismissed, and the draft is reachable again with exactly what it had.
        terminal.feed("\x1b");
        yield* until_(terminal, "the drawer closing", (one) => !shows(one, "decision: go"));
        yield* focusDraft(terminal);
        expect(draftText(terminal)).toBe(kept);
        expect(screenOf(terminal)[row]).toContain("next entry");

        terminal.end();
        yield* running;
      });
    }
  });
});
describe("REPL first use: UI7", () => {
  it("UI7: leaving strips the drawers only this process could mount", function* () {
    const { terminal, install } = recordingTerminal();
    let ended: ReplOutcome | undefined;
    let root = "";
    let performed: Performed | undefined;
    let waiting = "";
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);

      yield* submitted(terminal, JOURNEY_ONE);
      yield* openQuestion(terminal);

      // What the file holds while the question is still waiting, so that what
      // leaving appends is a comparison rather than an assumption.
      const files = yield* histories(root);
      waiting = yield* until(readFile(yield* historyPath(root, files[0]!), "utf8"));

      // Left while the modal is up. The control is physically in the footer and
      // belongs to the modal's own subtree, so a pointer on it reaches it without
      // reaching past the trap.
      yield* click(terminal, "[exit]");
      yield* running;
    });

    // The location it printed is one a second process can be handed: the drawer
    // that only this process could mount is not in it, and nothing was answered
    // to take it out.
    expect(ended?.location).toBeDefined();
    expect(ended?.location).not.toContain("+elicit");
    expect(ended?.location).not.toContain("+permission");
    expect(ended?.location).toContain("/entry-1");

    const path = yield* historyPath(root, (yield* histories(root))[0]!);
    // Leaving appended nothing at all: no close, no cancellation, no audit.
    expect(yield* until(readFile(path, "utf8"))).toBe(waiting);
    // The entry was interrupted, so the file holds no close for it. An unfinished
    // entry is what it is; nothing fabricated a cancellation to tidy it up.
    const first = (yield* histories(root))[0];
    expect((yield* projectionOf(root, first)).entries[0]?.terminal).toBeUndefined();
    // And no answer was recorded for the question that was waiting.
    expect((yield* records(root, first)).filter((line) => line.includes("elicit"))).toEqual([]);

    // That location is one a second process accepts: it resolves, which is what
    // being reopenable means. An unfinished entry is handed back to the engine to
    // continue, so this reopen resumes rather than reconstructs — the provider it
    // reaches belongs to resumed execution, not to restoration.
    const resumed = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* resumed.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* reopening(root);

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ location: ended?.location, profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(resumed.terminal);
      expect(selectedEntryOn(resumed.terminal)).toContain("entry-1");
      resumed.terminal.end();
      yield* running;
    });

    // The settled half of the claim, on a history with nothing left to resume: the
    // same exit, and a cold reopen that reaches no provider and appends nothing.
    const { terminal: last, install: installLast } = recordingTerminal();
    let settledLocation: string | undefined;
    let settledRoot = "";
    yield* scoped(function* (): Operation<void> {
      yield* installLast();
      yield* immediateClock();
      yield* useTempFileCompiler();
      settledRoot = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        settledLocation = ran.value.location;
      });
      yield* untilDrawn(last);
      yield* submitted(last, COLD_ONE);
      yield* settledEntry(last, 1, "ok");
      yield* click(last, "[exit]");
      yield* running;
    });

    expect(settledLocation).toBeDefined();
    const settledPath = yield* historyPath(settledRoot, (yield* histories(settledRoot))[0]!);
    const settledBytes = yield* until(readFile(settledPath, "utf8"));

    const cold = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* cold.install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* reopening(settledRoot);
      performed = yield* countPerformed();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ location: settledLocation, profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(cold.terminal);
      cold.terminal.end();
      yield* running;
    });

    expect(performed?.asked).toBe(0);
    expect(performed?.compiles).toBe(0);
    expect(yield* until(readFile(settledPath, "utf8"))).toBe(settledBytes);
    // The location the settled history ended at carries no live-only drawer either.
    expect(settledLocation).not.toContain("+elicit");
  });
});
describe("REPL first use: UI8", () => {
  it("UI8: the whole first-use path, using only what the screen says", function* () {
    // Wide, because step 4 reads what the answer made the document render and a
    // narrow frame mounts only its routed outlet — the transcript is not a region
    // it has. What a narrow frame does carry is proved by the rows above.
    const { terminal, install } = recordingTerminal({ columns: 160, rows: 36 });
    let ended: ReplOutcome | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      const root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);

      // 1. The screen says where typing goes and what Enter there does.
      expect(shows(terminal, "Type here")).toBe(true);
      expect(shows(terminal, "Enter submits")).toBe(true);
      yield* submitted(terminal, JOURNEY_ONE);

      // 2. Running, and then waiting — said on the entry's own row and in the
      // footer, without anything opening itself.
      yield* until_(terminal, "the entry running", (one) => shows(one, "1. [unfinished]"));
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);

      // 3. Between the surfaces and back, with the selected entry preserved.
      yield* activate(terminal, "Sessions");
      expect(routedSurfaceOn(terminal)).toBe("Sessions");
      yield* activate(terminal, "Entries");
      expect(routedSurfaceOn(terminal)).toBe("Entries");

      // 4. The question, answered in the drawer it opens.
      yield* openQuestion(terminal);
      yield* click(terminal, "decision: ");
      terminal.bytes(BYTES.encode("go"));
      yield* settled(30);
      yield* click(terminal, "[submit]");
      yield* until_(terminal, "the answer's output", (one) => shows(one, "One: alpha/go"));
      yield* settledEntry(terminal, 1, "ok");

      // 5. A history position, and back to the head.
      yield* activate(terminal, "[history]");
      yield* until_(terminal, "the History drawer", (one) => shows(one, "[close]"));
      yield* click(terminal, "Entry 1 admitted");
      yield* settled(40);
      expect(historicalOn(terminal)).toBe(true);
      yield* click(terminal, "[close]");
      yield* settled(30);
      // Frozen: what the draft's guidance says changes, because what Enter there
      // does changed — there is no head to submit into from here.
      yield* focusDraft(terminal);
      expect(saysAcross(terminal, "activate live to return to the head")).toBe(true);
      expect(shows(terminal, "Enter submits")).toBe(false);
      yield* activate(terminal, "[live]");
      yield* until_(terminal, "the head", (one) => !historicalOn(one));

      // 6. The next entry, after the first has completely settled.
      yield* submitted(terminal, COLD_TWO);
      yield* settledEntry(terminal, 2, "ok");
      expect(shows(terminal, "2. [ok] entry-2")).toBe(true);

      // 7. Out, from the control that said so all along.
      expect(yield* histories(root)).toHaveLength(1);
      yield* activate(terminal, "[exit]");
      yield* running;
    });

    expect(ended?.refusal).toBeUndefined();
    expect(ended?.location).toContain("xmd://repl/");
    expect(terminal.resets).toBe(1);
  });
});

/**
 * The whole first-use path at the narrowest supported frame (#870 C1).
 *
 * `UI8` walks this path at `160x36`, where there is a transcript column to read
 * the answer's output in. A narrow frame has no transcript region at all — it
 * mounts one routed outlet — so this row proves the other half of the behavior: that
 * everything a person has to *do* is reachable at `72x20`, found from the labels
 * and the one guidance row, with no hidden key and no semantic lookup.
 *
 * Every control here is reached the way a person reaches it: Tab to it and press
 * Enter, or click the exact cell the frame drew. Nothing addresses a node by key.
 */
describe("REPL first use: C1 narrow", () => {
  it("C1: submit, answer, dismiss, reopen, settle, Sessions, History, live and exit at 72x20", function* () {
    const { terminal, install } = recordingTerminal(NARROW);
    let ended: ReplOutcome | undefined;
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      yield* useTempFileCompiler();
      yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
        ended = ran.value;
      });
      yield* untilDrawn(terminal);

      // 1. What the screen says it is for, before anything has been typed.
      expect(guidanceRow(terminal)).toBe(
        "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move",
      );

      // 2. One entry, submitted the way the row said to submit it.
      yield* submitted(terminal, SHORT_QUESTION);
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);

      // 3. The screen now says what the execution is doing, and what to activate.
      expect(guidanceRow(terminal)).toBe(
        "Entry 1 question · activate answer · Type here · Tab/Shift+Tab move",
      );

      // 4. Reached by pointer, against the exact cell the frame drew for it.
      const at = askedRow(terminal);
      if (at === undefined) {
        throw new Error("the question announced itself");
      }
      yield* clickAt(terminal, at);
      yield* until_(terminal, "the question's form", (one) => formShowing(one));

      // 5. Escape dismisses without answering, and leaves focus somewhere real.
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !formShowing(one));
      expect(askedRow(terminal)).toBeDefined();
      // Focus is derived from the tree, so it lands on the next frame rather than
      // in the same one the drawer left. Waited for, with a deadline, because the
      // claim is that it arrives somewhere real — on the control still asking.
      yield* until_(terminal, "focus returning to the waiting question", (one) =>
        focusedOn(one, "[answer]"),
      );

      // 6. Reopened with Enter this time, because dismissing answered nothing.
      yield* activate(terminal, "[answer]");
      yield* until_(terminal, "the question's form again", (one) => formShowing(one));

      // 7. Answered by typing into the field that holds focus, then submitting.
      terminal.bytes(BYTES.encode("go"));
      yield* settled(30);
      yield* activate(terminal, "[submit]");
      yield* until_(terminal, "the entry settling", (one) => shows(one, "Ready for Entry 2"));
      expect(shows(terminal, "1. [ok] entry-1")).toBe(true);

      // 8. Sessions and back, with the entry still the one being read.
      yield* activate(terminal, "Sessions");
      yield* until_(terminal, "the Sessions surface", (one) => marked(one, "Sessions"));
      yield* activate(terminal, "Entries");
      yield* until_(terminal, "the Entries surface", (one) => marked(one, "Entries"));

      // 9. A draft that has to survive a position, and a position to survive.
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode("entry two"));
      yield* settled(30);
      yield* activate(terminal, "[history]");
      yield* until_(terminal, "the History drawer", (one) => shows(one, "[close]"));
      const positions = drawerMarkers(terminal);
      expect(positions.length).toBeGreaterThan(0);
      yield* activate(terminal, positions[0] ?? "");

      // 10. Frozen: it says so, says Enter is not a submission, and offers back.
      // Read from the guidance row rather than the location, because at 72
      // columns the location is drawn over several rows and says how much of
      // itself it is not showing — the sentence is what a person reads here.
      // The position is taken while the drawer is still up, and the row already
      // names the state it put the screen in rather than waiting to be dismissed.
      yield* until_(terminal, "the frozen state inside the drawer", (one) =>
        guidanceRow(one).startsWith("History · "),
      );
      expect(guidanceRow(terminal)).toContain("Esc closes");

      // 10. Dismissed, and back in the draft — which a frozen position leaves
      // editable — the row says what this position cannot do and how to leave it.
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "[close]"));
      yield* focusDraft(terminal);
      yield* until_(terminal, "the frozen guidance", (one) =>
        guidanceRow(one).startsWith("History · Enter unavailable"),
      );
      expect(guidanceRow(terminal)).toContain("activate live");
      expect(shows(terminal, "entry two")).toBe(true);

      // 11. Back to the head, and the draft submits from there.
      yield* activate(terminal, "[live]");
      yield* until_(terminal, "the head being ready again", (one) =>
        guidanceRow(one).startsWith("Ready for Entry 2"),
      );
      yield* focusDraft(terminal);
      terminal.feed("\r");
      yield* until_(terminal, "the second entry", (one) => shows(one, "2. "));

      // 12. And out, from a control on the screen.
      yield* activate(terminal, "[exit]");
      yield* running;
    });
    expect(ended?.location).toContain("xmd://repl/");
  });
});
