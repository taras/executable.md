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
import { type Operation, type Result, scoped, sleep, spawn, withResolvers } from "effection";
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
import { initialState, NO_AGENT, reduceRepl } from "../src/repl/application.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import type { ReplOutcome } from "../src/repl/program.ts";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import { drawerWidth, NARROW, surfaceWidth } from "../src/repl/layout.ts";
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
  let waiting: ((result: IteratorResult<Uint8Array, undefined>) => void) | undefined;
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
    write(bytes: Uint8Array): Promise<void> {
      terminal.presented.push(new Uint8Array(bytes));
      if (!holding) {
        return Promise.resolve();
      }
      holding = false;
      return new Promise<void>((resolve) => {
        terminal.holdPresent = { release: resolve };
      });
    },
    writeNow(): void {
      terminal.resets += 1;
    },
    setRaw(raw: boolean): void {
      terminal.raw.push(raw);
    },
    bytes(): AsyncIterable<Uint8Array> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array, undefined> {
          terminal.readers += 1;
          return {
            next(): Promise<IteratorResult<Uint8Array, undefined>> {
              const head = queue.shift();
              if (head !== undefined) {
                return Promise.resolve({ done: false, value: head });
              }
              if (ended) {
                return Promise.resolve({ done: true, value: undefined });
              }
              return new Promise((resolve) => {
                waiting = resolve;
              });
            },
            return(): Promise<IteratorResult<Uint8Array, undefined>> {
              terminal.readers -= 1;
              const resolve = waiting;
              waiting = undefined;
              resolve?.({ done: true, value: undefined });
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
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
      if (
        line
          .slice(at + 1)
          .trimStart()
          .startsWith(label)
      ) {
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
 * Dismiss the question's drawer, which opens itself when the question appears.
 *
 * A modal owns focus while it is up, so anything that means to reach a control
 * beneath it has to close it first — and it may not have opened yet when the
 * submission settles, so this waits for it rather than assuming.
 */
function* dismissQuestion(terminal: Terminal): Operation<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Keyed to the drawer's own form, because while it is up it covers the rows
    // the location is drawn on — a modal is drawn over what it is in front of.
    if (shows(terminal, "decision: approve | decline")) {
      terminal.feed("\x1b");
      yield* settled(30);
      return;
    }
    // Real time, not only turns: reaching the question compiles an eval block,
    // and a compile is work off this interpreter rather than a turn on it.
    yield* sleep(10);
    yield* settled(20);
  }
  throw new Error("the question's drawer never opened");
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
 * Every position the open History drawer lists, in the order it lists them.
 *
 * Read from the drawer rather than from the compact band: the band shares labels
 * when space is short, and what is being compared is the exact set.
 */
function drawerMarkers(terminal: Terminal): string[] {
  const found: string[] = [];
  const rows = screenOf(terminal);
  const title = rows.findIndex((line) => line.includes("History"));
  if (title === -1) {
    return found;
  }
  const at = rows[title].indexOf("History");
  for (let row = title + 1; row < rows.length; row += 1) {
    const text = (rows[row] ?? "").slice(at, at + drawerWidth(terminal.size)).trimEnd();
    const label = text.replace(/^>\s*/, "").trim();
    if (label.length === 0 || label === "[close]") {
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

      // The entry is admitted and immutable, and the question it reaches is
      // being asked.
      expect(shows(terminal, "(one entry admitted)")).toBe(true);
      expect(shows(terminal, "Approve Ship the REPL?")).toBe(true);

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
      expect(shows(terminal, "Approve Ship the REPL?")).toBe(true);

      // The question's drawer was offered when the question appeared: a blocked
      // document is the interaction, not something to go hunting for.
      // The drawer shows the retained schema as a form: one field, its choices.
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
      // Settled: the root closed, so the answer is in the history and the entry
      // is immutable.
      expect(shows(terminal, "(one entry admitted)")).toBe(true);

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
      yield* focusOn(terminal, "(one entry admitted)");

      terminal.bytes(BYTES.encode("<Json value={1} />"));
      yield* settled(30);
      terminal.feed("\r");
      yield* settled(120);

      // The submission path itself refused, history did not change, and the
      // screen says why rather than appearing to do nothing.
      expect(yield* records(root, files[0])).toEqual(admitted);
      expect(shows(terminal, "(one entry admitted)")).toBe(true);
      expect(shows(terminal, "admits one entry")).toBe(true);

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
      expect(shows(terminal, "Approve Ship the REPL?")).toBe(false);

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
      expect(shows(terminal, "Approve Ship the REPL?")).toBe(false);

      yield* activate(terminal, "[continue]");
      yield* until_(terminal, "the question", (t) => shows(t, "Approve Ship the REPL?"));

      // 6. The same execution takes the typed answer and settles.
      yield* until_(terminal, "the question's drawer", (t) =>
        shows(t, "decision: approve | decline"),
      );
      terminal.bytes(BYTES.encode("approve"));
      yield* settled(30);
      terminal.feed("\r");
      yield* until_(terminal, "the answer's output", (t) => shows(t, "Decision: approve"));
      expect(shows(terminal, "(one entry admitted)")).toBe(true);

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
      yield* activate(terminal, "1. entry-1");
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
        const title = rows.findIndex((line) => line.includes("History"));
        expect(title).toBeGreaterThanOrEqual(0);
        const left = Math.floor(size.columns / 8);
        const right = left + drawerWidth(terminal.size);
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
      yield* until_(first.terminal, "the question", (t) => shows(t, "Approve Ship the REPL?"));

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
      yield* until_(first.terminal, "the question's drawer", (t) =>
        shows(t, "decision: approve | decline"),
      );
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
      yield* until_(terminal, "the question", (t) => shows(t, "Approve Ship the REPL?"));

      // The drawer is offered on its own, and the URL says so while it is up.
      yield* until_(
        terminal,
        "the question's drawer",
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
      agent: NO_AGENT,
    });
    expect(pausing.intent.kind).toBe("none");
    expect(pausing.state.refusal).toContain("not paused");

    const held = reduceRepl(initialState("abc"), { kind: "continue" }, EMPTY_MODEL_FOR_TEST, {
      output: "",
      question: undefined,
      expansion: "paused",
      pausable: true,
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
      yield* until_(terminal, "the question", (t) => shows(t, "Decide?"));
      expect((yield* records(root, files[0])).length).toBeGreaterThan(0);

      terminal.end();
      yield* running;
    });
  });
});
