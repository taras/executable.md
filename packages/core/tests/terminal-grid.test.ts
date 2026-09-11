/**
 * Tier TG — a terminal grid written in a document (spec §6.21,
 * architecture.md §Interactive terminal grids, §Atomic presentation and
 * settlement, §Durability and replay).
 *
 * These rows are about what core contributes: the authored structure it
 * resolves, the lazy cell work it constructs, the journal it describes, and
 * what a document sees when a grid runs, fails, closes or replays. The
 * provider-neutral lifecycle those rows run on is proved in
 * `packages/terminal/tests/terminal-grid.test.ts`.
 *
 * The provider here is controlled and is not tmux: it opens no terminal,
 * starts no process, and records what it was asked to do in the order it was
 * asked. Every ordering claim is read off that record. Nothing is inferred
 * from timing, because a grid that showed too early and one that showed on
 * time take the same wall clock.
 *
 * Readiness is the claim these rows care about most, so it is always driven
 * explicitly: a cell becomes ready because work in it acquired a terminal
 * activity, never because it got far enough. `<Interactive />` is what a suite
 * writes to be that something, and it reaches the cell through the same
 * contextual handle a real `<Session.Launch>` will.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  Err,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation, Result, Task } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  registerTerminalProvider,
  reserveTerminal,
  TerminalGrids,
  useTerminalCellUI,
} from "@executablemd/terminal";
import type {
  TerminalActivity,
  TerminalCellUI,
  TerminalGridRequest,
  TerminalGridState,
  TerminalShellOutcome,
} from "@executablemd/terminal";
import {
  controlledTerminalProvider,
  installControlledLauncher,
  terminalProviderLog,
} from "@executablemd/terminal/test";
import type {
  ControlledProviderOptions,
  TerminalProviderLog,
  TerminalProviderResources,
} from "@executablemd/terminal/test";
import { useTerminalInstallation } from "@executablemd/terminal/lifecycle";
import type { PresentTerminalGrid } from "@executablemd/terminal/lifecycle";

import { Component } from "../src/component-api.ts";
import { execute } from "../src/execute.ts";
import { registerComponents } from "../src/components/registration.ts";
import { installTerminalGridProfile } from "../src/terminal/profile.ts";
import type { Json } from "../src/types.ts";

/** One document run against a controlled grid host. */
interface DocumentRun {
  outcome: Result<Json>;
  /** Text the consumer received — the root document's own output. */
  output: string;
  /** The grid the provider was actually asked to present. */
  requests: TerminalGridRequest[];
  /** What each cell displayed, by authored position. */
  shown: Map<number, string>;
  /** Everything the provider's host did, in order. */
  events: string[];
  /** Every mark a tripwire component recorded, in order. */
  ran: string[];
  /** Every printed error the run produced, in order. */
  errors: string[];
  /** The journal this run read and appended to. */
  journal: DurableEvent[];
  /** What the controlled provider still held when the run was over. */
  live: TerminalProviderResources;
}

/**
 * The mark a document records once it is past the grid.
 *
 * It fires whether the grid ran or replayed, so a harness can stop the run at
 * the same point either way — and a replay that hangs never reaches it, which
 * is a failure rather than something a deadline would quietly pass.
 */
const PAST_THE_GRID = "past the grid";

function useDir(): Operation<string> {
  return resource<string>(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "xmd-tg-")));
    yield* ensure(function* () {
      yield* rm(dir, { recursive: true, force: true });
    });
    yield* provide(dir);
  });
}

/** An outcome that is already settled. */
function done<T>(value: T): Operation<T> {
  // deno-lint-ignore require-yield
  return (function* (): Operation<T> {
    return value;
  })();
}

/**
 * An activity whose child spawned and is already finished.
 *
 * The ordinary case a row wants when it only needs a cell to be ready:
 * acquired at once, settled at once.
 */
function startsAndSettles(onStart?: () => void): TerminalActivity<TerminalShellOutcome> {
  return resource(function* (provide) {
    onStart?.();
    yield* provide(done<TerminalShellOutcome>({ exitCode: 0 }));
  });
}

/**
 * An activity whose child never spawned.
 *
 * It fails during acquisition, which is before a cell could be ready — the
 * shape of a preparation or spawn failure rather than of work that ran.
 */
function neverStarts(onAttempt?: () => void): TerminalActivity<TerminalShellOutcome> {
  return resource(function* () {
    onAttempt?.();
    throw new Error("this activity's child never spawned");
  });
}

/**
 * What the cell-handle rows read.
 *
 * Each of these is driven from inside a real cell, through the same
 * `TerminalCellUI` a `<Session.Launch>` reaches, and read back off an ordered
 * record rather than inferred.
 */
interface CellProbe {
  /** Refusals the document's own work collected, in the order they happened. */
  readonly refusals: string[];
  /** Ordered marks: which cell entered and left its interactive work. */
  readonly marks: string[];
  /** Cell handles kept past their grid on purpose. */
  readonly kept: TerminalCellUI[];
  /** Announce that this cell is inside its interactive body. */
  entered(): void;
  /** Settles once every cell this probe expects is inside one at the same time. */
  overlapped(): Operation<void>;
}

function cellProbe(expected = 2): CellProbe {
  const all = withResolvers<void>();
  let inside = 0;
  return {
    refusals: [],
    marks: [],
    kept: [],
    entered() {
      inside += 1;
      if (inside >= expected) {
        all.resolve();
      }
    },
    overlapped: () => all.operation,
  };
}

function refusalOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cell handle the current work is running in, or a failed row. */
function* cellHandle(name: string): Operation<TerminalCellUI> {
  const cell = yield* useTerminalCellUI();
  if (cell === undefined) {
    throw new Error(`<${name} /> is written inside a <Terminal> cell`);
  }
  return cell;
}

/** The controlled interactive child, and a tripwire. */
function useGridComponents(
  ran: string[],
  slowMarks: string[] = [],
  onMark: (mark: string) => void = () => {},
  afterShow: () => Operation<void> = function* () {},
  teardownHeld: () => Operation<void> = function* () {},
  teardownArmed: () => void = () => {},
  probe: CellProbe = cellProbe(),
): Operation<void> {
  return registerComponents([
    {
      name: "Interactive",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const cell = yield* cellHandle("Interactive");
        yield* cell.shell();
        return "";
      },
    },
    {
      name: "Ran",
      origin: "tier-tg",
      props: {
        type: "object",
        properties: { mark: { type: "string" } },
        required: ["mark"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props) {
        ran.push(String(props.mark));
        onMark(String(props.mark));
        return "";
      },
    },
    {
      // Enters its cell's interactive body and stays there until every other
      // cell is inside one too. Two cells that contended could never both be
      // inside, so the wait is the proof; the deadline only turns a regression
      // into a failed assertion instead of a hung suite.
      name: "Concurrent",
      origin: "tier-tg",
      props: {
        type: "object",
        properties: { mark: { type: "string" } },
        required: ["mark"],
        additionalProperties: false,
      },
      *fn(props) {
        const cell = yield* cellHandle("Concurrent");
        const mark = String(props.mark);
        probe.marks.push(`enter:${mark}`);
        probe.entered();
        yield* cell.shell();
        probe.marks.push(`leave:${mark}`);
        return "";
      },
    },
    {
      // One cell, asked for two interactive operations at once and then for a
      // second one after the first settled.
      name: "Overlapping",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const cell = yield* cellHandle("Overlapping");
        yield* spawn(function* () {
          // Raced against the first shell deliberately: whichever of the two
          // reaches admission second is the overlapping one, and it is refused
          // rather than queued.
          try {
            yield* cell.shell();
            probe.marks.push("second entered");
          } catch (error) {
            probe.refusals.push(refusalOf(error));
          }
        });
        yield* cell.shell();
        // The cell is free again: one owner at a time is not one owner ever.
        yield* cell.shell();
        probe.marks.push("sequential");
        // Kept deliberately, so a row can ask what it grants after the grid has
        // closed.
        probe.kept.push(cell);
        return "";
      },
    },
    {
      // Acquires one activity that spawns and settles in the same breath.
      name: "SettlesAtOnce",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const cell = yield* cellHandle("SettlesAtOnce");
        yield* cell.shell();
        probe.marks.push("started and settled");
        return "";
      },
    },
    {
      // Interactive work that never acquires an activity: doing work is not
      // starting.
      name: "Quiet",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const cell = yield* cellHandle("Quiet");
        probe.marks.push("tried to start");
        yield* cell.shell();
        return "";
      },
    },
    {
      // Starts interactively, slowly, and records when it did.
      name: "Slow",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const cell = yield* cellHandle("Slow");
        yield* sleep(25);
        slowMarks.push("ready:slow");
        yield* cell.shell();
        return "";
      },
    },
    {
      // Holds the cell open, and blocks its own teardown until released — so a
      // row can interrupt a run while reader-close teardown is in progress.
      name: "SlowTeardown",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* ensure(function* () {
          yield* teardownHeld();
        });
        // Armed: the finalizer is installed and this cell is live, which is
        // what a row waits for before letting the reader leave.
        teardownArmed();
        yield* suspend();
        return "";
      },
    },
    {
      // Waits until the grid has been shown, so a cell can fail *after* the
      // barrier — which is the failure the grid contains as a status rather
      // than the startup failure that fails the whole region.
      name: "AfterShow",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* afterShow();
        return "";
      },
    },
    {
      name: "Hold",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* suspend();
        return "";
      },
    },
  ]);
}

