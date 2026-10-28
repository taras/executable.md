/**
 * Semantic presentation, in the cells a frame actually wrote.
 *
 * One real engine pair, one real Freedom tree and the production
 * `commitReplFrame`, driven through the presentation fixture. What is under test
 * is that **what a row means is visible in the cells that row was drawn in** —
 * not that a palette value appears somewhere in the stream, and not that a
 * description carried a role nothing drew.
 *
 * Every assertion names a rectangle the committed frame published and reads the
 * characters and the attributes out of it. That is the whole discrimination: a
 * cyan code written anywhere else on the screen cannot satisfy an assertion about the
 * selected field, and a role attached to a candidate the manifest left out paints
 * nothing at all.
 *
 * The frames are real readings of a real Journal: three entries run for real, one
 * settling `ok`, one failing and one never closing, so `[ok]`, `[err]` and
 * `[unfinished]` are outcomes the file recorded rather than strings a fixture
 * chose.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { close, fit, open, text } from "@bomb.sh/tty";
import {
  collect,
  Elicitation,
  inlineSource,
  retainedSource,
  useTempFileCompiler,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { fileURLToPath } from "node:url";
import { readTextFile } from "@effectionx/fs";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { scoped, sleep, spawn } from "effection";
import type { Operation } from "effection";

import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { EntrySegmentStream } from "../src/repl/entries.ts";
import {
  EMPTY_FORM,
  guidanceSentence,
  initialState,
  NO_AGENT,
  reduceRepl,
  workspaceOf,
  viewFor,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { useReplElicitation } from "../src/repl/elicitation.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import { encodeLocation } from "../src/repl/route.ts";
import type {
  ReplAction,
  ReplFormMessage,
  ReplLive,
  ReplSidekickChatRow,
  ReplSidekickReading,
  ReplState,
  ReplView,
} from "../src/repl/application.ts";
import type { ReplDispatched, ReplTree } from "../src/repl/reconcile.ts";
import type { ReplDrawerRef } from "../src/repl/route.ts";
import {
  COLUMN_TOP_GAP,
  drawerRect,
  FOOTER_ROWS,
  HISTORY_ROWS,
  inspectionWidth,
  NARROW,
  sidebarWidth,
  BODY_GUTTER,
} from "../src/repl/layout.ts";
import { HISTORY_TITLE } from "../src/repl/history-rail.ts";
import {
  ACTION_ROW,
  DRAWER_WINDOW,
  READING_WINDOW,
  SIDEBAR_BODY,
  SIDEKICK_BODY,
  SESSIONS_WINDOW,
  SIDEKICK_WINDOW,
  TAB_ROW,
  TRANSCRIPT_BODY,
} from "../src/repl/application.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import type { ReplBounds } from "../src/repl/layout.ts";
import { BOLD, REPL_PALETTE } from "../src/repl/presentation-style.ts";
import {
  REFERENCE_ARCHIVE,
  REFERENCE_BOLD,
  RETAINED,
  SEMANTIC,
  SURFACE,
  SYNTAX,
  LIFECYCLE,
  RAIL,
} from "./fixtures/repl/reference-style.ts";
import { ACCEPTED_EDGE, ACCEPTED_SURFACE } from "./fixtures/repl/issue-883/reference-style.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import {
  createGrid,
  regionBounds,
  usePresenter,
  viewportBounds,
  windowOf,
} from "./fixtures/repl/presentation.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";
import {
  CHECKPOINT_DRAFT,
  CHECKPOINT_LIVE,
  CHECKPOINT_MEDIUM,
  CHECKPOINT_MESSAGE,
  CHECKPOINT_NARROW,
  CHECKPOINT_CURRENT_WORKSPACE,
  CHECKPOINT_SIDEKICK,
  CHECKPOINT_SIZE,
  CHECKPOINT_SIZES,
  CHECKPOINT_ASKING,
  chatAt,
  checkpointModel,
  checkpointState,
  checkpointViewOf,
  checkpointScopes,
  checkpointStateModel,
  commitCheckpoint,
  RUNNING_SOURCE,
  WRAPPING_LINE,
} from "./fixtures/repl/workspace-checkpoint.ts";
import { chatLinesFor, QUEUE_WINDOW } from "../src/repl/application.ts";
import { readDescription } from "../src/repl/description.ts";
import { useCountingRenderer } from "./fixtures/repl/presentation.ts";
import {
  appearanceJournal,
  appearanceModel,
  appearanceRecord,
  readAppearanceRecord,
  differences,
  screenOf,
  sizeOf,
} from "./fixtures/repl/appearance.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import { createFitStore, createPlainFitStore, fitPlain } from "../src/repl/fitting.ts";
import type { ReplFittedLine } from "../src/repl/fitting.ts";
import { commitReplFrame, prepareFrame } from "../src/repl/program.ts";
import { ordinaryGeneratedSelection } from "../src/evaluation-profile.ts";
import { submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { CellStyle, Observed, Presenter, TerminalGrid } from "./fixtures/repl/presentation.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };
/** The large frame the History rows drive, where the drawer sits lower. */
const LARGE: ReplTerminalSize = { columns: 200, rows: 60 };
const EXECUTION = "style";

/**
 * One entry that settles `ok`, binds a value and renders output of its own.
 *
 * Both rows matter: the binding is a fact about the event and the output is what
 * the run produced, and telling those apart on screen is what this file is about.
 */
const SETTLING = [
  "```js eval",
  'const kept = "alpha";',
  'output("the plan is ready to read");',
  "```",
  "",
  "One: {kept}",
  "",
].join("\n");

/**
 * One entry whose root closes `err` having recorded nothing to show.
 *
 * The same refusal the captures drive: a schema outside this REPL's form
 * language. Nothing renders before it, so the transcript has an outcome to draw
 * rather than a result, which is the branch that keeps the outcome accent.
 */
const FAILING = [
  "# A refused question",
  "",
  '<Elicit schema={{ type: "number" }} as="answer">This schema is outside the REPL\'s form language.</Elicit>',
  "",
].join("\n");

/** A Sidekick with nothing said in it, for a frame that has one. */
const SIDEKICK_QUIET = Object.freeze({
  chat: Object.freeze([]),
  busy: false,
  agent: "stub-agent",
  refusal: undefined,
});

const NOTHING_LIVE: ReplLive = Object.freeze({
  output: "",
  question: undefined,
  expansion: "playing",
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
});

/**
 * This process observing one element of the entry it is running.
 *
 * The lifecycle reading the session would publish, so a frame can be asked
 * what an observed element's badge looks like where it actually lands.
 */
function observing(
  entry: string,
  name: string,
  offset: number,
  phase: "active",
  path: string,
): ReplLive {
  return Object.freeze({
    ...NOTHING_LIVE,
    running: true,
    pausable: true,
    lifecycle: Object.freeze({
      entry,
      occurrences: Object.freeze([
        Object.freeze({
          key: `${entry}#1`,
          expansion: "x",
          name,
          parent: undefined,
          position: Object.freeze({
            path,
            generatedSource: undefined,
            offset,
            line: 1,
            column: 1,
          }),
          phase,
          waiting: Object.freeze([]),
        }),
      ]),
    }),
  });
}

/** This process part-way through an entry: output on the overlay, nothing closed. */
function streaming(output: string): ReplLive {
  return Object.freeze({ ...NOTHING_LIVE, output, running: true, pausable: true });
}

/** Run one entry at the end of `physical`, over a view of its own segment. */
function* runEntry(
  physical: DurableStream,
  source: string,
  initialBindings: Readonly<Record<string, Json>> = {},
): Operation<void> {
  const view = new EntrySegmentStream(physical);
  try {
    const execution = yield* executeInstalled({ ...inlineSource(source), stream: view }, [], {
      initialBindings,
    });
    yield* collect(execution);
  } catch {
    // How far an entry got is the point: a failing root closes `err`, and that
    // close is the record the catalog reads its outcome from.
  }
}

/**
 * The same entry submitted the way the command submits a host file: by its path.
 *
 * The path is what makes this fixture worth having. A document submitted from
 * the filesystem is recorded by where it came from, and in this checkout that
 * is longer than any pane the frame has room for — which is the metadata class
 * the gallery caught wrapping over the row beneath it.
 */
function* runHostEntry(physical: DurableStream, path: string, source: string): Operation<void> {
  const view = new EntrySegmentStream(physical);
  try {
    const execution = yield* executeInstalled(
      { ...retainedSource(path, source), stream: view },
      [],
    );
    yield* collect(execution);
  } catch {
    // As above: how far it got is the record the catalog reads.
  }
}

/** This file's own reference entry, by its absolute path in this checkout. */
const HOST_ENTRY_PATH = fileURLToPath(new URL("./fixtures/repl/entry.md", import.meta.url));

/** One real entry whose own metadata row is wider than the pane holding it. */
function* submittedByPath(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runHostEntry(physical, HOST_ENTRY_PATH, SETTLING);
  return projected(yield* physical.readAll());
}

/**
 * One line of prose longer than any pane this frame has, and one unbroken
 * token no word boundary can break.
 *
 * The case R3 needs: text that would reach the pane beside it if nothing fitted
 * it. It is a document's own prose rather than a path, because what a reader
 * came for is exactly the text this screen must not shorten — so the only
 * honest way to keep it inside its pane is to measure it and wrap it.
 */
const LONG_SOURCE = [
  "One line of ordinary prose, written long enough that no pane this frame has " +
    "room for could hold it on a single row without reaching into the column " +
    "beside it, which is the artifact this case exists to catch.",
  "",
  `t${"t".repeat(200)}`,
  "",
].join("\n");

function* submittedWithLongSource(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runHostEntry(physical, HOST_ENTRY_PATH, LONG_SOURCE);
  return projected(yield* physical.readAll());
}

/** The projected model, or the failure that stopped it. */
function projected(events: readonly DurableEvent[]): ReplModel {
  const result = projectRepl(events);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * One settled entry and one failed one, projected from bytes this run wrote.
 *
 * Both roots close, so the catalog holds a real `[ok]` beside a real `[err]`.
 */
function* settledAndFailed(): Operation<ReplModel> {
  return projected(yield* settledAndFailedJournal());
}

/**
 * The journal those two entries write.
 *
 * Returned as events as well as a model, because a reading frozen at a recorded
 * position needs the prefix that position names — and a prefix is a slice of
 * these bytes.
 */
function* settledAndFailedJournal(): Operation<DurableEvent[]> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, SETTLING);
  yield* runEntry(physical, FAILING, entryInitialBindings(projected(yield* physical.readAll())));
  return yield* physical.readAll();
}

/**
 * The model as it stood at one recorded position.
 *
 * The projector takes the position and reads the prefix that names it, which is
 * what a reading frozen there is a reading of — a route naming a position its
 * model was never projected at is refused, and rightly.
 */
function prefixAt(events: readonly DurableEvent[], marker: string): ReplModel {
  const grown = projectRepl(events, marker);
  if (!grown.ok) {
    throw grown.error;
  }
  return grown.value;
}

/**
 * The same prefix with a third entry that never closed.
 *
 * Truncated at the last admission rather than built by hand: an unfinished entry
 * is a segment whose root has no close, which is exactly what a prefix read while
 * an entry is running holds.
 */
function* settledFailedAndRunning(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, SETTLING);
  yield* runEntry(physical, FAILING, entryInitialBindings(projected(yield* physical.readAll())));
  const settled = yield* physical.readAll();
  const third = new InMemoryStream();
  yield* runEntry(third, SETTLING);
  const whole = [...settled, ...(yield* third.readAll())];
  const closes = whole
    .map((event, at) => ({ event, at }))
    .filter((one) => one.event.type === "close");
  const last = closes[closes.length - 1];
  return projected(whole.slice(0, last.at));
}

function stateWith(over: Partial<ReplState>): ReplState {
  return Object.freeze({ ...initialState(EXECUTION), ...over });
}

/**
 * The same state with the Bindings pane selected, as activating its tab does.
 *
 * Explicit, because the command's accepted default right pane is the Sidekick:
 * a row about what the Bindings column says has to be looking at the Bindings
 * column.
 */
function inspecting(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, right: "bindings", view: undefined }),
  });
}

/** The same state selecting one entry, the way the action selects it. */
function selecting(state: ReplState, ...scopes: readonly string[]): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, scopes: Object.freeze([...scopes]) }),
  });
}

/** The same state with the History drawer over it, as the grammar refers to it. */
function opening(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze([Object.freeze({ kind: "history" as const })]),
    }),
  });
}

/** The same state with one named drawer over it, as the grammar refers to them. */
function openingDrawer(state: ReplState, drawer: ReplDrawerRef): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, drawers: Object.freeze([drawer]) }),
  });
}

/** The same state frozen at one recorded position, the way the action freezes it. */
function frozenAt(state: ReplState, marker: string): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, at: marker, inspect: true }),
  });
}

/** The action one dispatch asked for, or a failure naming what it did instead. */
function asked(dispatched: ReplDispatched<ReplAction>): ReplAction {
  if (dispatched.outcome !== "action") {
    throw new Error(`this dispatch produced ${dispatched.outcome} rather than an action`);
  }
  return dispatched.action;
}

/** The view this state reads as, or the failure that stopped it. */
function reading(
  state: ReplState,
  model: ReplModel,
  live: ReplLive = NOTHING_LIVE,
  size: ReplTerminalSize = WIDE,
  focused?: string,
): ReplView {
  // The navigation a session would publish for this reading: every position
  // the file retained, with the head it is standing at. Derived from the
  // model here because these cases build the model directly rather than
  // running a session.
  const resolved = viewFor(
    state,
    model,
    live,
    size,
    focused,
    navigationOf(model.checkpoints, model.settled ? "settled" : "unfinished"),
  );
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.value;
}

/** Where one mounted row landed, or a failure naming the row that is missing. */
function placed(observed: Observed, key: string): ReplBounds {
  const bounds = observed.boundsOf(key);
  if (bounds === undefined) {
    throw new Error(`this frame drew no ${key}; it drew ${observed.keys.slice(0, 40).join(", ")}`);
  }
  return bounds;
}

/**
 * The style of the first cell one row actually put a character in.
 *
 * The first *written* cell, not the first cell of the rectangle: every row of
 * this product is indented by its own marker, and the leading blanks carry the
 * surface without carrying the foreground.
 */
function inkOf(grid: TerminalGrid, bounds: ReplBounds): CellStyle {
  for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    if (grid.at(x, bounds.y) !== " ") {
      return grid.styleAt(x, bounds.y);
    }
  }
  throw new Error(`nothing was written in the row at ${bounds.x},${bounds.y}`);
}

/** The text one row holds, with no attributes in it. */
function textOf(grid: TerminalGrid, bounds: ReplBounds): string {
  return grid.textIn(bounds)[0] ?? "";
}

/** The sidebar the catalog is drawn in. */
function sidebarRegion(observed: Observed): ReplBounds {
  const bounds = regionBounds(observed, "sidebar");
  if (bounds === undefined) {
    throw new Error("this frame published no sidebar region");
  }
  return bounds;
}

/** Whether one rectangle is inside another, so a row can be held to its pane. */
function within(inner: ReplBounds, outer: ReplBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * One subordinate row, as the frame drew it.
 *
 * Before #881 PR 2 this was a transcript record row — a fact about the event
 * that produced the output beside it. The transcript now holds the entry's
 * reading, so the subordinate reading is taken from a row that still carries
 * it: what the frame says where it has nothing retained to list.
 */
function metadataKey(observed: Observed): string {
  const key = observed.keys.find((one) => one === "sessions:empty");
  if (key === undefined) {
    throw new Error(`this frame drew no subordinate row; it drew ${observed.keys.join(", ")}`);
  }
  return key;
}

/** Every mounted row whose cells carry the focus foreground. */
function focusedRows(observed: Observed, grid: TerminalGrid): string[] {
  const found: string[] = [];
  for (const key of observed.keys) {
    const bounds = observed.boundsOf(key);
    if (bounds === undefined) {
      continue;
    }
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      if (grid.at(x, bounds.y) === " ") {
        continue;
      }
      if (grid.styleAt(x, bounds.y).foreground === REPL_PALETTE.focus) {
        found.push(key);
      }
      break;
    }
  }
  return found;
}

/** The key holding focus now, as the program reads it into the next view. */
function focusKeyOf(presenter: Presenter): string | undefined {
  const node = presenter.tree.focused();
  return node === undefined ? undefined : presenter.tree.keyOf(node);
}

/** Move focus until it reaches one key, or say where it got to instead. */
function* focusOn(presenter: Presenter, key: string, limit = 400): Operation<void> {
  const visited: string[] = [];
  for (let step = 0; step < limit; step += 1) {
    const moved = yield* presenter.tree.dispatch({ kind: "key", key: "Tab" });
    if (!moved.ok || moved.value.outcome !== "focus" || moved.value.focused === undefined) {
      break;
    }
    const at = presenter.tree.keyOf(moved.value.focused);
    if (at === key) {
      return;
    }
    if (at === undefined || visited.includes(at)) {
      break;
    }
    visited.push(at);
  }
  throw new Error(`Tab never reached ${key}; it visited ${visited.join(", ")}`);
}

/**
 * What the three accepted profiles look like, and nothing else.
 *
 * One recorded input, three stored records, and a comparison that reports rows
 * and style runs a person can read. No route, ancestry, target list or box id
 * is asserted here: those are the behaviour tiers' own subject, and a screen
 * that drew the accepted words in the accepted inks over the wrong tree is a
 * failure those tiers catch, in their own language.
 */
describe("REPL appearance - reviewed shipping profiles", () => {
  for (const profile of ["160x36", "120x30", "72x20"] as const) {
    it(`${profile}: every row and style run is the reviewed record's`, function* () {
      const record = yield* appearanceRecord(profile);
      const journal = yield* appearanceJournal();
      // The record says which input it describes, and this is that input. A
      // record left behind by a re-recording fails here, on the digest, rather
      // than further down as a row that stopped matching.
      expect([profile, record.input.journalSha256]).toEqual([profile, journal.sha256]);
      const model = yield* appearanceModel();
      const size = sizeOf(record);
      yield* scoped(function* (): Operation<void> {
        const presenter = yield* usePresenter(size);
        const frame = yield* commitCheckpoint(presenter, {
          model,
          size,
          workspace: workspaceOf(model, CHECKPOINT_SIDEKICK),
        });
        const screen = screenOf(presenter.grid, size);
        const found = differences(record, screen.rows, screen.runs);
        if (found.length > 0) {
          throw new Error(
            [
              `${profile}: ${found.length} difference(s) from the reviewed record`,
              `expected data ${record.expectedSha256}, input ${record.input.journalSha256}`,
              ...found.slice(0, 12),
            ].join("\n"),
          );
        }
        // The record describes a screen whose Draft took focus on its own.
        expect([profile, frame.focused]).toEqual([profile, record.input.focused]);
        expect([profile, screen.rows.length]).toEqual([profile, record.size.rows]);
      });
    });
  }
});

/**
 * What the recorded input actually is, before anything is drawn from it.
 *
 * The first recording of this journal was taken without the compiler
 * installed: every eval closed `err` with "compiler not installed", the first
 * entry settled nothing, and the nested child was never imported. The records
 * drawn from it were a consistent description of a broken reading. This says
 * what the reading has to be — a first entry that completed, a second still
 * running, and the nested scope the second one admits — so a journal that
 * loses it fails here, where the message is about the input.
 */
describe("REPL appearance - the recorded input", () => {
  it("the journal parses, settles its first entry and admits the nested Checklist", function* () {
    const journal = yield* appearanceJournal();
    expect(journal.events.length).toBeGreaterThan(0);
    const model = yield* appearanceModel();

    // Two entries: the first completed, the second has not closed.
    expect(model.entries.map((one) => one.terminal?.status ?? "unfinished")).toEqual([
      "ok",
      "unfinished",
    ]);
    // The first one's own output is there, which is what it closed `ok` with.
    const settled = model.entries[0];
    expect({ key: settled.key, outcome: settled.terminal?.status }).toEqual({
      key: settled.key,
      outcome: "ok",
    });
    // And the running entry admitted its nested child: one scope checkpoint,
    // belonging to the second entry, from a component this journal really
    // imported. Recorded without the compiler, that import never happened and
    // there was no scope to select.
    const scopes = model.checkpoints.filter((one) => one.kind === "scope");
    expect({
      scopes: scopes.length,
      of: scopes.every((one) => one.marker.startsWith(`${model.entries[1].key}:`)),
      imported: journal.events.some(
        (event) =>
          event.type === "yield" &&
          event.description.type === "import_component" &&
          event.description.name === "Checklist",
      ),
    }).toEqual({ scopes: 1, of: true, imported: true });

    // Every record describes this journal and no other.
    for (const profile of ["160x36", "120x30", "72x20"] as const) {
      const record = yield* appearanceRecord(profile);
      expect([profile, record.input.journalSha256]).toEqual([profile, journal.sha256]);
    }
  });

  /**
   * A record is parsed, so the shapes it could have lost are refused.
   *
   * The members a reader reaches for are the ones worth naming: a null where a
   * member should be, a number where a string should be, a run missing its
   * width. Each of these is a record that would otherwise be handed on with a
   * type written over it and fail later as a row that did not match.
   */
  it("a malformed record is refused by name rather than read as one", function* () {
    const sound = JSON.parse(
      yield* readTextFile(
        fileURLToPath(new URL("./fixtures/repl/appearance/72x20.json", import.meta.url)),
      ),
    );
    const broken: readonly { readonly what: string; readonly make: () => unknown }[] = [
      { what: "a null input", make: () => ({ ...sound, input: null }) },
      {
        what: "a null member of the input",
        make: () => ({ ...sound, input: { ...sound.input, journalSha256: null } }),
      },
      {
        what: "an authority value that is not a string",
        make: () => ({ ...sound, authority: { ...sound.authority, reviewedCapture: 7 } }),
      },
      { what: "a null size", make: () => ({ ...sound, size: null }) },
      {
        what: "a size whose columns went missing",
        make: () => ({ ...sound, size: { rows: sound.size.rows } }),
      },
      {
        what: "a style line that is not an object",
        make: () => ({ ...sound, styleRuns: [...sound.styleRuns.slice(1), "line"] }),
      },
      {
        what: "a run missing its width",
        make: () => ({
          ...sound,
          styleRuns: sound.styleRuns.map((line: { y: number; runs: unknown[] }, at: number) =>
            at === 0
              ? {
                  y: line.y,
                  runs: line.runs.map((run) => ({ ...(run as object), width: undefined })),
                }
              : line,
          ),
        }),
      },
      { what: "rows that are not strings", make: () => ({ ...sound, rows: [1, 2, 3] }) },
      { what: "a row count the size does not agree with", make: () => ({ ...sound, rows: [] }) },
    ];
    for (const one of broken) {
      let refused: unknown;
      try {
        readAppearanceRecord("72x20", JSON.stringify(one.make()));
      } catch (error) {
        refused = error;
      }
      expect({ what: one.what, refused: refused instanceof Error }).toEqual({
        what: one.what,
        refused: true,
      });
    }
    // And the record on disk is read without complaint.
    expect(readAppearanceRecord("72x20", JSON.stringify(sound)).profile).toBe("72x20");
  });
});

