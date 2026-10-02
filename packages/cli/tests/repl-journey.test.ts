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
  resource,
  type Result,
  scoped,
  sleep,
  spawn,
  type Stream,
  type Subscription,
  withResolvers,
} from "effection";
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { until } from "effection";

import { API } from "@executablemd/runtime";
import { Elicitation, useTempFileCompiler } from "@executablemd/core";
import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import { installReplHost } from "../src/repl-assembly.ts";
import { installReplTerminal } from "../src/repl/terminal-host.ts";
import type { ReplTerminalCapabilities } from "../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { ReplClock } from "../src/repl/frame.ts";
import {
  describeApplication,
  initialState,
  NO_AGENT,
  reduceRepl,
  refusedView,
} from "../src/repl/application.ts";
import { readDescription } from "../src/repl/description.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import type { ReplOutcome } from "../src/repl/program.ts";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import {
  drawerHeight,
  drawerWidth,
  HISTORY_ROWS,
  NARROW,
  sessionsHeight,
  surfaceWidth,
} from "../src/repl/layout.ts";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { decodeLocation, encodeLocation } from "../src/repl/route.ts";
import {
  REFERENCE_DIRECTORY,
  referenceEvents,
  referenceSource,
} from "./fixtures/repl/reference.ts";

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
const TEXT = new TextDecoder();

/** What this host installs around the reference entry. */
const INSTALLATIONS = [{ evaluation: ordinaryEvaluationProfile() }];

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
  permissionMode: "deny-all",
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

/** Let every task that is ready take its turn. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

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

/** A terminal the test drives completely. */
interface Terminal {
  /** Everything ever presented, in order. */
  readonly presented: Uint8Array[];
  /**
   * When set, the next presentation blocks here until it is released.
   *
   * The seam the frame-order control needs: while a frame is being written, the
   * stream must not have been told that frame was applied.
   */
  holdPresent: { release(): void } | undefined;
  size: ReplTerminalSize;
  readonly raw: boolean[];
  resets: number;
  listeners: number;
  readers: number;
  feed(text: string): void;
  bytes(raw: Uint8Array): void;
  /** Make the next presentation block, so a test can look at the frame stream. */
  holdNextPresent(): void;
  resized(size: ReplTerminalSize): void;
  end(): void;
}