/** What a row asks of the controlled provider, plus the ways it may misuse one. */
type ProviderOptions = ControlledProviderOptions & {
  /** Present something other than the request that was routed. */
  readonly substitute?: (request: TerminalGridRequest) => TerminalGridRequest;
  /** Answer the routed request without presenting anything at all. */
  readonly shortCircuit?: boolean;
  /** Keep the presentation function for a later, unrouted use. */
  readonly capture?: (present: PresentTerminalGrid) => void;
};

/**
 * Register a controlled provider that presents through the function it was
 * delivered.
 *
 * This is the whole handshake in miniature: the factory receives presentation
 * as an argument, supplies a provider of its own, and presents the exact
 * request it was routed. Nothing it returns reaches core.
 */
function useControlledProvider(options: ProviderOptions = {}): Operation<void> {
  return registerTerminalProvider("controlled", function* (_settings, present) {
    options.capture?.(present);
    const provider = controlledTerminalProvider(options);
    yield* TerminalGrids.around(
      {
        *open([request]) {
          if (options.shortCircuit === true) {
            // Answers, presents nothing. Core must not believe this.
            return { presented: true };
          }
          yield* present(options.substitute?.(request) ?? request, provider);
          return undefined;
        },
      },
      { at: "min" },
    );
  });
}

/** Close as soon as the reader is asked, which is the ordinary journey. */
function immediateClose(): () => Operation<void> {
  // deno-lint-ignore require-yield
  return function* () {};
}

/**
 * Expand one document against a controlled grid host.
 *
 * `provider: false` registers nothing, which is how "a host that cannot open a
 * grid refuses" is asked for.
 */
function runDocument(
  dir: string,
  source: string,
  options: {
    provider?: boolean;
    stream?: InMemoryStream;
    grid?: ProviderOptions;
    /** Where `<Slow />` records that it started. */
    slowMarks?: string[];
    /** Props this run supplies. Props are not restored across a continuation. */
    props?: Record<string, Json>;
    /** What the cell-handle rows record. */
    probe?: CellProbe;
  } = {},
): Operation<DocumentRun> {
  return scoped(function* () {
    const path = join(dir, "doc.md");
    yield* writeTextFile(path, source);
    const requests: TerminalGridRequest[] = [];
    const log = terminalProviderLog();
    const ran: string[] = [];
    const errors: string[] = [];
    yield* Component.around({
      *raise([segment], next) {
        errors.push(segment.message);
        return yield* next(segment);
      },
    });
    yield* useGridComponents(
      ran,
      options.slowMarks ?? [],
      undefined,
      undefined,
      undefined,
      undefined,
      options.probe,
    );
    yield* installControlledLauncher();

    // The reader stays until every cell has settled. Leaving sooner is a real
    // thing a reader does — TG12 covers it — but a row about what a cell
    // rendered must not race the close that cancels it.
    const settled = withResolvers<void>();
    const supplied = options.grid ?? {};
    if (options.provider !== false) {
      yield* useControlledProvider({
        ...supplied,
        log,
        close: supplied.close ?? (() => settled.operation),
        *onPrepare(asked) {
          requests.push(asked);
          if (supplied.onPrepare) {
            yield* supplied.onPrepare(asked);
          }
        },
        *render(state) {
          if (supplied.render) {
            yield* supplied.render(state);
          }
          if (state.cells.every((cell) => cell.status !== "starting" && isSettled(cell.status))) {
            settled.resolve();
          }
        },
      });
    }
    yield* installTerminalGridProfile(options.provider === false ? {} : { provider: "controlled" });

    const stream = options.stream ?? new InMemoryStream();
    const execution = yield* execute({
      path,
      stream,
      includes: [dir],
      ...(options.props === undefined ? {} : { props: options.props }),
    });
    const outcome = yield* execution;
    const output = yield* forEach(function* (_chunk: string) {}, execution.output);
    return {
      outcome,
      output,
      requests,
      shown: log.shown,
      events: log.events,
      ran,
      errors,
      journal: yield* stream.readAll(),
      live: log.live,
    };
  });
}

function isSettled(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "closed";
}

/** The message a run failed with, failing the test if it completed. */
function failureOf(run: DocumentRun): string {
  if (run.outcome.ok) {
    throw new Error(`expected the document to fail, but it completed: ${run.outcome.value}`);
  }
  return run.outcome.error.message;
}

/** A grid, then a component that holds the run open so the root never settles. */
function heldDocument(columns: number, cells: string[]): string {
  return [
    `<Terminal.Grid columns={${columns}}>`,
    ...cells,
    "</Terminal.Grid>",
    "",
    // The sibling after the grid. It runs whether the grid ran or replayed, so
    // a harness can wait for the document to have moved past the region.
    `<Ran mark="${PAST_THE_GRID}" />`,
    "",
    "<Hold />",
    "",
  ].join("\n");
}

/**
 * Run a document and interrupt it once the grid has journaled its outcome.
 *
 * A completed *or failed* root replays wholesale, so a second run of it would
 * never reach the grid at all. Only a genuinely interrupted run leaves the
 * region to be resumed — which is what every replay row below needs.
 */