describe("REPL presentation: what one row's cells say it is", () => {
  beforeAll(() => useTempFileCompiler());

  it("G1: output, metadata and the two outcomes are four different readings", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    // The entry whose result is under test, selected: a reading belongs to an
    // entry, so which entry is being read is part of asking what it says.
    const observed = yield* presenter.commit(
      reading(selecting(stateWith({}), model.entries[0].key), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;

    const transcript = regionBounds(observed, "transcript");
    if (transcript === undefined) {
      throw new Error("this frame published no transcript region");
    }

    // What the run produced, and a fact about the event that produced it.
    //
    // Re-anchored for #881 PR 2. These were adjacent transcript rows written by
    // one eval block; the transcript now holds the entry's *reading* — its
    // output and then its source — and the facts about events are the inspection
    // column's. The claim is unchanged: a result and a fact about the event that
    // produced it are two readings, and nothing but the style says which is
    // which.
    const output = placed(observed, "reading:output:0");
    const said = model.entries[0].terminal?.output.split("\n")[0] ?? "";
    expect(said.length).toBeGreaterThan(0);
    const metadata = placed(observed, metadataKey(observed));
    expect(inkOfSpan(grid, output, said).foreground).toBe(REPL_PALETTE.output);
    expect(inkOf(grid, metadata).foreground).toBe(REPL_PALETTE.muted);
    expect(inkOfSpan(grid, output, said).foreground).not.toBe(inkOf(grid, metadata).foreground);
    expect(within(output, transcript)).toBe(true);
    expect(within(metadata, sidebarRegion(observed))).toBe(true);

    // The two outcomes the file recorded, in the catalog that promises them.
    const sidebar = regionBounds(observed, "sidebar");
    if (sidebar === undefined) {
      throw new Error("this frame published no sidebar region");
    }
    const settled = placed(observed, "entry:entry-1");
    const failed = placed(observed, "entry:entry-2");
    expect(textOf(grid, settled)).toContain("[ok]");
    expect(textOf(grid, failed)).toContain("[err]");
    expect(inkOf(grid, settled).foreground).toBe(REPL_PALETTE.success);
    expect(inkOf(grid, failed).foreground).toBe(REPL_PALETTE.failure);
    expect(within(settled, sidebar)).toBe(true);
    expect(within(failed, sidebar)).toBe(true);

    // Four distinct readings, and the words survive without any of them.
    const colours = [
      inkOfSpan(grid, output, said).foreground,
      inkOf(grid, metadata).foreground,
      inkOf(grid, settled).foreground,
      inkOf(grid, failed).foreground,
    ];
    expect(new Set(colours).size).toBe(4);
  });

  it("G1: a settled document's recorded result is output, not an outcome", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);

    // The root really did record a result, so the rows under test are the
    // rendered document rather than the word the root closed with.
    const settled = model.entries[0];
    const at = settled.transcript.findIndex((row) => row.kind === "terminal");
    const record = settled.transcript[at];
    if (record === undefined || record.kind !== "terminal") {
      throw new Error("this entry recorded no root close");
    }
    expect(record.status).toBe("ok");
    expect(record.output.length).toBeGreaterThan(0);

    // Selected, and with nothing live: the only copy of this text on the screen
    // is the durable one, so a bright live overlay cannot stand in for it.
    const observed = yield* presenter.commit(
      reading(selecting(stateWith({}), settled.key), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;
    // Re-anchored for #881 PR 2: the entry's result is the Output half of its
    // reading rather than a transcript row keyed by the record's position. The
    // claim is unchanged — the rendered document reads as output, and not as the
    // word the root closed with.
    const first = placed(observed, "reading:output:0");
    const said = record.output.split("\n")[0];
    expect(textOf(grid, first)).toContain(said);
    // The text's own ink, not the row's first cell: every reading row opens
    // with its rail, which says which region the row is in rather than what the
    // row is.
    expect(inkOfSpan(grid, first, said).foreground).toBe(REPL_PALETTE.output);
    expect(inkOfSpan(grid, first, said).foreground).not.toBe(REPL_PALETTE.success);
    // And it is labelled as the retained result rather than as live text.
    expect(textOf(grid, placed(observed, "reading:caption:output"))).toContain("Output");
    expect(textOf(grid, placed(observed, "reading:caption:output"))).not.toContain("live");

    // The outcome keeps its accent where an outcome is what is shown.
    expect(inkOf(grid, placed(observed, `entry:${settled.key}`)).foreground).toBe(
      REPL_PALETTE.success,
    );
  });

  it("G1: a root that recorded no result shows its outcome and its reason", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);

    const failed = model.entries[1];
    const at = failed.transcript.findIndex((row) => row.kind === "terminal");
    const record = failed.transcript[at];
    if (record === undefined || record.kind !== "terminal") {
      throw new Error("this entry recorded no root close");
    }
    expect(record.status).toBe("err");
    expect(record.output).toBe("");

    const observed = yield* presenter.commit(
      reading(selecting(stateWith({}), failed.key), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;
    // With nothing recorded to show, the outcome itself is the row, and it keeps
    // the outcome accent; the reason recorded beside it is its own row.
    // Re-anchored for #881 PR 2 onto the reading's Output half; both claims and
    // both accents are unchanged, and the caption now says that the absence of
    // rendered text is what is being reported.
    expect(textOf(grid, placed(observed, "reading:caption:output"))).toContain(
      "No rendered output.",
    );
    const closed = placed(observed, "reading:output:outcome:0");
    expect(textOf(grid, closed)).toContain("closed err");
    expect(inkOfSpan(grid, closed, "closed err").foreground).toBe(REPL_PALETTE.failure);
    const reason = placed(observed, "reading:output:reason:0");
    expect(textOf(grid, reason)).toContain("failed:");
    expect(inkOfSpan(grid, reason, "failed:").foreground).toBe(REPL_PALETTE.failure);
  });

  it("G1: an entry that never closed reads as waiting, and says so", function* () {
    const model = yield* settledFailedAndRunning();
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(
      reading(stateWith({}), model, streaming("building the plan")),
    );
    const { grid } = presenter;

    const running = placed(observed, "entry:entry-3");
    expect(textOf(grid, running)).toContain("[unfinished]");
    expect(inkOf(grid, running).foreground).toBe(REPL_PALETTE.waiting);
    expect(inkOf(grid, running).foreground).not.toBe(
      inkOf(grid, placed(observed, "entry:entry-1")).foreground,
    );

    // The overlay is what this process is producing, so it reads as output
    // rather than as one more fact about an event. Re-anchored for #881 PR 2
    // onto the reading's Output half, which now also says it is still arriving.
    const live = placed(observed, "reading:output:live:0");
    expect(textOf(grid, live)).toContain("building the plan");
    expect(inkOfSpan(grid, live, "building the plan").foreground).toBe(REPL_PALETTE.output);
    expect(textOf(grid, placed(observed, "reading:caption:output"))).toContain("live");
  });

  it("G1: an empty screen's placeholders are subordinate, and the draft is a surface", function* () {
    const model = yield* scoped(function* () {
      const physical = new InMemoryStream();
      return projected(yield* physical.readAll());
    });
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(reading(stateWith({}), model));
    const { grid } = presenter;

    const none = placed(observed, "entry:none");
    expect(textOf(grid, none)).toContain("(not submitted)");
    expect(inkOf(grid, none).foreground).toBe(REPL_PALETTE.muted);
    const empty = placed(observed, "sessions:empty");
    expect(inkOf(grid, empty).foreground).toBe(REPL_PALETTE.muted);

    // The draft is where typing goes, so the whole row it was measured at
    // carries its own surface — blank cells included, which is the half a
    // foreground could never show.
    const draft = placed(observed, "footer:input");
    expect(draft.width).toBe(WIDE.columns);
    for (let x = draft.x; x < draft.x + draft.width; x += 1) {
      expect(grid.styleAt(x, draft.y).background).toBe(REPL_PALETTE.draftSurface);
    }
    // The guidance above it is prose rather than metadata, and reads as prose.
    expect(inkOf(grid, placed(observed, "guidance")).foreground).toBe(REPL_PALETTE.source);
  });

  it("G1: the History band keeps its own surface and accent at every size", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      yield* scoped(function* () {
        const presenter = yield* usePresenter(size);
        const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, size));
        const band = observed.regionOf("box:footer:band");
        if (band === undefined) {
          throw new Error(`the ${size.columns}x${size.rows} frame published no History band`);
        }
        expect(band.height).toBe(5);
        const row = placed(observed, "footer:input").y - band.height;
        expect(band.y).toBe(row);
        // Re-anchored for #881 PR 3: the band was one accent and is now a
        // rail whose cells say what each of them is — the title, the rule,
        // an entry mark, a minor mark, the selection, the head. The claim is
        // the same and is why either exists: every cell in this band is the
        // band's own, and nothing foreign is painted here.
        const own = new Set<number>([
          REPL_PALETTE.historyTitle,
          REPL_PALETTE.historyRail,
          REPL_PALETTE.historyEntryEarlier,
          REPL_PALETTE.historyTickEarlier,
          REPL_PALETTE.historyMinorEarlier,
          REPL_PALETTE.historyEntryLater,
          REPL_PALETTE.historyMinorLater,
          REPL_PALETTE.historySelected,
          REPL_PALETTE.historyHeadLive,
          REPL_PALETTE.historyHead,
        ]);
        for (const written of presenter.grid.nonblank(band)) {
          const [at] = written.split("=");
          const [x, y] = at.split(",").map(Number);
          const ink = presenter.grid.styleAt(x, y).foreground;
          expect([at, ink !== undefined && own.has(ink)]).toEqual([at, true]);
        }
        for (let x = band.x; x < band.x + band.width; x += 1) {
          expect(presenter.grid.styleAt(x, band.y).background).toBe(REPL_PALETTE.historySurface);
        }
      });
    }
  });
});

describe("REPL presentation: selection and focus are two different facts", () => {
  beforeAll(() => useTempFileCompiler());

  it("G2: a selected entry stays selected while focus is somewhere else", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = selecting(stateWith({}), "entry-1");

    // One commit to mount the tree, so there is something for Tab to move
    // through, and a second to draw what that move settled.
    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "sessions:heading");
    // Carried into the next view the way the program carries it: a view that
    // said nothing held focus would let the draft claim it straight back.
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const selected = placed(observed, "entry:entry-1");
    const unselected = placed(observed, "entry:entry-2");
    // Across the whole row the frame measured, blanks included: a selection
    // that stopped where the label stopped would be half a selection.
    for (let x = selected.x; x < selected.x + selected.width; x += 1) {
      expect(grid.styleAt(x, selected.y).background).toBe(REPL_PALETTE.selectedSurface);
    }
    expect(grid.styleAt(unselected.x, unselected.y).background).not.toBe(
      REPL_PALETTE.selectedSurface,
    );

    // Focus is elsewhere, so the selected row keeps its own outcome colour and
    // exactly one mounted row carries the focus foreground.
    expect(inkOf(grid, selected).foreground).toBe(REPL_PALETTE.success);
    expect(focusedRows(observed, grid)).toEqual(["sessions:heading"]);
    const heading = placed(observed, "sessions:heading");
    expect(inkOf(grid, heading).foreground).toBe(REPL_PALETTE.focus);
    expect(inkOf(grid, heading).attrs).toContain(BOLD);

    // And the whole reading survives with the colour thrown away.
    expect(textOf(grid, selected)).toContain("*");
    expect(textOf(grid, selected)).toContain("[ok]");
    expect(textOf(grid, unselected)).not.toContain("*");
    expect(textOf(grid, heading).trimStart().startsWith(">")).toBe(true);
  });

  it("G2: focus moving onto the selected row leaves its selection alone", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = selecting(stateWith({}), "entry-1");

    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "entry:entry-1");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const selected = placed(observed, "entry:entry-1");
    // The foreground is focus's; the surface is still selection's.
    expect(inkOf(grid, selected).foreground).toBe(REPL_PALETTE.focus);
    expect(inkOf(grid, selected).attrs).toContain(BOLD);
    for (let x = selected.x; x < selected.x + selected.width; x += 1) {
      expect(grid.styleAt(x, selected.y).background).toBe(REPL_PALETTE.selectedSurface);
    }
    expect(focusedRows(observed, grid)).toEqual(["entry:entry-1"]);
    expect(textOf(grid, selected)).toContain("*");
  });

  it("G2: a pointer and Enter on one row ask for the same thing", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(reading(stateWith({}), model));

    const bounds = placed(observed, "entry:entry-2");
    const node = observed.nodeOf("entry:entry-2");
    if (node === undefined) {
      throw new Error("this frame mounted no node for entry-2");
    }
    const pointed = yield* presenter.tree.dispatch({
      kind: "pointer",
      target: observed.committed.rendered.map.at(bounds.x, bounds.y) ?? "",
      frame: observed.committed.rendered.tree,
    });
    yield* focusOn(presenter, "entry:entry-2");
    const pressed = yield* presenter.tree.dispatch({ kind: "key", key: "Enter" });
    if (!pointed.ok || !pressed.ok) {
      throw new Error("one of the two activations was refused");
    }
    expect(observed.committed.rendered.map.at(bounds.x, bounds.y)).toBe(node);
    expect(asked(pointed.value)).toEqual(asked(pressed.value));
  });
});

describe("REPL presentation: what an updated frame leaves behind", () => {
  beforeAll(() => useTempFileCompiler());

  it("G5: a long reading, then a short one, then a closed drawer, is fresh-C", function* () {
    const model = yield* settledAndFailed();
    const closed = selecting(stateWith({}), "entry-1");

    /** The whole terminal, every cell with its character and its style. */
    const whole = (grid: TerminalGrid, size: ReplTerminalSize): readonly string[] =>
      grid.styledIn({ x: 0, y: 0, width: size.columns, height: size.rows });

    // A: long labels, a long stream and the pausable action row. B: the short
    // versions of all three. C: a drawer opened wide, taken to narrow, brought
    // back wide, and closed.
    const incremental = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      yield* presenter.commit(
        reading(
          selecting(stateWith({ draft: "a".repeat(240) }), "entry-2"),
          model,
          streaming(`${"streaming a very long line of output ".repeat(6)}\nand another`),
          WIDE,
        ),
      );
      yield* presenter.commit(reading(stateWith({ draft: "b" }), model, streaming("short"), WIDE));
      const history = opening(closed);
      yield* presenter.commit(reading(history, model, NOTHING_LIVE, WIDE));
      presenter.resize(NARROW);
      yield* presenter.commit(reading(history, model, NOTHING_LIVE, NARROW));
      presenter.resize(WIDE);
      yield* presenter.commit(reading(history, model, NOTHING_LIVE, WIDE));
      const last = yield* presenter.commit(reading(closed, model, NOTHING_LIVE, WIDE));
      return { cells: whole(presenter.grid, WIDE), observed: last };
    });

    const fresh = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      const last = yield* presenter.commit(reading(closed, model, NOTHING_LIVE, WIDE));
      return { cells: whole(presenter.grid, WIDE), observed: last };
    });

    // Characters, foregrounds, backgrounds and blanks alike: a cell the
    // shortened row no longer reaches has to have been erased, and only a
    // comparison that carries the blanks can say so.
    expect(incremental.cells).toEqual(fresh.cells);
    expect(incremental.observed.keys.slice().sort()).toEqual(fresh.observed.keys.slice().sort());
    // The drawer went with its branch: nothing it mounted is still a target.
    expect(
      fresh.observed.targets.some((target) =>
        (fresh.observed.committed.manifest.root.key ?? "").startsWith("drawer:"),
      ),
    ).toBe(false);
    expect(incremental.observed.keys.some((key) => key.startsWith("drawer:"))).toBe(false);
  });

  it("G5: an open drawer's interior is opaque inside the bounds the engine gave it", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const base = selecting(stateWith({}), "entry-1");

    // Something long behind it, so a transparent interior would be visible as
    // the transcript rather than as blank cells.
    yield* presenter.commit(
      reading(base, model, streaming(`${"behind the modal ".repeat(9)}\n`.repeat(4)), WIDE),
    );
    const history = opening(base);
    const observed = yield* presenter.commit(reading(history, model, NOTHING_LIVE, WIDE));
    const rect = regionBounds(observed, "drawer");
    if (rect === undefined) {
      throw new Error("this frame published no drawer region");
    }
    // The columns and the bottom edge this drawer has always had, stated; its
    // top is where the accepted envelope put it, which is below the guidance
    // this layer must not cover and is therefore the frame's own answer rather
    // than a number written here. The opacity claim below is unchanged: it
    // reads whatever rectangle the engine gave.
    expect([rect.x, rect.width, rect.y + rect.height]).toEqual([20, 120, 26]);
    const above = placed(observed, "guidance");
    expect(rect.y).toBeGreaterThanOrEqual(above.y + above.height);

    // Every cell of the rectangle carries the drawer's own surface. The ones
    // the drawer wrote nothing in are the ones that matter: those are where
    // the transcript would otherwise still be showing.
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const style = presenter.grid.styleAt(x, y);
        // Any of this palette's own surfaces, and never the terminal default:
        // what the rectangle must not show is whatever is behind it.
        const surfaces: readonly number[] = [
          REPL_PALETTE.drawerSurface,
          REPL_PALETTE.selectedSurface,
          REPL_PALETTE.historySurface,
          REPL_PALETTE.fieldSurface,
          REPL_PALETTE.draftSurface,
        ];
        const surfaced = style.background !== undefined && surfaces.includes(style.background);
        if (!surfaced) {
          throw new Error(
            `the cell at ${x},${y} is inside the drawer and carries ${String(style.background)}`,
          );
        }
      }
    }

    // And nothing outside it was repainted into the modal's surface.
    const viewport = viewportBounds(observed, "sessions");
    if (viewport === undefined) {
      throw new Error("this frame published no sessions viewport");
    }
    for (let y = viewport.y; y < viewport.y + viewport.height; y += 1) {
      for (let x = viewport.x; x < Math.min(viewport.x + viewport.width, rect.x); x += 1) {
        expect(presenter.grid.styleAt(x, y).background).not.toBe(REPL_PALETTE.drawerSurface);
      }
    }
  });

  it("G5: the grid it all rests on retains the attributes a cell was written under", function* () {
    // A control, so a defect in the replay cannot be mistaken for a defect in
    // the product: these are the exact sequences this renderer emits.
    const grid = createGrid();
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    grid.apply(
      encode("\u001B[0m\u001B[1m\u001B[38;2;127;211;232m\u001B[48;2;18;32;38m\u001B[1;1Hab"),
    );
    expect(grid.styleAt(0, 0)).toEqual({
      foreground: REPL_PALETTE.focus,
      background: REPL_PALETTE.selectedSurface,
      attrs: [BOLD],
    });
    // A reset drops the foreground and the weight and leaves the background the
    // sequence after it restates, which is exactly how a padded row arrives.
    grid.apply(encode("\u001B[0m\u001B[48;2;18;32;38m\u001B[1;3H c"));
    expect(grid.styleAt(2, 0)).toEqual({
      foreground: undefined,
      background: REPL_PALETTE.selectedSurface,
      attrs: [],
    });
    expect(grid.at(3, 0)).toBe("c");
    expect(grid.styledIn({ x: 0, y: 0, width: 2, height: 1 })).toEqual([
      "a|7fd3e8|122026|1 b|7fd3e8|122026|1",
    ]);
  });
});

describe("REPL presentation: the panes a reading is laid out in", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1: each shared column is named, and says so while it is empty", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      const presenter = yield* usePresenter(size);
      // Nothing selected and nothing live: the Bindings column holds no row at
      // all, which is exactly the state a pane that named itself only when full
      // would read as a gap.
      const observed = yield* presenter.commit(
        reading(inspecting(stateWith({})), model, NOTHING_LIVE, size),
      );
      const { grid } = presenter;

      const transcript = placed(observed, "transcript:heading");
      // The right column is named by its two tabs, which are its header: the
      // selected one is the name of what is in the column, and the other names
      // what the column can be turned to. Each appears once.
      const bindings = placed(observed, "tab:bindings");
      const sidekick = placed(observed, "tab:sidekick");
      expect(textOf(grid, transcript).trim()).toBe("Transcript");
      expect(textOf(grid, bindings).trim()).toBe("Bindings");
      expect(textOf(grid, sidekick).trim()).toBe("Sidekick");
      expect(inkOf(grid, transcript).attrs).toContain(BOLD);
      expect(inkOf(grid, bindings).attrs).toContain(BOLD);

      // One row, in that order, and two boxes that do not overlap: a pointer
      // aimed at a name reaches the tab bearing it.
      expect([bindings.y, sidekick.y]).toEqual([bindings.y, bindings.y]);
      expect(sidekick.x).toBeGreaterThanOrEqual(bindings.x + bindings.width);
      // Said once each. The right header is these two rows and nothing above
      // them, so neither name is repeated by a title of the column's own.
      expect(observed.keys).not.toContain("inspection:heading");
      for (const name of ["Bindings", "Sidekick"]) {
        const band = observed.regionOf(TAB_ROW);
        if (band === undefined) {
          throw new Error("this frame published no tab row");
        }
        expect([name, textOf(grid, band).split(name).length - 1]).toEqual([name, 1]);
      }

      // The transcript's name is something you read; the tabs are controls, and
      // being the column's heading does not stop them selecting it.
      expect(
        observed.targets.some((target) => target.node === observed.nodeOf("transcript:heading")),
      ).toBe(false);
      for (const key of ["tab:bindings", "tab:sidekick"]) {
        expect([key, observed.targets.some((one) => one.node === observed.nodeOf(key))]).toEqual([
          key,
          true,
        ]);
      }
    }
  });

  it("P1: a narrow frame has no pane to name, and names none", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(NARROW);
    const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, NARROW));
    // The two surface controls are the narrow frame's own headings; a pane title
    // described here would be mounted and placed nowhere.
    expect(observed.keys).toContain("sessions:heading");
    expect(observed.keys).toContain("entries:heading");
    expect(observed.keys).not.toContain("transcript:heading");
    // And no tab row either: the right column's header is the two tabs, and a
    // narrow frame has no right column to head.
    expect(observed.keys).not.toContain("tab:bindings");
    expect(observed.keys).not.toContain("tab:sidekick");
  });

  it("P1: a row is built to the inside of its pane, not to the pane", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(
        reading(selecting(stateWith({}), "entry-1"), model, NOTHING_LIVE, size),
      );

      for (const region of ["transcript", "inspection"] as const) {
        const outer = regionBounds(observed, region);
        const inside = observed.regionOf(`box:${region}:content`);
        if (outer === undefined || inside === undefined) {
          throw new Error(`the ${size.columns}x${size.rows} frame published no ${region} pane`);
        }
        // The edge is part of the pane and not part of the room in it.
        expect(inside.width).toBeLessThan(outer.width);
        expect(inside.x).toBeGreaterThan(outer.x - 1);
        // And every row of that pane is built to the room the pane has — a row
        // sized from the outer bound would reach into the column beside it.
        //
        // Re-anchored for the accepted body gutter, which the Transcript now
        // shares with the Sidekick: each column's body is inset two cells on
        // each side, so the rows under a heading are the inside less the gutter
        // while the heading band itself spans the inside. Both are measured, and
        // a row narrower than its pane begins at the gutter rather than adrift
        // somewhere inside it.
        const inset = inside.width - BODY_GUTTER * 2;
        for (const key of observed.keys) {
          const bounds = observed.boundsOf(key);
          if (bounds === undefined || !within(bounds, inside)) {
            continue;
          }
          // The two tabs share one row, so each is built to its own label
          // instead of to the column. `within` is what keeps that honest: a tab
          // sized from the outer bound would reach past the pane, and one given
          // the whole inside would cover the other.
          if (key.startsWith("tab:")) {
            expect([region, key, bounds.width < inside.width]).toEqual([region, key, true]);
            continue;
          }
          expect([region, key, bounds.width === inside.width || bounds.width === inset]).toEqual([
            region,
            key,
            true,
          ]);
          if (bounds.width !== inside.width) {
            expect([region, key, bounds.x]).toEqual([region, key, inside.x + BODY_GUTTER]);
          }
        }
      }
    }
  });

  it("P2 kernel: the footer keeps seven rows, and the draft says what it is", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const presenter = yield* usePresenter(size);
      const drafted = Object.freeze({
        ...stateWith({}),
        draft: "first line\nsecond line\nthird line",
      });
      // Twice: the draft claims focus on the first frame and the cue it renders
      // is the view's, which is one frame behind the tree that settled it.
      yield* presenter.commit(reading(drafted, model, NOTHING_LIVE, size));
      const observed = yield* presenter.commit(
        reading(drafted, model, NOTHING_LIVE, size, focusKeyOf(presenter)),
      );
      const { grid } = presenter;

      const footer = regionBounds(observed, "footer");
      if (footer === undefined) {
        throw new Error("this frame published no footer");
      }
      expect(footer.height).toBe(FOOTER_ROWS);

      // One row, the full width, and the count of what is not on it.
      const draft = placed(observed, "footer:input");
      expect(draft.height).toBe(1);
      expect(draft.width).toBe(size.columns);
      const text = textOf(grid, draft);
      expect(text.startsWith(">> Draft: ")).toBe(true);
      expect(text).toContain("[2 lines] third line");

      // The band keeps its own five rows and now says which band it is.
      const band = observed.regionOf("box:footer:band");
      if (band === undefined) {
        throw new Error("this frame published no History band");
      }
      expect(band.height).toBe(HISTORY_ROWS);
      expect(textOf(grid, band).startsWith(HISTORY_TITLE)).toBe(true);
    }
  });

  it("P2 kernel: the draft is marked unfocused when focus is elsewhere", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = selecting(stateWith({ draft: "typed" }), "entry-1");
    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "entries:heading");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const text = textOf(presenter.grid, placed(observed, "footer:input"));
    expect(text.startsWith(" > Draft: typed")).toBe(true);
  });

  it("P3: the dedicated location is drawn nowhere and reserves nothing", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      const presenter = yield* usePresenter(size);
      // A long multiline draft makes the canonical location longer than any row,
      // so a frame that still reserved room for it could not hide that.
      const state = Object.freeze({
        ...selecting(stateWith({}), "entry-1"),
        draft: "a long draft line\n".repeat(12),
      });
      const view = reading(state, model, NOTHING_LIVE, size);
      const observed = yield* presenter.commit(view);

      // The route still exists and still encodes exactly as it did.
      expect(view.location).toBe(encodeLocation(view.state.route));
      expect(view.location.startsWith("xmd://repl/")).toBe(true);

      // It is simply not on the screen: no candidate, no cell, no row.
      expect(observed.keys.filter((key) => key.startsWith("location:"))).toEqual([]);
      for (const row of presenter.grid.rows()) {
        expect(row).not.toContain("xmd://");
      }
      // And nothing was left blank where it used to be: the first body row is
      // the pane's own plus the accepted gap above its heading, which only
      // holds if no row was reserved for the location on top of that.
      const first =
        size === NARROW ? placed(observed, "guidance") : placed(observed, "transcript:heading");
      const body = regionBounds(observed, size === NARROW ? "content" : "transcript");
      if (body === undefined) {
        throw new Error("this frame published no body region");
      }
      // The narrow outlet heads no shared column and takes no gap.
      expect(first.y).toBe(body.y + (size === NARROW ? 0 : COLUMN_TOP_GAP));
    }
  });
});

describe("REPL presentation: what a drawer says it is showing", () => {
  beforeAll(() => useTempFileCompiler());

  it("D1: a binding drawer names the kind of reading and the binding", function* () {
    const model = yield* settledAndFailed();
    const binding = model.entries[0]?.bindings[0];
    if (binding === undefined) {
      throw new Error("this entry published no binding to inspect");
    }
    const presenter = yield* usePresenter(WIDE);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "binding",
      name: binding.name,
    });
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    const title = placed(observed, "drawer:open");
    expect(textOf(grid, title)).toContain(`Binding · ${binding.name}`);
    // A title is a heading: bold, and read rather than activated.
    expect(inkOf(grid, title).attrs).toContain(BOLD);
    expect(observed.targets.some((one) => one.node === observed.nodeOf("drawer:open"))).toBe(false);
    // The value it holds reads as the JSON it is, not as the words around it —
    // and it sits on the surface an editable value sits on, across the whole row
    // the drawer measured for it, so what holds a value is visible before it is
    // read.
    const value = placed(observed, "drawer:value:0");
    expect(textOf(grid, value).trimEnd()).toBe(JSON.stringify(binding.value, undefined, 2));
    expect(inkOf(grid, value).foreground).toBe(REPL_PALETTE.string);
    expect(inkOf(grid, value).foreground).not.toBe(REPL_PALETTE.heading);
    for (let x = value.x; x < value.x + value.width; x += 1) {
      expect(grid.styleAt(x, value.y).background).toBe(REPL_PALETTE.fieldSurface);
    }
  });

  it("D1: a recorded answer says so, and keeps the origin it came from", function* () {
    // The reference entry, which asks a question and is answered — so this
    // history really holds a retained answer to inspect.
    const model = projected(yield* referenceEvents());
    const recorded = model.entries.flatMap((entry) => entry.scope.elicitations)[0];
    if (recorded === undefined) {
      throw new Error("this history retained no answer to inspect");
    }
    const presenter = yield* usePresenter(WIDE);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "recorded-elicit",
      marker: recorded.marker,
    });
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    const title = placed(observed, "drawer:open");
    expect(textOf(grid, title)).toContain("Recorded answer · ");
    expect(textOf(grid, title)).toContain(recorded.location.slice(0, 12));
    expect(inkOf(grid, title).attrs).toContain(BOLD);

    // What was asked is a label, what was answered is a value, and the two are
    // not the same reading.
    const schema = placed(observed, "drawer:schema");
    expect(inkOf(grid, schema).attrs).toContain(BOLD);
    expect(inkOf(grid, placed(observed, "drawer:schema:0")).foreground).toBe(REPL_PALETTE.muted);

    // The answer itself is one window further on: the drawer's own top rule and
    // side inset are part of its measured rectangle, and this schema is long.
    // Reached through the window action a person presses, against the admission
    // each frame measured, so what is asserted is what a reader would see.
    let advanced = state;
    for (let press = 0; press < 40; press += 1) {
      if (presenter.last()?.boundsOf("drawer:answer:1") !== undefined) {
        break;
      }
      const view = reading(advanced, model, NOTHING_LIVE, WIDE);
      advanced = reduceRepl(
        advanced,
        { kind: "scroll", delta: 1 },
        model,
        NOTHING_LIVE,
        yield* presenter.prepare(view),
      ).state;
      yield* presenter.commit(reading(advanced, model, NOTHING_LIVE, WIDE));
    }
    const scrolled = presenter.last();
    if (scrolled === undefined) {
      throw new Error("this presenter committed no frame");
    }
    // The answer's own label, which is the second of the two readings and is
    // reached with the value it names. Asserted from the scrolled frame rather
    // than the first one: the accepted guidance-protected drawer envelope spends
    // the rows it moved down out of this window, so this label is a press
    // further on than it used to be. The claim is unchanged — what was asked is
    // a label and what was answered is a label of its own.
    expect(inkOf(grid, placed(scrolled, "drawer:answered")).attrs).toContain(BOLD);

    // Read as the JSON it is: what the answer calls its field, and the value
    // recorded under it, are two readings and neither is the muted schema.
    const recordedAnswer = placed(scrolled, "drawer:answer:1");
    expect(inkOfSpan(grid, recordedAnswer, '"decision"').foreground).toBe(REPL_PALETTE.attribute);
    expect(inkOfSpan(grid, recordedAnswer, '"approve"').foreground).toBe(REPL_PALETTE.string);
    expect(inkOfSpan(grid, recordedAnswer, '"approve"').foreground).not.toBe(REPL_PALETTE.muted);
  });

  it("D1: History names itself, and its rows keep the band's own accent", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = opening(selecting(stateWith({}), "entry-1"));
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    expect(textOf(grid, placed(observed, "drawer:open")).trim()).toBe("History");
    const marker = model.checkpoints[0];
    if (marker === undefined) {
      throw new Error("this history retained no position");
    }
    const row = placed(observed, `drawer:marker:${marker.marker}`);
    expect(inkOf(grid, row).foreground).toBe(REPL_PALETTE.historical);
  });

  it("D2: a drawer's actions sit on their own surface, and only one is focused", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const state = opening(selecting(stateWith({}), "entry-1"));
    yield* presenter.commit(reading(state, model));
    yield* focusOn(presenter, "drawer:close");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    // Every control of this drawer carries the surface a control carries, so a
    // reader can tell what acts from what explains before reading either.
    for (const key of ["drawer:scroll:up", "drawer:scroll:down", "drawer:close"]) {
      const bounds = placed(observed, key);
      expect(grid.styleAt(bounds.x, bounds.y).background).toBe(REPL_PALETTE.draftSurface);
    }
    // And exactly one of them is the one a keystroke reaches.
    expect(focusedRows(observed, grid)).toEqual(["drawer:close"]);
    expect(textOf(grid, placed(observed, "drawer:close"))).toContain("[close]");
  });

  it("D3: a recorded position reads as history, and returning live clears it", function* () {
    const events = yield* settledAndFailedJournal();
    const model = projected(events);
    const marker = model.checkpoints[0];
    if (marker === undefined) {
      throw new Error("this history retained no position");
    }

    const inspected = yield* scoped(function* (): Operation<CellStyle> {
      const presenter = yield* usePresenter(WIDE);
      const prefix = prefixAt(events, marker.marker);
      const state = frozenAt(stateWith({}), marker.marker);
      const observed = yield* presenter.commit(reading(state, prefix, NOTHING_LIVE, WIDE));
      return inkOf(presenter.grid, placed(observed, "guidance"));
    });
    // A reading of a recorded position says so in its own accent.
    expect(inspected.foreground).toBe(REPL_PALETTE.historical);

    const live = yield* scoped(function* (): Operation<CellStyle> {
      const presenter = yield* usePresenter(WIDE);
      const observed = yield* presenter.commit(
        reading(selecting(stateWith({}), "entry-1"), model, NOTHING_LIVE, WIDE),
      );
      return inkOf(presenter.grid, placed(observed, "guidance"));
    });
    // And the head reads as the head: the accent leaves with the reading.
    expect(live.foreground).toBe(REPL_PALETTE.source);
    expect(live.foreground).not.toBe(inspected.foreground);
  });
});