function recordingTerminal(
  size: ReplTerminalSize = { columns: 160, rows: 36 },
  interactive = true,
): {
  terminal: Terminal;
  install(): Operation<void>;
} {
  const queue: Uint8Array[] = [];
  const watchers = new Set<() => void>();
  let waiting: ((result: IteratorResult<Uint8Array, void>) => void) | undefined;
  let ended = false;

  let holding = false;
  const terminal: Terminal = {
    presented: [],
    holdPresent: undefined,
    size,
    raw: [],
    resets: 0,
    listeners: 0,
    readers: 0,
    feed(text: string): void {
      terminal.bytes(BYTES.encode(text));
    },
    holdNextPresent(): void {
      holding = true;
    },
    bytes(raw: Uint8Array): void {
      const resolve = waiting;
      if (resolve === undefined) {
        queue.push(raw);
        return;
      }
      waiting = undefined;
      resolve({ done: false, value: raw });
    },
    resized(next: ReplTerminalSize): void {
      terminal.size = next;
      for (const watcher of watchers) {
        watcher();
      }
    },
    end(): void {
      ended = true;
      const resolve = waiting;
      if (resolve !== undefined) {
        waiting = undefined;
        resolve({ done: true, value: undefined });
      }
    },
  };

  const host: ReplTerminalCapabilities = {
    interactive: () => interactive,
    size: () => terminal.size,
    *write(bytes: Uint8Array): Operation<void> {
      terminal.presented.push(new Uint8Array(bytes));
      if (!holding) {
        // A write that completed, which still costs the caller a turn.
        yield* sleep(0);
        return;
      }
      holding = false;
      const held = withResolvers<void>();
      terminal.holdPresent = { release: held.resolve };
      yield* held.operation;
    },
    writeNow(): void {
      terminal.resets += 1;
    },
    setRaw(raw: boolean): void {
      terminal.raw.push(raw);
    },
    input(): Stream<Uint8Array, void> {
      return resource<Subscription<Uint8Array, void>>(function* (provide) {
        let open = false;
        // Registered before the reader is taken, so a scope cancelled between
        // the two leaves nothing holding this terminal's input.
        yield* ensure(() => {
          if (!open) {
            return;
          }
          open = false;
          terminal.readers -= 1;
          // Actively cancelled: a cleanup that waited for the outstanding read
          // to end on its own would need another keystroke to get one.
          const resolve = waiting;
          waiting = undefined;
          resolve?.({ done: true, value: undefined });
        });
        terminal.readers += 1;
        open = true;
        yield* provide({
          *next(): Operation<IteratorResult<Uint8Array, void>> {
            // Always one suspension per chunk, buffered or not: the reader turns
            // one chunk into many decoded events, and draining a buffer without
            // yielding hands them over faster than the scanner takes them.
            const pending = withResolvers<IteratorResult<Uint8Array, void>>();
            const head = queue.shift();
            if (head !== undefined) {
              pending.resolve({ done: false, value: head });
            } else if (ended) {
              pending.resolve({ done: true, value: undefined });
            } else {
              waiting = pending.resolve;
            }
            return yield* pending.operation;
          },
        });
      });
    },
    onResize(listener: () => void): () => void {
      watchers.add(listener);
      terminal.listeners += 1;
      return () => {
        watchers.delete(listener);
        terminal.listeners -= 1;
      };
    },
  };

  return { terminal, install: () => installReplTerminal(host) };
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

/**
 * What the screen says, by replaying what was written to it.
 *
 * A real buffer rather than the bytes with escapes stripped, because this
 * renderer writes *diffs*: it moves the cursor to what changed and writes only
 * that. Concatenating the diffs gives characters in the order they were written
 * rather than the order they appear, and a character the previous frame already
 * had is not written again at all — so stripped bytes read as words with letters
 * missing. Interpreting the cursor moves is what makes an assertion about the
 * screen an assertion about the screen.
 */
function screenOf(terminal: Terminal): string[] {
  const rows: string[][] = [];
  let row = 0;
  let column = 0;

  const put = (character: string): void => {
    while (rows.length <= row) {
      rows.push([]);
    }
    const line = rows[row];
    while (line.length < column) {
      line.push(" ");
    }
    line[column] = character;
    column += 1;
  };

  const written = terminal.presented.map((bytes) => TEXT.decode(bytes)).join("");
  for (let index = 0; index < written.length; index += 1) {
    const character = written[index];
    if (character !== "\u001B") {
      if (character === "\n") {
        row += 1;
        column = 0;
      } else if (character === "\r") {
        column = 0;
      } else {
        put(character);
      }
      continue;
    }
    // CSI: the only sequences this renderer uses to position and to clear.
    const csi = /^\u001B\[([0-9;]*)([@-~])/.exec(written.slice(index));
    if (csi !== null) {
      const parameters = csi[1].split(";").map((one) => (one === "" ? 0 : Number(one)));
      if (csi[2] === "H") {
        row = Math.max(0, (parameters[0] ?? 1) - 1);
        column = Math.max(0, (parameters[1] ?? 1) - 1);
      } else if (csi[2] === "J") {
        rows.length = 0;
        row = 0;
        column = 0;
      }
      index += csi[0].length - 1;
      continue;
    }
    // OSC, and the two-byte escapes. Neither carries anything readable.
    const osc = /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/.exec(written.slice(index));
    if (osc !== null) {
      index += osc[0].length - 1;
      continue;
    }
    index += 1;
  }
  return rows.map((line) => line.join(""));
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

/** Whether any row of the screen contains this text. */
function shows(terminal: Terminal, expected: string): boolean {
  return screenOf(terminal).some((line) => line.includes(expected));
}

/**
 * Tab until the control this key names holds focus.
 *
 * Traversal through the ordinary normalized boundary, exactly as a person does
 * it: there is no host shortcut that jumps to a control, and the marker on the
 * focused control is how anybody — a person or this test — knows where they are.
 */
function* focusOn(terminal: Terminal, label: string, limit = 240): Operation<void> {
  if (focusedOn(terminal, label)) {
    return;
  }
  for (let press = 0; press < limit; press += 1) {
    terminal.feed("\t");
    yield* settled(12);
    if (focusedOn(terminal, label)) {
      return;
    }
  }
  throw new Error(`focus never reached ${label} in ${limit} presses`);
}

/**
 * Put focus on the entry draft.
 *
 * There is no label to aim at: the draft is empty, and what it draws is its own
 * prompt. So the marker and the prompt together are what name it — a focused
 * field renders its marker immediately before its prompt, and the draft's
 * prompt is the only one on this screen that is itself a marker.
 */
function* focusDraft(terminal: Terminal, limit = 240): Operation<void> {
  for (let press = 0; press <= limit; press += 1) {
    if (screenOf(terminal).some((line) => line.includes(">> "))) {
      return;
    }
    terminal.feed("\t");
    yield* settled(12);
  }
  throw new Error(`focus never reached the entry draft in ${limit} presses`);
}

/**
 * Whether the control holding focus is the one this label names.
 *
 * Anchored to the marker rather than matched anywhere on the line, because a
 * line of this screen crosses three columns: the sidebar, the transcript and the
 * inspection column all write to the same rows, so a label found *somewhere* on
 * a line with a marker on it is usually a different control in a different column.
 * The marker is searched for at any position for the same reason — a focused
 * control in the inspection column has the sidebar's text to the left of it.
 */
function focusedOn(terminal: Terminal, label: string): boolean {
  for (const line of screenOf(terminal)) {
    for (let at = line.indexOf(">"); at !== -1; at = line.indexOf(">", at + 1)) {
      // Past the selection channel as well as the indent: a row can be both
      // focused and the one being read, and the two markers are independent.
      const after = line.slice(at + 1).trimStart();
      const beyond = after.startsWith("* ") ? after.slice(2) : after;
      if (after.startsWith(label) || beyond.startsWith(label)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The canonical location the screen is showing, if it has drawn one yet.
 *
 * Reassembled, because a location carrying a draft is longer than a row and the
 * screen shows it as consecutive rows. Which rows belong to it is decided by the
 * grammar rather than by counting: the longest run that decodes *is* the location,
 * and a shorter prefix of it decodes to a different route or to nothing.
 */
function maybeLocation(terminal: Terminal): string | undefined {
  const rows = screenOf(terminal);
  const first = rows.findIndex((line) => line.includes("xmd://repl/"));
  if (first === -1) {
    return undefined;
  }
  const at = rows[first].indexOf("xmd://repl/");
  const parts: string[] = [];
  for (let row = first; row < rows.length && row < first + 24; row += 1) {
    const part = (rows[row] ?? "").slice(at, at + surfaceWidth(terminal.size));
    if (part.trim().length === 0) {
      break;
    }
    parts.push(part.trimEnd());
    // Every row of a location is padded to the full surface width, so a row
    // with space left on its end is the last of them. Without this the row
    // drawn underneath joins on, and the round-trip below cannot always tell:
    // a location ending in `/entry-2` followed by a transcript row beginning
    // `entry ...` re-encodes as `/entry-2entry` exactly as written.
    if (part.trimEnd().length < part.length) {
      break;
    }
  }

  // The rows below a location belong to whatever is drawn under it, and a row that
  // used to hold a longer location can still have that tail on the end. So the
  // answer is the longest prefix that *round-trips*: the grammar accepts some
  // trailing junk inside a drawer segment, but re-encoding what it decoded only
  // reproduces the prefix that really was the location.
  const joined = parts.join("");
  let found: string | undefined;
  for (let length = joined.length; length > "xmd://repl/".length; length -= 1) {
    const candidate = joined.slice(0, length);
    const decoded = decodeLocation(candidate);
    if (decoded.ok && encodeLocation(decoded.value) === candidate) {
      found = candidate;
      break;
    }
  }
  return found;
}

/** The canonical location the screen is showing. */
function locationOn(terminal: Terminal): string {
  const shown = maybeLocation(terminal);
  if (shown === undefined) {
    throw new Error(
      "the screen shows its canonical location. rows=" +
        JSON.stringify(
          screenOf(terminal)
            .slice(0, 5)
            .map((l) => l.trimEnd()),
        ),
    );
  }
  return shown;
}

/**
 * Wait until the first frame has been drawn.
 *
 * The command opens a terminal, a repository and a session before it can draw
 * anything, and how long that takes is not a number of turns — so every test
 * that reads the screen waits for it rather than assuming.
 */
function* untilDrawn(terminal: Terminal): Operation<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (maybeLocation(terminal) !== undefined) {
      return;
    }
    yield* sleep(10);
    yield* settled(10);
  }
  throw new Error(
    `the screen never drew its first frame. frames=${terminal.presented.length} rows=` +
      JSON.stringify(
        screenOf(terminal)
          .map((l) => l.trimEnd())
          .filter((l) => l.trim().length > 0),
      ),
  );
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
 * The rectangle the layout places the drawer in, at one size.
 *
 * The same arithmetic the placement uses, read back from what layout exports:
 * the body is everything above the footer, and the drawer is inset an eighth of
 * it on every side.
 */
function drawerBox(size: ReplTerminalSize): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const top = Math.floor(sessionsHeight(size) / 8);
  const left = Math.floor(size.columns / 8);
  return { top, bottom: top + drawerHeight(size), left, right: left + drawerWidth(size) };
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
  const box = drawerBox(terminal.size);
  let title = false;
  for (let row = box.top; row < box.bottom; row += 1) {
    const text = (rows[row] ?? "").slice(box.left, box.right).trimEnd();
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
    if (label === "[close]") {
      break;
    }
    found.push(label);
  }
  return found;
}

/** Focus one control and activate it, the way a person does. */
function* activate(terminal: Terminal, marker: string): Operation<void> {
  yield* focusOn(terminal, marker);
  terminal.feed("\r");
  yield* settled(30);
}

/** Every history file the repository holds, by name. */
function* histories(root: string): Operation<string[]> {
  const entries = yield* until(readdir(join(root, "xmd", "repl")));
  return entries.filter((name) => name.endsWith(".jsonl")).sort();
}

/** The last row of the screen that contains this text, or none. */
function lastRowContaining(rows: readonly string[], text: string): number {
  for (let row = rows.length - 1; row >= 0; row -= 1) {
    if (rows[row].includes(text)) {
      return row;
    }
  }
  return -1;
}

/** One history file's lines, projected as the model reads them. */
function* projectionOf(root: string, file: string): Operation<ReplModel> {
  const projected = projectRepl(
    (yield* records(root, file)).map((line) => {
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
function* records(root: string, file: string): Operation<string[]> {
  const text = yield* until(readFile(join(root, "xmd", "repl", file), "utf8"));
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
      expect(decoded.value.surface).toBe("repl");
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      expect(shows(terminal, "Decision: approve")).toBe(true);
      // Settled: the root closed, so the answer is in the history and the
      // entry's catalog row carries the outcome it closed with.
      expect(shows(terminal, "[ok]")).toBe(true);

      terminal.end();
      yield* running;
    });

    // The Sessions surface is still there, and still explicitly empty.
    expect(shows(terminal, "(none retained)")).toBe(true);
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      surface: "repl",
      scopes: [entry.key],
      drawers: [{ kind: "binding", name: binding.name }],
      at: marker,
      inspect: true,
      draft: undefined,
      session: undefined,
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
      // The drawer the location named is open on the retained value.
      expect(shows(second.terminal, "[close]")).toBe(true);

      // Out from under the drawer first: a modal covers what it is in front of, so
      // the columns beneath it are read once it is closed.
      second.terminal.feed("\x1b");
      yield* settled(30);

      // The same topology: the entry, and the nested component occurrence beneath
      // it, at the exact keys the first process recorded.
      expect(shows(second.terminal, entry.name)).toBe(true);
      expect(shows(second.terminal, nested.name)).toBe(true);
      // The same binding value, read from the file.
      expect(shows(second.terminal, `${binding.name} = `)).toBe(true);
      // The same transcript, including the answer the first process gave and the
      // output that answer produced.
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
      expect(shows(terminal, "Sessions")).toBe(true);
      expect(shows(terminal, "(none retained)")).toBe(true);
      expect(shows(terminal, "Entries")).toBe(true);
      expect(shows(terminal, "(not submitted)")).toBe(true);

      terminal.end();
      yield* running;
      expect(outcome?.location).toBe(`xmd://repl/${execution}/repl`);
      expect(outcome?.refusal).toBeUndefined();
    });

    // And it gave the terminal back.
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
    expect(terminal.listeners).toBe(0);
    expect(terminal.raw[terminal.raw.length - 1]).toBe(false);
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      const standing = locationOn(terminal);
      expect(standing).toContain("/Checklist-1");
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
      expect(locationOn(terminal)).toContain("/Checklist-1");
      expect(locationOn(terminal)).not.toContain("at=");
      expect(shows(terminal, "History")).toBe(true);
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
      expect(locationOn(terminal)).not.toContain("+history");
      expect(locationOn(terminal)).toContain("/Checklist-1");
      expect(before.length).toBeGreaterThan(0);

      terminal.end();
      yield* running;
    });
  });

  it("J1: a document that cannot be admitted leaves the draft and an empty journal", function* () {
    const { terminal, install } = recordingTerminal();
    yield* scoped(function* (): Operation<void> {
      yield* install();
      yield* immediateClock();
      const root = yield* useTemporaryHost();

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      expect(locationOn(terminal)).toContain("draft=");

      terminal.end();
      yield* running;
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
          location: "xmd://repl/broken/repl",
          profile: PROFILE,
        });
        refused = !ran.ok;
      });
      yield* settled(20);
      // What it says, rather than a crash: the command cannot show this history.
      expect(shows(terminal, "cannot read")).toBe(true);
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

      // Control-C, Alt-a, Control-H and F5: each decodes to a letter or a key
      // this product has no meaning for, and none of them is text.
      terminal.bytes(new Uint8Array([0x03]));
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);
      files = yield* histories(root);

      // 1. The draft, and the exact canonical location that carries it. Decoded
      // from what is on the terminal, and compared to the whole pasted source.
      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      const drafting = decodeLocation(locationOn(terminal));
      expect(drafting.ok).toBe(true);
      if (drafting.ok) {
        expect(drafting.value.draft).toBe(source);
      }

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
      expect(focusedOn(terminal, "[20 lines]")).toBe(true);
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
      expect(locationOn(terminal)).toContain("+history");
      yield* focusOn(terminal, "Entry 1 admitted");
      terminal.feed("\r");
      yield* settled(40);

      const frozen = locationOn(terminal);
      expect(frozen).toContain("at=");
      expect(frozen).toContain("inspect");
      // Read only, and nothing of the present in it.
      expect(shows(terminal, "[pause]")).toBe(false);
      expect(screenOf(terminal).some((line) => line.trim().startsWith("…"))).toBe(false);

      // 5. Back to the head, and Continue — once — releases the hold.
      terminal.feed("\x1b");
      yield* settled(30);
      yield* activate(terminal, "[live]");
      expect(locationOn(terminal)).not.toContain("at=");
      expect(askedRow(terminal)).toBeUndefined();

      yield* activate(terminal, "[continue]");
      yield* until_(terminal, "the question", (t) => askedRow(t) !== undefined);

      // 6. The same execution takes the typed answer and settles, once the
      // waiting announcement has been activated.
      yield* openQuestion(terminal);
      terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      terminal.feed("\r");
      yield* until_(terminal, "the answer's output", (t) => shows(t, "Decision: approve"));
      expect(shows(terminal, "[ok]")).toBe(true);

      // The generated fragment's source is on screen above the row that admits it.
      // Which two rows those are comes from the model rather than from a guess at
      // their wording; which order they are in comes from the screen.
      const settledModel = yield* projectionOf(root, files[0]);
      const at = settledModel.transcript.findIndex((row) => row.kind === "generated");
      expect(at).toBeGreaterThanOrEqual(0);
      const sourceRow = settledModel.transcript[at];
      const admission = settledModel.transcript.slice(at + 1).find((row) => row.kind === "effect");
      if (sourceRow?.kind !== "generated" || admission?.kind !== "effect") {
        throw new Error("the settled history holds a generated fragment and its admission");
      }
      const rows = screenOf(terminal).map((line) => line.trim());
      const sourceAt = rows.findIndex((line) => line.includes(sourceRow.source ?? "«none»"));
      const admittedAt = lastRowContaining(rows, `${admission.type} ${admission.status}`);
      expect(sourceAt).toBeGreaterThanOrEqual(0);
      expect(admittedAt).toBeGreaterThanOrEqual(0);
      expect(sourceAt).toBeLessThan(admittedAt);

      // 7. The complete binding value, from the drawer that holds it.
      yield* activate(terminal, "1. [ok] entry-1");
      yield* activate(terminal, "plan");
      expect(locationOn(terminal)).toContain("binding:plan");
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

      captured = locationOn(terminal);
      const decoded = decodeLocation(captured);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.scopes).toEqual(["entry-1"]);
        expect(decoded.value.at).toBeDefined();
        expect(decoded.value.inspect).toBe(true);
        expect(decoded.value.drawers.map((one) => one.kind)).toEqual(["recorded-elicit"]);
      }
      // The whole retained schema and the whole retained answer, in rows.
      for (const line of JSON.stringify(SCHEMA, undefined, 2).split("\n")) {
        expect(shows(terminal, line)).toBe(true);
      }
      for (const line of JSON.stringify(ANSWER, undefined, 2).split("\n")) {
        expect(shows(terminal, line)).toBe(true);
      }

      terminal.end();
      yield* running;
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({
          location: captured,
          profile: PROFILE,
        });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(second.terminal);

      // The same location, unchanged, rendered from the URL it was given.
      expect(locationOn(second.terminal)).toBe(captured);

      // The same retained question: the whole schema and the whole answer, not a
      // label that happens to contain the word.
      for (const line of JSON.stringify(SCHEMA, undefined, 2).split("\n")) {
        expect(shows(second.terminal, line)).toBe(true);
      }
      for (const line of JSON.stringify(ANSWER, undefined, 2).split("\n")) {
        expect(shows(second.terminal, line)).toBe(true);
      }

      // Then out from under the drawer, for the rest of what the file holds.
      second.terminal.feed("\x1b");
      yield* settled(30);
      expect(shows(second.terminal, "component Checklist")).toBe(true);
      expect(shows(second.terminal, "generated admitted:")).toBe(true);
      expect(shows(second.terminal, "Decision: approve")).toBe(true);

      // The same complete binding value.
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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