function runInterrupted(
  dir: string,
  source: string,
  stream: InMemoryStream,
  options: {
    provider?: boolean;
    shell?: ControlledProviderOptions["shell"];
    /** Let the reader leave, so the grid completes rather than staying open. */
    close?: boolean;
    /** Props this run supplies. Props are not restored across a continuation. */
    props?: Record<string, Json>;
    /**
     * Keep the grid open until a cell reports a failure.
     *
     * A cell that fails *after* it is shown is contained as that cell's status,
     * and the grid settles as failed rather than throwing. Closing before that
     * would record the cell as cancelled by the close instead.
     */
    closeAfterFailure?: boolean;
    /** Let the reader leave only once a `<SlowTeardown />` cell is armed. */
    closeWhenArmed?: boolean;
    /** Let the reader leave only once this tripwire mark has been recorded. */
    closeWhenMarked?: string;
    /** Position of a shell that starts, waits for the grid, then exits badly. */
    shellFailsAfterShow?: number;
    /** Holds a `<SlowTeardown />` cell's finalizer until this settles. */
    holdTeardown?: () => Operation<void>;
    /**
     * Called once a cell's finalizer has been entered and is blocked, with what
     * the provider is holding at that moment.
     *
     * A row reads those counters here to know they ever went up, which is what
     * makes reading them again at the end mean something.
     */
    onTeardownEntered?: (live: TerminalProviderResources) => void;
    /**
     * Called once that finalizer has left.
     *
     * Kept apart from entering it deliberately: a finalizer that was entered
     * and then cancelled reaches the first hook and never the second, which is
     * the difference between teardown starting and teardown finishing.
     */
    onTeardownExited?: () => void;
    /**
     * Called once for each time the foreground lease is taken back after the
     * run, which the harness always does twice.
     *
     * It is the grid's lease that has to come back: a run that stranded it
     * would refuse the first of those, and one that never released what this
     * harness took would refuse the second.
     */
    onLeaseReacquired?: () => void;
    /** Interrupt the run when this settles rather than at a lifecycle signal. */
    interruptWhen?: Operation<void>;
    /**
     * Called once cancellation has begun but before it is awaited.
     *
     * A row that blocks a finalizer has to release it *after* the parent is
     * cancelled, or the cancellation would be waiting on the very thing the row
     * is holding. Awaiting the halt afterwards is what proves teardown
     * completed rather than merely started.
     */
    releaseOnInterrupt?: () => void;
    /**
     * How many cells must have settled before the run is interrupted.
     *
     * A cell's status is published only after its durable child has returned,
     * so this is also how many cell Closes the journal is known to hold.
     */
    settled?: number;
  } = {},
): Operation<DocumentRun> {
  return scoped(function* () {
    const requests: TerminalGridRequest[] = [];
    const log = terminalProviderLog();
    const ran: string[] = [];
    const errors: string[] = [];
    // Three signals, kept apart because they mean different things. `shown`
    // says a grid opened on this run. `pastGrid` says the document reached the
    // sibling after it, which is what a *replayed* grid does. `cellsSettled`
    // says the cell children the row cares about have written their records.
    //
    // Every one of them is an event this run produced. Nothing here waits for a
    // duration, so a replay that hangs reaches none of them and hangs the row —
    // it can never hand back a run that looks finished but is not.
    const shown = withResolvers<void>();
    const pastGrid = withResolvers<void>();
    const cellsSettled = withResolvers<void>();
    if ((options.settled ?? 0) === 0) {
      cellsSettled.resolve();
    }
    yield* Component.around({
      *raise([segment], next) {
        errors.push(segment.message);
        return yield* next(segment);
      },
    });
    const cellFailed = withResolvers<void>();
    // Resolved once a `<SlowTeardown />` cell has installed its finalizer.
    const armed = withResolvers<void>();
    const marked = withResolvers<void>();
    yield* useGridComponents(
      ran,
      [],
      (mark) => {
        if (mark === PAST_THE_GRID) {
          pastGrid.resolve();
        }
        if (mark === options.closeWhenMarked) {
          marked.resolve();
        }
      },
      () => shown.operation,
      function* () {
        options.onTeardownEntered?.(log.live);
        if (options.holdTeardown) {
          yield* options.holdTeardown();
        }
        options.onTeardownExited?.();
      },
      () => armed.resolve(),
    );
    yield* installControlledLauncher();
    if (options.provider !== false) {
      yield* useControlledProvider({
        log,
        close:
          options.closeAfterFailure === true
            ? () => cellFailed.operation
            : options.closeWhenMarked !== undefined
              ? () => marked.operation
              : options.closeWhenArmed === true
                ? () => armed.operation
                : options.close === true
                  ? immediateClose()
                  : () => suspend(),
        ...(options.shellFailsAfterShow !== undefined
          ? {
              shell: (position: number) =>
                resource<Operation<TerminalShellOutcome>>(function* (provide) {
                  // Acquired, so the cell is ready and the grid is shown; the
                  // failure is in the settlement afterwards, which is the
                  // failure a grid contains as a cell status.
                  if (position !== options.shellFailsAfterShow) {
                    yield* provide(done({ exitCode: 0 }));
                    return;
                  }
                  yield* provide(
                    (function* (): Operation<TerminalShellOutcome> {
                      yield* shown.operation;
                      return { exitCode: 1 };
                    })(),
                  );
                }),
            }
          : options.shell === undefined
            ? {}
            : { shell: options.shell }),
        // deno-lint-ignore require-yield
        *onPrepare(asked) {
          requests.push(asked);
        },
        // deno-lint-ignore require-yield
        *onShow() {
          shown.resolve();
        },
        // deno-lint-ignore require-yield
        *render(state) {
          for (const cell of state.cells) {
            if (cell.status === "failed") {
              cellFailed.resolve();
            }
          }
          const settledCells = state.cells.filter((cell) => isSettled(cell.status)).length;
          if (settledCells >= (options.settled ?? 0)) {
            cellsSettled.resolve();
          }
        },
      });
    }
    yield* installTerminalGridProfile(options.provider === false ? {} : { provider: "controlled" });

    const path = join(dir, "doc.md");
    yield* writeTextFile(path, source);
    const task: Task<void> = yield* spawn(function* () {
      const execution = yield* execute({
        path,
        stream,
        includes: [dir],
        ...(options.props === undefined ? {} : { props: options.props }),
      });
      yield* execution;
    });
    // `close: true` expects the grid to complete, so the run is interrupted only
    // once the document has moved past it — which is what leaves a completed
    // grid child under an incomplete root. Otherwise the grid is expected to
    // stay open, and the run is interrupted once it has been shown and the cell
    // records the row reads are durable.
    if (options.interruptWhen !== undefined) {
      yield* options.interruptWhen;
    } else if (options.close === true || options.closeAfterFailure === true) {
      yield* pastGrid.operation;
    } else {
      yield* shown.operation;
      yield* cellsSettled.operation;
    }
    // Cancellation is begun, then released, then awaited. A row that blocks a
    // finalizer has to release it after the parent is cancelled, or the
    // cancellation would be waiting on the very thing the row is holding; and
    // awaiting the halt afterwards is what proves teardown completed rather
    // than merely started.
    const halting = yield* spawn(() => task.halt());
    options.releaseOnInterrupt?.();
    yield* halting;
    // Taken and given back twice, now that the run is over. The first proves
    // the grid returned the foreground lease; the second proves this harness
    // gave it back too, so the first cannot have passed against a lease nobody
    // was holding in the first place.
    for (let attempt = 0; attempt < 2; attempt++) {
      yield* scoped(function* () {
        yield* reserveTerminal();
        options.onLeaseReacquired?.();
      });
    }
    return {
      outcome: Err(new Error("interrupted")),
      output: "",
      requests,
      shown: log.shown,
      events: log.events,
      ran,
      errors,
      journal: yield* stream.readAll(),
      live: log.live,
    };
  });
}

const CELLS = [
  '<Terminal title="Left">left<Interactive /></Terminal>',
  '<Terminal title="Right" />',
];