describe("REPL presentation: a row stays inside the pane it was measured for", () => {
  beforeAll(() => useTempFileCompiler());

  it("R3: a long reading is fitted, and the row beneath it is its own", function* () {
    // An entry submitted by its host path, which in this checkout is longer
    // than any pane the frame has room for. The engine clips nothing, so a row
    // written unbounded wraps over the cells of the row beneath it: that is the
    // artifact the complete gallery caught in the Transcript pane.
    //
    // Re-anchored for #881 PR 2. The rows under test were the transcript's
    // metadata records, bounded by shortening them; the transcript now holds
    // the entry's reading, fitted by measuring it. Both claims are kept — what
    // is drawn in a row is what that row contributed, and no row reaches the
    // pane beside it — and the case still needs a row that would overflow if
    // nothing bounded it.
    const model = yield* submittedWithLongSource();
    let exercised = false;

    for (const size of [WIDE, MEDIUM]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, size));
      const { grid } = presenter;

      // The body the reading is in, not the pane the heading spans: the
      // Transcript's rows are now inset two cells on each side, the same as the
      // Sidekick's, and what bounds a row is the box that holds it.
      const inside = observed.regionOf(TRANSCRIPT_BODY);
      const pane = observed.regionOf("box:transcript:content");
      if (inside === undefined || pane === undefined) {
        throw new Error(`the ${size.columns}x${size.rows} frame published no transcript interior`);
      }
      expect([size.columns, inside.width]).toEqual([size.columns, pane.width - BODY_GUTTER * 2]);

      const lines = observed.keys.filter((key) => key.startsWith("reading:"));

      // Every transcript row holds what its own node contributed and nothing
      // else. This is the whole discrimination: an unbounded row leaves its
      // tail on the cells of the row beneath it, so the row beneath stops
      // reading as itself before anything else goes wrong.
      for (const key of lines) {
        const bounds = placed(observed, key);
        const drawn = textOf(grid, bounds).trimEnd();
        const contributed = (observed.cells.get(key) ?? "").trimEnd();
        expect([size.columns, key, drawn]).toEqual([size.columns, key, contributed]);
      }

      // Every row of the reading, held to the body it was measured for. Each
      // one is as wide as that body and ends where it ends, so nothing of it
      // reaches the gutter beside it, let alone the pane beyond — which is what
      // the engine, left to itself, does not do.
      expect(lines.length).toBeGreaterThan(0);
      for (const key of lines) {
        const bounds = placed(observed, key);
        expect([key, bounds.width]).toEqual([key, inside.width]);
        expect([size.columns, key, bounds.x + bounds.width]).toEqual([
          size.columns,
          key,
          inside.x + inside.width,
        ]);
        // A row that is the continuation of a longer line: without the
        // measurement that cut it, that line is what would have landed on the
        // cells of the row beneath.
        if (key.startsWith("reading:src:") && key.includes("+")) {
          exercised = true;
        }
      }
    }

    // One of those rows really did fill its pane, or this proves nothing: the
    // case needs a row that would overflow if nothing bounded it.
    expect(exercised).toBe(true);
  });
});

describe("REPL presentation: the one guidance row", () => {
  beforeAll(() => useTempFileCompiler());

  it("G1: the whole guidance block is readable, and nothing of it is dropped", function* () {
    // Focus on a mounted control that is not the draft. That is the branch with
    // the most to say — the state, what Enter does here, the way back and the
    // movement hint are all in it together — and it is the branch the gallery
    // caught running out of a transcript column.
    //
    // Re-anchored for #883's accepted wrapping. This required all of those
    // words on one physical row, which the shared column no longer has room
    // for; the block now takes the rows its words need, and the claim is the
    // same claim: every direction is there, whole, and nothing is cut.
    const model = yield* settledAndFailed();

    for (const size of [WIDE, MEDIUM, NARROW]) {
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(
        reading(stateWith({}), model, NOTHING_LIVE, size, "entries:heading"),
      );
      const { grid } = presenter;

      // Every row of the block, in the order it is read.
      const rows = observed.keys
        .filter((key) => key === "guidance" || key.startsWith("guidance:row:"))
        .sort((left, right) =>
          left === "guidance" ? -1 : right === "guidance" ? 1 : left.localeCompare(right),
        )
        .map((key) => ({
          key,
          bounds: placed(observed, key),
          said: observed.cells.get(key) ?? "",
        }));
      expect([size.columns, rows.length]).toEqual([
        size.columns,
        rows.length >= 1 ? rows.length : 1,
      ]);
      const said = rows.map((one) => one.said.trim()).join(" ");

      // Each physical row fits the room it was measured for. This engine clips
      // no text, so a row longer than its own width is a row written across the
      // one beneath it.
      for (const one of rows) {
        expect([size.columns, one.key, one.said.length <= one.bounds.width]).toEqual([
          size.columns,
          one.key,
          true,
        ]);
      }

      // And the block still says everything it exists to say, each whole: the
      // state, what the focused control does, the way back to the draft and how
      // to move. No ellipsis, because nothing was cut to get here.
      expect([size.columns, said.startsWith("Ready for Entry ")]).toEqual([size.columns, true]);
      expect([size.columns, said.includes("Enter")]).toEqual([size.columns, true]);
      expect([size.columns, /Tab to (the )?draft/.test(said)]).toEqual([size.columns, true]);
      expect([size.columns, said.includes("Tab/Shift+Tab move")]).toEqual([size.columns, true]);
      expect([size.columns, said.includes("\u2026")]).toEqual([size.columns, false]);

      // At the narrow size the compact sentences already fit, so the block is
      // the one row it has always been.
      if (size.columns === NARROW.columns) {
        expect([size.columns, rows.length]).toEqual([size.columns, 1]);
      }

      // What is drawn in each row is what that row contributed, and so is every
      // transcript row beneath the block: an overlong sentence lands on the
      // cells of the row below, which is where it was seen.
      for (const one of rows) {
        expect([size.columns, one.key, grid.textIn(one.bounds)[0]?.trimEnd()]).toEqual([
          size.columns,
          one.key,
          one.said.trimEnd(),
        ]);
      }
    }
  });
});

/**
 * The frozen source example, exactly as the accepted presentation states it.
 *
 * Three lines of existing grammar: a heading, a tag with an attribute, a quoted
 * value and a reference, and a tag whose whole content is a reference. It is a
 * presentation example rather than a program — nothing here is executed — which
 * is why it is carried as a question's message and as a draft.
 */
const SOURCE_EXAMPLE: readonly string[] = Object.freeze([
  "# Create a project README",
  '<Elicit as="answers" schema={schema}>Enter the project details.</Elicit>',
  '<Plan as="draft">{answers}</Plan>',
]);

/**
 * One entry binding the frozen JSON example, and one value holding escapes.
 *
 * Bound by a real eval block in a real run, so what the inspector shows is a
 * value this Journal actually recorded and `detail()` actually serialized.
 */
const BINDING_EXAMPLE = [
  "```js eval",
  "const tokens = {",
  '  name: "Northstar",',
  "  count: 3,",
  "  approved: true,",
  "  empty: null,",
  '  quote: "say \\"hi\\" \\\\ once",',
  "};",
  "```",
  "",
].join("\n");

/** Project details, with the exact labels and hints the presentation freezes. */
const DETAILS_SCHEMA: { readonly [key: string]: Json } = {
  type: "object",
  title: "Project details",
  properties: {
    project: {
      type: "string",
      minLength: 1,
      title: "Project name",
      description: "Name your project.",
    },
    description: {
      type: "string",
      minLength: 1,
      title: "One-sentence description",
      description: "Describe its purpose.",
    },
  },
  required: ["project", "description"],
  additionalProperties: false,
};

/** One real entry whose eval block binds the frozen JSON example. */
function* boundExample(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, BINDING_EXAMPLE);
  return projected(yield* physical.readAll());
}

/**
 * Install the real provider, ask one real question, and hand back the pending
 * one.
 *
 * The provider's own question, so the form a drawer draws is the one Core
 * compiled from the request rather than a shape this file assembled.
 */
function* askingWith(
  schema: { readonly [key: string]: Json },
  message: string,
): Operation<ReplQuestion> {
  const elicitation = yield* useReplElicitation();
  yield* spawn(function* () {
    yield* Elicitation.operations.elicit({ message, schema: { ...schema } });
  });
  // The provider publishes before it suspends, so one turn is enough.
  yield* sleep(0);
  const question = elicitation.pending;
  if (question === undefined) {
    throw new Error("the provider published no question");
  }
  return question;
}

/** A live reading with one question waiting. */
function asking(question: ReplQuestion): ReplLive {
  return Object.freeze({ ...NOTHING_LIVE, question });
}

/** The same state with the live question's drawer over it and a form filled in. */
function answering(
  state: ReplState,
  values: Readonly<Record<string, string>>,
  messages: readonly ReplFormMessage[] = [],
): ReplState {
  return Object.freeze({
    ...openingDrawer(state, { kind: "live-elicit" }),
    form: Object.freeze({
      ...EMPTY_FORM,
      values: Object.freeze({ ...values }),
      messages: Object.freeze([...messages]),
    }),
  });
}

/**
 * What one stretch of a row was drawn with, found by where that stretch is.
 *
 * The whole stretch, and it has to be one colour: a span drawn half in one
 * foreground and half in another is not a classified token, and a helper that
 * returned its first cell would call that a pass. The span is located in the
 * characters the frame actually painted, so a row that drew something else has
 * no such stretch and says so.
 */
function inkOfSpan(grid: TerminalGrid, bounds: ReplBounds, span: string, from = 0): CellStyle {
  const row = textOf(grid, bounds);
  const at = row.indexOf(span, from);
  if (at < 0) {
    throw new Error(`the row ${JSON.stringify(row)} holds no ${JSON.stringify(span)}`);
  }
  const first = grid.styleAt(bounds.x + at, bounds.y);
  for (let step = 1; step < span.length; step += 1) {
    const next = grid.styleAt(bounds.x + at + step, bounds.y);
    if (next.foreground !== first.foreground) {
      throw new Error(
        `${JSON.stringify(span)} is drawn in two foregrounds: ` +
          `${String(first.foreground)} then ${String(next.foreground)} at column ` +
          `${bounds.x + at + step}`,
      );
    }
  }
  return first;
}

/**
 * The source rows of an open question drawer, in order.
 *
 * Found by the keys the frame placed rather than by searching the screen for
 * words: the message is arbitrary text, and a row of it may say anything.
 */
function messageRows(observed: Observed): readonly ReplBounds[] {
  const found: ReplBounds[] = [];
  for (let offset = 0; ; offset += 1) {
    const bounds = observed.boundsOf(`drawer:message:${offset}`);
    if (bounds === undefined) {
      return found;
    }
    found.push(bounds);
  }
}

describe("REPL presentation: what the characters of a reading are", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T1: a source row's delimiters, names, values and references are each their own", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(WIDE);
    const state = answering(stateWith({}), {});
    const observed = yield* presenter.commit(reading(state, model, asking(question), WIDE));
    const { grid } = presenter;

    // The whole example, preserved exactly: three rows, each holding the line
    // it was given and nothing the screen added to it.
    const rows = messageRows(observed);
    expect(rows.length).toBe(SOURCE_EXAMPLE.length);
    expect(rows.map((bounds) => textOf(grid, bounds).trimEnd())).toEqual([...SOURCE_EXAMPLE]);

    // A heading is the whole line, and it is a heading: its own colour, bold.
    const [heading, elicit, plan] = rows;
    expect(inkOfSpan(grid, heading, "# Create a project README").foreground).toBe(SYNTAX.head);
    expect(inkOfSpan(grid, heading, "# Create a project README").attrs).toContain(REFERENCE_BOLD);

    // And every part of a tag is read as the thing it is, in the cells it was
    // drawn in: one colour for the whole row would satisfy none of these.
    expect(inkOfSpan(grid, elicit, "<").foreground).toBe(SYNTAX.del);
    expect(inkOfSpan(grid, elicit, "Elicit").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, elicit, "as").foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, elicit, "=").foreground).toBe(SYNTAX.punct);
    expect(inkOfSpan(grid, elicit, '"answers"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, elicit, "schema", 20).foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, elicit, "{").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, elicit, "}").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, elicit, "Enter the project details.").foreground).toBe(SEMANTIC.src);
    expect(inkOfSpan(grid, elicit, "</").foreground).toBe(SYNTAX.del);
    // The reference inside the braces is neither the braces nor the attribute
    // whose value it is: three stretches, three colours, one row.
    const referenced = inkOfSpan(grid, elicit, "schema", 28);
    expect(referenced.foreground).toBe(SYNTAX.ref);
    expect(referenced.foreground).not.toBe(SYNTAX.brace);
    expect(referenced.foreground).not.toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, plan, "answers").foreground).toBe(SYNTAX.ref);
    expect(inkOfSpan(grid, plan, "Plan").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, plan, '"draft"').foreground).toBe(SYNTAX.str);
  });

  it("P1-T1: a binding's JSON is read as JSON, escapes and all", function* () {
    const model = yield* boundExample();
    const binding = model.entries[0]?.bindings.find((one) => one.name === "tokens");
    if (binding === undefined) {
      throw new Error(
        `this entry bound ${(model.entries[0]?.bindings ?? [])
          .map((one) => one.name)
          .join(", ")} rather than tokens`,
      );
    }
    const presenter = yield* usePresenter(WIDE);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "binding",
      name: "tokens",
    });
    const observed = yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    // The complete parsed value, line for line, exactly as it serializes.
    const serialized = (JSON.stringify(binding.value, undefined, 2) ?? "null").split("\n");
    const rows = serialized.map((_, offset) => placed(observed, `drawer:value:${offset}`));
    expect(rows.map((bounds) => textOf(grid, bounds).trimEnd())).toEqual(serialized);

    const of = (needle: string): ReplBounds => {
      const at = serialized.findIndex((line) => line.includes(needle));
      if (at < 0) {
        throw new Error(`this value serializes without ${needle}`);
      }
      return rows[at];
    };
    // A key is a key, a string is a string, and a brace is not either of them.
    expect(inkOfSpan(grid, of('"name"'), '"name"').foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, of('"name"'), '"Northstar"').foreground).toBe(SYNTAX.jstr);
    expect(inkOfSpan(grid, of('"name"'), ":").foreground).toBe(SYNTAX.punct);
    expect(inkOfSpan(grid, of('"count"'), "3").foreground).toBe(SYNTAX.num);
    expect(inkOfSpan(grid, of('"approved"'), "true").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, of('"empty"'), "null").foreground).toBe(SEMANTIC.label);
    expect(inkOfSpan(grid, rows[0], "{").foreground).toBe(SYNTAX.punct);
    // An escaped quote and an escaped backslash are characters of the string
    // they are in, so the whole quoted run is one colour and nothing is lost.
    const quoted = of('"quote"');
    expect(inkOfSpan(grid, quoted, '"say \\"hi\\" \\\\ once"').foreground).toBe(SYNTAX.jstr);
  });

  it("P1-T1: an unfinished draft keeps every character it has", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const unfinished = '<Elicit as="ans';
    const observed = yield* presenter.commit(
      reading(stateWith({ draft: unfinished }), model, NOTHING_LIVE, WIDE),
    );
    const { grid } = presenter;

    const draft = placed(observed, "footer:input");
    // Every character, in order, with the row's own name in front of it: a
    // classifier that dropped the half-written attribute would be editing input.
    expect(textOf(grid, draft).trimEnd()).toBe(` > Draft: ${unfinished}`);
    expect(inkOfSpan(grid, draft, "<").foreground).toBe(SYNTAX.del);
    expect(inkOfSpan(grid, draft, "Elicit").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, draft, "as").foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, draft, '"ans').foreground).toBe(SYNTAX.str);
    // And the row still says what it is, in its own colour rather than a token's.
    expect(inkOfSpan(grid, draft, "Draft:").foreground).toBe(SEMANTIC.src);
  });
});

describe("REPL presentation: focus marks the row without repainting it", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T2: a focused draft keeps its token colours while the marker is the cyan", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const typed = '<Plan as="draft">{answers}</Plan>';
    const state = selecting(stateWith({ draft: typed }), "entry-1");

    yield* presenter.commit(reading(state, model, NOTHING_LIVE, WIDE));
    yield* focusOn(presenter, "footer:input");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, WIDE, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const draft = placed(observed, "footer:input");
    // The marker is the one cyan thing on the row, and it is a column wide.
    expect(textOf(grid, draft).trimEnd()).toBe(`>> Draft: ${typed}`);
    expect(grid.styleAt(draft.x, draft.y).foreground).toBe(SEMANTIC.active);
    expect(grid.styleAt(draft.x, draft.y).attrs).toContain(REFERENCE_BOLD);
    // Everything after it keeps the colour it had, and gains the weight focus
    // adds: a focus that repainted the row would make all of these cyan.
    expect(grid.styleAt(draft.x + 1, draft.y).foreground).toBe(SEMANTIC.src);
    expect(inkOfSpan(grid, draft, "Plan").foreground).toBe(SEMANTIC.active);
    expect(inkOfSpan(grid, draft, '"draft"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, draft, '"draft"').attrs).toContain(REFERENCE_BOLD);
    expect(inkOfSpan(grid, draft, "answers").foreground).toBe(SYNTAX.ref);
    expect(inkOfSpan(grid, draft, "</").foreground).toBe(SYNTAX.del);

    // And the entry a reader chose is still the chosen one, whole width, with
    // the cue that survives colour being thrown away.
    const selected = placed(observed, "entry:entry-1");
    for (let x = selected.x; x < selected.x + selected.width; x += 1) {
      expect(grid.styleAt(x, selected.y).background).toBe(RETAINED.selectedSurface);
    }
    expect(textOf(grid, selected)).toContain("*");
    expect(inkOf(grid, selected).foreground).toBe(SEMANTIC.tick);
    expect(focusedRows(observed, grid)).toEqual(["footer:input"]);
  });
});

/**
 * A real session, held at a question it is actually waiting on.
 *
 * Everything else in this file hands the frame an observation it composed.
 * This one does not: the entry is submitted into a live session, the `<Elicit>`
 * inside it suspends for real, and the phase the badge is drawn from is the
 * one this process's own observer recorded while that invocation waited.
 */
const HELD_SOURCE = [
  "```js eval",
  `const decide = ${JSON.stringify({
    type: "object",
    properties: { decision: { type: "string", enum: ["Approve", "Stop"] } },
    required: ["decision"],
    additionalProperties: false,
  })};`,
  "```",
  "",
  '<Elicit schema={decide} as="answer">Hold here?</Elicit>',
  "",
].join("\n");

/** Wait until this session is asking something. */
function* held(session: ReplSession): Operation<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (session.overlay.question !== undefined) {
      return;
    }
    yield* sleep(0);
  }
  // The entry's own outcome, because the usual reason a question never
  // arrives is that the entry failed before asking it.
  throw new Error(
    "this session never reached a question it had to wait at: " +
      (session.model.entries[0]?.terminal?.message ?? "it is still running"),
  );
}

describe("REPL presentation: a frame of a real held invocation", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T4: the waiting invocation says so on its own row, in the archive's literal", () =>
    scoped(function* () {
      const opened = yield* submitReplEntry({
        execution: { id: "held", stream: new InMemoryStream([]) },
        installations: [],
        generated: ordinaryGeneratedSelection(),
        source: HELD_SOURCE,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const session = opened.value;
      yield* held(session);

      const entry = session.model.entries[0];
      if (entry === undefined) {
        throw new Error("a held session admitted no entry");
      }
      // The overlay the program reads, with this process's actual lifecycle
      // in it. Nothing here names a phase: what the badge says comes from the
      // invocation that is waiting as this frame is composed.
      const live: ReplLive = {
        output: session.overlay.output,
        question: session.overlay.question,
        expansion: session.expansion.state,
        pausable: session.controller !== undefined,
        running: session.live,
        agent: session.agent,
        lifecycle: session.lifecycle,
      };
      const resolved = viewFor(
        selecting(stateWith({}), entry.key),
        session.model,
        live,
        WIDE,
        undefined,
        session.navigation,
      );
      if (!resolved.ok) {
        throw resolved.error;
      }
      const presenter = yield* usePresenter(WIDE);
      const observed = yield* presenter.commit(resolved.value);
      const { grid } = presenter;

      const badge = `${LIFECYCLE.hold.glyph} ${LIFECYCLE.hold.word}`;
      const rows = observed.keys
        .filter((key) => key.startsWith("reading:"))
        .map((key) => ({ key, bounds: observed.boundsOf(key) }));
      const carrying = rows.find(
        (one) => one.bounds !== undefined && textOf(grid, one.bounds).includes(badge),
      );
      if (carrying?.bounds === undefined) {
        throw new Error(
          `no reading row says ${badge}; they say ${rows
            .map((one) => (one.bounds === undefined ? "" : textOf(grid, one.bounds).trim()))
            .join(" | ")}`,
        );
      }
      // The row it is on is the invocation that is waiting, not some other
      // element of the same entry.
      expect(textOf(grid, carrying.bounds)).toContain("<Elicit");
      // And it is drawn in the archive's own literal for a held call.
      expect(inkOfSpan(grid, carrying.bounds, badge).foreground).toBe(LIFECYCLE.hold.colour);
      // The source beside it keeps its own colours, so the badge is not
      // repainting the row it sits on.
      expect(inkOfSpan(grid, carrying.bounds, "<").foreground).not.toBe(LIFECYCLE.hold.colour);
    }));
});