describe("REPL journey: the same product at every size", () => {
  it("J1: a long draft location stays exact at medium, and no row crosses its region", function* () {
    const source = yield* referenceSource();
    // Medium: a narrower content surface than wide, and an inspection column
    // beside it — so a location row written at the wide width would run into it.
    const { terminal, install } = recordingTerminal({ columns: 120, rows: 30 });

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

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);

      // Exact, all of it, at this size.
      const decoded = decodeLocation(locationOn(terminal));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.draft).toBe(source);
      }

      // And no row of it reaches past the surface it was placed in: the columns
      // to its right belong to the inspection column, and the layout gave them
      // to something else.
      const surface = surfaceWidth(terminal.size);
      expect(surface).toBe(64);
      const rows = screenOf(terminal);
      const first = rows.findIndex((line) => line.includes("xmd://repl/"));
      expect(first).toBeGreaterThanOrEqual(0);
      const at = rows[first].indexOf("xmd://repl/");
      for (let row = first; row < rows.length; row += 1) {
        const inside = (rows[row] ?? "").slice(at, at + surface);
        if (inside.trim().length === 0) {
          break;
        }
        // Whatever is past the surface's right edge is not this row's.
        expect((rows[row] ?? "").slice(at + surface, at + surface + 4).trim()).toBe("");
      }

      terminal.end();
      yield* running;
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
        yield* until_(terminal, "the transcript", (t) => shows(t, "component Checklist"));

        // A transcript with something in it — recorded before anything covers it,
        // so what follows is a claim about coverage rather than about absence.
        // Texts that belong to the transcript and to nothing the drawer lists, so
        // finding one inside the drawer means it showed through.
        const underneath = ["import_component ok", "About to evaluate:"];
        for (const text of underneath) {
          expect(shows(terminal, text)).toBe(true);
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
        const box = drawerBox(terminal.size);
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
          // the transcript has out there exactly where it was.
          expect((inside.slice(LABEL_ROOM) ?? "").trim()).toBe("");
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);

      // The routed surface, and the location above it — both, at the smallest
      // size this REPL draws at.
      expect(shows(terminal, "Entries")).toBe(true);
      expect(locationOn(terminal)).toMatch(/^xmd:\/\/repl\/[A-Za-z0-9_-]+\/repl$/);
      expect(surfaceWidth(terminal.size)).toBe(NARROW.columns);

      terminal.end();
      yield* running;
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      surface: "repl",
      scopes: [entryKey, "Nowhere-9"],
      drawers: [],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      surface: "repl",
      scopes: [model.entries[0]?.key ?? ""],
      drawers: [{ kind: "live-elicit" }],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
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

      const model = yield* projectionOf(root, "unclosed.jsonl");
      expect(model.settled).toBe(false);
      expect(model.entries[0]?.scope.elicitations[0].answer).toEqual({ decision: "approve" });

      const running = yield* spawn(function* (): Operation<void> {
        outcome = yield* runReplProgram({
          location: `xmd://repl/unclosed/repl/${model.entries[0]?.key ?? ""}/+elicit`,
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);
      const files = yield* histories(root);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      terminal.feed("\r");
      yield* until_(terminal, "the question", (t) => askedRow(t) !== undefined);

      // Activating the announcement opens the drawer, and the URL says so while
      // it is up.
      yield* openQuestion(terminal);
      yield* until_(
        terminal,
        "the question's drawer in the location",
        (t) => maybeLocation(t)?.includes("+elicit") === true,
      );
      expect(shows(terminal, "[close]")).toBe(true);

      terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      terminal.feed("\r");
      yield* until_(terminal, "the answer", (t) => shows(t, "Decision: approve"));

      // The question is over, so the drawer is over: it is off the screen, and
      // it is out of the URL. A location still naming `+elicit` would name a
      // drawer nothing mounts, which is a view nobody can be shown.
      expect(shows(terminal, "[close]")).toBe(false);
      expect(locationOn(terminal)).not.toContain("+elicit");
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);

      terminal.bytes(BYTES.encode(source));
      yield* settled(60);
      expect(focusedOn(terminal, "[20 lines]")).toBe(true);
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
    });
    expect(held.intent.kind).toBe("continue");
    expect(held.state.refusal).toBe(undefined);
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      expect(shows(terminal, "Decide?")).toBe(false);
      // The text after the last record this document writes. Nothing recorded
      // it, nothing reprojected because of it, and it is on the screen.
      expect(shows(terminal, PRINTED)).toBe(true);

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
 * What says the entry exists is the draft leaving the location: it clears only
 * once it has become one, and it is the thing this helper just put there.
 */
function* submitted(terminal: Terminal, source: string): Operation<void> {
  yield* focusDraft(terminal);
  terminal.bytes(BYTES.encode(source));
  yield* settled(60);
  terminal.feed("\r");
  yield* admittedDraft(terminal);
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      expect(locationOn(terminal)).toContain("draft=Three.");

      // A position from before the second entry was ever admitted.
      yield* activate(terminal, "[history]");
      const markers = drawerMarkers(terminal);
      expect(markers.length).toBeGreaterThan(1);
      yield* activate(terminal, markers[0] ?? "");
      // The drawer is read through, so it is closed before the location is.
      terminal.feed("\x1b");
      yield* settled(40);

      const after = decodeLocation(locationOn(terminal));
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
        expect(after.value.surface).toBe("repl");
      }
      // And the catalog is the one that prefix holds, rather than the head's.
      // Which entries the prefix holds, whatever they had settled to by then —
      // at this position the first one has not closed.
      expect(shows(terminal, "] entry-1")).toBe(true);
      expect(shows(terminal, "] entry-2")).toBe(false);

      terminal.end();
      yield* running;
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
 * Every rendered row except the ones the location is drawn on.
 *
 * So a claim that switching changed the screen cannot be satisfied by the URL,
 * which is the whole thing this Story says is not enough.
 */
function without(terminal: Terminal): string[] {
  return screenOf(terminal)
    .map((line) => line.trimEnd())
    .filter((line) => !line.includes("xmd://repl/"));
}

/** The draft a location carries, as it spells it, or none. */
function draftIn(location: string): string | undefined {
  return /[?&]draft=([^&]*)/.exec(location)?.[1];
}

/** Wait until the draft has left the location, which is when it became an entry. */
function admittedDraft(terminal: Terminal): Operation<void> {
  return awaiting(
    terminal,
    "the draft becoming an entry",
    (one) => !(maybeLocation(one) ?? "draft=").includes("draft="),
  );
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
      expect(locationOn(terminal)).toContain("draft=");
      terminal.feed("\r");
      yield* settled(120);

      // Refused, because Entry 1 has not finished. Nothing was admitted, the
      // history did not move, and the draft is exactly where it was.
      expect(shows(terminal, "has not finished")).toBe(true);
      expect(yield* records(root, files[0])).toEqual(held);
      expect(locationOn(terminal)).toContain("draft=");
      const drafted = decodeLocation(locationOn(terminal));
      expect(drafted.ok).toBe(true);
      if (drafted.ok) {
        expect(drafted.value.draft).toBe(JOURNEY_TWO);
      }

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
      terminal.feed("\r");
      yield* admittedDraft(terminal);
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
      expect(locationOn(terminal)).toContain("/entry-1");
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
    const path = join(retained, "xmd", "repl", files[0]);
    const before = yield* until(readFile(path, "utf8"));
    const execution = files[0].replace(/\.jsonl$/, "");

    const live = yield* projectionOf(retained, files[0]);
    expect(live.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

    // A location that names the *second* entry, so what comes back has to be a
    // catalog and a selection rather than whatever happens to be first.
    const location = encodeLocation({
      execution,
      surface: "repl",
      scopes: ["entry-2"],
      drawers: [],
      at: undefined,
      inspect: false,
      draft: undefined,
      session: undefined,
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
      expect(locationOn(second.terminal)).toContain("/entry-2");
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
      const before = yield* until(readFile(join(root, "xmd", "repl", files[0]), "utf8"));

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
      expect(yield* until(readFile(join(root, "xmd", "repl", files[0]), "utf8"))).toBe(before);
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
        expect(shows(terminal, "Tab/Shift+Tab move")).toBe(true);
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
          expect(shows(terminal, "Tab to the draft to type")).toBe(true);
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      expect(band.some((row) => row.includes(model.checkpoints[0].label))).toBe(true);
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);

      // Something in the draft first, so "unchanged" is a claim about bytes rather
      // than about emptiness.
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode("the draft"));
      yield* settled(40);
      const before = locationOn(terminal);
      expect(before).toContain("draft=the%20draft");

      yield* focusOn(terminal, "[exit]");
      // The explanation is on the screen *before* the keystroke that needs it.
      expect(shows(terminal, "Tab to the draft to type")).toBe(true);

      terminal.bytes(BYTES.encode("xyz"));
      yield* settled(40);
      // Byte for byte: a control that let text fall through to the draft would be
      // editing a field nobody is looking at.
      expect(locationOn(terminal)).toBe(before);
      expect(shows(terminal, "xyz")).toBe(false);

      // And the draft takes them again as soon as focus comes back to it.
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode("more"));
      yield* settled(40);
      expect(locationOn(terminal)).not.toBe(before);
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
    ).map((one) => readDescription(one).key);
    expect(tiny).not.toContain("footer:exit");
    const roomy = describeApplication(
      refusedView(initialState("tiny"), "this history cannot be read.", {
        columns: 160,
        rows: 36,
      }),
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);

      // On Sessions, with something typed, before anything is asked.
      yield* activate(terminal, "Sessions");
      yield* focusDraft(terminal);
      terminal.bytes(BYTES.encode(JOURNEY_ONE));
      yield* settled(60);
      terminal.feed("\r");
      yield* admittedDraft(terminal);
      expect(locationOn(terminal)).toContain("/sessions");
      yield* focusOn(terminal, "[exit]");
      const standing = locationOn(terminal);

      // The question arrives. It announces itself and does nothing else: the
      // route, the surface and the focused control are where they were.
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);
      expect(locationOn(terminal)).toBe(standing);
      expect(locationOn(terminal)).toContain("/sessions");
      expect(locationOn(terminal)).not.toContain("+elicit");
      expect(focusedOn(terminal, "[exit]")).toBe(true);
      expect(shows(terminal, "decision: go")).toBe(false);

      // Activating it is what opens it, and that act crosses to the surface the
      // question belongs to and selects the entry that is asking.
      const at = askedRow(terminal);
      if (at === undefined) {
        throw new Error("the question announced itself");
      }
      yield* clickAt(terminal, at);
      yield* until_(terminal, "the question's form", (one) => shows(one, "decision: go"));
      expect(locationOn(terminal)).toContain("/repl/entry-1/+elicit");

      // Escape dismisses without answering, and the question is still waiting — so
      // it announces itself again and opens again.
      terminal.feed("\x1b");
      yield* until_(terminal, "the drawer closing", (one) => !shows(one, "decision: go"));
      expect(locationOn(terminal)).not.toContain("+elicit");
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

        // Selecting an entry does not filter the chronology this execution has.
        yield* activate(terminal, "Sessions");
        expect(shows(terminal, "(none retained)")).toBe(true);

        terminal.end();
        yield* running;
      });
    }
  });
});