describe("Tier TG — presenting a grid from a document", () => {
  const GRID = ["<Terminal.Grid columns={2}>", ...CELLS, "</Terminal.Grid>", ""].join("\n");

  it("TA1: a handler that answers without presenting opens nothing", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, GRID, {});
    expect(run.outcome.ok).toBe(true);

    // The same document, against a provider that answers the routed request
    // itself. A return value is not evidence that a grid opened.
    const shorted = yield* scoped(function* () {
      const path = join(dir, "doc.md");
      const ran: string[] = [];
      yield* useGridComponents(ran);
      yield* installControlledLauncher();
      yield* useControlledProvider({ shortCircuit: true });
      yield* installTerminalGridProfile({ provider: "controlled" });
      const execution = yield* execute({ path, stream: new InMemoryStream(), includes: [dir] });
      const outcome = yield* execution;
      yield* forEach(function* (_chunk: string) {}, execution.output);
      return { outcome, ran };
    });

    expect(shorted.outcome.ok).toBe(false);
    expect(shorted.outcome.ok ? "" : shorted.outcome.error.message).toContain(
      "a handler answered without delivering the request to a registered provider",
    );
    // Nothing beneath the grid ran either.
    expect(shorted.ran).toEqual([]);
  });

  it("TA2: presenting a rebuilt request authorizes nothing", function* () {
    const dir = yield* useDir();
    const forged = yield* scoped(function* () {
      const path = join(dir, "doc.md");
      yield* writeTextFile(path, GRID);
      const ran: string[] = [];
      yield* useGridComponents(ran);
      yield* installControlledLauncher();
      // Same members, different object. Identity is what presentation reads.
      yield* useControlledProvider({
        substitute: (request) => ({
          columns: request.columns,
          rows: request.rows,
          cells: request.cells.map((cell) => ({ ...cell })),
        }),
      });
      yield* installTerminalGridProfile({ provider: "controlled" });
      const execution = yield* execute({ path, stream: new InMemoryStream(), includes: [dir] });
      const outcome = yield* execution;
      yield* forEach(function* (_chunk: string) {}, execution.output);
      return { outcome, ran };
    });

    expect(forged.outcome.ok).toBe(false);
    expect(forged.outcome.ok ? "" : forged.outcome.error.message).toContain(
      "this grid request is not live",
    );
    expect(forged.ran).toEqual([]);
  });

  it("TA3: presenting a changed request authorizes nothing", function* () {
    const dir = yield* useDir();
    const changed = yield* scoped(function* () {
      const path = join(dir, "doc.md");
      yield* writeTextFile(path, GRID);
      const ran: string[] = [];
      yield* useGridComponents(ran);
      yield* installControlledLauncher();
      yield* useControlledProvider({
        substitute: (request) => ({ ...request, columns: request.columns + 1 }),
      });
      yield* installTerminalGridProfile({ provider: "controlled" });
      const execution = yield* execute({ path, stream: new InMemoryStream(), includes: [dir] });
      const outcome = yield* execution;
      yield* forEach(function* (_chunk: string) {}, execution.output);
      return outcome;
    });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? "" : changed.error.message).toContain("this grid request is not live");
  });

  it("TA7: two cells are interactive at the same time", function* () {
    const dir = yield* useDir();
    const probe = cellProbe(2);
    const gateBoth = withResolvers<void>();
    let inside = 0;
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="a"><Concurrent mark="a" /></Terminal>',
        '<Terminal title="b"><Concurrent mark="b" /></Terminal>',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      {
        probe,
        grid: {
          shell: () =>
            resource<Operation<TerminalShellOutcome>>(function* (provide) {
              // Acquired: this cell is holding its activity. Settlement waits
              // for every other cell to be holding one too. Cells that
              // contended could never all be here at once.
              inside += 1;
              if (inside >= 2) {
                gateBoth.resolve();
              }
              yield* provide(
                (function* (): Operation<TerminalShellOutcome> {
                  const together = yield* race([
                    (function* (): Operation<boolean> {
                      yield* gateBoth.operation;
                      return true;
                    })(),
                    (function* (): Operation<boolean> {
                      yield* sleep(2000);
                      return false;
                    })(),
                  ]);
                  probe.marks.push(`together:${together}`);
                  return { exitCode: 0 };
                })(),
              );
            }),
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    expect(probe.marks.filter((mark) => mark === "together:true")).toHaveLength(2);
    // And both were holding before either let go.
    expect(probe.marks.indexOf("enter:b")).toBeLessThan(probe.marks.indexOf("leave:a"));
  });

  it("TA8: one cell refuses overlapping work, and admits the next after it settles", function* () {
    const dir = yield* useDir();
    const probe = cellProbe(1);
    const held = withResolvers<void>();
    let first = true;
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="a"><Overlapping /></Terminal>',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      {
        probe,
        grid: {
          shell: () =>
            resource<Operation<TerminalShellOutcome>>(function* (provide) {
              // The first activity holds the cell until the overlapping one has
              // been refused, so the refusal is what the row reads rather than
              // a schedule it hoped for.
              if (first) {
                first = false;
                yield* provide(
                  (function* (): Operation<TerminalShellOutcome> {
                    yield* held.operation;
                    return { exitCode: 0 };
                  })(),
                );
                return;
              }
              yield* provide(done({ exitCode: 0 }));
            }),
          // deno-lint-ignore require-yield
          *render(state) {
            if (probe.refusals.length > 0) {
              held.resolve();
            }
            void state;
          },
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    expect(probe.refusals).toHaveLength(1);
    expect(probe.refusals[0]).toContain("one owns a cell terminal at a time");
    // The refused operation never ran, and the one written after the first
    // settled did: a cell has one owner at a time, not one owner ever.
    expect(probe.marks).not.toContain("second entered");
    expect(probe.marks).toContain("sequential");
  });

  it("TA9: a cell handle kept past its grid admits nothing", function* () {
    const dir = yield* useDir();
    const probe = cellProbe(1);
    const held = withResolvers<void>();
    let first = true;
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="a"><Overlapping /></Terminal>',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      {
        probe,
        grid: {
          shell: () =>
            resource<Operation<TerminalShellOutcome>>(function* (provide) {
              if (first) {
                first = false;
                yield* provide(
                  (function* (): Operation<TerminalShellOutcome> {
                    yield* held.operation;
                    return { exitCode: 0 };
                  })(),
                );
                return;
              }
              yield* provide(done({ exitCode: 0 }));
            }),
          // deno-lint-ignore require-yield
          *render() {
            if (probe.refusals.length > 0) {
              held.resolve();
            }
          },
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    const kept = probe.kept[0];
    expect(kept).toBeDefined();

    let refusal: unknown;
    yield* scoped(function* () {
      try {
        yield* kept!.shell();
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusalOf(refusal)).toContain("has stopped admitting");
  });

  it("TA10: a child that spawns and settles at once is both ready and settled", function* () {
    const dir = yield* useDir();
    const probe = cellProbe(1);
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="a"><SettlesAtOnce /></Terminal>',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      { probe },
    );

    // Acquired and settled in the same breath: the grid was shown rather than
    // waiting for a cell that had already finished.
    expect(run.outcome.ok).toBe(true);
    expect(probe.marks).toContain("started and settled");
    expect(run.events.some((event) => event.startsWith("show:0:"))).toBe(true);
  });

  it("TA11: an activity that fails before acquisition never makes a cell ready", function* () {
    const dir = yield* useDir();
    const probe = cellProbe(1);
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="a"><Quiet /></Terminal>',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      { probe, grid: { shell: () => neverStarts() } },
    );

    // The cell owned its terminal and tried. Neither is starting.
    expect(probe.marks).toContain("tried to start");
    // The cell fails with the reason its activity could not start, rather than
    // with the generic "never started anything" — a spawn that failed says why.
    expect(failureOf(run)).toContain("this activity's child never spawned");
    expect(run.events.some((event) => event.startsWith("show:"))).toBe(false);
    expect(run.events).toContain("destroy:0");
  });
});

/**
 * What every completed journey must be able to say.
 *
 * The provider's host is released exactly once — not zero times, and not twice —
 * and nothing it handed out is still held. Both halves matter: a count alone
 * would pass for a run that released one host and stranded another.
 */
function expectReleasedOnce(run: DocumentRun, generation = 0): void {
  expect(run.events.filter((event) => event === `destroy:${generation}`)).toEqual([
    `destroy:${generation}`,
  ]);
  expect(run.live).toEqual({ grids: 0, shown: 0, activities: 0 });
}

describe("Tier TG — a grid written in a document", () => {
  it("TG4: the provider is asked for exactly the authored row-major layout", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="One" />',
        '<Terminal title="Two" />',
        '<Terminal title="Three" />',
        '<Terminal title="Four" />',
        '<Terminal title="Five" />',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
    );

    expect(run.outcome.ok).toBe(true);
    expect(run.requests).toHaveLength(1);
    // Position is identity: no ordinal, index or key duplicates it.
    expect(run.requests[0]).toEqual({
      columns: 2,
      rows: 3,
      cells: [
        { title: "One", row: 0, column: 0, form: "self-closing" },
        { title: "Two", row: 0, column: 1, form: "self-closing" },
        { title: "Three", row: 1, column: 0, form: "self-closing" },
        { title: "Four", row: 1, column: 1, form: "self-closing" },
        { title: "Five", row: 2, column: 0, form: "self-closing" },
      ],
    });
    // A grid that succeeded released its provider's host once, holding nothing.
    expectReleasedOnce(run);
  });

  it("TG4: duplicate titles stay valid, and identity is the position", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Agent">first<Interactive /></Terminal>',
        '<Terminal title="Agent" />',
        '<Terminal title="Agent">third<Interactive /></Terminal>',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
    );

    expect(run.outcome.ok).toBe(true);
    expect(run.requests[0]?.cells).toEqual([
      { title: "Agent", row: 0, column: 0, form: "paired" },
      { title: "Agent", row: 0, column: 1, form: "self-closing" },
      { title: "Agent", row: 1, column: 0, form: "paired" },
    ]);
  });

  it("TG7: root output is flushed before the grid, and cell text stays in its cell", function* () {
    const dir = yield* useDir();
    const flushed: string[] = [];
    const run = yield* runDocument(
      dir,
      [
        "before",
        "",
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Left">left text<Interactive /></Terminal>',
        '<Terminal title="Right">right text<Interactive /></Terminal>',
        "</Terminal.Grid>",
        "",
        "after",
        "",
      ].join("\n"),
      {
        grid: {
          // Preparation happens after the lease and the flush, so what the
          // reader had already been given is on screen before the grid covers
          // it.
          *onPrepare() {
            flushed.push("prepared");
          },
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    expect(flushed).toEqual(["prepared"]);
    // Each cell's own text went to that cell.
    expect(run.shown.get(0)).toContain("left text");
    expect(run.shown.get(1)).toContain("right text");
    // The grid renders "": the root output holds what surrounds it and no cell
    // display at all.
    expect(run.output).toContain("before");
    expect(run.output).toContain("after");
    expect(run.output).not.toContain("left text");
    expect(run.output).not.toContain("right text");
  });

  it("TG20: a cell's output is committed before the effect written after it", function* () {
    const dir = yield* useDir();
    // The shell records what the aggregate already said about its own cell at
    // the moment it was asked to start. Text written before `<Interactive />`
    // must already be there: an append that waited for the next authored effect
    // would show empty content here.
    const contentAtLaunch: string[] = [];
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Left">',
        "first paragraph",
        "",
        "<Interactive />",
        "",
        "second paragraph",
        "</Terminal>",
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      {
        grid: {
          shell: () =>
            resource<Operation<TerminalShellOutcome>>(function* (provide) {
              yield* provide(done({ exitCode: 0 }));
            }),
          // deno-lint-ignore require-yield
          *render(state) {
            for (const cell of state.cells) {
              if (cell.status === "launching") {
                contentAtLaunch.push(cell.content);
              }
            }
          },
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    expect(contentAtLaunch).toHaveLength(1);
    expect(contentAtLaunch[0]).toContain("first paragraph");
    // And what came after is not there yet: the append is per boundary, not one
    // dump at the end.
    expect(contentAtLaunch[0]).not.toContain("second paragraph");
    // The complete output is what the cell finally displays.
    expect(run.shown.get(0)).toContain("first paragraph");
    expect(run.shown.get(0)).toContain("second paragraph");
  });

  it("TG20: output nested inside one structural child reaches state before the action beside it", function* () {
    const dir = yield* useDir();
    // Every snapshot the renderer worked through, and what the newest of them
    // said at the moment the provider was asked for a terminal. Read off the
    // renderer rather than the store, so this is the screen the action waited
    // for rather than a value beside it.
    const rendered: TerminalGridState[] = [];
    const convergedContent: string[] = [];
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Left">',
        "<If condition={true}>",
        "before the action",
        "",
        "<Interactive />",
        "",
        "after the action",
        "</If>",
        "",
        "outside the branch",
        "</Terminal>",
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      {
        grid: {
          // deno-lint-ignore require-yield
          *render(state) {
            rendered.push(state);
          },
          shell: () =>
            resource<Operation<TerminalShellOutcome>>(function* (provide) {
              const applied = rendered[rendered.length - 1];
              convergedContent.push(applied?.cells[0]?.content ?? "");
              yield* provide(done({ exitCode: 0 }));
            }),
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    expect(convergedContent).toHaveLength(1);
    // The output written before the action inside the same branch is already
    // part of the desired screen the action converged through. A publication
    // that waited for the whole `<If>` to finish would have committed none of
    // it by now.
    expect(convergedContent[0]).toContain("before the action");
    // And nothing written after it is, at either depth.
    expect(convergedContent[0]).not.toContain("after the action");
    expect(convergedContent[0]).not.toContain("outside the branch");
    // All three reach the cell in the end, in authored order.
    const shown = run.shown.get(0) ?? "";
    expect(shown).toContain("before the action");
    expect(shown).toContain("after the action");
    expect(shown).toContain("outside the branch");
    expect(shown.indexOf("before the action")).toBeLessThan(shown.indexOf("after the action"));
    expect(shown.indexOf("after the action")).toBeLessThan(shown.indexOf("outside the branch"));
    // Once each: a boundary that published twice would repeat itself.
    expect(shown.split("before the action")).toHaveLength(2);
    expect(shown.split("after the action")).toHaveLength(2);
    expect(shown.split("outside the branch")).toHaveLength(2);
  });

  it("TG6: a cell inherits the grid site's bindings and keeps its own", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        '<Let as="shared" value={"site"} />',
        "",
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Left">',
        "sees {shared}",
        "",
        '<Let as="mine" value={"left"} />',
        "",
        "then {mine}",
        "",
        "<Interactive />",
        "</Terminal>",
        '<Terminal title="Right">',
        "sees {shared} and {mine}",
        "",
        "<Interactive />",
        "</Terminal>",
        "</Terminal.Grid>",
        "",
        "after {mine}",
        "",
      ].join("\n"),
    );

    expect(run.outcome.ok).toBe(true);
    // Inherited from the grid site.
    expect(run.shown.get(0)).toContain("sees site");
    expect(run.shown.get(1)).toContain("sees site");
    // Created inside one cell, visible to later work in that cell.
    expect(run.shown.get(0)).toContain("then left");
    // Invisible to the sibling and to the document after the grid: an
    // unresolved binding stays the literal text it was written as.
    expect(run.shown.get(1)).toContain("and {mine}");
    expect(run.output).toContain("after {mine}");
  });

  it("TG6: a cell's <Return> cannot claim a value body outside the grid", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "---",
        "returns:",
        "  type: string",
        "---",
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Cell">',
        '<Return value={"from the cell"} />',
        "<Interactive />",
        "</Terminal>",
        "</Terminal.Grid>",
        "",
        '<Return value={"from the document"} />',
        "",
      ].join("\n"),
    );

    // The cell has no enclosing value body to claim, so the <Return> written in
    // it is refused where it sits rather than becoming the document's value.
    expect(failureOf(run)).toContain(
      "is not written in the flow of a body that declares `returns`",
    );
    expect(failureOf(run)).not.toContain("from the document");
  });

  it("TG6: a cell's checked failure settles that cell and not its sibling", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Broken">',
        "<PrintErrors>",
        '<Fail message="this cell gave up" />',
        "</PrintErrors>",
        "<Interactive />",
        "</Terminal>",
        '<Terminal title="Fine">',
        '<Ran mark="sibling" />',
        "<Interactive />",
        "</Terminal>",
        "</Terminal.Grid>",
        "",
      ].join("\n"),
    );

    // Printed inside the cell it happened in, and the sibling ran regardless.
    expect(run.shown.get(0)).toContain("this cell gave up");
    expect(run.ran).toEqual(["sibling"]);
    expect(run.output).not.toContain("this cell gave up");
  });

  it("TG6: a paired cell runs every component in its body, in order", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    // The reader leaves only once the cell's *second* component has run, so a
    // cell body that stopped after the first would never let the grid close —
    // a hang rather than a pass.
    const run = yield* runInterrupted(
      dir,
      heldDocument(2, [
        '<Terminal title="Two components"><Interactive /><Ran mark="second component" /></Terminal>',
        '<Terminal title="Shell" />',
      ]),
      stream,
      { close: true, closeWhenMarked: "second component" },
    );

    expect(run.ran).toContain("second component");
  });

  it("TG9: with no provider installed, no cell body or shell runs", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Work">',
        '<Ran mark="cell body" />',
        "<Interactive />",
        "</Terminal>",
        '<Terminal title="Shell" />',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      { provider: false },
    );

    expect(failureOf(run)).toContain("no terminal provider is installed");
    // The cell held work; none of it was reached, and nothing was displayed.
    expect(run.ran).toEqual([]);
    expect(run.shown.size).toBe(0);
  });
});