describe("REPL presentation: the surfaces a reading is drawn on", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T3: an observed badge ends at the pane's right inner edge, in its own ink", function* () {
    // The frozen requirement is that these align at the *measured source
    // pane's right inner edge*. Everything asserting it so far has read the
    // composed run strings, which is the model's answer — the same shape of
    // claim that let a clipped drawer preview pass its own regression. This
    // reads the cells.
    // An entry whose source holds an element the scanner reports — a fence is
    // not one, so observing at its offset would match nothing and prove
    // nothing.
    // Long enough that its opening delimiter wraps: "only the first visual row
    // carries each badge" says nothing about an element that fits on one row,
    // and a check written against one cannot see a badge repeated.
    const source = '<Json value={{ note: "' + "detail ".repeat(26).trim() + '" }} as="n" />\n';
    const model = yield* scoped(function* () {
      const physical = new InMemoryStream();
      yield* runEntry(physical, source);
      return projected(yield* physical.readAll());
    });
    const entry = model.entries[0];
    const at = entry.source.indexOf("<Json");
    expect(at).toBeGreaterThanOrEqual(0);
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(
      reading(
        selecting(stateWith({}), entry.key),
        model,
        observing(entry.key, "Json", at, "active", entry.scope.path),
        WIDE,
      ),
    );
    const { grid } = presenter;

    // The body the reading is in, and its inside. The accepted gutter insets
    // the Transcript's rows two cells on each side, so a row's right inner edge
    // is this body's — the badge aligns to the box that holds the source, which
    // is the frozen requirement read where the row actually ends.
    const inside = observed.regionOf(TRANSCRIPT_BODY);
    if (inside === undefined) {
      throw new Error("this frame published no transcript body");
    }
    // Whichever row carries the badge. Found by what it says, because which
    // row that is depends on where the window happens to be.
    const badge = `${LIFECYCLE.active.glyph} ${LIFECYCLE.active.word}`;
    const carrying = observed.keys
      .filter((key) => key.startsWith("reading:"))
      .map((key) => ({ key, bounds: observed.boundsOf(key) }))
      .find((one) => one.bounds !== undefined && textOf(grid, one.bounds).includes(badge));
    if (carrying?.bounds === undefined) {
      throw new Error(
        `no reading row says ${badge}; they say ${observed.keys
          .filter((key) => key.startsWith("reading:"))
          .map((key) => textOf(grid, observed.boundsOf(key) ?? inside).trim())
          .join(" | ")}`,
      );
    }
    const row = textOf(grid, carrying.bounds);
    const starts = row.indexOf(badge);
    // Its last cell is the pane interior's last cell: right inner edge, in
    // cells, not in a string this test composed for itself.
    expect([carrying.key, carrying.bounds.x + starts + badge.length]).toEqual([
      carrying.key,
      inside.x + inside.width,
    ]);
    // And it is drawn in the archive's own literal for that phase.
    expect(inkOfSpan(grid, carrying.bounds, badge).foreground).toBe(LIFECYCLE.active.colour);
    // The source beside it keeps its own colours, so the badge is not
    // repainting the row it sits on.
    expect(inkOfSpan(grid, carrying.bounds, "<").foreground).not.toBe(LIFECYCLE.active.colour);

    // Exactly one row says it. "Only the first visual row carries each badge"
    // is frozen, and a second one would say the phase changed between two
    // halves of one element — counted in cells, because that is where a
    // reader would see it twice.
    const saying = observed.keys
      .filter((key) => key.startsWith("reading:"))
      .map((key) => observed.boundsOf(key))
      .filter((bounds) => bounds !== undefined && textOf(grid, bounds).includes(badge));
    expect(saying.length).toBe(1);

    // And every row of the reading opens with its rail, in cells. The rail is
    // what says which region a row is in, so a reading drawn without one is a
    // reading with its structure removed — and until now nothing asked the
    // screen whether it was there.
    const railed = observed.keys
      .filter((key) => key.startsWith("reading:src:") || key.startsWith("reading:output:"))
      .map((key) => ({ key, bounds: observed.boundsOf(key) }))
      .filter((one) => one.bounds !== undefined);
    expect(railed.length).toBeGreaterThan(0);
    for (const one of railed) {
      const bounds = one.bounds;
      if (bounds === undefined) {
        continue;
      }
      expect([one.key, grid.at(bounds.x, bounds.y)]).toEqual([one.key, "\u2502"]);
      // In the rail's own ink, which for an observed region is not the
      // unobserved one: a rail painted the same everywhere says nothing.
      expect([one.key, grid.styleAt(bounds.x, bounds.y).foreground]).not.toEqual([
        one.key,
        REPL_PALETTE.source,
      ]);
    }
    // The observed region really is drawn in the archive's active rail, so
    // this is not satisfied by painting every row alike.
    const activeRail = railed.filter(
      (one) =>
        one.bounds !== undefined &&
        grid.styleAt(one.bounds.x, one.bounds.y).foreground === RAIL.active,
    );
    expect(activeRail.length).toBeGreaterThan(0);
  });

  it("P1-T3: an empty screen's panes, edges and uncovered area are each their own", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(reading(stateWith({}), model, NOTHING_LIVE, WIDE));
    const { grid } = presenter;

    // Each pane's own surface, across the pane the engine admitted — and the
    // first column of a pane that begins with an edge is that edge.
    //
    // Re-anchored for #883. Two of these values are superseded by the accepted
    // refinement and come from its own fixture: the sidebar and the right
    // column were restated, and the transcript's own surface was not. The top
    // anchor moved for the same reason — a pane with a title now has a header
    // surface of its own on that row — so the pane's surface is read where its
    // header is not, and the header is asserted as the header. The claim is
    // unchanged: every measured cell of a pane that no row of its own covers is
    // that pane's surface, to the pane's full width.
    const surfaces: readonly {
      readonly region: string;
      readonly surface: number;
      readonly header?: number;
    }[] = [
      { region: "sidebar", surface: ACCEPTED_SURFACE.side },
      {
        region: "transcript",
        surface: SURFACE.center,
        header: ACCEPTED_SURFACE.transcriptHeader,
      },
      {
        region: "inspection",
        surface: ACCEPTED_SURFACE.right,
        header: ACCEPTED_SURFACE.rightHeader,
      },
    ];
    for (const { region, surface, header } of surfaces) {
      const bounds = regionBounds(observed, region);
      if (bounds === undefined) {
        throw new Error(`this frame published no ${region} region`);
      }
      // The gap above each column's heading. Where the column has a header
      // band, the band owns that space and paints it with the header's own
      // surface — the gap reads as the top of the band rather than as a strip
      // of the reading pushed down. The sidebar has no band, so its gap is its
      // own surface either way.
      for (let y = bounds.y; y < bounds.y + COLUMN_TOP_GAP; y += 1) {
        expect([region, y, grid.styleAt(bounds.x + bounds.width - 1, y).background]).toEqual([
          region,
          y,
          header ?? surface,
        ]);
      }
      // And the header itself, on the first row below that gap.
      expect([
        region,
        grid.styleAt(bounds.x + bounds.width - 1, bounds.y + COLUMN_TOP_GAP).background,
      ]).toEqual([region, header ?? surface]);
      // The bottom of the pane's own moving content, not the bottom of the
      // pane. Re-anchored for #881 PR 2: the transcript's last row is now the
      // reading's `[\u2193 later]` control, and a control carries the draft's
      // surface wherever it is — which is this terminal's existing rule, not a
      // new one. The claim is unchanged: the area a pane holds that no control
      // covers is that pane's own surface.
      const floor =
        viewportBounds(observed, region === "transcript" ? READING_WINDOW : region) ?? bounds;
      expect([
        region,
        grid.styleAt(bounds.x + bounds.width - 1, floor.y + floor.height - 1).background,
      ]).toEqual([region, surface]);
    }

    // The rule that parts two columns is the separator's own colour, drawn in
    // the first column of the pane that begins at it.
    const transcript = regionBounds(observed, "transcript");
    const footer = regionBounds(observed, "footer");
    if (transcript === undefined || footer === undefined) {
      throw new Error("this frame published no transcript or footer region");
    }
    // Re-anchored for #883: the one value that served both roles is now two,
    // and which of them belongs to which rule is the accepted separation.
    expect(grid.styleAt(transcript.x, transcript.y).foreground).toBe(ACCEPTED_EDGE.divider);
    // And the rule that parts the body from the footer, on the row above it.
    expect(grid.styleAt(transcript.x, footer.y - 1).foreground).toBe(ACCEPTED_EDGE.chrome);

    // What no row of its own covers is still this application's: the end of the
    // action row, where no control was placed.
    const actions = observed.regionOf(ACTION_ROW);
    if (actions === undefined) {
      throw new Error("this frame published no action row");
    }
    expect(grid.at(actions.x + actions.width - 1, actions.y)).toBe(" ");
    expect(grid.styleAt(actions.x + actions.width - 1, actions.y).background).toBe(SURFACE.app);

    // Both shared columns still say what they are while they hold nothing.
    expect(textOf(grid, placed(observed, "sessions:heading"))).toContain("Sessions");
    // The right column says what it is through the tab that is selected, which
    // is the accepted default pane for an empty screen.
    expect(inkOf(grid, placed(observed, "tab:sidekick")).foreground).toBe(SEMANTIC.intro);
  });

  it("P1-T3: a question drawer is bounded, named as waiting, and read in groups", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(WIDE);
    const filled = answering(
      stateWith({}),
      {
        project: "Northstar",
        description: "A lightweight workspace for coordinating coding agents.",
      },
      [{ field: "project", message: "project is required" }],
    );
    const observed = yield* presenter.commit(reading(filled, model, asking(question), WIDE));
    const { grid } = presenter;

    const rect = regionBounds(observed, "drawer");
    if (rect === undefined) {
      throw new Error("this frame published no drawer region");
    }
    // One cell of rule along the top of the rectangle, inside it, across it.
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const style = grid.styleAt(x, rect.y);
      expect([x, style.foreground, style.background]).toEqual([x, SEMANTIC.hold, SURFACE.drawer]);
    }

    // The title is inside the rectangle, below the rule, inset from its side —
    // so it cannot be read as one more line of what the drawer is covering.
    const title = placed(observed, "drawer:open");
    expect(title.y).toBe(rect.y + 1);
    expect(title.x).toBe(rect.x + 1);
    expect(title.x + title.width).toBe(rect.x + rect.width - 1);
    expect(textOf(grid, title).trimEnd()).toBe("Project details");
    // A question nobody has answered yet says so before a word of it is read.
    expect(inkOfSpan(grid, title, "Project details").foreground).toBe(SEMANTIC.hold);
    expect(inkOfSpan(grid, title, "Project details").attrs).toContain(REFERENCE_BOLD);

    // A field's name, what it means and what is in it are three readings.
    const named = placed(observed, "drawer:field:project");
    expect(inkOfSpan(grid, named, "*Project name:").foreground).toBe(SEMANTIC.label);
    expect(inkOfSpan(grid, named, "Northstar").foreground).toBe(SEMANTIC.out);
    const hint = placed(observed, "drawer:field:project:about");
    expect(inkOfSpan(grid, hint, "Name your project.").foreground).toBe(SEMANTIC.dim);
    const edited = placed(observed, "drawer:value:project");
    expect(inkOfSpan(grid, edited, "Northstar").foreground).toBe(SEMANTIC.out);
    // The row text goes into sits on the surface that says so, whole width.
    for (let x = edited.x; x < edited.x + edited.width; x += 1) {
      expect(grid.styleAt(x, edited.y).background).toBe(SURFACE.field);
    }
    // The second field's group reads the same way, with its own words.
    const second = placed(observed, "drawer:field:description");
    expect(inkOfSpan(grid, second, "*One-sentence description:").foreground).toBe(SEMANTIC.label);
    expect(
      inkOfSpan(grid, second, "A lightweight workspace for coordinating coding agents.").foreground,
    ).toBe(SEMANTIC.out);
    expect(
      inkOfSpan(grid, placed(observed, "drawer:field:description:about"), "Describe its purpose.")
        .foreground,
    ).toBe(SEMANTIC.dim);

    // What the last submission was told, in the accent a refusal has.
    const invalid = placed(observed, "drawer:invalid:0");
    expect(textOf(grid, invalid)).toContain("project is required");
    expect(inkOfSpan(grid, invalid, "project is required").foreground).toBe(SEMANTIC.exit);
    // And the way to answer is still there, on a control's own surface.
    const submit = placed(observed, "drawer:form:submit");
    expect(textOf(grid, submit)).toContain("[submit]");
    expect(grid.styleAt(submit.x, submit.y).background).toBe(SURFACE.input);

    // Every cell of the rectangle is the drawer's, the unused ones included.
    const own: readonly number[] = [
      SURFACE.drawer,
      RETAINED.selectedSurface,
      SURFACE.field,
      SURFACE.input,
    ];
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const background = grid.styleAt(x, y).background;
        if (background === undefined || !own.includes(background)) {
          throw new Error(
            `the cell at ${x},${y} is inside the drawer and shows ${String(background)}`,
          );
        }
      }
    }
  });

  it("P1-T3: a shorter reading and a closed drawer leave nothing behind", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const live = asking(question);
    const long = answering(stateWith({}), {
      project: "Northstar",
      description: "A lightweight workspace for coordinating coding agents.",
    });
    const short = answering(stateWith({}), { project: "N", description: "x" });

    const incremental = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      yield* presenter.commit(reading(long, model, live, WIDE));
      const after = yield* presenter.commit(reading(short, model, live, WIDE));
      // The cells the longer value reached and the shorter one does not: still
      // the row's own surface, with nothing of the longer value left in them.
      const edited = placed(after, "drawer:value:description");
      // Its unfocused marker, its name and the one character left in it.
      expect(textOf(presenter.grid, edited).trimEnd()).toBe("   = x");
      for (let x = edited.x; x < edited.x + edited.width; x += 1) {
        expect(presenter.grid.styleAt(x, edited.y).background).toBe(SURFACE.field);
      }
      const closed = yield* presenter.commit(reading(stateWith({}), model, live, WIDE));
      return {
        cells: presenter.grid.styledIn({ x: 0, y: 0, width: WIDE.columns, height: WIDE.rows }),
        keys: closed.keys.slice().sort(),
      };
    });

    const fresh = yield* scoped(function* () {
      const presenter = yield* usePresenter(WIDE);
      const first = yield* presenter.commit(reading(stateWith({}), model, live, WIDE));
      return {
        cells: presenter.grid.styledIn({ x: 0, y: 0, width: WIDE.columns, height: WIDE.rows }),
        keys: first.keys.slice().sort(),
      };
    });

    // Every cell, its characters, its foreground, its background and its blanks:
    // a drawer that left its rule, its inset or a vacated value behind would
    // differ from a screen that never drew one.
    expect(incremental.cells).toEqual(fresh.cells);
    expect(incremental.keys).toEqual(fresh.keys);
    expect(incremental.keys.some((key) => key.startsWith("drawer:"))).toBe(false);
  });
});

describe("REPL presentation: decoration the frame measured", () => {
  beforeAll(() => useTempFileCompiler());

  it("P1-T4: the drawer's rule and inset are measured, and every row lands inside them", function* () {
    const model = yield* boundExample();
    for (const size of [WIDE, MEDIUM, NARROW]) {
      yield* scoped(function* () {
        const presenter = yield* usePresenter(size);
        const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
          kind: "binding",
          name: "tokens",
        });
        const view = reading(state, model, NOTHING_LIVE, size);
        const admission = yield* presenter.prepare(view);
        const observed = yield* presenter.commit(view);
        const { grid } = presenter;

        const rect = regionBounds(observed, "drawer");
        const viewport = viewportBounds(observed, DRAWER_WINDOW);
        const footer = regionBounds(observed, "footer");
        if (rect === undefined || viewport === undefined || footer === undefined) {
          throw new Error(`${size.columns}x${size.rows} published no drawer or footer`);
        }
        // The rule is the rectangle's own first row, and the content begins
        // below it and one column in from each side.
        expect([size.columns, grid.styleAt(rect.x, rect.y).foreground]).toEqual([
          size.columns,
          SEMANTIC.hold,
        ]);
        expect([size.columns, viewport.y > rect.y]).toEqual([size.columns, true]);
        expect([size.columns, viewport.x]).toEqual([size.columns, rect.x + 1]);
        expect([size.columns, viewport.x + viewport.width]).toEqual([
          size.columns,
          rect.x + rect.width - 1,
        ]);

        // Capacity is the viewport the engine measured with the decoration
        // already in it, so what the window admits was never the undecorated
        // rectangle: padding worked out afterwards would admit a row too many.
        const admitted = admission.windows.get(DRAWER_WINDOW);
        if (admitted === undefined) {
          throw new Error(`${size.columns}x${size.rows} measured no drawer window`);
        }
        expect([size.columns, admitted.capacity]).toEqual([size.columns, viewport.height]);
        expect([size.columns, admitted.count <= admitted.capacity]).toEqual([size.columns, true]);

        // Every row the drawer placed is whole, inside the inset content area,
        // and below the rule — the window controls and the way out included.
        const inside: ReplBounds = {
          x: rect.x + 1,
          y: rect.y + 1,
          width: rect.width - 2,
          height: rect.height - 1,
        };
        const drawn = observed.keys.filter((key) => key.startsWith("drawer:"));
        expect([size.columns, drawn.length > 0]).toEqual([size.columns, true]);
        for (const key of drawn) {
          const bounds = observed.boundsOf(key);
          if (bounds === undefined) {
            continue;
          }
          expect([key, size.columns, within(bounds, inside)]).toEqual([key, size.columns, true]);
        }
        // And the footer is still the seven rows it always is.
        expect([size.columns, footer.height]).toEqual([size.columns, FOOTER_ROWS]);
      });
    }
  });

  it("P1-T4: a reading longer than the decorated window is in no cell and no target", function* () {
    const model = yield* boundExample();
    const presenter = yield* usePresenter(NARROW);
    const state = openingDrawer(selecting(stateWith({}), "entry-1"), {
      kind: "binding",
      name: "tokens",
    });
    const view = reading(state, model, NOTHING_LIVE, NARROW);
    const admission = yield* presenter.prepare(view);
    const observed = yield* presenter.commit(view);

    const admitted = admission.windows.get(DRAWER_WINDOW);
    if (admitted === undefined) {
      throw new Error("this frame measured no drawer window");
    }
    // The narrowest supported frame cannot hold this value whole, which is what
    // makes the window the thing under test rather than a formality.
    expect(admitted.total).toBeGreaterThan(admitted.capacity);
    expect(admitted.more).toBe(true);

    // Exactly the admitted rows mounted; the ones past the window are in no
    // cell, so they are in no pointer target and no Tab stop either.
    const shown = observed.keys.filter((key) => key.startsWith("drawer:value:"));
    expect(shown.length).toBe(admitted.count);
    expect(observed.boundsOf(`drawer:value:${admitted.total - 1}`)).toBe(undefined);
    for (const key of shown) {
      expect([key, observed.nodeOf(key) !== undefined]).toEqual([key, true]);
    }
    // And the way out of the drawer is still reachable at this size.
    expect(observed.keys).toContain("drawer:close");
  });
});

describe("REPL presentation: a row the frame cannot hold whole", () => {
  beforeAll(() => useTempFileCompiler());

  /** One tag far wider than any drawer at any supported size. */
  const OVERFLOWING =
    '<Elicit as="answers" schema={schema}>' +
    "Enter the project details, at length, so that this one line is wider ".repeat(4) +
    "</Elicit>";

  it("P1-T1: an overflowing source row keeps its roles and every character it shows", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, OVERFLOWING);
    const presenter = yield* usePresenter(WIDE);
    const observed = yield* presenter.commit(
      reading(answering(stateWith({}), {}), model, asking(question), WIDE),
    );
    const { grid } = presenter;

    const row = placed(observed, "drawer:message:0");
    const written = textOf(grid, row).replace(/\s+$/, "");
    // Whatever the row shows is a prefix of the line it was given, with no gap
    // where a stretch wrapped away: every written cell is the next character of
    // the source, in order.
    expect(written.length).toBeGreaterThan(40);
    expect(OVERFLOWING.startsWith(written)).toBe(true);
    expect(written).not.toContain("  ");

    // And every visible character still reads as the thing it is. A row drawn
    // as one stretch to dodge the engine's per-operation wrapping would make
    // all of these the same colour, which is the defect this rejects.
    expect(inkOfSpan(grid, row, "<").foreground).toBe(SYNTAX.del);
    expect(inkOfSpan(grid, row, "Elicit").foreground).toBe(SYNTAX.tag);
    expect(inkOfSpan(grid, row, "as").foreground).toBe(SYNTAX.attr);
    expect(inkOfSpan(grid, row, "=").foreground).toBe(SYNTAX.punct);
    expect(inkOfSpan(grid, row, '"answers"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, row, "{").foreground).toBe(SYNTAX.brace);
    expect(inkOfSpan(grid, row, "schema", 28).foreground).toBe(SYNTAX.ref);
    expect(inkOfSpan(grid, row, "Enter the project").foreground).toBe(SYNTAX.prose);
    // Nothing on the row is drawn in one colour throughout.
    const inks = new Set<number | undefined>();
    for (let x = row.x; x < row.x + row.width; x += 1) {
      if (grid.at(x, row.y) !== " ") {
        inks.add(grid.styleAt(x, row.y).foreground);
      }
    }
    expect(inks.size).toBeGreaterThan(3);
  });

  it("P1-T2: an overflowing focused row keeps its cue and its roles", function* () {
    const model = yield* settledAndFailed();
    const presenter = yield* usePresenter(NARROW);
    // A draft wider than the narrowest supported frame, with focus on it.
    const typed = `<Plan as="draft">{answers}</Plan> ${"and more source ".repeat(6)}`;
    const state = stateWith({ draft: typed });

    yield* presenter.commit(reading(state, model, NOTHING_LIVE, NARROW));
    yield* focusOn(presenter, "footer:input");
    const observed = yield* presenter.commit(
      reading(state, model, NOTHING_LIVE, NARROW, focusKeyOf(presenter)),
    );
    const { grid } = presenter;

    const draft = placed(observed, "footer:input");
    expect(textOf(grid, draft).startsWith(">> Draft: <Plan")).toBe(true);
    // The cue is still the one cyan thing, and the row is still read.
    expect(grid.styleAt(draft.x, draft.y).foreground).toBe(SEMANTIC.active);
    expect(grid.styleAt(draft.x, draft.y).attrs).toContain(REFERENCE_BOLD);
    expect(inkOfSpan(grid, draft, "Plan").foreground).toBe(SYNTAX.tag);
    expect(inkOfSpan(grid, draft, '"draft"').foreground).toBe(SYNTAX.str);
    expect(inkOfSpan(grid, draft, "answers").foreground).toBe(SYNTAX.ref);
  });

  it("P1-T3: a populated field keeps its name and its value apart at 72x20", function* () {
    const model = yield* settledAndFailed();
    const question = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(NARROW);
    // The frozen values. At this size the second field's row is wider than the
    // drawer, which is exactly where a single-colour fallback painted the
    // visible value as though it were the field's name.
    let filled = answering(stateWith({}), {
      project: "Northstar",
      description: "A lightweight workspace for coordinating coding agents.",
    });
    const live = asking(question);
    let observed = yield* presenter.commit(reading(filled, model, live, NARROW));
    // The second field is one window further on at this size. Reached through
    // the drawer's own window action, against the admission each frame
    // measured, so the row asserted below is one a reader would be looking at.
    for (let press = 0; press < 40; press += 1) {
      if (observed.boundsOf("drawer:field:description") !== undefined) {
        break;
      }
      const view = reading(filled, model, live, NARROW);
      filled = reduceRepl(
        filled,
        { kind: "scroll", delta: 1 },
        model,
        live,
        yield* presenter.prepare(view),
      ).state;
      observed = yield* presenter.commit(reading(filled, model, live, NARROW));
    }
    const { grid } = presenter;

    const named = placed(observed, "drawer:field:description");
    expect(textOf(grid, named)).toContain("*One-sentence description:");
    expect(textOf(grid, named)).toContain("A lightweight");
    expect(inkOfSpan(grid, named, "*One-sentence description:").foreground).toBe(SEMANTIC.label);
    expect(inkOfSpan(grid, named, "A lightweight").foreground).toBe(SEMANTIC.out);
    expect(inkOfSpan(grid, named, "A lightweight").foreground).not.toBe(SEMANTIC.label);
  });

  it("P1-T1: a row the drawer does hold is read the same way", function* () {
    const model = yield* settledAndFailed();
    const short = yield* askingWith(DETAILS_SCHEMA, SOURCE_EXAMPLE.join("\n"));
    const presenter = yield* usePresenter(WIDE);
    const fitted = yield* presenter.commit(
      reading(answering(stateWith({}), {}), model, asking(short), WIDE),
    );
    expect(inkOfSpan(presenter.grid, placed(fitted, "drawer:message:1"), "Elicit").foreground).toBe(
      SYNTAX.tag,
    );
  });
});

/** An entry whose source is this many lines, for measuring what a frame costs. */
function sourceOf(lines: number): string {
  return Array.from({ length: lines }, (_, at) =>
    at % 4 === 3
      ? ""
      : `<Json value={{ ordinal: ${at}, note: "line ${at} of a long entry" }} as="n${at}" />`,
  ).join("\n");
}

/**
 * What one complete frame asks the engine for, with the draft moved.
 *
 * The production commit path — measure, admit, reconcile, draw — against one
 * real tree, one real engine pair and the store a running REPL owns. The
 * first frame is warmup; the number returned is what the *second* frame costs
 * when the only thing that changed is the draft beside the reading.
 */
function* frameCost(lines: number): Operation<{ warmup: number; typed: number }> {
  return yield* scoped(function* () {
    const renderer = yield* useCountingRenderer(WIDE);
    const tree = yield* useReplTree<ReplAction>();
    const store = createFitStore();
    const model = yield* scoped(function* () {
      const physical = new InMemoryStream();
      yield* runEntry(physical, `${sourceOf(lines)}\n`);
      return projected(yield* physical.readAll());
    });
    const entry = model.entries[0];
    if (entry === undefined) {
      throw new Error("the fixture admitted no entry");
    }
    const drafted = (draft: string) =>
      reading(
        Object.freeze({ ...selecting(stateWith({}), entry.key), draft }),
        model,
        NOTHING_LIVE,
        WIDE,
      );

    const first = yield* commitReplFrame(
      tree,
      renderer,
      drafted("a"),
      0,
      undefined,
      undefined,
      store,
    );
    if (!first.ok) {
      throw first.error;
    }
    const warmup = renderer.measures();
    renderer.reset();
    const second = yield* commitReplFrame(
      tree,
      renderer,
      drafted("ab"),
      0,
      undefined,
      undefined,
      store,
    );
    if (!second.ok) {
      throw second.error;
    }
    return { warmup, typed: renderer.measures() };
  });
}

describe("REPL responsiveness: a complete frame after a keystroke", () => {
  it("RS2: costs the same whether the selected reading is short or long", () =>
    scoped(function* () {
      const short = yield* frameCost(12);
      const long = yield* frameCost(222);

      // The first frame of each pays for its own reading, and the long one
      // pays far more — so these two fixtures really do differ in the work
      // the cache is about.
      expect(long.warmup).toBeGreaterThan(short.warmup * 4);

      // The second frame changed only the draft. What it costs is the fixed
      // measurement a complete frame always performs — three structural
      // passes, the rail and the drawer — and *not* the source fitting, so it
      // is the same number for twelve lines and for two hundred and
      // twenty-two.
      expect(long.typed).toBe(short.typed);
      // That floor is real work, not zero: this is a whole frame, not the
      // fitter on its own.
      expect(short.typed).toBeGreaterThan(0);
      // And it is a fraction of what the reading cost to fit.
      expect(long.typed).toBeLessThan(long.warmup / 10);
    }));
});

/**
 * Tier TE — the accepted roles, in ordinary kernel cells (#883).
 *
 * Every expected value here comes from `issue-883/reference-style.ts`, which
 * transcribes the refinement the Product Owner accepted. Nothing is read back
 * off `REPL_PALETTE`: a test that asked the product what colour a divider is
 * would agree with the product however it drifted.
 *
 * The two roles that used to share one constant are asserted separately on
 * purpose. A vertical column divider and the rule between the body and the
 * footer are different readings of the screen, so a product drawing both from
 * one value cannot satisfy both of these rows at once.
 *
 * **Ordinary kernel.** These frames are `reading()`, which is `viewFor` with no
 * workspace: the production renderer draws them, but the composition is the
 * kernel's rather than the staged screen a person is offered. That is why the
 * three shipping appearance records do not stand in for any of it — they hold
 * one input with one tab selected, and this asks about roles under both tabs
 * and about outlets they never route.
 */