/**
 * The narrow guidance row is composed, not cut (#870 UI10/UI16).
 *
 * Asserted by exact equality, because the claim is about the whole row. A row
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      yield* focusOn(terminal, "[v later]");
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      yield* until_(terminal, "the frozen position", (one) => locationOn(one).includes("inspect"));

      // Reopened over a frozen position: now both are true at once.
      yield* activate(terminal, "[history]");
      yield* until_(terminal, "the History drawer again", (one) => shows(one, "[close]"));
      const saying = screenOf(terminal).findIndex((line) => line.includes("History ·"));
      expect(saying).toBeGreaterThanOrEqual(0);
      // Above the drawer's own rows — which is exactly what made the old anchor
      // read the wrong one. It shares columns with the box at this size, so the
      // row is the distinction and the column is not.
      const box = drawerBox(terminal.size);
      expect(saying).toBeLessThan(box.top);

      // And the helper still answers with the drawer's own rows: every one of
      // them is a position this history holds, and none is a piece of the
      // sentence or of the transcript behind the box.
      // The positions this frozen prefix holds — fewer than the live head's, which
      // is what a prefix is — and every one of them a position rather than a
      // piece of the sentence or of the transcript behind the box.
      const markers = drawerMarkers(terminal);
      expect(markers.length).toBeGreaterThan(0);
      expect(markers).toContain("Entry 1 admitted");
      expect(markers.length).toBeLessThanOrEqual(listed.length);
      for (const marker of markers) {
        expect([marker, marker.includes("·")]).toEqual([marker, false]);
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
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
      expect(locationOn(terminal)).toContain("/repl/entry-1");
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
      const path = join(root, "xmd", "repl", files[0]);
      before = yield* until(readFile(path, "utf8"));
      const execution = files[0].replace(/\.jsonl$/, "");

      const running = yield* spawn(function* (): Operation<void> {
        // A location this history cannot answer: an entry it never admitted.
        outcome = yield* runReplProgram({
          location: `xmd://repl/${execution}/repl/entry-9`,
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
    expect(yield* until(readFile(join(root, "xmd", "repl", files[0]), "utf8"))).toBe(before);
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
          location: `xmd://repl/${execution}/repl/entry-9`,
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);

      yield* submitted(terminal, SIBLING_FAILS);

      // The question is asked and opened, the way a person opens it.
      yield* openQuestion(terminal);
      expect(locationOn(terminal)).toContain("+elicit");
      expect(shows(terminal, "decision: go")).toBe(true);

      // Now the sibling fails. The question goes with the expansion that was
      // asking it, while this process stays alive and keeps the screen.
      held.resolve();

      // The drawer and the form go together, and neither becomes an answer.
      yield* until_(terminal, "the drawer withdrawing", (one) => !shows(one, "decision: go"));
      expect(locationOn(terminal)).not.toContain("+elicit");
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

      const running = yield* spawn(function* (): Operation<void> {
        const ran = yield* runReplProgram({ profile: PROFILE });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);

      yield* submitted(terminal, JOURNEY_ONE);
      yield* until_(terminal, "the waiting question", (one) => askedRow(one) !== undefined);
      const standing = locationOn(terminal);
      const before = yield* records(root, (yield* histories(root))[0]);

      // A historical position cannot answer the question this process is asking,
      // and asking it to says so instead of freezing a live drawer into a prefix.
      yield* activate(terminal, "[history]");
      yield* until_(terminal, "the History drawer", (one) => shows(one, "[close]"));
      yield* click(terminal, "Entry 1 admitted");
      yield* settled(40);
      expect(locationOn(terminal)).toContain("at=");
      // The announcement is gone with the live state it belonged to: a frozen view
      // fills nothing from the head.
      expect(askedRow(terminal)).toBeUndefined();
      yield* click(terminal, "[close]");
      yield* settled(30);
      yield* activate(terminal, "[live]");
      yield* until_(terminal, "the waiting question again", (one) => askedRow(one) !== undefined);

      // Every refusal left the route standing and the file alone.
      expect(locationOn(terminal)).toBe(standing);
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
        const kept = draftIn(locationOn(terminal));
        expect(kept).toBe("next%20entry");

        yield* openQuestion(terminal);

        // Still drawn, on its own footer row, which the drawer sits above rather
        // than across. The draft and the question are both readable at once. Read
        // from the row rather than from the location, because a drawer covers the
        // rows the location is drawn on — which is exactly why the draft needs a
        // row of its own.
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
        expect(draftIn(locationOn(terminal))).toBe(kept);
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
      waiting = yield* until(readFile(join(root, "xmd", "repl", files[0]), "utf8"));

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

    const path = join(root, "xmd", "repl", (yield* histories(root))[0]);
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
      expect(locationOn(resumed.terminal)).toContain("/entry-1");
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
    const settledPath = join(settledRoot, "xmd", "repl", (yield* histories(settledRoot))[0]);
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
      expect(locationOn(terminal)).toContain("/sessions");
      yield* activate(terminal, "Entries");
      expect(locationOn(terminal)).toContain("/repl");

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
      expect(locationOn(terminal)).toContain("at=");
      yield* click(terminal, "[close]");
      yield* settled(30);
      // Frozen: what the draft's guidance says changes, because what Enter there
      // does changed — there is no head to submit into from here.
      yield* focusDraft(terminal);
      expect(shows(terminal, "activate live to return to the head")).toBe(true);
      expect(shows(terminal, "Enter submits")).toBe(false);
      yield* activate(terminal, "[live]");
      yield* until_(terminal, "the head", (one) => !(maybeLocation(one) ?? "at=").includes("at="));

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