describe("Tier TG — startup, settlement and teardown in a document", () => {
  const TWO = ["<Terminal.Grid columns={2}>", ...CELLS, "</Terminal.Grid>", ""].join("\n");

  it("TG9: nothing is shown until every cell has acquired a terminal activity", function* () {
    const dir = yield* useDir();
    // One ordered record the cell and the grid both write to, so "readiness
    // came first" is read rather than assumed.
    const timeline: string[] = [];
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Slow"><Slow /></Terminal>',
        '<Terminal title="Shell" />',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      {
        slowMarks: timeline,
        grid: {
          // deno-lint-ignore require-yield
          *onShow() {
            timeline.push("show");
          },
          shell: (position) =>
            resource<Operation<TerminalShellOutcome>>(function* (provide) {
              if (position === 1) {
                timeline.push("ready:shell");
              }
              yield* provide(done({ exitCode: 0 }));
            }),
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    // The slow cell started last, and the grid still waited for it.
    expect(timeline[timeline.length - 1]).toBe("show");
    expect(timeline).toContain("ready:slow");
  });

  it("TG9: a cell that never starts fails the grid, and nothing is shown", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Quiet">nothing interactive here</Terminal>',
        '<Terminal title="Shell" />',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
    );

    expect(failureOf(run)).toContain("finished without starting anything interactive");
    // No partial grid was ever shown, and the hidden host was released — once,
    // with nothing of the provider's still held.
    expect(run.events.some((event) => event.startsWith("show:"))).toBe(false);
    expectReleasedOnce(run);
  });

  it("TG9: an immediate spawn-and-exit is both ready and settled", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      ["<Terminal.Grid columns={1}>", '<Terminal title="Shell" />', "</Terminal.Grid>", ""].join(
        "\n",
      ),
    );

    expect(run.outcome.ok).toBe(true);
    // Ready the moment the activity was acquired, so the grid was shown;
    // settled straight after, so its final status is its own.
    expect(run.events.some((event) => event.startsWith("show:0:"))).toBe(true);
    expect(run.events).toContain("status:0:0:succeeded");
    expect(run.events.indexOf("status:0:0:succeeded")).toBeGreaterThan(
      run.events.findIndex((event) => event.startsWith("show:0:")),
    );
  });

  it("TG9: a preparation failure starts no cell at all", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, TWO, {
      grid: {
        // deno-lint-ignore require-yield
        *onPrepare() {
          throw new Error("no cell endpoint could be created");
        },
      },
    });

    expect(failureOf(run)).toContain("no cell endpoint could be created");
    expect(run.shown.size).toBe(0);
  });

  it("TG9: a failure showing the grid shows no partial grid and releases it", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, TWO, {
      grid: {
        // deno-lint-ignore require-yield
        *onShow() {
          throw new Error("the grid could not be shown");
        },
      },
    });

    expect(failureOf(run)).toContain("the grid could not be shown");
    expect(run.events).toContain("destroy:0");
  });

  it("TG9: simultaneous startup failures report the first authored position", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="First">no interactive child</Terminal>',
        '<Terminal title="Second">no interactive child either</Terminal>',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
    );

    // Both cells fail to start. The one reported is the first authored, not
    // whichever settled first.
    expect(failureOf(run)).toContain('terminal 0 ("First")');
    expect(failureOf(run)).not.toContain('terminal 1 ("Second")');
  });

  it("TG12: close cancels a live cell as closed, then destroys and continues", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Live"><Interactive /><Hold /></Terminal>',
        "</Terminal.Grid>",
        "",
        '<Ran mark="after the grid" />',
        "",
      ].join("\n"),
      {
        grid: {
          // The reader leaves while the cell is still live.
          close: immediateClose(),
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    // Teardown cancellation is not a cell failure.
    expect(run.events).toContain("status:0:0:closed");
    const destroyed = run.events.indexOf("destroy:0");
    expect(run.events.indexOf("closed:0")).toBeLessThan(destroyed);
    // Released once, after the reader left, with nothing still held.
    expectReleasedOnce(run);
    // The following sibling started only after the grid came down.
    expect(run.ran).toEqual(["after the grid"]);
  });

  it("TG13: an active provider failure cancels every cell and fails the grid", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, TWO, {
      grid: {
        // deno-lint-ignore require-yield
        *close() {
          throw new Error("the terminal provider lost its server");
        },
      },
    });

    expect(failureOf(run)).toContain("the terminal provider lost its server");
    // A provider that failed mid-grid still had its host released exactly once.
    expectReleasedOnce(run);
  });

  it("TG21: a background provider failure fails the grid with no foreground action", function* () {
    const dir = yield* useDir();
    const background = withResolvers<Error>();
    const run = yield* runDocument(dir, TWO, {
      grid: {
        // Nothing is waiting on the renderer: the reader never leaves, and the
        // failure is raised from the provider's own background observation.
        close: () => suspend(),
        fail: () => background.operation,
        // deno-lint-ignore require-yield
        *onShow() {
          background.resolve(new Error("the renderer lost its channel"));
        },
      },
    });

    expect(failureOf(run)).toContain("the renderer lost its channel");
    expectReleasedOnce(run);
  });
});