describe("Tier TE kernel — pane roles, edges and routed outlets", () => {
  /** The two sizes that draw three columns. */
  const COLUMNED: readonly { readonly name: string; readonly size: ReplTerminalSize }[] =
    Object.freeze([
      { name: "160x36", size: WIDE },
      { name: "120x30", size: MEDIUM },
    ]);

  /** The right pane's two tabs, and what selects each one. */
  const TABS: readonly {
    readonly name: string;
    readonly select: (state: ReplState) => ReplState;
    readonly row: string;
  }[] = Object.freeze([
    { name: "Sidekick", select: (state: ReplState) => state, row: "tab:sidekick" },
    { name: "Bindings", select: inspecting, row: "tab:bindings" },
  ]);

  /** The background of the last cell of a row, which no text reaches. */
  function fillBeyond(grid: TerminalGrid, bounds: ReplBounds): number | undefined {
    return grid.styleAt(bounds.x + bounds.width - 1, bounds.y).background;
  }

  it("TE4 kernel: pane roles survive both tab selections", function* () {
    const model = yield* settledAndFailed();
    for (const { name, size } of COLUMNED) {
      for (const tab of TABS) {
        const where = `${name} ${tab.name}`;
        yield* scoped(function* (): Operation<void> {
          const presenter = yield* usePresenter(size);
          const observed = yield* presenter.commit(
            reading(tab.select(stateWith({})), model, NOTHING_LIVE, size),
          );
          const { grid } = presenter;

          // Both header surfaces, across the measured row rather than behind
          // its text: a fill that stopped where the title ends would leave the
          // pane's own surface showing for the rest of the header.
          expect([where, fillBeyond(grid, placed(observed, "transcript:heading"))]).toEqual([
            where,
            ACCEPTED_SURFACE.transcriptHeader,
          ]);
          // The right pane's header is the one tab row, so the fill is read
          // across that band: the last cell of it is past both names.
          const band = observed.regionOf(TAB_ROW);
          if (band === undefined) {
            throw new Error(`${where} published no tab row`);
          }
          expect([where, fillBeyond(grid, band)]).toEqual([where, ACCEPTED_SURFACE.rightHeader]);
          for (const key of ["tab:bindings", "tab:sidekick"]) {
            expect([where, key, grid.styleAt(placed(observed, key).x, band.y).background]).toEqual([
              where,
              key,
              ACCEPTED_SURFACE.rightHeader,
            ]);
          }

          // Each header's own edge, which is what closes the band: read in the
          // row directly under the last header row, not inferred from the
          // band's bounds — a published row is a position this frame committed.
          const transcriptHeader = placed(observed, "transcript:heading");
          // One header row now, and the band is it: the edge closes the tabs.
          const rightHeader = band;
          for (const [name, header] of [
            ["transcript", transcriptHeader],
            ["inspection", rightHeader],
          ] as const) {
            const edge = header.y + 1;
            // Across the band, not at one cell: the edge closes the whole
            // header or it is a dash somebody drew in the corner.
            for (const x of [
              header.x,
              header.x + Math.floor(header.width / 2),
              header.x + header.width - 1,
            ]) {
              expect([where, name, x, grid.styleAt(x, edge).foreground]).toEqual([
                where,
                name,
                x,
                ACCEPTED_EDGE.chrome,
              ]);
            }
          }

          // The transcript's own body is still its own surface, and is none of
          // the three the refinement gave the chrome around it.
          const window = viewportBounds(observed, READING_WINDOW);
          if (window === undefined) {
            throw new Error(`${where} published no reading window`);
          }
          const body = grid.styleAt(
            window.x + window.width - 1,
            window.y + window.height - 1,
          ).background;
          expect([where, body]).toEqual([where, ACCEPTED_SURFACE.centre]);
          expect([where, body === ACCEPTED_SURFACE.transcriptHeader]).toEqual([where, false]);
          expect([where, body === ACCEPTED_SURFACE.right]).toEqual([where, false]);

          // The two panes the refinement restated, read directly rather than
          // left to the one older assertion: the measured floor of each one's
          // own window, where no row of its own covers the cells.
          const sidebar = regionBounds(observed, "sidebar");
          const right = regionBounds(observed, "inspection");
          if (sidebar === undefined || right === undefined) {
            throw new Error(`${where} published no sidebar or inspection region`);
          }
          const floorOf = (
            bounds: ReplBounds,
            ...windows: readonly string[]
          ): number | undefined => {
            for (const window of windows) {
              const found = viewportBounds(observed, window);
              if (found !== undefined) {
                return grid.styleAt(found.x + found.width - 1, found.y + found.height - 1)
                  .background;
              }
            }
            return grid.styleAt(bounds.x + bounds.width - 1, bounds.y + bounds.height - 1)
              .background;
          };
          expect([where, "sidebar", floorOf(sidebar, SESSIONS_WINDOW)]).toEqual([
            where,
            "sidebar",
            ACCEPTED_SURFACE.side,
          ]);
          expect([where, "right", floorOf(right, SIDEKICK_WINDOW, "inspection")]).toEqual([
            where,
            "right",
            ACCEPTED_SURFACE.right,
          ]);

          // Both column dividers, continuous down the whole pane: one cell, in
          // the first column of the pane that begins at it, on every row of it.
          for (const region of ["transcript", "inspection"]) {
            const bounds = regionBounds(observed, region);
            if (bounds === undefined) {
              throw new Error(`${where} published no ${region} region`);
            }
            for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
              expect([where, region, y, grid.styleAt(bounds.x, y).foreground]).toEqual([
                where,
                region,
                y,
                ACCEPTED_EDGE.divider,
              ]);
            }
          }

          // And the rule between the body and the footer, which is the other
          // role: the chrome edge, not the divider.
          const transcript = regionBounds(observed, "transcript");
          const footer = regionBounds(observed, "footer");
          if (transcript === undefined || footer === undefined) {
            throw new Error(`${where} published no transcript or footer region`);
          }
          expect([where, grid.styleAt(transcript.x, footer.y - 1).foreground]).toEqual([
            where,
            ACCEPTED_EDGE.chrome,
          ]);
          // The footer keeps its seven rows: no edge was bought with one.
          expect([where, footer.height]).toEqual([where, FOOTER_ROWS]);

          // And which tab is selected is readable in the cells this frame
          // committed. Neither label says so any more, so the evidence is the
          // active styling the two tabs have always differed by — measured on
          // both of them, because one colour proves nothing on its own.
          const other = tab.row === "tab:sidekick" ? "tab:bindings" : "tab:sidekick";
          expect([where, inkOf(grid, placed(observed, tab.row)).foreground]).toEqual([
            where,
            SEMANTIC.intro,
          ]);
          expect([
            where,
            inkOf(grid, placed(observed, other)).foreground === SEMANTIC.intro,
          ]).toEqual([where, false]);
          for (const key of [tab.row, other]) {
            expect([
              where,
              key,
              textOf(grid, placed(observed, key)).includes("[selected]"),
            ]).toEqual([where, key, false]);
          }
        });
      }
    }
  });

  it("TE4 kernel: each routed outlet omits wide chrome and targets", function* () {
    const model = yield* settledAndFailed();
    // Each outlet reached by the action that reaches it, rather than by a route
    // written here: what a narrow frame draws is decided by the surface a
    // person selected, so the selection has to be the real one.
    const outlets: readonly { readonly name: string; readonly action: ReplAction }[] =
      Object.freeze([
        { name: "entries", action: { kind: "select-surface", surface: "entries" } },
        { name: "sessions", action: { kind: "select-surface", surface: "sessions" } },
        { name: "sidekick", action: { kind: "select-pane", pane: "sidekick" } },
      ]);

    for (const outlet of outlets) {
      yield* scoped(function* (): Operation<void> {
        const presenter = yield* usePresenter(NARROW);
        const initial = stateWith({});
        const prepared = yield* presenter.prepare(reading(initial, model, NOTHING_LIVE, NARROW));
        const routed = reduceRepl(initial, outlet.action, model, NOTHING_LIVE, prepared).state;
        const observed = yield* presenter.commit(reading(routed, model, NOTHING_LIVE, NARROW));
        const { grid } = presenter;

        // One body, and the footer it shares the screen with is the same seven
        // rows every other profile has.
        const content = regionBounds(observed, "content");
        const footer = regionBounds(observed, "footer");
        if (content === undefined || footer === undefined) {
          throw new Error(`the ${outlet.name} outlet published no content or footer region`);
        }
        expect([outlet.name, footer.height]).toEqual([outlet.name, FOOTER_ROWS]);
        for (const absent of ["sidebar", "transcript", "inspection"]) {
          expect([outlet.name, absent, regionBounds(observed, absent)]).toEqual([
            outlet.name,
            absent,
            undefined,
          ]);
        }

        // No wide chrome is drawn: a hidden column has no divider and no header
        // to draw, so neither colour is anywhere on this screen.
        for (let y = 0; y < NARROW.rows; y += 1) {
          for (let x = 0; x < NARROW.columns; x += 1) {
            const cell = grid.styleAt(x, y);
            expect([outlet.name, x, y, cell.foreground === ACCEPTED_EDGE.divider]).toEqual([
              outlet.name,
              x,
              y,
              false,
            ]);
            expect([
              outlet.name,
              x,
              y,
              cell.background === ACCEPTED_SURFACE.transcriptHeader,
            ]).toEqual([outlet.name, x, y, false]);
            expect([outlet.name, x, y, cell.background === ACCEPTED_SURFACE.rightHeader]).toEqual([
              outlet.name,
              x,
              y,
              false,
            ]);
          }
        }

        // And none of it is targetable either. A target names a mounted node, so
        // a chrome row this frame never mounted has nothing for a keystroke or a
        // pointer to reach — which is a stronger claim than its cells being
        // blank, and the reason both are asserted.
        for (const key of ["transcript:heading", "tab:bindings", "tab:sidekick"]) {
          expect([outlet.name, key, observed.keys.includes(key)]).toEqual([
            outlet.name,
            key,
            false,
          ]);
          expect([outlet.name, key, observed.nodeOf(key)]).toEqual([outlet.name, key, undefined]);
        }
      });
    }
  });
});

/**
 * Tier RS — what a keystroke costs once the chat has something in it (#883).
 *
 * The Product Owner reported the Sidekick going sluggish as a conversation
 * grew, and a read-only diagnosis measured the cause: every frame refitted
 * every chat line, including while Bindings hid the chat, so twenty wrapping
 * messages turned one typed key into 1,284 measurement renders.
 *
 * These rows count the renders the production commit path actually asks the
 * engine for, through the real tree and the two stores a running command owns.
 * Counts rather than milliseconds: a wall time describes this machine and a
 * render count describes the work. They are display fixtures for deterministic
 * frame work and state nothing about what an agent can do.
 */
describe("REPL responsiveness: a chat the keystroke did not change", () => {
  /** One line wide enough that the pane has to cut it into several rows. */
  const WRAPS = "This is a complete sentence with words that have to wrap. ".repeat(4);

  /** One acknowledged reply, as the owner publishes one. */
  function replyRow(conversation: string, turn: number, text: string): ReplSidekickChatRow {
    return Object.freeze({
      key: `${conversation}:response:${turn}`,
      conversation,
      turn,
      kind: "reply",
      text,
      hasOutput: true,
      failure: undefined,
    });
  }

  /**
   * The same item while it is still only what a turn is saying.
   *
   * Under the key its reply will carry, because a response is one item on the
   * screen from its first word to its last — which is what makes growing its
   * text a change to a line that is already there.
   */
  function previewRow(conversation: string, turn: number, text: string): ReplSidekickChatRow {
    return Object.freeze({
      key: `${conversation}:response:${turn}`,
      conversation,
      turn,
      kind: "preview",
      text,
      hasOutput: false,
      failure: undefined,
    });
  }

  /** Several acknowledged replies in order, which is what most rows need. */
  function repliesOf(
    texts: readonly string[],
    conversation = "chat-one",
  ): readonly ReplSidekickChatRow[] {
    return texts.map((text, at) => replyRow(conversation, at + 1, text));
  }

  /** One chat, as the reading this screen is handed. */
  function chatOf(
    rows: readonly ReplSidekickChatRow[],
    conversation = "chat-one",
  ): ReplSidekickReading {
    const reading: ReplSidekickReading = {
      agent: "scribe",
      busy: false,
      refusal: undefined,
      question: undefined,
      requested: undefined,
      verified: undefined,
      conversation,
      reading: conversation,
      current: true,
      turns: [],
      availability: { chats: [conversation], sessions: [], refusal: undefined },
      chat: rows,
    };
    return Object.freeze(reading);
  }

  /** A frame of this chat, with this draft and this right-hand pane. */
  function frameOf(
    chat: ReplSidekickReading,
    over: { readonly draft?: string; readonly message?: string; readonly bindings?: boolean },
    model: ReplModel,
    size: ReplTerminalSize = WIDE,
  ): ReplView {
    const base = initialState(EXECUTION);
    const state: ReplState = Object.freeze({
      ...base,
      draft: over.draft ?? "",
      message: over.message ?? "",
      route: Object.freeze({
        ...base.route,
        right: over.bindings === true ? "bindings" : "sidekick",
      }),
    });
    return reading(state, model, { ...NOTHING_LIVE, sidekick: chat }, size);
  }

  /** The mounted chat rows of the frame this tree last committed. */
  function chatKeys(tree: ReplTree<ReplAction>): readonly string[] {
    return tree
      .mounted()
      .map((node) => tree.keyOf(node))
      .filter((key): key is string => key !== undefined && key.startsWith("sidekick:chat-one"));
  }

  /** One warm command: both stores, one tree, one counting engine pair. */
  function* commanding(size: ReplTerminalSize = WIDE) {
    const renderer = yield* useCountingRenderer(size);
    const tree = yield* useReplTree<ReplAction>();
    const fits = createFitStore();
    const chatFits = createPlainFitStore();
    const model = projectRepl([]);
    if (!model.ok) {
      throw model.error;
    }
    // One grid across every frame this command draws, because this renderer
    // writes diffs: a single frame's bytes are what changed, not the screen.
    const grid = createGrid();
    return {
      renderer,
      tree,
      model: model.value,
      /**
       * The chat rows a frame prepares, warm or cold.
       *
       * Cold means prepared with no stores at all, which is the answer every
       * comparison here is against: the rows a command that had measured
       * nothing would draw.
       */
      *prepared(view: ReplView, warm: boolean): Operation<readonly ReplFittedLine[]> {
        const done = warm
          ? yield* prepareFrame(renderer, view, fits, chatFits)
          : yield* prepareFrame(renderer, view);
        if (!done.ok) {
          throw done.error;
        }
        return done.value.context.chat ?? [];
      },
      /** Commit one view and answer what the engine was asked for. */
      *commit(view: ReplView): Operation<number> {
        renderer.reset();
        const done = yield* commitReplFrame(
          tree,
          renderer,
          view,
          0,
          undefined,
          undefined,
          fits,
          chatFits,
        );
        if (!done.ok) {
          throw done.error;
        }
        grid.apply(done.value.rendered.output);
        return renderer.measures();
      },
      /** Everything drawn so far, as the accumulated screen reads. */
      screen(at: ReplTerminalSize = size): string {
        return grid.textIn({ x: 0, y: 0, width: at.columns, height: at.rows }).join("\n");
      },
    };
  }

  it("RS3: typing reuses an unchanged chat, however long it is", function* () {
    const measured: Record<string, { warm: number; draft: number; message: number }> = {};
    for (const [name, texts] of [
      ["short", ["one", "two", "three"]],
      ["long", Array.from({ length: 12 }, (_, at) => `${at + 1}. ${WRAPS}`)],
    ] as const) {
      yield* scoped(function* (): Operation<void> {
        const held = yield* commanding();
        const chat = chatOf(repliesOf(texts));
        const warm = yield* held.commit(frameOf(chat, { draft: "a" }, held.model));
        // Only the draft, then only the message. Neither touches the chat.
        const draft = yield* held.commit(frameOf(chat, { draft: "ab" }, held.model));
        const message = yield* held.commit(
          frameOf(chat, { draft: "ab", message: "hello" }, held.model),
        );
        // What was typed is what is drawn, which is what makes the counts a
        // claim about cost rather than about a frame that skipped its work.
        const screen = held.screen();
        expect([name, screen.includes("Draft: ab")]).toEqual([name, true]);
        // The composer draws its name and its value on rows of their own now,
        // so both are asserted rather than one row holding the pair.
        expect([name, screen.includes("Message Sidekick:")]).toEqual([name, true]);
        expect([name, screen.includes("hello")]).toEqual([name, true]);
        // The first reply's own opening, which is as much of a wrapping line as
        // one row holds.
        expect([name, screen.includes(texts[0].slice(0, 10))]).toEqual([name, true]);
        measured[name] = { warm, draft, message };
      });
    }
    const short = measured["short"];
    const long = measured["long"];
    if (short === undefined || long === undefined) {
      throw new Error("both chats were expected to be measured");
    }
    console.log(JSON.stringify({ RS3: measured }));

    // Warming the long chat genuinely costs more: these are real wrapping
    // lines and the engine really measured them.
    expect(long.warm).toBeGreaterThan(short.warm);

    // And then it costs nothing. A keystroke's work is the frame's structure,
    // which is the same for both chats — so the count does not grow with a
    // history the keystroke did not change.
    expect(long.draft).toBe(short.draft);
    expect(long.message).toBe(short.message);
    expect(long.draft).toBeLessThan(long.warm);
  });

  /**
   * What one list of prepared rows states, as a comparison can read it.
   *
   * The rows themselves rather than the keys they mounted under: matching keys
   * cannot say that the text under them, or how many rows it took, is what an
   * unmeasured command would have drawn.
   */
  function shapeOf(
    rows: readonly ReplFittedLine[],
  ): readonly { readonly key: string; readonly line: string; readonly text: string }[] {
    return rows.map((one) => ({ key: one.key, line: one.line, text: one.text }));
  }

  it("RS4: growing one line measures only the line that grew", function* () {
    const held = yield* commanding();
    // Blank lines and a combining grapheme travel with this fixture, because
    // what the engine answers about them is the reason the cuts come from it.
    const settled = [
      `1. ${WRAPS}`,
      "a line\n\nwith a blank line of its own",
      `2. e\u0301\u0301 wide \u5e83\u3044 ${WRAPS}`,
    ];
    // And a final item that is still only what a turn is saying, which is the
    // line that is going to grow — under the key its reply will carry.
    const saying = `GROWING ${WRAPS}`;
    const withPreview = (text: string): readonly ReplSidekickChatRow[] => [
      ...repliesOf(settled),
      previewRow("chat-one", settled.length + 1, text),
    ];

    yield* held.commit(frameOf(chatOf(withPreview(saying)), { draft: "a" }, held.model));
    // The structural cost of a frame this shape, with nothing to refit.
    const baseline = yield* held.commit(
      frameOf(chatOf(withPreview(saying)), { draft: "ab" }, held.model),
    );

    // That same item's text grows, its key unchanged. Its new end is marked,
    // because a following chat shows a growing line's newest rows — which is
    // where the text that just arrived actually is.
    const grown = `GROWING ${WRAPS}${WRAPS} TAIL-GROWN`;
    const growing = yield* held.commit(
      frameOf(chatOf(withPreview(grown)), { draft: "ab" }, held.model),
    );
    // The text that just arrived is on the screen, under the same item.
    expect(held.screen()).toContain("TAIL-GROWN");
    // Then the next item is appended behind it.
    const appended = `4. ${WRAPS}`;
    const finalRows: readonly ReplSidekickChatRow[] = [
      ...withPreview(grown),
      replyRow("chat-one", settled.length + 2, appended),
    ];
    const appending = yield* held.commit(frameOf(chatOf(finalRows), { draft: "ab" }, held.model));

    // What fitting those changed lines costs on their own, at the width this
    // frame measured for the pane they are drawn in.
    const final = frameOf(chatOf(finalRows), { draft: "ab" }, held.model);
    const prepared = yield* prepareFrame(held.renderer, final);
    if (!prepared.ok) {
      throw prepared.error;
    }
    // The body's own width, not the pane's: the chat is inset by the gutter,
    // so that is the width its lines were actually fitted to.
    const room = prepared.value.context.widths?.body ?? 0;
    expect(room).toBeGreaterThan(0);
    const alone = function* (text: string): Operation<number> {
      held.renderer.reset();
      const fitted = yield* fitPlain(held.renderer, WIDE, [{ key: "alone", text }], room);
      if (!fitted.ok) {
        throw fitted.error;
      }
      return held.renderer.measures();
    };
    // Each row carries who said it, so the line the frame fits is the
    // composed one rather than the bare text.
    const grownAlone = yield* alone(`  scribe (preview): ${grown}`);
    const appendedAlone = yield* alone(`  scribe: ${appended}`);
    console.log(
      JSON.stringify({
        RS4: { baseline, growing, appending, grownAlone, appendedAlone, room },
      }),
    );

    // Each update paid for exactly the line it changed, and nothing for the
    // lines in front of it.
    expect(growing - baseline).toBe(grownAlone);
    expect(appending - baseline).toBe(appendedAlone);

    // And the rows a warm store prepared are the rows an unmeasured command
    // prepares: the same text, under the same keys, in the same order, and as
    // many of them.
    const warm = yield* held.prepared(final, true);
    const cold = yield* held.prepared(final, false);
    expect(shapeOf(warm)).toEqual(shapeOf(cold));
    expect(warm.length).toBe(cold.length);
    expect(warm.length).toBeGreaterThan(finalRows.length);

    // And the prepared rows hold the grown text whole, rather than the text
    // it replaced: concatenating one line's rows recovers exactly that line.
    const growns = shapeOf(warm)
      .filter((one) => one.line === `sidekick:chat-one:response:${settled.length + 1}`)
      .map((one) => one.text.trim())
      .join(" ");
    expect(growns).toContain("GROWING");
    expect(growns).toContain("TAIL-GROWN");
    expect(
      shapeOf(warm)
        .map((one) => one.text)
        .join(""),
    ).not.toContain(`${saying} `);
  });

  it("RS5: a hidden chat is not measured, and showing it measures what is there", function* () {
    const texts = Array.from({ length: 12 }, (_, at) => `${at + 1}. ${WRAPS}`);
    const longChat = chatOf(repliesOf(texts));
    const emptyChat = chatOf([]);

    // The first frame as well as a warmed one. Both commands warm the same
    // entry reading, so what differs between them is the chat alone.
    const hidden = function* (
      chat: ReplSidekickReading,
    ): Operation<{ readonly first: number; readonly typed: number }> {
      return yield* scoped(function* () {
        const own = yield* commanding();
        const first = yield* own.commit(frameOf(chat, { draft: "a", bindings: true }, own.model));
        const typed = yield* own.commit(frameOf(chat, { draft: "ab", bindings: true }, own.model));
        return { first, typed };
      });
    };
    const hiddenLong = yield* hidden(longChat);
    const hiddenEmpty = yield* hidden(emptyChat);
    console.log(JSON.stringify({ RS5: { hiddenLong, hiddenEmpty } }));

    // Behind Bindings a long chat costs what an empty one costs, from the
    // very first frame rather than only once something has been warmed.
    expect(hiddenLong.first).toBe(hiddenEmpty.first);
    expect(hiddenLong.typed).toBe(hiddenEmpty.typed);

    const held = yield* commanding();
    yield* held.commit(frameOf(longChat, { draft: "a", bindings: true }, held.model));

    // Shown, it is fitted against the geometry it has now and its own text is
    // on the screen: a hidden frame retained nothing that could stand in.
    const shown = frameOf(longChat, { draft: "ab" }, held.model);
    yield* held.commit(shown);
    expect(shapeOf(yield* held.prepared(shown, true))).toEqual(
      shapeOf(yield* held.prepared(shown, false)),
    );
    expect(held.screen()).toContain("12. This is a complete");

    // A resize, then a genuinely different chat, then a Preview that was
    // there and is withdrawn — one bounded sequence, each transition compared
    // with what an unmeasured command would prepare.
    const withdrawn = `WITHDRAWN ${WRAPS}`;
    const other = "chat-two";
    const sequence: readonly { readonly name: string; readonly view: ReplView }[] = [
      { name: "resized", view: frameOf(longChat, { draft: "ab" }, held.model, MEDIUM) },
      {
        name: "another chat, with its own identity",
        view: frameOf(
          chatOf(
            [...repliesOf(["only one message here"], other), previewRow(other, 2, withdrawn)],
            other,
          ),
          { draft: "ab" },
          held.model,
          MEDIUM,
        ),
      },
      {
        name: "its Preview withdrawn",
        view: frameOf(
          chatOf(repliesOf(["only one message here"], other), other),
          { draft: "ab" },
          held.model,
          MEDIUM,
        ),
      },
    ];
    for (const step of sequence) {
      yield* held.commit(step.view);
      const warm = yield* held.prepared(step.view, true);
      const cold = yield* held.prepared(step.view, false);
      expect([step.name, shapeOf(warm)]).toEqual([step.name, shapeOf(cold)]);
      expect([step.name, warm.length]).toEqual([step.name, cold.length]);
    }

    // The second chat's rows are the second chat's: its own conversation owns
    // them, and the first chat's reading is not in them.
    const second = yield* held.prepared(sequence[2].view, true);
    expect(second.every((one) => one.line.startsWith(`sidekick:${other}:`))).toBe(true);
    expect(
      shapeOf(second)
        .map((one) => one.text)
        .join(""),
    ).not.toContain("12. This is");

    // And the withdrawn Preview is gone from what is prepared and from the
    // screen: a retained cut never authorizes drawing text the display facts
    // no longer hold.
    expect(
      shapeOf(second)
        .map((one) => one.text)
        .join(""),
    ).not.toContain("WITHDRAWN");
    expect(held.screen(MEDIUM)).not.toContain("WITHDRAWN");
  });
});

/**
 * Tier PW — the space after the sidebar, shared (#883).
 *
 * The right column was a fixed 36 cells wide at 160 and 28 at 120. It holds a
 * conversation, so the Product Owner accepted splitting what the sidebar leaves
 * equally with the Transcript, with the spare cell of an odd remainder going to
 * the Transcript rather than to fractional geometry.
 *
 * Every expected number here is the accepted table's. Nothing asks
 * `inspectionWidth` what it thinks: a test that did would agree with the
 * product however it drifted.
 *
 * **Ordinary kernel.** This is `reading()` again — `viewFor` with no workspace —
 * so what it pins is the column primitive, not the screen a person is offered.
 * The shipping appearance of the three accepted profiles is the appearance
 * records' subject; this one also asks about an odd 161 column, which is not a
 * profile and not the odd History remainder, and about the Bindings body, which
 * those records never select.
 */
describe("REPL kernel — ordinary column shares and pane bodies", () => {
  // The fixture entry publishes its binding from an eval block, and the
  // Bindings reading below measures the row that binding draws. Without the
  // compiler that block refuses and the pane has nothing in it to measure.
  beforeAll(() => useTempFileCompiler());
  /** The accepted table, as columns of whole cells. */
  const SHARES: readonly {
    readonly name: string;
    readonly size: ReplTerminalSize;
    readonly sidebar: number;
    readonly transcript: number;
    readonly right: number;
    readonly rightStartsAt: number;
    /**
     * The two accepted bodies of the right pane, where the table states them.
     *
     * The pane holds either reading, and they are not inset alike. `bindings`
     * is the pane's own interior — the pane less the one edge it draws — which
     * is the body a binding row has always been written to. `sidekick` is that
     * interior inset two cells on each side, which is what was asked for about
     * the conversation. Both are the accepted table's own numbers rather than
     * a subtraction performed here.
     */
    readonly body?: {
      readonly bindings: { readonly startsAt: number; readonly width: number };
      readonly sidekick: { readonly startsAt: number; readonly width: number };
    };
  }[] = Object.freeze([
    {
      name: "160x36",
      size: WIDE,
      sidebar: 36,
      transcript: 62,
      right: 62,
      rightStartsAt: 98,
      body: { bindings: { startsAt: 99, width: 61 }, sidekick: { startsAt: 101, width: 57 } },
    },
    {
      name: "120x30",
      size: MEDIUM,
      sidebar: 36,
      transcript: 42,
      right: 42,
      rightStartsAt: 78,
      body: { bindings: { startsAt: 79, width: 41 }, sidekick: { startsAt: 81, width: 37 } },
    },
    {
      name: "161x36",
      size: { columns: 161, rows: 36 },
      sidebar: 36,
      transcript: 63,
      right: 62,
      rightStartsAt: 99,
      body: { bindings: { startsAt: 100, width: 61 }, sidekick: { startsAt: 102, width: 57 } },
    },
  ]);

  it("PW1 kernel: ordinary shares and pane bodies remain whole under both tabs", function* () {
    const model = yield* settledAndFailed();
    for (const share of SHARES) {
      for (const tab of [
        { name: "Sidekick", sidekick: true, select: (state: ReplState) => state },
        { name: "Bindings", sidekick: false, select: inspecting },
      ]) {
        const where = `${share.name} ${tab.name}`;
        yield* scoped(function* (): Operation<void> {
          const presenter = yield* usePresenter(share.size);
          // The first entry selected, so the Bindings reading has a real
          // binding row to measure rather than an empty pane: the row is the
          // thing the accepted body width is about.
          const observed = yield* presenter.commit(
            reading(
              tab.select(selecting(stateWith({}), "entry-1")),
              model,
              NOTHING_LIVE,
              share.size,
            ),
          );
          const { grid } = presenter;
          const bounds = (region: string): ReplBounds => {
            const found = regionBounds(observed, region);
            if (found === undefined) {
              throw new Error(`${where} published no ${region} region`);
            }
            return found;
          };
          const sidebar = bounds("sidebar");
          const transcript = bounds("transcript");
          const right = bounds("inspection");

          // The accepted shares, as outer columns.
          expect([where, sidebar.x, sidebar.width]).toEqual([where, 0, share.sidebar]);
          expect([where, transcript.x, transcript.width]).toEqual([
            where,
            share.sidebar,
            share.transcript,
          ]);
          expect([where, right.x, right.width]).toEqual([where, share.rightStartsAt, share.right]);

          // Whole cells, and the three of them exactly the terminal: no column
          // overlaps the one beside it and none of the row is unaccounted for.
          for (const [name, one] of [
            ["sidebar", sidebar],
            ["transcript", transcript],
            ["right", right],
          ] as const) {
            expect([where, name, Number.isInteger(one.width)]).toEqual([where, name, true]);
            expect([where, name, Number.isInteger(one.x)]).toEqual([where, name, true]);
          }
          expect([where, sidebar.width + transcript.width + right.width]).toEqual([
            where,
            share.size.columns,
          ]);
          expect([where, transcript.x]).toEqual([where, sidebar.x + sidebar.width]);
          expect([where, right.x]).toEqual([where, transcript.x + transcript.width]);

          // Both header edges are still drawn, across the columns they close.
          const rightHeader = observed.regionOf(TAB_ROW);
          if (rightHeader === undefined) {
            throw new Error(`${where} published no tab row`);
          }
          for (const [name, header] of [
            ["transcript", placed(observed, "transcript:heading")],
            ["right", rightHeader],
          ] as const) {
            expect([
              where,
              name,
              grid.styleAt(header.x + header.width - 1, header.y + 1).foreground,
            ]).toEqual([where, name, ACCEPTED_EDGE.chrome]);
          }

          // Whichever of the two bodies this reading has. The inset was asked
          // for about the Sidekick's own body, so the other reading keeps the
          // pane it always had — and a row four cells narrower than the source
          // it quotes is the regression this distinguishes.
          const body = share.body;
          if (body !== undefined) {
            const inside = observed.regionOf(SIDEKICK_BODY);
            if (tab.sidekick) {
              if (inside === undefined) {
                throw new Error(`${where} published no Sidekick body`);
              }
              expect([where, inside.x, inside.width]).toEqual([
                where,
                body.sidekick.startsAt,
                body.sidekick.width,
              ]);
              // Every body row is inside that width, and the gutters hold no
              // text of their own.
              for (const key of observed.keys) {
                const row = observed.boundsOf(key);
                if (row === undefined || !within(row, inside)) {
                  continue;
                }
                expect([where, key, row.x, row.width]).toEqual([
                  where,
                  key,
                  inside.x,
                  inside.width,
                ]);
              }
              const { startsAt, width } = body.sidekick;
              for (const gutter of [startsAt - 1, startsAt + width]) {
                expect([where, gutter, grid.at(gutter, inside.y)]).toEqual([where, gutter, " "]);
              }
            } else {
              // No inset body is published for this reading at all, which is
              // what leaves the measured body width the pane's own.
              expect([where, inside]).toEqual([where, undefined]);
              const binding = observed.boundsOf("binding:kept");
              if (binding === undefined) {
                throw new Error(`${where} drew no binding row to measure`);
              }
              expect([where, binding.x, binding.width]).toEqual([
                where,
                body.bindings.startsAt,
                body.bindings.width,
              ]);
            }
            // The header spans the whole pane, which is the point of measuring
            // it and the body separately. It is the tab band that spans it: the
            // two tabs inside take their own labels, and the row they share is
            // the column's full inner width.
            expect([where, rightHeader.width]).toEqual([where, right.width - 1]);
          }

          // And the footer is the seven rows it has always been.
          expect([where, bounds("footer").height]).toEqual([where, FOOTER_ROWS]);
        });
      }
    }
  });
});

/**
 * Tier AR — a retained reading larger than one measuring render (A2).
 *
 * The frame is the point. A finished reading is as long as the entry that
 * produced it, and measuring every one of its candidates in a single render
 * refused on a long enough entry — so the command died before it drew
 * anything, with no frame to scroll and no reading to read. Everything here
 * goes through the real presenter: the commit, the window the frame measured
 * and the action a person presses to move it.
 */
describe("Tier AR — a retained reading larger than one measuring render", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * One entry with more lines than a measuring render carries.
   *
   * Prose rather than elements, because what is under test is the length of
   * the reading and not the work of evaluating it. Blank lines are in it
   * deliberately: an empty candidate is measured differently from a full one,
   * and a batch boundary is exactly where that difference could be dropped.
   */
  const LONG = Array.from({ length: 1400 }, (_, at) =>
    at % 5 === 4 ? "" : `Line ${at} of a retained entry, kept exactly as it was written.`,
  ).join("\n");

  function* longReading(): Operation<ReplModel> {
    const physical = new InMemoryStream();
    yield* runEntry(physical, LONG);
    return projected(yield* physical.readAll());
  }

  it("A2: it commits, its window reaches later rows, and the draft and History survive", function* () {
    const model = yield* longReading();
    const presenter = yield* usePresenter(WIDE);
    const DRAFT = "a draft nothing here types over";
    let state = selecting(stateWith({ draft: DRAFT }), "entry-1");
    const viewOf = (one: ReplState): ReplView => reading(one, model, NOTHING_LIVE, WIDE);

    // A frame at all. This is the commit that used to refuse.
    const observed = yield* presenter.commit(viewOf(state));
    if (viewportBounds(observed, READING_WINDOW) === undefined) {
      throw new Error("this frame published no reading window");
    }

    // The whole reading exists, and the viewport is what limits the drawing:
    // more rows than one render carries, and more than the pane can hold.
    const first = windowOf(yield* presenter.prepare(viewOf(state)), READING_WINDOW);
    expect(first.total).toBeGreaterThan(1024);
    expect(first.capacity).toBeLessThan(first.total);
    expect(first.from).toBe(0);
    expect(first.more).toBe(true);

    // Later rows, reached the way a reader reaches them: against the window
    // each frame measured, one press at a time. A few presses are enough: what
    // is under test is that the window moves over a reading this long at all.
    for (let press = 0; press < 6; press += 1) {
      state = reduceRepl(
        state,
        { kind: "scroll-reading", delta: 1 },
        model,
        NOTHING_LIVE,
        yield* presenter.prepare(viewOf(state)),
      ).state;
      yield* presenter.commit(viewOf(state));
    }
    const moved = windowOf(yield* presenter.prepare(viewOf(state)), READING_WINDOW);
    expect(moved.from).toBeGreaterThan(0);
    // The reading did not get shorter to fit the engine.
    expect(moved.total).toBe(first.total);

    // Nothing above typed over the draft.
    expect(state.draft).toBe(DRAFT);

    // History still opens over this reading, and one Close still leaves it.
    const over = opening(state);
    const opened = yield* presenter.commit(viewOf(over));
    expect(opened.boundsOf("drawer:open")).toBeDefined();
    const closed = reduceRepl(
      over,
      { kind: "close-drawer" },
      model,
      NOTHING_LIVE,
      yield* presenter.prepare(viewOf(over)),
    ).state;
    expect(closed.route.drawers.length).toBe(0);
    const after = yield* presenter.commit(viewOf(closed));
    expect(after.boundsOf("drawer:open")).toBeUndefined();
    expect(closed.draft).toBe(DRAFT);
  });
});

/**
 * Tier UH — the right pane's one header row, and the space above three headings.
 *
 * The Product Owner asked for Bindings and Sidekick beside each other with each
 * name said once, and for space between the top of the screen and the headings
 * of all three columns. What was there said Sidekick twice while the Sidekick
 * was the reading — once as the pane's title and once on its tab — and marked
 * the selection with the literal word `[selected]`, which the amendment
 * supersedes: the active styling says it, and keyboard focus stays the separate
 * mark it has always been.
 *
 * Read in cells and bounds rather than in the description, because the request
 * was about what the screen looks like. One row is the accepted gap.
 */
describe("Tier UH — horizontal pane tabs and the gap above each column heading", () => {
  beforeAll(() => useTempFileCompiler());

  it("UH1: both tabs are one header row, named once, with selection and focus apart", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      for (const { name, select, active } of [
        { name: "Sidekick", select: (one: ReplState) => one, active: "tab:sidekick" },
        { name: "Bindings", select: inspecting, active: "tab:bindings" },
      ]) {
        const where = `${size.columns}x${size.rows} ${name}`;
        const presenter = yield* usePresenter(size);
        // Focus put on the tab that is *not* selected, which is the one frame
        // where a label-shaped indicator and a focus mark cannot be confused.
        const observed = yield* presenter.commit(
          reading(
            select(stateWith({})),
            model,
            NOTHING_LIVE,
            size,
            active === "tab:sidekick" ? "tab:bindings" : "tab:sidekick",
          ),
        );
        const { grid } = presenter;

        const bindings = placed(observed, "tab:bindings");
        const sidekick = placed(observed, "tab:sidekick");
        const band = observed.regionOf(TAB_ROW);
        const right = regionBounds(observed, "inspection");
        const inside = observed.regionOf("box:inspection:content");
        if (band === undefined || right === undefined || inside === undefined) {
          throw new Error(`${where} published no tab row or right column`);
        }

        // One row, Bindings then Sidekick, in boxes that do not overlap and do
        // not leave the column.
        expect([where, bindings.y, sidekick.y, band.y]).toEqual([where, band.y, band.y, band.y]);
        expect([where, bindings.x < sidekick.x]).toEqual([where, true]);
        expect([where, sidekick.x >= bindings.x + bindings.width]).toEqual([where, true]);
        for (const [key, box] of [
          ["tab:bindings", bindings],
          ["tab:sidekick", sidekick],
        ] as const) {
          expect([where, key, box.x >= inside.x]).toEqual([where, key, true]);
          expect([where, key, box.x + box.width <= inside.x + inside.width]).toEqual([
            where,
            key,
            true,
          ]);
          // Its own label and not the column's width, which is what lets two
          // of them share one row.
          expect([where, key, box.width < inside.width]).toEqual([where, key, true]);
        }

        // The band is the column's full inner width, closed by the one edge
        // directly beneath it: the header is one row now, not three.
        expect([where, band.width]).toEqual([where, inside.width]);
        expect([where, band.x]).toEqual([where, inside.x]);
        expect([where, grid.styleAt(band.x, band.y + 1).foreground]).toEqual([
          where,
          ACCEPTED_EDGE.chrome,
        ]);

        // Each name once, across the whole band, and no title repeating it.
        const header = textOf(grid, band);
        for (const label of ["Bindings", "Sidekick"]) {
          expect([where, label, header.split(label).length - 1]).toEqual([where, label, 1]);
        }
        expect([where, header.includes("[selected]")]).toEqual([where, false]);
        expect([where, observed.keys.includes("inspection:heading")]).toEqual([where, false]);

        // Which one is selected, and separately where the next keystroke lands.
        // Two marks, on two different tabs, so neither stands in for the other.
        const idle = active === "tab:sidekick" ? "tab:bindings" : "tab:sidekick";
        expect([where, inkOf(grid, placed(observed, active)).foreground]).toEqual([
          where,
          SEMANTIC.intro,
        ]);
        expect([where, inkOf(grid, placed(observed, idle)).foreground]).toEqual([
          where,
          REPL_PALETTE.focus,
        ]);

        // Both are still real controls, each with a target of its own.
        for (const key of ["tab:bindings", "tab:sidekick"]) {
          const node = observed.nodeOf(key);
          expect([where, key, observed.targets.filter((one) => one.node === node).length]).toEqual([
            where,
            key,
            1,
          ]);
        }
      }
    }
  });

  it("UH3: one row of space above all three headings, holding nothing reachable", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(
        reading(selecting(stateWith({}), "entry-1"), model, NOTHING_LIVE, size),
      );
      const { grid } = presenter;

      // The first row of each column's own content, and the gap above it.
      const first: readonly { readonly region: "sidebar" | "transcript"; readonly key: string }[] =
        [
          { region: "sidebar", key: "sessions:heading" },
          { region: "transcript", key: "transcript:heading" },
        ];
      for (const { region, key } of first) {
        const column = regionBounds(observed, region);
        if (column === undefined) {
          throw new Error(`${where} published no ${region} column`);
        }
        expect([where, key, placed(observed, key).y]).toEqual([
          where,
          key,
          column.y + COLUMN_TOP_GAP,
        ]);
      }
      const band = observed.regionOf(TAB_ROW);
      const right = regionBounds(observed, "inspection");
      if (band === undefined || right === undefined) {
        throw new Error(`${where} published no tab row`);
      }
      expect([where, band.y]).toEqual([where, right.y + COLUMN_TOP_GAP]);

      // Nothing is in the gap: no mounted row of any column was drawn there and
      // no pointer target covers it, so it is space rather than a blank control.
      for (const region of ["sidebar", "transcript", "inspection"] as const) {
        const column = regionBounds(observed, region);
        if (column === undefined) {
          throw new Error(`${where} published no ${region} column`);
        }
        for (let y = column.y; y < column.y + COLUMN_TOP_GAP; y += 1) {
          for (const key of observed.keys) {
            const bounds = observed.boundsOf(key);
            if (bounds === undefined) {
              continue;
            }
            const covers =
              bounds.y <= y &&
              y < bounds.y + bounds.height &&
              bounds.x < column.x + column.width &&
              column.x < bounds.x + bounds.width;
            expect([where, region, y, key, covers]).toEqual([where, region, y, key, false]);
          }
          for (const target of observed.targets) {
            const covers =
              target.bounds.y <= y &&
              y < target.bounds.y + target.bounds.height &&
              target.bounds.x < column.x + column.width &&
              column.x < target.bounds.x + target.bounds.width;
            expect([where, region, y, target.node, covers]).toEqual([
              where,
              region,
              y,
              target.node,
              false,
            ]);
          }
        }
      }

      // The lower Entries heading is the column's second reading rather than
      // the top of a fourth column, so it takes no gap of its own.
      const sessions = placed(observed, "sessions:heading");
      const entries = placed(observed, "entries:heading");
      expect([where, entries.y > sessions.y]).toEqual([where, true]);

      // And the room below is the engine's own remainder: the footer still has
      // its seven rows, and the reading window ends above them.
      const footer = regionBounds(observed, "footer");
      const window = viewportBounds(observed, READING_WINDOW);
      if (footer === undefined || window === undefined) {
        throw new Error(`${where} published no footer or reading window`);
      }
      expect([where, footer.height]).toEqual([where, FOOTER_ROWS]);
      expect([where, window.y + window.height <= footer.y]).toEqual([where, true]);
      expect([where, window.height > 0]).toEqual([where, true]);
    }
  });
});

/**
 * Tier UH5 — a route drawer stays clear of the guidance it must not cover.
 *
 * The one row of space above each column heading moved every column's content
 * down a row, and this layer floats at a rectangle the terminal's size alone
 * decided — so the row it gained was the guidance, which is where the screen
 * says how to close the drawer in front of it. The accepted envelope keeps the
 * drawer's horizontal bounds and its bottom edge and begins it below the whole
 * fitted block, spending its own window rather than the footer's rows.
 *
 * Geometry here, against the committed frame and the published rectangles;
 * actual visibility and closing are the mounted row's in the sidekick
 * presentation file. The whole block, not its first row: the directions wrap,
 * and a drawer clearing one row of a three-row block still hides two of them.
 */
describe("Tier UH5 — the guidance above a route drawer", () => {
  beforeAll(() => useTempFileCompiler());

  it("UH5: the whole fitted guidance block is above the drawer, at three sizes", function* () {
    const model = yield* settledAndFailed();
    let wrapped = 0;
    for (const size of [WIDE, MEDIUM, LARGE]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      const view = reading(opening(selecting(stateWith({}), "entry-1")), model, NOTHING_LIVE, size);
      const observed = yield* presenter.commit(view);
      const { grid } = presenter;

      // Every row the directions were fitted into, by the keys that describe
      // them, in the order they are read.
      const keys = observed.keys.filter(
        (key) => key === "guidance" || key.startsWith("guidance:row:"),
      );
      expect([where, keys.length > 0]).toEqual([where, true]);
      if (keys.length > 1) {
        wrapped += 1;
      }

      const layer = observed.regionOf("box:drawer:layer");
      const base = drawerRect(size);
      const footer = regionBounds(observed, "footer");
      if (layer === undefined || base === undefined || footer === undefined) {
        throw new Error(`${where} published no drawer layer, rectangle or footer`);
      }

      // Not one row of the block is inside the layer, and every one of them
      // still holds the text it was fitted to: a covered row is drawn and then
      // painted over, so the cells are the evidence rather than the bounds
      // alone.
      const said: string[] = [];
      for (const key of keys) {
        const bounds = placed(observed, key);
        expect([where, key, bounds.y + bounds.height <= layer.y]).toEqual([where, key, true]);
        said.push(textOf(grid, bounds).trim());
      }
      const block = said.join(" ").replace(/\s+/g, " ").trim();

      // The whole of what this width composed, across however many rows it
      // took — compared by content rather than by a sentence written here, which
      // would be a different sentence at each of these three widths.
      for (const word of guidanceSentence(view)
        .split(/\s+/)
        .filter((one) => one.length > 0)) {
        expect([where, word, block.includes(word)]).toEqual([where, word, true]);
      }
      // Including the way out of the drawer that is in front of it.
      expect([where, block.includes("Esc closes")]).toEqual([where, true]);

      // The envelope: the same columns and the same bottom edge it has always
      // had, so moving down was paid for out of this drawer's own window.
      expect([where, layer.x, layer.width]).toEqual([where, base.x, base.width]);
      expect([where, layer.y + layer.height]).toEqual([where, base.y + base.height]);
      expect([where, layer.y >= base.y]).toEqual([where, true]);
      // And still above the seven rows that are never covered.
      expect([where, layer.y + layer.height <= footer.y]).toEqual([where, true]);
      expect([where, footer.height]).toEqual([where, FOOTER_ROWS]);

      // A window with room in it, and the three controls that move and close
      // it, each a real target outside the thing it moves.
      const window = viewportBounds(observed, DRAWER_WINDOW);
      if (window === undefined) {
        throw new Error(`${where} published no drawer window`);
      }
      expect([where, window.height > 0]).toEqual([where, true]);
      for (const key of ["drawer:scroll:up", "drawer:scroll:down", "drawer:close"]) {
        const node = observed.nodeOf(key);
        expect([where, key, node !== undefined]).toEqual([where, key, true]);
        expect([where, key, observed.targets.some((one) => one.node === node)]).toEqual([
          where,
          key,
          true,
        ]);
      }
    }
    // At least one of the three wrapped the directions over more than one row,
    // which is what makes the claim above stronger than protecting the first.
    expect(wrapped).toBeGreaterThan(0);
  });
});

/**
 * Tier BP — the three shared bodies, inset alike (#883).
 *
 * The Product Owner asked for the Transcript and Sessions to have the same
 * padding the Sidekick's body already had. So every shared column now draws two
 * boxes: the pane, which its heading band spans, and the body inset two cells
 * on each side, which everything a person reads in that column is built to.
 *
 * Read from the committed frame's own geometry and cells. The gutters are the
 * point: they hold nothing, reach nothing, and carry the column they belong to.
 */
describe("Tier BP — matching body padding in the three shared columns", () => {
  beforeAll(() => useTempFileCompiler());

  it("BP1: each shared body is inset two cells, and its gutters hold nothing", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      // The Sidekick selected, so all three bodies are drawn in one frame and
      // the one that was already inset is measured beside the two that are new.
      const observed = yield* presenter.commit(
        reading(selecting(stateWith({}), "entry-1"), model, NOTHING_LIVE, size),
      );
      const { grid } = presenter;

      const columns: readonly {
        readonly name: string;
        readonly pane: string;
        readonly body: string;
        readonly surface: number;
      }[] = [
        {
          name: "transcript",
          pane: "box:transcript:content",
          body: TRANSCRIPT_BODY,
          surface: ACCEPTED_SURFACE.centre,
        },
        {
          name: "sidebar",
          pane: "box:sidebar",
          body: SIDEBAR_BODY,
          surface: ACCEPTED_SURFACE.side,
        },
        {
          name: "inspection",
          pane: "box:inspection:content",
          body: SIDEKICK_BODY,
          surface: ACCEPTED_SURFACE.right,
        },
      ];

      for (const { name, pane, body, surface } of columns) {
        const outer = observed.regionOf(pane);
        const inner = observed.regionOf(body);
        if (outer === undefined || inner === undefined) {
          throw new Error(`${where} published no ${name} pane or body`);
        }
        // Two cells on each side, which is the Sidekick's accepted gutter and
        // now every shared column's.
        expect([where, name, inner.width]).toEqual([where, name, outer.width - BODY_GUTTER * 2]);
        expect([where, name, inner.x]).toEqual([where, name, outer.x + BODY_GUTTER]);

        // The gutters hold no text and carry the column they are part of, so
        // the inset reads as space in that pane rather than as a seam.
        for (const x of [inner.x - 1, inner.x - BODY_GUTTER, inner.x + inner.width]) {
          expect([where, name, x, grid.at(x, inner.y)]).toEqual([where, name, x, " "]);
          expect([where, name, x, grid.styleAt(x, inner.y).background]).toEqual([
            where,
            name,
            x,
            surface,
          ]);
        }

        // Every row this column drew inside that body, and every target over
        // it, stays within the body: a row built to the pane would publish a
        // hit box reaching into a gutter that is meant to be untouchable.
        for (const key of observed.keys) {
          const bounds = observed.boundsOf(key);
          if (bounds === undefined || !within(bounds, inner)) {
            continue;
          }
          expect([where, name, key, bounds.x >= inner.x]).toEqual([where, name, key, true]);
          expect([where, name, key, bounds.x + bounds.width <= inner.x + inner.width]).toEqual([
            where,
            name,
            key,
            true,
          ]);
        }
      }

      // What the inset did not touch: the heading band still spans the pane,
      // the header edge still closes it, and the outer columns did not move.
      const transcriptPane = observed.regionOf("box:transcript:content");
      const heading = placed(observed, "transcript:heading");
      const band = observed.regionOf(TAB_ROW);
      const inspection = observed.regionOf("box:inspection:content");
      if (transcriptPane === undefined || band === undefined || inspection === undefined) {
        throw new Error(`${where} published no pane, tab row or inspection interior`);
      }
      // The band spans the whole inner column, and the title *inside* it is
      // inset by the same gutter the body is — so the column's name lines up
      // with what it names while the header surface and its rule still cover
      // the full width.
      const headerBand = observed.regionOf("box:transcript:header");
      if (headerBand === undefined) {
        throw new Error(`${where} published no transcript header band`);
      }
      expect([where, headerBand.width]).toEqual([where, transcriptPane.width]);
      expect([where, heading.width]).toEqual([where, transcriptPane.width - BODY_GUTTER * 2]);
      expect([where, heading.x]).toEqual([where, transcriptPane.x + BODY_GUTTER]);
      expect([where, band.width]).toEqual([where, inspection.width]);
      expect([where, regionBounds(observed, "sidebar")?.width]).toEqual([
        where,
        sidebarWidth(size),
      ]);
      expect([where, regionBounds(observed, "inspection")?.width]).toEqual([
        where,
        inspectionWidth(size),
      ]);
      expect([where, regionBounds(observed, "footer")?.height]).toEqual([where, FOOTER_ROWS]);
      // And the gap above each heading is still one row.
      const column = regionBounds(observed, "transcript");
      if (column === undefined) {
        throw new Error(`${where} published no transcript column`);
      }
      expect([where, heading.y]).toEqual([where, column.y + COLUMN_TOP_GAP]);
    }
  });

  it("BP2: a reading that now wraps keeps its whole text, in order, with room to scroll", function* () {
    // A source line longer than any body this frame has, so the inset is what
    // decides how many rows it takes.
    const model = yield* submittedWithLongSource();
    for (const size of [WIDE, MEDIUM]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      const observed = yield* presenter.commit(
        reading(selecting(stateWith({}), "entry-1"), model, NOTHING_LIVE, size),
      );
      const { grid } = presenter;

      const body = observed.regionOf(TRANSCRIPT_BODY);
      const footer = regionBounds(observed, "footer");
      if (body === undefined || footer === undefined) {
        throw new Error(`${where} published no transcript body or footer`);
      }

      // The line really was cut: a continuation row is what a wrapped line
      // produces, and without one this case proves nothing about wrapping.
      const rows = observed.keys.filter((key) => key.startsWith("reading:"));
      expect([where, rows.some((key) => key.includes("+"))]).toEqual([where, true]);

      // Its text survives the cut, across the rows it was cut into and in the
      // order they are drawn. Read from the cells, joined inside this body
      // alone — joining across the row would splice in the column beside it —
      // and gathered through the window's own control, because a reading longer
      // than its window is reached rather than drawn all at once. Scrolling
      // moves the viewport and writes nothing.
      const gather = (frame: Observed): string =>
        frame.keys
          .filter((key) => key.startsWith("reading:"))
          .map((key) => ({ key, bounds: frame.boundsOf(key) }))
          .filter((one) => one.bounds !== undefined && within(one.bounds, body))
          .sort((one, two) => (one.bounds?.y ?? 0) - (two.bounds?.y ?? 0))
          .map((one) => textOf(grid, one.bounds ?? body).trim())
          .join(" ");
      let state = selecting(stateWith({}), "entry-1");
      let said = gather(observed);
      for (let press = 0; press < 80; press += 1) {
        const view = reading(state, model, NOTHING_LIVE, size);
        state = reduceRepl(
          state,
          { kind: "scroll-reading", delta: 1 },
          model,
          NOTHING_LIVE,
          yield* presenter.prepare(view),
        ).state;
        const next = yield* presenter.commit(reading(state, model, NOTHING_LIVE, size));
        const shown = gather(next);
        if (said.includes(shown)) {
          break;
        }
        said = `${said} ${shown}`;
      }
      said = said.replace(/\s+/g, " ");
      // The prose line of the fixture, which is the one longer than any pane
      // and the one whose words have to survive being cut.
      const longest = LONG_SOURCE.split("\n").filter((line) => line.includes(" "))[0] ?? "";
      expect([where, longest.length > body.width]).toEqual([where, true]);
      for (const word of longest.split(/\s+/).filter((one) => one.length > 2)) {
        expect([where, word, said.includes(word)]).toEqual([where, word, true]);
      }

      // And there is room to read it in: both windows have measured height and
      // end above the seven rows the footer keeps.
      for (const window of [READING_WINDOW, SESSIONS_WINDOW]) {
        const viewport = viewportBounds(observed, window);
        if (viewport === undefined) {
          throw new Error(`${where} published no ${window} window`);
        }
        expect([where, window, viewport.height > 0]).toEqual([where, window, true]);
        expect([where, window, viewport.y + viewport.height <= footer.y]).toEqual([
          where,
          window,
          true,
        ]);
      }
      // The controls that reach what the window does not hold are mounted and
      // are real targets, outside the thing they move.
      for (const key of ["reading:earlier", "reading:later"]) {
        const node = observed.nodeOf(key);
        expect([where, key, node !== undefined]).toEqual([where, key, true]);
        expect([where, key, observed.targets.some((one) => one.node === node)]).toEqual([
          where,
          key,
          true,
        ]);
      }
    }
  });
});