describe("Tier TG — durability and replay", () => {
  const GRID = heldDocument(2, CELLS);
  /**
   * A grid whose only cell never starts, with its failure contained.
   *
   * `<PrintErrors>` keeps the document going, so the root reaches no outcome of
   * its own and a resumed run reaches the region rather than replaying the root
   * wholesale.
   */
  const CONTAINED_FAILURE = [
    "<PrintErrors>",
    "<Terminal.Grid columns={2}>",
    '<Terminal title="Broken" />',
    '<Terminal title="Fine" />',
    "</Terminal.Grid>",
    "</PrintErrors>",
    "",
    `<Ran mark="${PAST_THE_GRID}" />`,
    "",
    "<Hold />",
    "",
  ].join("\n");

  /**
   * Whether the grid child reached a terminal record of its own.
   *
   * `ok` or `err`: both are outcomes the region settled on. Only a cancelled
   * close, or no close at all, means it was interrupted — and that is the
   * difference this row exists to depend on.
   */
  function completedGrid(run: DocumentRun): boolean {
    return run.journal.some(
      (event) =>
        event.type === "close" &&
        String(event.coroutineId).split(".").length === 2 &&
        (event.result.status === "ok" || event.result.status === "err"),
    );
  }

  /** What the grid child retained, read from its own completed `Close`. */
  function retainedGrid(run: DocumentRun): Record<string, unknown> | undefined {
    for (const event of run.journal) {
      if (
        event.type === "close" &&
        String(event.coroutineId).split(".").length === 2 &&
        event.result.status === "ok"
      ) {
        const value = event.result.value;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return { ...value };
        }
      }
    }
    return undefined;
  }

  /** The cell outcomes the grid retained, in authored order. */
  function cellOutcomes(run: DocumentRun): unknown[] {
    const cells = retainedGrid(run)?.cells;
    return Array.isArray(cells) ? cells : [];
  }

  /**
   * How every `Close` at this coroutine depth ended, in journal order.
   *
   * Depth 2 is the grid child and depth 3 its cells, so a row reads these to
   * say how many records each level wrote and what each one settled to —
   * including whether any of them settled as a cancellation.
   */
  function closeStatuses(run: DocumentRun, depth: number): string[] {
    const statuses: string[] = [];
    for (const event of run.journal) {
      if (event.type === "close" && String(event.coroutineId).split(".").length === depth) {
        statuses.push(event.result.status);
      }
    }
    return statuses;
  }

  it("TG15: a completed successful grid replays its exact result, with no work", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    const first = yield* runInterrupted(dir, GRID, stream, { close: true });
    expect(first.requests).toHaveLength(1);
    // The region genuinely completed: without that this row would be about an
    // interrupted grid resuming, which is TG16's claim rather than this one.
    expect(completedGrid(first)).toBe(true);

    const second = yield* runInterrupted(dir, GRID, stream, { close: true });

    // No provider was asked for a host, nothing was prepared, rendered or
    // shown, no cell content expanded, no shell or launcher ran, and nothing
    // displayed.
    expect(second.requests).toEqual([]);
    expect(second.events).toEqual([]);
    expect(second.shown.size).toBe(0);
    expect(second.ran).toEqual([PAST_THE_GRID]);
  });

  it("TG15: a contained failed grid replays the same failure, with no work", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    const first = yield* runInterrupted(dir, CONTAINED_FAILURE, stream, {
      closeAfterFailure: true,
      shellFailsAfterShow: 0,
    });
    expect(first.requests).toHaveLength(1);
    expect(completedGrid(first)).toBe(true);
    // What the failure looked like, as the document reported it.
    expect(first.errors.some((message) => message.includes("shell exited with status 1"))).toBe(
      true,
    );

    // No provider at all on the resumed run: a replay that contacted one would
    // refuse, and the retained result does not need one.
    const second = yield* runInterrupted(dir, CONTAINED_FAILURE, stream, {
      close: true,
      provider: false,
    });

    // The same result came back, rather than being derived again.
    expect(second.errors).toEqual(first.errors);
    // And the document carried on from it, exactly as it did the first time.
    expect(second.ran).toContain(PAST_THE_GRID);
    expect(second.requests).toEqual([]);
    expect(second.events).toEqual([]);
    expect(second.shown.size).toBe(0);
  });

  it("TG16: each cell is a durable child of the grid, in authored order", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    // Both cells settle, so both cell children have written their records.
    const first = yield* runInterrupted(dir, GRID, stream, { settled: 2 });

    const closes = first.journal.filter((event) => event.type === "close");
    const cellIds = closes
      .map((event) => String(event.coroutineId))
      .filter((id) => id.split(".").length >= 3)
      .sort();
    expect(cellIds).toHaveLength(2);
    const [left, right] = cellIds;
    // Authored order, not scheduling order, and both beneath one grid child.
    expect(left!.endsWith(".0")).toBe(true);
    expect(right!.endsWith(".1")).toBe(true);
    expect(left!.slice(0, left!.lastIndexOf("."))).toBe(right!.slice(0, right!.lastIndexOf(".")));
  });

  it("TG16: an interrupted grid acquires a fresh provider host rather than hanging", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    // Interrupted while the grid is open, so its child records a cancelled
    // close. The resumed run continues that region instead of suspending on it.
    const first = yield* runInterrupted(dir, GRID, stream);
    expect(first.requests).toHaveLength(1);

    const second = yield* runInterrupted(dir, GRID, stream);

    // A fresh host, acquired by this run, with a state sequence of its own that
    // starts at revision zero.
    expect(second.requests).toHaveLength(1);
    expect(second.events).toContain("prepare:0:2x1");
    expect(second.events).toContain("render:0:0");
  });

  it("TG16: a completed cell is restored; an incomplete shell starts again", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const source = heldDocument(2, [
      '<Terminal title="Left"><Ran mark="left ran" /><Interactive /></Terminal>',
      '<Terminal title="Right" />',
    ]);
    const holdingShell: ControlledProviderOptions["shell"] = (position) =>
      resource<Operation<TerminalShellOutcome>>(function* (provide) {
        if (position === 0) {
          yield* provide(done({ exitCode: 0 }));
          return;
        }
        // Started, and never finishes on its own.
        yield* provide(
          (function* (): Operation<TerminalShellOutcome> {
            yield* suspend();
            // Unreachable: the shell is released rather than returning.
            return { exitCode: 0 };
          })(),
        );
      });

    // The left cell settles; the shell holds, so only one cell record exists.
    const first = yield* runInterrupted(dir, source, stream, {
      shell: holdingShell,
      settled: 1,
    });
    expect(first.ran).toContain("left ran");

    const second = yield* runInterrupted(dir, source, stream, {
      shell: holdingShell,
      settled: 1,
    });

    // The completed cell came back from its retained outcome: its body did not
    // run again, and no activity was acquired for it.
    expect(second.ran).not.toContain("left ran");
    expect(second.events.filter((event) => event.startsWith("shell:"))).toEqual(["shell:0:1"]);
  });

  /**
   * A grid whose `columns` and first `title` come from props.
   *
   * A continuation executes the retained root, so the document itself cannot
   * change between runs — but props are not restored, so these two values are
   * exactly what a fixed retained source can still resolve differently.
   */
  const PROP_BORNE = [
    "---",
    "props:",
    "  columns:",
    "    type: number",
    "  label:",
    "    type: string",
    "---",
    "<Terminal.Grid columns={props.columns}>",
    "<Terminal title={props.label}>left<Interactive /></Terminal>",
    '<Terminal title="Right" />',
    "</Terminal.Grid>",
    "",
    `<Ran mark="${PAST_THE_GRID}" />`,
    "",
    "<Hold />",
    "",
  ].join("\n");

  it("TG17: a changed prop-borne column count refuses with zero provider observation", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    const first = yield* runInterrupted(dir, PROP_BORNE, stream, {
      props: { columns: 2, label: "Left" },
    });
    expect(first.requests).toHaveLength(1);

    const second = yield* runDocument(dir, PROP_BORNE, {
      stream,
      props: { columns: 3, label: "Left" },
    });

    // Refused before the foreground lease and before the provider: nothing was
    // prepared, rendered or displayed.
    expect(second.requests).toEqual([]);
    expect(second.events).toEqual([]);
    expect(second.shown.size).toBe(0);
    // A replay refusal, not a run that opened something and then failed, and it
    // names the value that changed.
    expect(failureOf(second)).toContain("columns 2 rather than 3");
    expect(failureOf(second)).toContain("cannot be replayed onto this run");
  });

  it("TG17: a changed prop-borne title refuses with zero provider observation", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    const first = yield* runInterrupted(dir, PROP_BORNE, stream, {
      props: { columns: 2, label: "Left" },
    });
    expect(first.requests).toHaveLength(1);

    const second = yield* runDocument(dir, PROP_BORNE, {
      stream,
      props: { columns: 2, label: "Elsewhere" },
    });

    expect(second.requests).toEqual([]);
    expect(failureOf(second)).toContain('terminal 0 titled "Left" rather than "Elsewhere"');
    expect(second.events).toEqual([]);
    expect(second.shown.size).toBe(0);
  });

  it("TG17: an unchanged prop-borne layout is admitted", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const props = { columns: 2, label: "Left" };

    yield* runInterrupted(dir, PROP_BORNE, stream, { props });
    const second = yield* runInterrupted(dir, PROP_BORNE, stream, { props });

    // The discriminator for the two rows above: the same resolved layout
    // resumes and opens a grid, so a refusal there is about the change.
    expect(second.requests).toHaveLength(1);
  });

  it("TG17: a continuation opens the retained structure, not the file's", function* () {
    const structural: [string, string[]][] = [
      ["cell count", [...CELLS, '<Terminal title="Extra" />']],
      ["cell order", ['<Terminal title="Right" />', ...CELLS.slice(0, 1)]],
      ["cell form", ['<Terminal title="Left" />', '<Terminal title="Right" />']],
    ];

    for (const [what, cells] of structural) {
      const dir = yield* useDir();
      const stream = new InMemoryStream();
      const first = yield* runInterrupted(dir, GRID, stream);
      const retained = first.requests[0]!;

      // The file now says something else. A continuation executes the root the
      // journal retained, so the grid it opens is the one that was recorded.
      const second = yield* runInterrupted(dir, heldDocument(2, cells), stream);

      expect(`${what}: ${second.requests.length}`).toBe(`${what}: 1`);
      expect(`${what}: ${JSON.stringify(second.requests[0])}`).toBe(
        `${what}: ${JSON.stringify(retained)}`,
      );
    }
  });

  it("TG17: the retained record holds the complete authored cell structure", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const run = yield* runInterrupted(dir, GRID, stream);

    const layout = run.journal.find(
      (event) => event.type === "yield" && String(event.description.name).endsWith(":layout"),
    );
    expect(layout).toBeDefined();
    const value =
      layout?.type === "yield" && layout.result.status === "ok" ? layout.result.value : undefined;
    // Every authored cell, with its title, form and derived position — and no
    // ordinal, index, key or live identity beside them.
    expect(value).toEqual({
      columns: 2,
      rows: 1,
      cells: [
        { title: "Left", form: "paired", row: 0, column: 0 },
        { title: "Right", form: "self-closing", row: 0, column: 1 },
      ],
    });
  });

  it("TG17: a malformed retained layout refuses before provider observation", function* () {
    /** The retained layout, replaced by something the record cannot mean. */
    const damaged: [string, Json][] = [
      ["a missing member", { columns: 2, cells: [] }],
      [
        "an extra member",
        {
          columns: 2,
          rows: 1,
          extra: true,
          cells: [
            { title: "Left", form: "paired", row: 0, column: 0 },
            { title: "Right", form: "self-closing", row: 0, column: 1 },
          ],
        },
      ],
      [
        "a mistyped member",
        {
          columns: "two",
          rows: 1,
          cells: [
            { title: "Left", form: "paired", row: 0, column: 0 },
            { title: "Right", form: "self-closing", row: 0, column: 1 },
          ],
        },
      ],
      [
        "a retained ordinal",
        {
          columns: 2,
          rows: 1,
          cells: [
            { ordinal: 0, title: "Left", form: "paired", row: 0, column: 0 },
            { ordinal: 1, title: "Right", form: "self-closing", row: 0, column: 1 },
          ],
        },
      ],
      [
        "a record that disagrees with itself",
        {
          columns: 2,
          rows: 5,
          cells: [
            { title: "Left", form: "paired", row: 3, column: 1 },
            { title: "Right", form: "self-closing", row: 0, column: 1 },
          ],
        },
      ],
    ];

    for (const [what, layout] of damaged) {
      const dir = yield* useDir();
      const stream = new InMemoryStream();
      yield* runInterrupted(dir, GRID, stream);

      // The same journal with only its layout entry replaced, so nothing else
      // about the continuation changes.
      const damagedStream = new InMemoryStream();
      for (const event of yield* stream.readAll()) {
        const isLayout =
          event.type === "yield" && String(event.description.name).endsWith(":layout");
        yield* damagedStream.append(
          isLayout && event.result.status === "ok"
            ? { ...event, result: { status: "ok", value: layout } }
            : event,
        );
      }

      const second = yield* runDocument(dir, GRID, { stream: damagedStream });

      expect(`${what}: ${second.outcome.ok}`).toBe(`${what}: false`);
      // Refused while reading the record, before anything was asked for.
      expect(`${what}: ${second.requests.length}`).toBe(`${what}: 0`);
      expect(`${what}: ${second.events.length}`).toBe(`${what}: 0`);
      expect(`${what}: ${second.shown.size}`).toBe(`${what}: 0`);
    }
  });

  it("TG19: a cancellation during reader-close teardown waits for it, and replays", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const source = heldDocument(2, [
      '<Terminal title="Live"><Interactive /><Ran mark="cell body" /><SlowTeardown /></Terminal>',
      '<Terminal title="Shell" />',
    ]);

    // Signals and counters, and nothing else. Every step below is an event this
    // run produced, so a lifecycle that never reached one hangs the row rather
    // than passing it, and every "exactly once" claim is a count rather than a
    // look at the record.
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    let entries = 0;
    let exits = 0;
    let leases = 0;
    let heldWhenBlocked: TerminalProviderResources | undefined;

    const first = yield* runInterrupted(dir, source, stream, {
      // 1. The live cell arms its blocking finalizer, and 2. only then does the
      //    reader leave.
      closeWhenArmed: true,
      // 3. Entering the finalizer is observed, and it blocks there.
      onTeardownEntered: (live) => {
        entries++;
        heldWhenBlocked = { ...live };
        entered.resolve();
      },
      holdTeardown: () => release.operation,
      onTeardownExited: () => {
        exits++;
      },
      // 4. Cancellation begins while that finalizer is still blocked.
      interruptWhen: entered.operation,
      // 5. Released afterwards, so the cancellation was not waiting on it.
      releaseOnInterrupt: () => release.resolve(),
      onLeaseReacquired: () => {
        leases++;
      },
    });

    // 6. Teardown ran to the end, and the grid recorded a completed close —
    //    both before the cancellation was observed, because the document never
    //    reached the sibling after the grid.
    expect(entries).toBe(1);
    expect(exits).toBe(1);
    expect(first.events.filter((event) => event === "destroy:0")).toEqual(["destroy:0"]);
    expect(first.ran).toEqual(["cell body"]);

    // One grid child, completed, and it says what closed it.
    expect(closeStatuses(first, 2)).toEqual(["ok"]);
    expect(retainedGrid(first)?.close).toBe("reader");
    // Two cell children, both completed. Neither they nor the grid recorded a
    // cancellation: a cancelled child is what a later run would have to revive,
    // and these have nothing left to do.
    expect(closeStatuses(first, 3)).toEqual(["ok", "ok"]);
    expect(cellOutcomes(first)).toEqual([
      { status: "closed", reason: "" },
      { status: "succeeded", reason: "" },
    ]);

    // The provider's counters went up and came back down. Reading them only at
    // the end would be true of counters that never moved.
    expect(heldWhenBlocked).toEqual({ grids: 1, shown: 1, activities: 0 });
    expect(first.live).toEqual({ grids: 0, shown: 0, activities: 0 });
    // And the foreground lease came back: it was taken and given back twice
    // over once the run was done.
    expect(leases).toBe(2);

    // 7. Resumed with three tripwires: no provider at all, so a replay that
    //    asked for a host would refuse; a mark inside the cell body, so a cell
    //    that expanded again would say so; and the finalizer, which would
    //    report being entered a second time.
    let reentered = 0;
    const second = yield* runInterrupted(dir, source, stream, {
      close: true,
      provider: false,
      onTeardownEntered: () => {
        reentered++;
      },
    });

    expect(second.requests).toEqual([]);
    expect(second.events).toEqual([]);
    expect(second.shown.size).toBe(0);
    expect(reentered).toBe(0);
    // The retained grid came back and the document carried on from it.
    expect(second.ran).toEqual([PAST_THE_GRID]);
  });

  it("TG17: the retained layout and cell outcomes are provider-neutral", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const run = yield* runInterrupted(dir, GRID, stream);

    const written = JSON.stringify(run.journal);
    expect(written).toContain('"columns":2');
    expect(written).toContain('"Left"');
    for (const leak of ["socket", "tmux", "attach-key", "argv", "multiplexer", "ordinal"]) {
      expect(`${leak}: ${written.includes(leak)}`).toBe(`${leak}: false`);
    }
  });
});