/**
 * Tier BP5 — the header's own space, its inset title, and pane navigation.
 *
 * Three Product Owner corrections to the padding increment. The Transcript's
 * name lines up with what is under it. The blank row above a column's heading
 * belongs to that column's header band and is painted with it, rather than
 * reading as a strip of the reading pushed down. And the two controls that move
 * a window take the pane they navigate: `Earlier`/`Later` inherited the generic
 * action surface, which drew a dark bar across the top and bottom of every
 * reading.
 *
 * Read from the committed cells, because all three are about what the screen
 * looks like.
 */
describe("Tier BP5 — header space, the inset title and pane navigation", () => {
  beforeAll(() => useTempFileCompiler());

  /** One chat with rows enough to be worth a window of its own. */
  function chatting(): ReplSidekickReading {
    const conversation = "chat-nav";
    const chat: readonly ReplSidekickChatRow[] = Object.freeze(
      ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((text, at) =>
        Object.freeze({
          key: `${conversation}:response:${at + 1}`,
          conversation,
          turn: at + 1,
          kind: "reply" as const,
          text,
          hasOutput: false,
          failure: undefined,
        }),
      ),
    );
    return Object.freeze({
      agent: "scribe",
      busy: false,
      refusal: undefined,
      question: undefined,
      requested: undefined,
      verified: undefined,
      conversation,
      reading: conversation,
      current: true,
      turns: [],
      availability: { chats: [conversation], sessions: [], refusal: undefined },
      chat,
    });
  }

  it("BP5: the title is inset, the header owns its gap, and navigation takes its pane", function* () {
    const model = yield* settledAndFailed();
    for (const size of [WIDE, MEDIUM]) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      const live: ReplLive = { ...NOTHING_LIVE, sidekick: chatting() };
      const state = selecting(stateWith({}), "entry-1");
      const observed = yield* presenter.commit(reading(state, model, live, size));
      const { grid } = presenter;

      const pane = observed.regionOf("box:transcript:content");
      const band = observed.regionOf("box:transcript:header");
      const column = regionBounds(observed, "transcript");
      if (pane === undefined || band === undefined || column === undefined) {
        throw new Error(`${where} published no transcript pane, band or column`);
      }

      // 1. The title's text begins two cells inside the column, while its band
      // and the rule under it still cover the whole inner width.
      const title = placed(observed, "transcript:heading");
      expect([where, title.x]).toEqual([where, pane.x + BODY_GUTTER]);
      expect([where, textOf(grid, title).trim()]).toEqual([where, "Transcript"]);
      expect([where, band.x, band.width]).toEqual([where, pane.x, pane.width]);
      // Still on the accepted gap's row, and still something you only read.
      expect([where, title.y]).toEqual([where, column.y + COLUMN_TOP_GAP]);
      expect([
        where,
        observed.targets.some((one) => one.node === observed.nodeOf("transcript:heading")),
      ]).toEqual([where, false]);
      // The rule that closes the band, across its full width.
      for (const x of [band.x, band.x + Math.floor(band.width / 2), band.x + band.width - 1]) {
        expect([where, x, grid.styleAt(x, title.y + 1).foreground]).toEqual([
          where,
          x,
          ACCEPTED_EDGE.chrome,
        ]);
      }

      // 2. The blank row above each heading belongs to that column's header
      // band, read in cells beyond where any label reaches. Under both tabs,
      // because the right pane's header is the same band either way.
      for (const right of [state, inspecting(state)]) {
        const frame = yield* presenter.commit(reading(right, model, live, size));
        const which = right === state ? "sidekick" : "bindings";
        for (const [region, surface] of [
          ["transcript", ACCEPTED_SURFACE.transcriptHeader],
          ["inspection", ACCEPTED_SURFACE.rightHeader],
        ] as const) {
          const bounds = regionBounds(frame, region);
          if (bounds === undefined) {
            throw new Error(`${where} ${which} published no ${region} column`);
          }
          for (let y = bounds.y; y < bounds.y + COLUMN_TOP_GAP; y += 1) {
            for (const x of [bounds.x + bounds.width - 1, bounds.x + bounds.width - 2]) {
              expect([where, which, region, x, grid.at(x, y)]).toEqual([
                where,
                which,
                region,
                x,
                " ",
              ]);
              expect([where, which, region, x, grid.styleAt(x, y).background]).toEqual([
                where,
                which,
                region,
                x,
                surface,
              ]);
            }
          }
        }
        // The sidebar has no band, so its own top space keeps its own surface.
        const sidebar = regionBounds(frame, "sidebar");
        if (sidebar === undefined) {
          throw new Error(`${where} ${which} published no sidebar`);
        }
        expect([
          where,
          which,
          grid.styleAt(sidebar.x + sidebar.width - 1, sidebar.y).background,
        ]).toEqual([where, which, ACCEPTED_SURFACE.side]);
      }

      // 3. Every window's own two controls take the pane they navigate, rather
      // than the dark surface a generic action carries.
      const panes: readonly { readonly keys: readonly string[]; readonly surface: number }[] = [
        {
          keys: ["sessions:earlier", "sessions:later", "entries:earlier", "entries:later"],
          surface: ACCEPTED_SURFACE.side,
        },
        { keys: ["reading:earlier", "reading:later"], surface: ACCEPTED_SURFACE.centre },
        { keys: ["sidekick:earlier", "sidekick:later"], surface: ACCEPTED_SURFACE.right },
      ];
      let navigation = 0;
      for (const { keys, surface } of panes) {
        let covered = 0;
        for (const key of keys) {
          const bounds = observed.boundsOf(key);
          if (bounds === undefined) {
            continue;
          }
          navigation += 1;
          expect([where, key, grid.styleAt(bounds.x, bounds.y).background]).toEqual([
            where,
            key,
            surface,
          ]);
          // And the same with focus on it: these backgrounds say which pane a
          // control belongs to, never where the next keystroke lands — so the
          // pane shows through either way and the cue is the foreground.
          const focused = yield* presenter.commit(reading(state, model, live, size, key));
          const row = placed(focused, key);
          expect([where, key, grid.styleAt(row.x, row.y).background]).toEqual([
            where,
            key,
            surface,
          ]);
          expect([where, key, inkOf(grid, row).foreground]).toEqual([
            where,
            key,
            REPL_PALETTE.focus,
          ]);
          covered += 1;
        }
        // Each of the three panes really contributed a measured control, or
        // this row would be proving the colour of whichever one it found.
        expect([where, keys[0], covered > 0]).toEqual([where, keys[0], true]);
      }
      // The Entries catalog states its own height while it fits, so it offers
      // its two controls only once it is windowed — the other three readings
      // offer theirs always, which is six of these in an ordinary frame.
      expect([where, navigation >= 6]).toEqual([where, true]);

      // The positive control: an ordinary action still carries the surface the
      // draft does, so restyling every action could not have satisfied any of
      // the above.
      const again = yield* presenter.commit(reading(state, model, live, size));
      const exit = placed(again, "footer:exit");
      expect([where, grid.styleAt(exit.x, exit.y).background]).toEqual([
        where,
        REPL_PALETTE.draftSurface,
      ]);
    }
  });
});

/**
 * #971 checkpoint C1/C2: the staged workspace screen, drawn by the production
 * pipeline at 160x36 from one controlled reading.
 *
 * The geometry asserted here is the plan's proposal — columns of 36, 66 and 58
 * cells, one identity row, 33 body rows, a four-row Draft, one History row and
 * one guidance row — not a reviewed image. Colours are asserted only as the
 * distinctions the screen has to keep; the palette itself waits for the
 * Product Owner's image review.
 */
describe("Checkpoint #971 — the staged workspace screen at 160x36", () => {
  beforeAll(() => useTempFileCompiler());

  it("C1/C2: every surface is placed whole, wraps inside its region and keeps its styles", function* () {
    expect(RUNNING_SOURCE.includes(WRAPPING_LINE)).toBe(true);
    const presenter = yield* usePresenter(CHECKPOINT_SIZE);
    const committed = yield* commitCheckpoint(presenter);
    const { model, view, observed } = committed;
    const { grid } = presenter;
    const region = (id: string): ReplBounds => {
      const found = observed.regionOf(id);
      if (found === undefined) {
        throw new Error(`this frame placed no ${id}`);
      }
      return found;
    };

    // C1: the rows above, inside and below the body.
    expect(region("box:identity")).toEqual({ x: 0, y: 0, width: 160, height: 1 });
    expect(region("box:body")).toEqual({ x: 0, y: 1, width: 160, height: 33 });
    expect(region("box:history")).toEqual({ x: 0, y: 34, width: 160, height: 1 });
    expect(region("box:guidance")).toEqual({ x: 0, y: 35, width: 160, height: 1 });
    // The three columns, dividers included, side by side and whole.
    expect(regionBounds(observed, "sidebar")).toEqual({ x: 0, y: 1, width: 36, height: 33 });
    expect(regionBounds(observed, "transcript")).toEqual({ x: 36, y: 1, width: 66, height: 33 });
    expect(regionBounds(observed, "inspection")).toEqual({ x: 102, y: 1, width: 58, height: 33 });
    // The Draft is four rows at the foot of the selected work.
    const draft = region("box:draft");
    expect(draft.height).toBe(4);
    expect(draft.y + draft.height).toBe(34);
    expect(draft.x).toBeGreaterThanOrEqual(36);
    expect(draft.x + draft.width).toBeLessThanOrEqual(102);

    // C1: a real nested scope is selected, and the breadcrumb beside Entries
    // says the ancestry it actually resolved to.
    const entry = model.entries[model.entries.length - 1];
    const scopes = checkpointScopes(model);
    expect(scopes.length).toBe(2);
    expect(scopes[0]).toBe(entry.key);
    expect(view.state.route.scopes).toEqual(scopes);
    const ancestry = view.selection.ancestry;
    expect(ancestry.map((one) => one.key)).toEqual(scopes);
    expect(view.selection.scope?.key).toBe(scopes[1]);
    expect(view.selection.scope?.key).not.toBe(entry.scope.key);
    expect(view.selection.scope?.kind).toBe("component");
    // The breadcrumb, as the parts it is drawn in. Every name but the innermost
    // is a control that goes to it — the reading is already at the last one —
    // so the trail is one node per ancestor and one row for where the reading
    // is, each on the same row as the Entries control and in the order the
    // scopes were selected.
    const ancestors = observed.keys
      .filter((key) => key.startsWith("work:crumb:"))
      .sort((left, right) => placed(observed, left).x - placed(observed, right).x);
    expect(ancestors).toHaveLength(ancestry.length - 1);
    const crumbRow = placed(observed, "work:crumbs");
    const entries = placed(observed, "entries:heading");
    const crumbText = (key: string): string => observed.cells.get(key) ?? "";
    const targeted = (key: string): boolean => {
      const node = observed.nodeOf(key);
      return node !== undefined && observed.targets.some((one) => one.node === node);
    };
    // The entry is the one ancestor here, and it is where this trail starts.
    expect(crumbText(ancestors[0])).toContain(`Entry ${entry.order}`);
    // The innermost is the reading itself, and it is not a way to anywhere.
    expect(crumbText("work:crumbs")).toContain(ancestry[1].name);
    expect(targeted("work:crumbs")).toBe(false);
    // And each ancestor is reachable: it publishes a target of its own, inside
    // the row, in front of the reading it leads to.
    for (const key of ancestors) {
      const at = placed(observed, key);
      expect([key, at.y]).toEqual([key, entries.y]);
      expect([key, at.x > entries.x && at.x < crumbRow.x]).toEqual([key, true]);
      expect([key, targeted(key)]).toEqual([key, true]);
    }
    expect(crumbRow.y).toBe(entries.y);
    expect(entries.x).toBeLessThan(crumbRow.x);

    // The old composition's surfaces are not on this screen at all.
    for (const key of observed.keys) {
      expect(key.startsWith("entry:")).toBe(false);
      expect(key === "sessions:heading" || key === "transcript:heading").toBe(false);
    }
    expect(observed.regionOf("box:band:0")).toBe(undefined);

    // The Draft's own Stop shares its heading row, at the right of the field.
    const input = placed(observed, "footer:input");
    const draftStop = placed(observed, "draft:stop");
    expect(input.y).toBe(draft.y);
    expect(draftStop.y).toBe(draft.y);
    expect(draftStop.x).toBeGreaterThan(input.x);
    expect(draftStop.x + draftStop.width).toBeLessThanOrEqual(draft.x + draft.width);

    // The inactive TODO tray on the left and the Sidekick's own Stop on the
    // right, on one row above the composer. QUEUE and the Follow checkbox that
    // used to sit between them are DQ0 and DF1 in
    // `fixtures/repl/deferred-presentation.json`: this build offers neither, so
    // neither is drawn, measured or mounted.
    const todo = placed(observed, "tray:todo");
    const sidekickStop = placed(observed, "sidekick:stop");
    expect(sidekickStop.y).toBe(todo.y);
    expect(todo.x).toBeLessThan(sidekickStop.x);
    expect(sidekickStop.x + sidekickStop.width).toBeGreaterThan(155);
    for (const key of ["tray:queue", "follow"]) {
      expect({ key, mounted: observed.nodeOf(key) !== undefined }).toEqual({
        key,
        mounted: false,
      });
    }
    expect(placed(observed, "sidekick:message").y).toBeGreaterThan(todo.y);

    // The pending-message rows this screen used to draw beside the composer —
    // their order, their origin marks, each row's own withdrawal control and
    // the way a long one wrapped between its origin and its X — are DQ1 in
    // `fixtures/repl/deferred-presentation.json`. This build offers no shared
    // queue, so there is nothing here to place them against.

    // Mounted controls are whole, inside the screen, and never overlap.
    const targets = observed.targets.map((one) => one.bounds);
    for (const one of targets) {
      expect(Number.isInteger(one.x) && Number.isInteger(one.y)).toBe(true);
      expect(one.x).toBeGreaterThanOrEqual(0);
      expect(one.x + one.width).toBeLessThanOrEqual(160);
      expect(one.y + one.height).toBeLessThanOrEqual(36);
    }
    for (const [at, one] of targets.entries()) {
      for (const other of targets.slice(at + 1)) {
        const apart =
          one.x + one.width <= other.x ||
          other.x + other.width <= one.x ||
          one.y + one.height <= other.y ||
          other.y + other.height <= one.y;
        expect(apart).toBe(true);
      }
    }

    // C2: the exact source wraps at measured word boundaries inside the
    // selected work, and the run of spaces in it survives.
    const body = region(TRANSCRIPT_BODY);
    for (const key of observed.keys.filter((one) => one.startsWith("reading:"))) {
      const row = placed(observed, key);
      expect(row.x).toBeGreaterThanOrEqual(body.x);
      expect(row.x + row.width).toBeLessThanOrEqual(body.x + body.width);
    }
    const centre = grid.textIn(body);
    const start = centre.findIndex((one) => one.includes("Compute the total once,    after"));
    expect(start).toBeGreaterThanOrEqual(0);
    const column = centre[start].indexOf("Compute");
    const pieces: string[] = [];
    for (
      let at = start;
      at < centre.length && pieces.join(" ").length < WRAPPING_LINE.length;
      at += 1
    ) {
      pieces.push(centre[at].slice(column).trimEnd());
    }
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(" ")).toBe(WRAPPING_LINE);

    // Surfaces: the three columns, a header row and the Draft are each their
    // own ground, blank cells included.
    const left = grid.styleAt(30, 30).background;
    const middle = grid.styleAt(80, 26).background;
    const right = grid.styleAt(150, 22).background;
    const heading = grid.styleAt(30, 1).background;
    const drafted = grid.styleAt(draft.x + draft.width - 2, draft.y + 2).background;
    expect(new Set([left, middle, right, heading, drafted]).size).toBe(5);
    for (const key of ["draft:value:0", "draft:value:1", "draft:value:2"]) {
      const row = placed(observed, key);
      expect(grid.styleAt(row.x + row.width - 1, row.y).background).toBe(drafted);
    }
    // C2: the Draft is the control the mounted tree holds focus on, and the
    // cue is drawn on that same control. A cue for a control that does not hold
    // focus would say the next keystroke lands somewhere it does not.
    expect(committed.focused).toBe("footer:input");
    expect(focusKeyOf(presenter)).toBe("footer:input");
    expect(view.focused).toBe("footer:input");
    const marker = grid.styleAt(input.x, input.y);
    expect(grid.at(input.x, input.y)).toBe(">");
    expect(marker.attrs.includes(BOLD)).toBe(true);
    const value = placed(observed, "draft:value:0");
    expect(grid.styleAt(value.x, value.y).foreground).not.toBe(
      grid.styleAt(value.x + 1, value.y).foreground,
    );
    // What a person asked, what the agent replied, what this execution is doing
    // and what is still being typed all read differently from one another. The
    // queued rows and their origin marks this used to compare are DQ1 in
    // `fixtures/repl/deferred-presentation.json`.
    const asked = placed(observed, "sidekick:chat:message:1");
    const replied = placed(observed, "sidekick:chat:response:1");
    const askedInk = grid.styleAt(asked.x, asked.y).foreground;
    const repliedInk = grid.styleAt(replied.x, replied.y).foreground;
    expect(askedInk).not.toBe(repliedInk);
    const composer = placed(observed, "sidekick:message:value:0");
    expect(grid.styleAt(composer.x, composer.y).foreground).not.toBe(askedInk);
    const working = placed(observed, "sidekick:work:entry-1");
    expect(grid.styleAt(working.x, working.y).foreground).not.toBe(askedInk);
    const state = placed(observed, "work:state");
    expect(grid.styleAt(state.x, state.y).foreground).not.toBe(
      grid.styleAt(placed(observed, "work:crumbs").x, state.y).foreground,
    );
  });

  /**
   * #971: the Transcript is one list, and the conversations are its filter.
   *
   * The person who accepted this screen asked for exactly that — one list
   * rather than two headed sections, with All sessions filtering it
   * (`human-transcript-single-list-20261027-1706.json`). Every fact here is the
   * reading's own: two owners that really did work under two different provider
   * session keys, and the keys themselves read from those records rather than
   * named here.
   *
   * One displayed list is not one lifetime. The owners keep their own authority
   * and their own recorded order — this asserts what a reader sees and what the
   * selector does to it, and nothing about merging the two histories.
   */
  /**
   * #971 B1: the Entries catalog, opened over the reading it navigates.
   *
   * The staged screen keeps no permanent catalog column — its three columns are
   * the Transcript, the selected work and Bindings/Sidekick — so Entries opens
   * the catalog as a drawer over the body, the way every other whole-execution
   * reading is opened. What this holds it to is that the overlay is a
   * *presentation*: it selects nothing by existing, it changes nothing by
   * closing, and the rows in it are the same rows, under the same keys, that
   * the permanent column draws.
   */
  it("A6: Entries opens a catalog over the reading, and only a row in it navigates", function* () {
    const model = yield* checkpointModel();
    for (const size of CHECKPOINT_SIZES) {
      const where = `${size.columns}x${size.rows}`;
      yield* scoped(function* (): Operation<void> {
        const presenter = yield* usePresenter(size);
        // The shipping root's own presentation, not the staged fixture's.
        const shipping = { model, size, workspace: workspaceOf() };
        const base = yield* commitCheckpoint(presenter, shipping);

        // Closed, there is no catalog on the screen and no drawer layer.
        expect([where, base.observed.keys.includes("drawer:open")]).toEqual([where, false]);
        expect([where, base.observed.keys.some((key) => key.startsWith("entry:"))]).toEqual([
          where,
          false,
        ]);

        // The control a person actually presses asks for the catalog. Reached
        // through the mounted tree at the cell it was drawn in, so what this
        // asserts is the control on the screen rather than a description.
        const opener = placed(base.observed, "entries:heading");
        const pressed = yield* presenter.tree.dispatch({
          kind: "pointer",
          target: base.observed.committed.rendered.map.at(opener.x, opener.y) ?? "",
          frame: base.observed.committed.rendered.tree,
        });
        if (!pressed.ok) {
          throw new Error(`${where}: the Entries control refused its own activation`);
        }
        expect([where, asked(pressed.value)]).toEqual([where, { kind: "open-catalog" }]);

        const next = reduceRepl(base.view.state, { kind: "open-catalog" }, model, base.view.live);
        // Opening is navigation and nothing else: no provider work, no append,
        // no submission.
        expect([where, next.intent]).toEqual([where, { kind: "none" }]);
        const open = yield* presenter.commit(
          checkpointViewOf(model, base.focused, { ...shipping, state: next.state }),
        );

        // A floating layer over the body, whole-celled, inside the frame and
        // clear of the footer the identity and History rows keep.
        const layer = open.regionOf("box:drawer:layer");
        if (layer === undefined) {
          throw new Error(`${where}: the catalog drew no drawer layer`);
        }
        for (const edge of [layer.x, layer.y, layer.width, layer.height]) {
          expect([where, Number.isInteger(edge)]).toEqual([where, true]);
        }
        expect([where, layer.x + layer.width <= size.columns]).toEqual([where, true]);
        expect([where, layer.y + layer.height < size.rows - 1]).toEqual([where, true]);

        // The same rows the permanent column builds, under the same keys: an
        // entry is one identity however a reader reached it. Every entry this
        // prefix retained, in admission order, with its own nested scope.
        const rows = open.keys.filter(
          (key) => key.startsWith("entry:") || key.startsWith("scope:"),
        );
        expect([where, rows]).toEqual([
          where,
          ["entry:entry-1", "entry:entry-2", "scope:entry-2/Checklist-1"],
        ]);
        // And they are inside the drawer, not mounted somewhere nothing drew
        // them: each one has a box, and each box is inside that layer.
        for (const key of rows) {
          const at = open.boundsOf(key);
          if (at === undefined) {
            throw new Error(`${where}: the catalog mounted ${key} and drew it nowhere`);
          }
          expect([where, key, at.x >= layer.x && at.x + at.width <= layer.x + layer.width]).toEqual(
            [where, key, true],
          );
          expect([
            where,
            key,
            at.y >= layer.y && at.y + at.height <= layer.y + layer.height,
          ]).toEqual([where, key, true]);
        }
        // Its own window controls and its way out, outside the moving rows.
        for (const key of ["drawer:scroll:up", "drawer:scroll:down", "drawer:close"]) {
          expect([where, key, open.boundsOf(key) !== undefined]).toEqual([where, key, true]);
        }

        // A nested scope, by its exact path. The reading moves to that exact
        // entry and child, and the catalog closes behind the choice it was
        // opened to make.
        const chose = reduceRepl(
          next.state,
          { kind: "select-scope", scopes: ["entry-2", "Checklist-1"] },
          model,
          base.view.live,
        );
        expect([where, chose.intent]).toEqual([where, { kind: "none" }]);
        expect([where, chose.state.route.scopes]).toEqual([where, ["entry-2", "Checklist-1"]]);
        expect([where, chose.state.catalog]).toEqual([where, false]);

        // An older entry, by its own key, from the same open catalog.
        const older = reduceRepl(
          next.state,
          { kind: "select-scope", scopes: ["entry-1"] },
          model,
          base.view.live,
        );
        expect([where, older.state.route.scopes]).toEqual([where, ["entry-1"]]);
        expect([where, older.state.catalog]).toEqual([where, false]);

        // Nothing a person was holding moved, by either route: both texts, the
        // conversation filter, the history marker and the saved chat stand.
        for (const after of [chose.state, older.state, next.state]) {
          expect([where, after.draft]).toEqual([where, base.view.state.draft]);
          expect([where, after.message]).toEqual([where, base.view.state.message]);
          expect([where, after.route.session]).toEqual([where, base.view.state.route.session]);
          expect([where, after.route.at]).toEqual([where, base.view.state.route.at]);
          expect([where, after.route.sidekick]).toEqual([where, base.view.state.route.sidekick]);
        }

        // And closing chooses nothing. The scope being read is the one that was
        // being read before the catalog opened.
        const shut = reduceRepl(next.state, { kind: "close-catalog" }, model, base.view.live);
        expect([where, shut.state.catalog]).toEqual([where, false]);
        expect([where, shut.state.route.scopes]).toEqual([where, base.view.state.route.scopes]);
        expect([where, shut.state.draft]).toEqual([where, base.view.state.draft]);

        // The catalog survives a resize: it is a reading somebody opened, not a
        // property of the frame that drew it.
        const grown = yield* presenter.commit(
          checkpointViewOf(model, base.focused, {
            ...shipping,
            size: CHECKPOINT_SIZE,
            state: next.state,
          }),
        );
        expect([where, grown.keys.includes("drawer:open")]).toEqual([where, true]);
      });
    }
  });

  it("A5: one Transcript list, with the conversations as its filter", function* () {
    const entryTurn = CHECKPOINT_LIVE.agent.turns[0];
    const chatTurn = CHECKPOINT_SIDEKICK.turns[0];
    if (entryTurn === undefined || chatTurn === undefined) {
      throw new Error("this reading holds no turn for one of its two owners");
    }
    // Two owners, two provider conversations: a filter that kept both rows
    // under either key would prove nothing about filtering.
    const entryKey = entryTurn.sessionKey;
    const chatKey = chatTurn.sessionKey;
    if (entryKey === undefined || chatKey === undefined || entryKey === chatKey) {
      throw new Error("this reading does not hold two separate provider conversations");
    }
    const entryRow = `sessions:turn:${entryTurn.key}`;
    const chatRow = `sessions:${chatTurn.key}`;

    const presenter = yield* usePresenter(CHECKPOINT_SIZE);
    const opened = yield* commitCheckpoint(presenter);
    const { model } = opened;

    /** What activating one drawn row asks for, as the pointer reaches it. */
    function* activated(observed: Observed, key: string): Operation<ReplAction> {
      const bounds = placed(observed, key);
      const pointed = yield* presenter.tree.dispatch({
        kind: "pointer",
        target: observed.committed.rendered.map.at(bounds.x, bounds.y) ?? "",
        frame: observed.committed.rendered.tree,
      });
      if (!pointed.ok) {
        throw new Error(`activating ${key} was refused`);
      }
      return asked(pointed.value);
    }

    /** The next frame of this same screen, after one action was reduced. */
    function* acted(
      state: ReplState,
      action: ReplAction,
    ): Operation<{ readonly state: ReplState; readonly observed: Observed }> {
      const next = reduceRepl(state, action, model, CHECKPOINT_LIVE);
      // Filtering is a reading, not work: no provider is started and no record
      // is written by any of these.
      expect(next.intent).toEqual({ kind: "none" });
      const observed = yield* presenter.commit(
        checkpointViewOf(model, presenter.tree.keyOf(presenter.tree.focused() ?? "") ?? undefined, {
          state: next.state,
        }),
      );
      return { state: next.state, observed };
    }

    // One list. A row from each owner is in it, and there is no heading over
    // either of them and no per-owner placeholder beneath either.
    expect(opened.observed.keys).toContain(entryRow);
    expect(opened.observed.keys).toContain(chatRow);
    for (const gone of [
      "sessions:section:entries",
      "sessions:section:sidekick",
      "sessions:entries:none",
      "sessions:sidekick:none",
    ]) {
      expect({ key: gone, drawn: opened.observed.keys.includes(gone) }).toEqual({
        key: gone,
        drawn: false,
      });
    }
    // Each row still says whose work it is, which is where owner authority is
    // read now that no heading says it.
    expect(opened.observed.cells.get(`${entryRow}:whose`) ?? "").toContain(entryKey);
    expect(opened.observed.cells.get(`${chatRow}:whose`) ?? "").toContain(chatTurn.conversation);
    // And each goes where it always did.
    const toEntry = yield* activated(opened.observed, entryRow);
    const toChat = yield* activated(opened.observed, chatRow);
    expect(toChat).toEqual({
      kind: "read-sidekick-turn",
      conversation: chatTurn.conversation,
      turn: chatTurn.turn,
    });

    // The selector is a control a keystroke reaches, not a caption — and it
    // draws no choices while it is closed.
    yield* focusOn(presenter, "transcript:selector");
    const pressed = yield* presenter.tree.dispatch({ kind: "key", key: "Enter" });
    if (!pressed.ok) {
      throw new Error("the Transcript selector refused its own activation");
    }
    expect(asked(pressed.value)).toEqual({ kind: "toggle-session-filter" });
    expect(opened.observed.keys.some((key) => key.startsWith("sessions:conversation:"))).toBe(
      false,
    );

    // Opened, it offers the conversations this reading actually holds, once
    // each, with the way back to all of them.
    const showing = yield* acted(opened.view.state, { kind: "toggle-session-filter" });
    expect(showing.observed.keys).toContain("sessions:all");
    expect(showing.observed.keys).toContain(`sessions:conversation:${entryKey}`);
    expect(showing.observed.keys).toContain(`sessions:conversation:${chatKey}`);
    // Both owners' rows are still in the list behind the open chooser.
    expect(showing.observed.keys).toContain(entryRow);
    expect(showing.observed.keys).toContain(chatRow);

    // Choosing one is the key that row names, and it filters the whole list:
    // only that conversation's rows remain, across both owners.
    const chose = yield* activated(showing.observed, `sessions:conversation:${entryKey}`);
    expect(chose).toEqual({ kind: "select-session", session: entryKey });
    const filtered = yield* acted(showing.state, chose);
    expect(filtered.state.route.session).toBe(entryKey);
    expect(filtered.observed.keys).toContain(entryRow);
    expect(filtered.observed.keys).not.toContain(chatRow);
    // The choice closes the chooser behind it, and the selector says what is
    // chosen.
    expect(filtered.observed.keys.some((key) => key.startsWith("sessions:conversation:"))).toBe(
      false,
    );
    expect(filtered.observed.cells.get("transcript:selector") ?? "").toContain(entryKey);
    // The entry row goes exactly where it went unfiltered.
    expect(yield* activated(filtered.observed, entryRow)).toEqual(toEntry);
    // Nothing anybody was typing moved.
    expect(filtered.state.draft).toBe(CHECKPOINT_DRAFT);
    expect(filtered.state.message).toBe(CHECKPOINT_MESSAGE);

    // All sessions restores both owners' rows to the one list.
    const restored = yield* acted(filtered.state, { kind: "all-sessions" });
    expect(restored.state.route.session).toBe(undefined);
    expect(restored.observed.keys).toContain(entryRow);
    expect(restored.observed.keys).toContain(chatRow);

    // The other conversation filters to its own owner's rows, so the filter is
    // the key rather than a section this list no longer has.
    const theirs = yield* acted(restored.state, { kind: "select-session", session: chatKey });
    expect(theirs.observed.keys).toContain(chatRow);
    expect(theirs.observed.keys).not.toContain(entryRow);

    // And closing the chooser without choosing changes no selection: the
    // conversation stands, the list stands, and both texts stand.
    const reopened = yield* acted(theirs.state, { kind: "toggle-session-filter" });
    const closed = yield* acted(reopened.state, { kind: "toggle-session-filter" });
    expect(closed.state.route).toEqual(theirs.state.route);
    expect(closed.observed.keys.some((key) => key.startsWith("sessions:conversation:"))).toBe(
      false,
    );
    expect(closed.observed.keys).toContain(chatRow);
    expect(closed.observed.keys).not.toContain(entryRow);
    expect(closed.state.draft).toBe(CHECKPOINT_DRAFT);
    expect(closed.state.message).toBe(CHECKPOINT_MESSAGE);
  });

  /**
   * #971: the Transcript's selector says a name in cells, not in code units.
   *
   * What that control says once a conversation has been chosen is the
   * conversation's name, and a provider's session key is a name nothing in this
   * product bounds. Counting its code units gets its width wrong in both
   * directions — a wide character occupies two cells and counts as one unit, a
   * base character with combining marks occupies one and counts as several —
   * and slicing by them cuts an emoji sequence in half. All three were
   * measured: twenty-five `\u754c` declared twenty-nine cells and needed
   * fifty-four, so the engine drew none of it; combining accents declared more
   * cells than they used and published a target reaching past the column's own
   * divider; and a joined sequence came back as two glyphs where its author
   * wrote one.
   *
   * The ASCII key is here beside them because it passed throughout: a row that
   * only held ASCII is what let the other three through.
   */
  it("A5 selector: the name is fitted in cells, whole graphemes, inside its column", function* () {
    const named: readonly { readonly what: string; readonly key: string }[] = [
      { what: "ascii", key: "x".repeat(50) },
      { what: "wide", key: "\u754c".repeat(25) },
      { what: "combining", key: "e\u0301".repeat(25) },
      { what: "joined", key: "\u{1f469}\u200d\u{1f4bb}".repeat(12) },
      // One grapheme, and longer in code units than any cut this product used
      // to make before the fitter saw it: an `e` under a hundred combining
      // accents is 101 units and one cell. Measured, the old cut at
      // fifty-nine units handed the fitter a name missing forty-two of those
      // accents, so what was drawn was an alteration of somebody's name that
      // the fitter then reported an honest width for.
      { what: "one long grapheme", key: `e${"\u0301".repeat(100)}` },
    ];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const graphemes = (text: string): readonly string[] =>
      [...segmenter.segment(text)].map((one) => one.segment);

    for (const size of [CHECKPOINT_SIZE, { columns: 120, rows: 30 }]) {
      for (const one of named) {
        const where = `${one.what} at ${size.columns}`;
        const presenter = yield* usePresenter(size);
        const model = yield* checkpointModel();
        // A key this reading can actually be filtered by: the live turns name
        // it, which is what makes it a conversation this route may select.
        const live: ReplLive = Object.freeze({
          ...CHECKPOINT_LIVE,
          agent: Object.freeze({
            ...CHECKPOINT_LIVE.agent,
            turns: Object.freeze(
              CHECKPOINT_LIVE.agent.turns.map((turn) =>
                Object.freeze({ ...turn, sessionKey: one.key }),
              ),
            ),
          }),
        });
        const base = checkpointState(model, { size });
        const committed = yield* commitCheckpoint(presenter, {
          size,
          model,
          live,
          state: Object.freeze({
            ...base,
            route: Object.freeze({ ...base.route, session: one.key }),
          }),
        });
        const observed = committed.observed;
        const label = observed.cells.get("transcript:selector") ?? "";
        const target = observed.boundsOf("transcript:selector");
        if (target === undefined) {
          throw new Error(`${where}: the selector published no target`);
        }

        // Whole cells, which is what this product draws in: a fractional
        // rectangle is a frame it refuses rather than rounds.
        expect([where, Number.isInteger(target.x) && Number.isInteger(target.width)]).toEqual([
          where,
          true,
        ]);

        // The engine's own answer for the label it is given, against the target
        // that label was published in. Equal, not merely "no exception": a
        // label wider than its box is drawn over the column beside it, and a
        // box wider than its label publishes cells nothing wrote.
        const natural = yield* presenter.renderer.measure(
          [
            open("selector:probe", { layout: { width: fit(), height: fit() } }),
            text(label),
            close(),
          ],
          size,
        );
        if (!natural.ok) {
          throw natural.error;
        }
        expect([where, natural.value.boundsOf("selector:probe")?.width]).toEqual([
          where,
          target.width,
        ]);

        // Inside the Transcript's own column, whole. A target reaching past
        // that divider is a pointer target over somebody else's reading.
        const column = observed.regionOf("box:sidebar");
        if (column === undefined) {
          throw new Error(`${where}: this frame drew no Transcript column`);
        }
        expect([
          where,
          target.x >= column.x && target.x + target.width <= column.x + column.width,
        ]).toEqual([where, true]);

        // The mark that says it opens survives whatever the name costs.
        expect([where, label.endsWith(" \u25be")]).toEqual([where, true]);

        // And the name itself is whole graphemes of the key, in order: a cut
        // inside a sequence is a glyph its author never wrote. The marker room
        // in front and the mark behind are the row's, not the name's.
        const said = label.slice(2, label.length - 2);
        const shown = said.endsWith("\u2026") ? said.slice(0, -1) : said;
        expect([where, graphemes(shown)]).toEqual([
          where,
          graphemes(one.key).slice(0, graphemes(shown).length),
        ]);
        // A key longer than its column gives columns up; one that fits keeps
        // every grapheme it had. Either way what is drawn is a whole prefix of
        // the *original* name — nothing shortened it on the way to the fitter.
        expect([where, shown.length > 0]).toEqual([where, true]);
      }
    }
  });
});

/**
 * #971 A1 is now read in the places each of its fields belongs.
 *
 * What the screen looks like — every row of text, every style run under it and
 * the blank backgrounds a surface paints — is the three appearance records and
 * the cases above them. Where the frame put its regions, pane bodies and whole
 * contained targets is A2 and the admission boundary. Which reading it is of,
 * which scope is selected and which control a keystroke reaches are A6 and the
 * mounted-focus cases. The accepted capture itself stays in the history at
 * `accepted-160.ts`, blob 83dd9453 at f0232b3e, recoverable with `git show`.
 *
 * It was one case asserting six different kinds of thing about a composition
 * this build no longer draws — the staged screen it pinned still had the shared
 * queue in it.
 */
describe("Checkpoint #971 A2 — the staged screen at the two smaller sizes", () => {
  beforeAll(() => useTempFileCompiler());

  /** Every mounted control's box, by the key that owns it. */
  function targetsOf(presenter: Presenter, observed: Observed): ReadonlyMap<string, ReplBounds> {
    return new Map(
      observed.targets.flatMap((one) => {
        const key = presenter.tree.keyOf(one.node);
        return key === undefined ? [] : [[key, one.bounds] as const];
      }),
    );
  }

  it("A2: every size places whole controls inside the frame and keeps its routes", function* () {
    for (const size of CHECKPOINT_SIZES) {
      const where = `${size.columns}x${size.rows}`;
      const presenter = yield* usePresenter(size);
      const observed = (yield* commitCheckpoint(presenter, { size })).observed;

      // Three rows of chrome at every size: the identity row above the body,
      // then the compact History row and the guidance row below it.
      expect({ where, bounds: observed.regionOf("box:identity") }).toEqual({
        where,
        bounds: { x: 0, y: 0, width: size.columns, height: 1 },
      });
      expect({ where, bounds: observed.regionOf("box:body") }).toEqual({
        where,
        bounds: { x: 0, y: 1, width: size.columns, height: size.rows - 3 },
      });
      expect({ where, bounds: observed.regionOf("box:history") }).toEqual({
        where,
        bounds: { x: 0, y: size.rows - 2, width: size.columns, height: 1 },
      });
      expect({ where, bounds: observed.regionOf("box:guidance") }).toEqual({
        where,
        bounds: { x: 0, y: size.rows - 1, width: size.columns, height: 1 },
      });

      // Whole cells, inside the frame, and no two controls over one another.
      const targets = [...targetsOf(presenter, observed).values()];
      expect({ where, count: targets.length > 0 }).toEqual({ where, count: true });
      for (const one of targets) {
        expect({ where, whole: Number.isInteger(one.x) && Number.isInteger(one.y) }).toEqual({
          where,
          whole: true,
        });
        expect({
          where,
          inside:
            one.x >= 0 &&
            one.y >= 0 &&
            one.x + one.width <= size.columns &&
            one.y + one.height <= size.rows,
        }).toEqual({ where, inside: true });
      }
      for (const [at, one] of targets.entries()) {
        for (const other of targets.slice(at + 1)) {
          const apart =
            one.x + one.width <= other.x ||
            other.x + other.width <= one.x ||
            one.y + one.height <= other.y ||
            other.y + other.height <= one.y;
          expect({ where, apart }).toEqual({ where, apart: true });
        }
      }
    }
  });

  it("A2: medium gives the selected work room its reading can use", function* () {
    const presenter = yield* usePresenter(CHECKPOINT_MEDIUM);
    const committed = yield* commitCheckpoint(presenter, { size: CHECKPOINT_MEDIUM });
    const { observed } = committed;
    // The corrected medium proportions, dividers included: the selected work
    // takes the remainder because it is the column whose room is spent on a
    // reserved rail and badge column before a reader sees any source.
    expect(regionBounds(observed, "sidebar")).toEqual({ x: 0, y: 1, width: 36, height: 27 });
    expect(regionBounds(observed, "transcript")).toEqual({ x: 36, y: 1, width: 52, height: 27 });
    expect(regionBounds(observed, "inspection")).toEqual({ x: 88, y: 1, width: 32, height: 27 });

    // What that buys is source room, measured through the reading's own
    // reservation rather than counted from the column's width.
    const prepared = yield* prepareFrame(presenter.renderer, committed.view);
    if (!prepared.ok) {
      throw prepared.error;
    }
    const reservation = prepared.value.context.reading?.reservation;
    expect(reservation?.content).toBeGreaterThanOrEqual(24);
    // The reservation itself is unchanged: the rail, its separators and a
    // column as wide as the widest badge this reading could ever hold.
    expect(reservation?.rail).toBeGreaterThan(0);
    expect(reservation?.status).toBeGreaterThan(0);

    // A header whose groups do not fit one row still takes a second row of its
    // own column rather than a shortened label or a dropped control.
    for (const id of ["box:inspection:tabs", "box:tray:controls"]) {
      const row = observed.regionOf(id);
      const second = observed.regionOf(`${id}:second`);
      expect({ id, wrapped: second === undefined || second.y === (row?.y ?? 0) + 1 }).toEqual({
        id,
        wrapped: true,
      });
    }

    // The Draft keeps its four rows at the foot of that column.
    const draft = observed.regionOf("box:draft");
    expect(draft?.height).toBe(4);
    expect((draft?.y ?? 0) + (draft?.height ?? 0)).toBe(CHECKPOINT_MEDIUM.rows - 2);
  });

  it("A2: the selected work's source wraps at word boundaries and stays exact", function* () {
    const presenter = yield* usePresenter(CHECKPOINT_MEDIUM);
    const committed = yield* commitCheckpoint(presenter, { size: CHECKPOINT_MEDIUM });
    const prepared = yield* prepareFrame(presenter.renderer, committed.view);
    if (!prepared.ok) {
      throw prepared.error;
    }
    const rows = prepared.value.context.reading?.rows ?? [];
    const texts = rows.map((one) => one.text);

    // The output line breaks between whole words, and neither filename is cut.
    // The boundary space stays on the row that ends with it: whitespace is
    // part of the line, and the next row does not begin with somebody else's.
    const opened = texts.indexOf("Reading checkout.md and ");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(texts[opened + 1]).toBe("architecture.md");

    // The long source line reconstructs exactly, four spaces included, and the
    // remainder that fits a row stays whole on it.
    const started = texts.findIndex((one) => WRAPPING_LINE.startsWith(one.trimEnd()) && one !== "");
    expect(started).toBeGreaterThanOrEqual(0);
    let said = "";
    let at = started;
    while (at < texts.length && said.length < WRAPPING_LINE.length) {
      said += texts[at];
      at += 1;
    }
    expect(said).toBe(WRAPPING_LINE);
    expect(said).toContain("once,    after");
    // The last row of that line is its whole remainder: what fits a row stays
    // on it, which is the behaviour D10's own regressions hold the fitter to.
    expect(texts[at - 1]).toBe("customer pays.");
    // Each drawn row fits the room the reading reserved for its content.
    const content = prepared.value.context.reading?.reservation.content ?? 0;
    for (const row of rows) {
      expect(row.width + row.indent).toBeLessThanOrEqual(content);
    }
  });

  it("A2: narrow routes one outlet, keeps both surface controls and the Draft", function* () {
    const model = yield* checkpointModel();
    // The entry surface: the selected work, its reading and its Draft.
    const work = yield* usePresenter(CHECKPOINT_NARROW);
    const entries = (yield* commitCheckpoint(work, { size: CHECKPOINT_NARROW, model })).observed;
    expect(regionBounds(entries, "content")).toEqual({ x: 0, y: 1, width: 72, height: 17 });
    // Neither of the other two columns exists at this size.
    expect(regionBounds(entries, "sidebar")).toBe(undefined);
    expect(regionBounds(entries, "inspection")).toBe(undefined);
    for (const key of ["sessions:heading", "entries:heading", "footer:input", "draft:stop"]) {
      expect({ key, drawn: entries.boundsOf(key) !== undefined }).toEqual({ key, drawn: true });
    }
    // The Sidekick's own rows are on no other surface's screen.
    for (const key of ["tray:queue", "follow", "sidekick:message"]) {
      expect({ key, drawn: entries.keys.includes(key) }).toEqual({ key, drawn: false });
    }

    // The Sessions surface: the Transcript's own reading, and no Draft.
    const sessions = yield* usePresenter(CHECKPOINT_NARROW);
    const read = (yield* commitCheckpoint(sessions, {
      size: CHECKPOINT_NARROW,
      model,
      surface: "sessions",
    })).observed;
    expect(read.keys.includes("transcript:title")).toBe(true);
    expect(read.keys.includes("footer:input")).toBe(false);
    expect(read.boundsOf("sessions:heading")).not.toBe(undefined);

    // The Sidekick surface: its chat, its tray and its composer, reached by the
    // route rather than by a tab this size does not draw.
    const chat = yield* usePresenter(CHECKPOINT_NARROW);
    const talking = (yield* commitCheckpoint(chat, {
      size: CHECKPOINT_NARROW,
      model,
      sidekick: true,
    })).observed;
    for (const key of ["tray:todo", "sidekick:stop", "sidekick:message"]) {
      expect({ key, drawn: talking.boundsOf(key) !== undefined }).toEqual({ key, drawn: true });
    }
    // Neither offer this build does not have reaches a narrow outlet either.
    for (const key of ["tray:queue", "follow"]) {
      expect({ key, drawn: talking.boundsOf(key) !== undefined }).toEqual({ key, drawn: false });
    }
    expect(talking.keys.includes("tab:bindings")).toBe(false);
    expect(talking.keys.includes("footer:input")).toBe(false);
  });
});

/**
 * #971 A4: every outcome a reading can hold, on one screen, at each size.
 *
 * One controlled reading rather than one per state: four entries that really
 * ran — settled, failed, stopped and still running — a Sidekick question
 * waiting, and a queue longer than the tray can show. Asking for a screen per
 * state would be asking for the same frame fifteen times.
 *
 * What this proves is fitting and state: that each outcome is on the screen,
 * that they read differently, and that nothing the window holds is unreachable.
 * Whether it looks right is the image review's answer, not a test's.
 */
describe("Checkpoint #971 A4 — current outcomes, work and the waiting question", () => {
  beforeAll(() => useTempFileCompiler());

  /** The four outcomes this reading holds, as the words the screen says. */
  const OUTCOMES = ["✓ COMPLETED", "× FAILED", "- INTERRUPTED", "● ACTIVE"] as const;

  it("A4: every outcome, work identity and the waiting question read from the current screen", function* () {
    const model = yield* checkpointStateModel();
    expect(model.entries.map((one) => one.terminal?.status ?? "unfinished")).toEqual([
      "ok",
      "err",
      "cancelled",
      "unfinished",
    ]);

    for (const size of CHECKPOINT_SIZES) {
      const where = `${size.columns}x${size.rows}`;
      const narrow = size.columns === CHECKPOINT_NARROW.columns;
      const presenter = yield* usePresenter(size);
      // The composition this build offers: the same staged work rows and
      // conversation, with no shared queue tray, no queued rows and no Follow.
      const workspace = CHECKPOINT_CURRENT_WORKSPACE;
      const committed = yield* commitCheckpoint(presenter, {
        model,
        size,
        live: CHECKPOINT_ASKING,
        workspace,
        // A narrow frame routes one outlet, and the conversation is the outlet
        // these readings are in.
        ...(narrow ? { sidekick: true } : {}),
      });
      const { observed } = committed;
      const { admission } = observed.committed;

      // Every outcome is in the reading this screen is showing, whatever its
      // window has room for: a smaller screen scrolls to them rather than
      // losing them. The rows come from the production builder, so this is the
      // reading the frame draws from rather than a second account of it.
      const reading = chatLinesFor(committed.view)
        .map((one) => one.text)
        .join("\n");
      for (const word of OUTCOMES) {
        expect({ where, word, held: reading.includes(word) }).toEqual({
          where,
          word,
          held: true,
        });
      }
      // And what this window is not showing is reachable rather than gone.
      const whole = windowOf(admission, SIDEKICK_WINDOW);
      expect({
        where,
        reachable: whole.total >= whole.count && whole.from + whole.count <= whole.total,
      }).toEqual({ where, reachable: true });

      // The outcomes this frame is actually showing read differently from one
      // another: no two of them in the same ink.
      const said = presenter.grid
        .textIn({ x: 0, y: 0, width: size.columns, height: size.rows })
        .join("\n");
      const shown = OUTCOMES.filter((word) => said.includes(word));
      const inks = new Set<number | undefined>();
      for (const word of shown) {
        const at = said.indexOf(word);
        const before = said.slice(0, at).split("\n");
        const y = before.length - 1;
        const x = before[before.length - 1].length;
        inks.add(presenter.grid.styleAt(x, y).foreground);
      }
      expect({ where, distinct: inks.size }).toEqual({ where, distinct: shown.length });

      // The question announces itself where it can be answered, and answering
      // it is a control rather than a sentence.
      if (!narrow || committed.view.state.route.view === "sidekick") {
        expect({ where, asked: observed.boundsOf("sidekick:answer") !== undefined }).toEqual({
          where,
          asked: true,
        });
      }

      // Each work row this screen carries is an identity this history already
      // holds: a message this conversation acknowledged, paired with the entry
      // that message admitted. Nothing is shown for an entry this reading does
      // not hold.
      expect({ where, work: workspace.work.length > 0 }).toEqual({ where, work: true });
      for (const one of workspace.work) {
        expect({
          where,
          message: CHECKPOINT_SIDEKICK.chat.some((row) => row.key === one.message),
          entry: model.entries.some((entry) => entry.key === one.entry),
        }).toEqual({ where, message: true, entry: true });
      }
      // And the tray this build offers is the inactive one, with no shared
      // queue behind it.
      expect({
        where,
        todo: observed.nodeOf("tray:todo") !== undefined || narrow,
        queue: observed.nodeOf("tray:queue") !== undefined,
      }).toEqual({ where, todo: true, queue: false });
    }
  });
});

/**
 * #971 R2: the chat window this screen holds, traversed rather than described.
 *
 * The chat holds more than it can show, and the question is the same one a
 * window always asks: is what it is not showing reachable, and is what it *is*
 * showing something a person can act on? So this walks it — down to the
 * outcomes its first window cuts off — and reads the answers off the committed
 * frame rather than off the description that produced it.
 *
 * One presenter, one tree and one grid throughout: the screen under test is
 * what the frames have left in the grid together, which is also the only way a
 * row that stopped being drawn can be told from a row that is still there.
 *
 * The shared message queue this case used to traverse beside the chat is not
 * offered by this build. Its rows, its withdrawal controls and its own window
 * are recorded in `fixtures/repl/deferred-presentation.json` under DQ1, with
 * the case they came from and what has to exist before they come back.
 */
describe("Checkpoint #971 R2 — current chat windows and outcomes", () => {
  beforeAll(() => useTempFileCompiler());

  /** The four outcomes this reading holds, as the words the screen says. */
  const OUTCOMES = ["✓ COMPLETED", "× FAILED", "- INTERRUPTED", "● ACTIVE"] as const;

  it("R2: current chat traversal reads every outcome and keeps its composer", function* () {
    const model = yield* checkpointStateModel();
    // The size whose conversation still holds more than it shows. Without the
    // shared queue's tray the widest screen has room for the whole chat, and a
    // window with nothing outside it is not a traversal.
    const size = CHECKPOINT_MEDIUM;
    const presenter = yield* usePresenter(size);
    const asking = {
      model,
      size,
      live: CHECKPOINT_ASKING,
      workspace: CHECKPOINT_CURRENT_WORKSPACE,
    } as const;

    const opening = yield* commitCheckpoint(presenter, asking);

    // No shared queue is offered here, so nothing of it is measured, mounted or
    // drawn: a window over rows this build has none of would be chrome over a
    // reading that does not exist.
    expect(opening.observed.committed.admission.windows.get(QUEUE_WINDOW)).toBe(undefined);
    for (const key of ["queue:earlier", "queue:later", "tray:queue"]) {
      expect({ key, mounted: opening.observed.nodeOf(key) !== undefined }).toEqual({
        key,
        mounted: false,
      });
    }

    // What the column does offer is all there: the inactive tray, the
    // conversation's own composer, and the controls that move the chat.
    for (const key of ["tray:todo", "sidekick:message", "sidekick:earlier", "sidekick:later"]) {
      expect({ key, drawn: opening.observed.boundsOf(key) !== undefined }).toEqual({
        key,
        drawn: true,
      });
    }
    const chat = windowOf(opening.observed.committed.admission, SIDEKICK_WINDOW);
    expect({ rows: chat.count >= 1 }).toEqual({ rows: true });

    // One traversal of the chat's own window, which holds more rows than it
    // shows: each outcome's ink is read the first time that outcome is on the
    // screen, and the walk stops once all four have been.
    const inks = new Map<string, number | undefined>();
    // Where the window actually sat at each step. A following chat sits at its
    // own end, so this walk moves it down from there rather than up.
    const visited = new Set<number>([chat.from]);
    for (let offset = 0; offset <= chat.total && inks.size < OUTCOMES.length; offset += 1) {
      const at = yield* commitCheckpoint(presenter, {
        ...asking,
        state: chatAt(model, offset),
        focused: opening.focused,
      });
      visited.add(windowOf(at.observed.committed.admission, SIDEKICK_WINDOW).from);
      const said = presenter.grid
        .textIn({ x: 0, y: 0, width: size.columns, height: size.rows })
        .join("\n");
      for (const word of OUTCOMES) {
        const found = said.indexOf(word);
        if (found < 0 || inks.has(word)) {
          continue;
        }
        const before = said.slice(0, found).split("\n");
        const y = before.length - 1;
        const x = before[before.length - 1]?.length ?? 0;
        inks.set(word, presenter.grid.styleAt(x, y).foreground);
      }
    }
    // The walk moved the window rather than redrawing the same rows.
    expect({ moved: visited.size > 1 }).toEqual({ moved: true });
    // All four were rendered, and no two of them in the same ink.
    expect({ read: [...inks.keys()].sort() }).toEqual({
      read: [...OUTCOMES].sort(),
    });
    expect({ distinct: new Set(inks.values()).size }).toEqual({
      distinct: OUTCOMES.length,
    });

    // The composer the conversation is answered in is still there afterwards,
    // and the chat's own offset moved without the source or the saved reading
    // following it.
    expect({
      composer: opening.observed.boundsOf("sidekick:message") !== undefined,
      source: opening.observed.committed.admission.windows.get(READING_WINDOW)?.from,
    }).toEqual({
      composer: true,
      source: windowOf(opening.observed.committed.admission, READING_WINDOW).from,
    });
  });
});
