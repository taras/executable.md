/**
 * Tier TG — running a terminal grid through a replaceable provider
 * (spec §6.21, architecture.md §Terminal authority, §Atomic presentation and
 * settlement, §Durability and replay).
 *
 * The provider here is controlled and is not tmux: it opens no terminal, starts
 * no process, and records what it was asked to do in the order it was asked.
 * Every ordering claim is read off that record. Nothing is inferred from
 * timing, because a grid that attached too early and one that attached on time
 * take the same wall clock.
 *
 * Readiness is the claim these rows care about most, so it is always driven
 * explicitly: a pane becomes ready because something called the latch it was
 * handed, never because it got far enough. That is what lets "started" and "did
 * some work" be told apart at all.
 *
 * A paired pane is ready only when something in it starts and reports a spawn.
 * Until the native-launch Story lands, `<Interactive />` is what a suite writes
 * to be that something — and it reaches the pane through the same seam a real
 * `<Session.Launch>` will.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
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
  installControlledLauncher,
  prepareControlledComposite,
  reserveTerminal,
  TerminalGrids,
  terminalProviderLog,
} from "@executablemd/runtime";
import type {
  ControlledCompositeOptions,
  TerminalComposite,
  TerminalGridRequest,
  TerminalProviderLog,
  TerminalProviderResources,
} from "@executablemd/runtime";

import { Component } from "../src/component-api.ts";
import { execute } from "../src/execute.ts";
import { registerComponents } from "../src/components/registration.ts";
import {
  createTerminalGridClaims,
  TerminalAuthorityError,
  useTerminalInstallation,
} from "../src/terminal/authority.ts";
import type { TerminalGridAuthority } from "../src/terminal/authority.ts";
import {
  installTerminalProvider,
  registerTerminalProvider,
  TerminalProviderInstallError,
  TerminalProviders,
} from "../src/terminal/provider-api.ts";
import { installTerminalGridProfile } from "../src/terminal/profile.ts";
import { paneTerminal } from "../src/terminal/pane.ts";
import type { Json } from "../src/types.ts";

/** One document run against a controlled grid host. */
interface DocumentRun {
  outcome: Result<Json>;
  /** Text the consumer received — the root document's own output. */
  output: string;
  /** The grid the provider was actually asked to present. */
  requests: TerminalGridRequest[];
  /** What each pane displayed. */
  shown: Map<number, string>;
  /** Everything the composite did, in order. */
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

/** The controlled interactive child, and a tripwire. */
function useGridComponents(
  ran: string[],
  slowMarks: string[] = [],
  onMark: (mark: string) => void = () => {},
  afterAttach: () => Operation<void> = function* () {},
  teardownHeld: () => Operation<void> = function* () {},
  teardownArmed: () => void = () => {},
): Operation<void> {
  return registerComponents([
    {
      name: "Interactive",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const pane = yield* paneTerminal();
        if (pane === undefined) {
          throw new Error("<Interactive /> is written inside a <Terminal> pane");
        }
        yield* pane.interactive(function* (spawned) {
          spawned();
        });
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
      // Starts interactively, slowly, and records when it did.
      name: "Slow",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const pane = yield* paneTerminal();
        if (pane === undefined) {
          throw new Error("<Slow /> is written inside a <Terminal> pane");
        }
        yield* pane.interactive(function* (spawned) {
          yield* sleep(25);
          slowMarks.push("ready:slow");
          spawned();
        });
        return "";
      },
    },
    {
      // Holds the pane open, and blocks its own teardown until released — so a
      // row can interrupt a run while reader-close teardown is in progress.
      name: "SlowTeardown",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* ensure(function* () {
          yield* teardownHeld();
        });
        // Armed: the finalizer is installed and this pane is live, which is
        // what a row waits for before letting the reader leave.
        teardownArmed();
        yield* suspend();
        return "";
      },
    },
    {
      // Waits until the grid has attached, so a pane can fail *after* the
      // barrier — which is the failure the grid contains as a status rather
      // than the startup failure that fails the whole region.
      name: "AfterAttach",
      origin: "tier-tg",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* afterAttach();
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

/**
 * Register a controlled provider that presents through the authority it was
 * delivered.
 *
 * This is the whole handshake in miniature: the factory receives the authority
 * as an argument, prepares a composite of its own, and presents the exact
 * request it was routed. Nothing it returns reaches core.
 */
function useControlledProvider(
  options: ControlledCompositeOptions & {
    /** Present something other than the request that was routed. */
    readonly substitute?: (request: TerminalGridRequest) => TerminalGridRequest;
    /** Answer the routed request without presenting anything at all. */
    readonly shortCircuit?: boolean;
    /** Keep the authority for a later, unrouted use. */
    readonly capture?: (authority: TerminalGridAuthority) => void;
  } = {},
): Operation<void> {
  let generation = 0;
  return registerTerminalProvider("controlled", function* (_settings, authority) {
    options.capture?.(authority);
    yield* TerminalGrids.around(
      {
        *open([request]) {
          if (options.shortCircuit === true) {
            // Answers, presents nothing. Core must not believe this.
            return { presented: true };
          }
          const composite = yield* prepareControlledComposite(request, options, generation++);
          yield* authority.present(options.substitute?.(request) ?? request, composite);
          return undefined;
        },
      },
      { at: "min" },
    );
  });
}

/** Everything a controlled grid host installs, for an in-process grid. */
function useGridHost(
  options: Parameters<typeof useControlledProvider>[0] = {},
): Operation<TerminalGridAuthority> {
  return (function* (): Operation<TerminalGridAuthority> {
    yield* installControlledLauncher();
    yield* useControlledProvider(options);
    const authority = yield* useTerminalInstallation();
    yield* installTerminalProvider("controlled", { label: "controlled" }, authority);
    return authority;
  })();
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
    composite?: ControlledCompositeOptions;
    /** Where `<Slow />` records that it started. */
    slowMarks?: string[];
    /** Props this run supplies. Props are not restored across a continuation. */
    props?: Record<string, Json>;
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
    yield* useGridComponents(ran, options.slowMarks ?? []);
    yield* installControlledLauncher();

    // The reader stays until every pane has settled. Leaving sooner is a real
    // thing a reader does — TG12 covers it — but a row about what a pane
    // rendered must not race the close that cancels it.
    const settled = withResolvers<void>();
    let expected = 0;
    let done = 0;
    const supplied = options.composite ?? {};
    if (options.provider !== false) {
      yield* useControlledProvider({
        ...supplied,
        log,
        close: supplied.close ?? (() => settled.operation),
        *onPrepare(asked) {
          expected = asked.panes.length;
          requests.push(asked);
          if (supplied.onPrepare) {
            yield* supplied.onPrepare(asked);
          }
        },
        onUpdate(ordinal, state) {
          supplied.onUpdate?.(ordinal, state);
          if (state === "succeeded" || state === "failed" || state === "closed") {
            done++;
            if (done >= expected) {
              settled.resolve();
            }
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

/** The message a run failed with, failing the test if it completed. */
function failureOf(run: DocumentRun): string {
  if (run.outcome.ok) {
    throw new Error(`expected the document to fail, but it completed: ${run.outcome.value}`);
  }
  return run.outcome.error.message;
}

/** A grid on its own, which a resumed run can carry to an outcome. */
function plainDocument(columns: number, panes: string[]): string {
  return [`<Terminal.Grid columns={${columns}}>`, ...panes, "</Terminal.Grid>", ""].join("\n");
}

/** A grid, then a component that holds the run open so the root never settles. */
function heldDocument(columns: number, panes: string[]): string {
  return [
    `<Terminal.Grid columns={${columns}}>`,
    ...panes,
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
    shell?: ControlledCompositeOptions["shell"];
    /** Let the reader leave, so the grid completes rather than staying open. */
    close?: boolean;
    /** Props this run supplies. Props are not restored across a continuation. */
    props?: Record<string, Json>;
    /**
     * Keep the grid open until a pane reports a failure.
     *
     * A pane that fails *after* attachment is contained as that pane's status,
     * and the grid settles as failed rather than throwing. Closing before that
     * would record the pane as cancelled by the close instead.
     */
    closeAfterFailure?: boolean;
    /** Let the reader leave only once a `<SlowTeardown />` pane is armed. */
    closeWhenArmed?: boolean;
    /** Let the reader leave only once this tripwire mark has been recorded. */
    closeWhenMarked?: string;
    /** Ordinal of a shell that starts, waits for attachment, then exits badly. */
    shellFailsAfterAttach?: number;
    /** Holds a `<SlowTeardown />` pane's finalizer until this settles. */
    holdTeardown?: () => Operation<void>;
    /**
     * Called once a pane's finalizer has been entered and is blocked, with what
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
     * How many panes must have settled before the run is interrupted.
     *
     * A pane's status is published only after its durable child has returned,
     * so this is also how many pane Closes the journal is known to hold. Rows
     * that read those records name the number they need; rows that only need an
     * open grid name none.
     */
    settled?: number;
  } = {},
): Operation<DocumentRun> {
  return scoped(function* () {
    const requests: TerminalGridRequest[] = [];
    const log = terminalProviderLog();
    const ran: string[] = [];
    const errors: string[] = [];
    // Three signals, kept apart because they mean different things. `attached`
    // says a grid opened on this run. `pastGrid` says the document reached the
    // sibling after it, which is what a *replayed* grid does and what a
    // completed-region journal has to be waited for. `panesSettled` says the
    // pane children the row cares about have written their own records.
    //
    // Every one of them is an event this run produced. Nothing here waits for a
    // duration, so a replay that hangs reaches none of them and hangs the row —
    // it can never hand back a run that looks finished but is not.
    const attached = withResolvers<void>();
    const pastGrid = withResolvers<void>();
    const panesSettled = withResolvers<void>();
    let settledPanes = 0;
    if ((options.settled ?? 0) === 0) {
      panesSettled.resolve();
    }
    // The printed errors this run produced, which is how a contained failure is
    // observable at all — and the same list on a replayed run is how "the same
    // result came back" is read rather than assumed.
    yield* Component.around({
      *raise([segment], next) {
        errors.push(segment.message);
        return yield* next(segment);
      },
    });
    const paneFailed = withResolvers<void>();
    // Resolved once a `<SlowTeardown />` pane has installed its finalizer.
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
      () => attached.operation,
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
            ? () => paneFailed.operation
            : options.closeWhenMarked !== undefined
              ? () => marked.operation
              : options.closeWhenArmed === true
                ? () => armed.operation
                : options.close === true
                  ? immediateClose()
                  : () => suspend(),
        ...(options.shellFailsAfterAttach !== undefined
          ? {
              shell: function* (ordinal: number, spawned: () => void) {
                spawned();
                if (ordinal !== options.shellFailsAfterAttach) {
                  return { exitCode: 0 };
                }
                // Started, so the grid attaches; it fails only afterwards, which
                // is the failure a grid contains as a pane status.
                yield* attached.operation;
                return { exitCode: 1 };
              },
            }
          : options.shell === undefined
            ? {}
            : { shell: options.shell }),
        // deno-lint-ignore require-yield
        *onPrepare(asked) {
          requests.push(asked);
        },
        // Attach, not `running`: a pane that settles before the barrier keeps
        // its own status and never becomes runnable.
        // deno-lint-ignore require-yield
        *onAttach() {
          attached.resolve();
        },
        onUpdate(_ordinal, state) {
          if (state === "failed") {
            paneFailed.resolve();
          }
          if (state === "succeeded" || state === "failed" || state === "closed") {
            settledPanes++;
            if (settledPanes >= (options.settled ?? 0)) {
              panesSettled.resolve();
            }
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
    // stay open, and the run is interrupted once it has opened and the pane
    // records the row reads are durable.
    if (options.interruptWhen !== undefined) {
      yield* options.interruptWhen;
    } else if (options.close === true || options.closeAfterFailure === true) {
      yield* pastGrid.operation;
    } else {
      yield* attached.operation;
      yield* panesSettled.operation;
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
      outcome: { ok: false, error: new Error("interrupted") } as Result<Json>,
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

const PANES = [
  '<Terminal title="Left">left<Interactive /></Terminal>',
  '<Terminal title="Right" />',
];

describe("Tier TG — the terminal authority", () => {
  const GRID = ["<Terminal.Grid columns={2}>", ...PANES, "</Terminal.Grid>", ""].join("\n");

  it("TA1: a handler that answers without presenting opens nothing", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, GRID, { composite: {} as ControlledCompositeOptions });
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
    const run = yield* runDocument(dir, GRID, {
      composite: {},
    });
    expect(run.outcome.ok).toBe(true);

    const forged = yield* scoped(function* () {
      const path = join(dir, "doc.md");
      const ran: string[] = [];
      yield* useGridComponents(ran);
      yield* installControlledLauncher();
      // Same members, different object. Identity is what the authority reads.
      yield* useControlledProvider({
        substitute: (request) => ({
          columns: request.columns,
          rows: request.rows,
          panes: request.panes.map((pane) => ({ ...pane })),
        }),
      });
      yield* installTerminalGridProfile({ provider: "controlled" });
      const execution = yield* execute({ path, stream: new InMemoryStream(), includes: [dir] });
      const outcome = yield* execution;
      yield* forEach(function* (_chunk: string) {}, execution.output);
      return outcome;
    });

    expect(forged.ok).toBe(false);
    expect(forged.ok ? "" : forged.error.message).toContain("this grid request is not live");
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

  it("TA4: an authority kept past its grid authorizes nothing", function* () {
    const dir = yield* useDir();
    let kept: TerminalGridAuthority | undefined;
    const run = yield* runDocument(dir, GRID, {});
    expect(run.outcome.ok).toBe(true);

    yield* scoped(function* () {
      const path = join(dir, "doc.md");
      const ran: string[] = [];
      yield* useGridComponents(ran);
      yield* installControlledLauncher();
      yield* useControlledProvider({ capture: (authority) => (kept = authority) });
      yield* installTerminalGridProfile({ provider: "controlled" });
      const execution = yield* execute({ path, stream: new InMemoryStream(), includes: [dir] });
      yield* execution;
      yield* forEach(function* (_chunk: string) {}, execution.output);
    });

    // The execution has finished, so the request it issued is no longer live.
    let refusal: unknown;
    yield* scoped(function* () {
      const composite = yield* prepareControlledComposite(
        {
          columns: 1,
          rows: 1,
          panes: [{ ordinal: 0, title: "x", row: 0, column: 0, form: "self-closing" }],
        },
        {},
      );
      try {
        yield* kept!.present(
          {
            columns: 1,
            rows: 1,
            panes: [{ ordinal: 0, title: "x", row: 0, column: 0, form: "self-closing" }],
          },
          composite,
        );
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(TerminalAuthorityError);
    expect(refusal instanceof Error ? refusal.message : "").toContain("is not live");
  });

  it("TA5: an authority from another installation generation authorizes nothing", function* () {
    let refusal: unknown;
    yield* scoped(function* () {
      // Two installations in one scope: the second supersedes the first, so the
      // first's authority names a generation the live registry no longer has.
      const stale = yield* scoped(function* () {
        return yield* useTerminalInstallation();
      });
      yield* useTerminalInstallation();
      const composite = yield* prepareControlledComposite(
        {
          columns: 1,
          rows: 1,
          panes: [{ ordinal: 0, title: "x", row: 0, column: 0, form: "self-closing" }],
        },
        {},
      );
      try {
        yield* stale.present(
          {
            columns: 1,
            rows: 1,
            panes: [{ ordinal: 0, title: "x", row: 0, column: 0, form: "self-closing" }],
          },
          composite,
        );
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(TerminalAuthorityError);
    expect(refusal instanceof Error ? refusal.message : "").toContain("is not live");
  });

  it("TA6: a provider that never acknowledges installs nothing", function* () {
    let refusal: unknown;
    yield* scoped(function* () {
      const authority = yield* useTerminalInstallation();
      // A handler that answers the install request without delivering it to a
      // registered provider.
      yield* registerTerminalProvider("real", function* () {});
      yield* TerminalProviders.around({
        // deno-lint-ignore require-yield
        *install() {
          return undefined;
        },
      });
      try {
        yield* installTerminalProvider("real", { label: "real" }, authority);
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeInstanceOf(TerminalProviderInstallError);
    expect(refusal instanceof Error ? refusal.message : "").toContain("did not install");
  });

  it("TA7: two claims from one grid do not contend; one pane admits one", function* () {
    const grid = createTerminalGridClaims({
      columns: 2,
      rows: 1,
      panes: [
        { ordinal: 0, title: "a", row: 0, column: 0, form: "paired" },
        { ordinal: 1, title: "b", row: 0, column: 1, form: "paired" },
      ],
    });
    const first = grid.claims[0]!;
    const second = grid.claims[1]!;
    let refusal: unknown;
    let concurrent = false;

    yield* scoped(function* () {
      yield* first.admit(function* () {
        try {
          yield* first.admit(function* () {});
        } catch (error) {
          refusal = error;
        }
        yield* second.admit(function* () {
          concurrent = true;
        });
      });
    });

    expect(refusal).toBeInstanceOf(TerminalAuthorityError);
    expect(refusal instanceof Error ? refusal.message : "").toContain(
      "one owns a pane terminal at a time",
    );
    expect(concurrent).toBe(true);
  });

  it("TA8: a claim from another grid, or a sealed one, admits nothing", function* () {
    const request = {
      columns: 1,
      rows: 1,
      panes: [{ ordinal: 0, title: "a", row: 0, column: 0, form: "paired" as const }],
    };
    const first = createTerminalGridClaims(request);
    const second = createTerminalGridClaims(request);
    // Sealing one grid says nothing about the other: claims belong to the grid
    // that minted them, not to a request shape.
    first.seal();

    let refusal: unknown;
    let other = false;
    yield* scoped(function* () {
      try {
        yield* first.claims[0]!.admit(function* () {});
      } catch (error) {
        refusal = error;
      }
      yield* second.claims[0]!.admit(function* () {
        other = true;
      });
    });

    expect(refusal instanceof Error ? refusal.message : "").toContain("its grid has stopped");
    expect(other).toBe(true);
  });

  it("TA9: readiness is the acknowledgement, and acknowledging twice is one event", function* () {
    const grid = createTerminalGridClaims({
      columns: 1,
      rows: 1,
      panes: [{ ordinal: 0, title: "a", row: 0, column: 0, form: "paired" }],
    });
    const claim = grid.claims[0]!;
    const readiness = grid.readiness[0]!;

    // Doing work is not being ready.
    expect(readiness.acknowledged).toBe(false);
    claim.ready();
    expect(readiness.acknowledged).toBe(true);
    claim.ready();
    expect(readiness.acknowledged).toBe(true);
    yield* scoped(function* () {
      yield* readiness.reached();
    });
  });

  it("TA10: a request whose ordinals are not its positions is refused", function* () {
    let refusal: unknown;
    try {
      createTerminalGridClaims({
        columns: 2,
        rows: 1,
        panes: [
          { ordinal: 1, title: "a", row: 0, column: 0, form: "paired" },
          { ordinal: 0, title: "b", row: 0, column: 1, form: "paired" },
        ],
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(TerminalAuthorityError);
    yield* sleep(0);
  });
});

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
    expect(run.requests[0]).toEqual({
      columns: 2,
      rows: 3,
      panes: [
        { ordinal: 0, title: "One", row: 0, column: 0, form: "self-closing" },
        { ordinal: 1, title: "Two", row: 0, column: 1, form: "self-closing" },
        { ordinal: 2, title: "Three", row: 1, column: 0, form: "self-closing" },
        { ordinal: 3, title: "Four", row: 1, column: 1, form: "self-closing" },
        { ordinal: 4, title: "Five", row: 2, column: 0, form: "self-closing" },
      ],
    });
  });

  it("TG4: duplicate titles stay valid, and identity is the ordinal", function* () {
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
    expect(run.requests[0]?.panes).toEqual([
      { ordinal: 0, title: "Agent", row: 0, column: 0, form: "paired" },
      { ordinal: 1, title: "Agent", row: 0, column: 1, form: "self-closing" },
      { ordinal: 2, title: "Agent", row: 1, column: 0, form: "paired" },
    ]);
  });

  it("TG7: root output is flushed before the grid, and pane text stays in its pane", function* () {
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
        composite: {
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
    // Each pane's own text went to that pane.
    expect(run.shown.get(0)).toContain("left text");
    expect(run.shown.get(1)).toContain("right text");
    // The grid renders "": the root output holds what surrounds it and no pane
    // display at all.
    expect(run.output).toContain("before");
    expect(run.output).toContain("after");
    expect(run.output).not.toContain("left text");
    expect(run.output).not.toContain("right text");
  });

  it("TG6: a pane inherits the grid site's bindings and keeps its own", function* () {
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
    // Created inside one pane, visible to later work in that pane.
    expect(run.shown.get(0)).toContain("then left");
    // Invisible to the sibling and to the document after the grid: an
    // unresolved binding stays the literal text it was written as.
    expect(run.shown.get(1)).toContain("and {mine}");
    expect(run.output).toContain("after {mine}");
  });

  it("TG6: a pane's <Return> cannot claim a value body outside the grid", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "---",
        "returns:",
        "  type: string",
        "---",
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Pane">',
        '<Return value={"from the pane"} />',
        "<Interactive />",
        "</Terminal>",
        "</Terminal.Grid>",
        "",
        '<Return value={"from the document"} />',
        "",
      ].join("\n"),
    );

    // The pane has no enclosing value body to claim, so the <Return> written in
    // it is refused where it sits rather than becoming the document's value.
    expect(failureOf(run)).toContain(
      "is not written in the flow of a body that declares `returns`",
    );
    expect(failureOf(run)).not.toContain("from the document");
  });

  it("TG6: a pane's checked failure settles that pane and not its sibling", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Broken">',
        "<PrintErrors>",
        '<Fail message="this pane gave up" />',
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

    // Printed inside the pane it happened in, and the sibling ran regardless.
    expect(run.shown.get(0)).toContain("this pane gave up");
    expect(run.ran).toEqual(["sibling"]);
    expect(run.output).not.toContain("this pane gave up");
  });

  it("TG6: a paired pane runs every component in its body, in order", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    // The reader leaves only once the pane's *second* component has run, so a
    // pane body that stopped after the first would never let the grid close —
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

  it("TG9: with no provider installed, no pane body or shell runs", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Work">',
        '<Ran mark="pane body" />',
        "<Interactive />",
        "</Terminal>",
        '<Terminal title="Shell" />',
        "</Terminal.Grid>",
        "",
      ].join("\n"),
      { provider: false },
    );

    expect(failureOf(run)).toContain("no terminal provider is installed");
    // The pane held work; none of it was reached, and nothing was displayed.
    expect(run.ran).toEqual([]);
    expect(run.shown.size).toBe(0);
  });
});

describe("Tier TG — startup, settlement and teardown", () => {
  const TWO = ["<Terminal.Grid columns={2}>", ...PANES, "</Terminal.Grid>", ""].join("\n");

  it("TG9: nothing attaches until every pane has reported a spawn", function* () {
    const dir = yield* useDir();
    // One ordered record the pane and the composite both write to, so
    // "readiness came first" is read rather than assumed. The grid emits
    // `running` for every pane immediately before it attaches, so asserting on
    // that alone would prove nothing.
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
        composite: {
          // deno-lint-ignore require-yield
          *onAttach() {
            timeline.push("attach");
          },
          // deno-lint-ignore require-yield
          *shell(_ordinal, spawned) {
            timeline.push("ready:shell");
            spawned();
            return { exitCode: 0 };
          },
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    // The slow pane started last, and the grid still waited for it.
    expect(timeline[timeline.length - 1]).toBe("attach");
    expect(timeline).toContain("ready:slow");
  });

  it("TG9: a pane that never starts fails the grid, and nothing attaches", function* () {
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
    // No partial grid was ever shown, and the hidden composite was destroyed.
    expect(run.events).not.toContain("attach:0");
    expect(run.events).toContain("destroy:0");
  });

  it("TG9: an immediate spawn-and-exit is both ready and settled", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      ["<Terminal.Grid columns={1}>", '<Terminal title="Shell" />', "</Terminal.Grid>", ""].join(
        "\n",
      ),
      {
        composite: {
          // Reports its spawn and returns in the same breath.
          // deno-lint-ignore require-yield
          *shell(_ordinal, spawned) {
            spawned();
            return { exitCode: 0 };
          },
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    // Ready at the spawn event, so the grid attached; settled straight after,
    // so its final status is its own. Both, from one child that started and
    // stopped in the same breath.
    expect(run.events).toContain("attach:0");
    expect(run.events).toContain("state:0:0:succeeded");
    expect(run.events.indexOf("state:0:0:succeeded")).toBeGreaterThan(
      run.events.indexOf("attach:0"),
    );
  });

  it("TG9: a preparation failure starts no pane at all", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, TWO, {
      composite: {
        // deno-lint-ignore require-yield
        *onPrepare() {
          throw new Error("no pane endpoint could be created");
        },
      },
    });

    expect(failureOf(run)).toContain("no pane endpoint could be created");
    expect(run.shown.size).toBe(0);
  });

  it("TG9: an attach failure shows no partial grid and tears the composite down", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, TWO, {
      composite: {
        // deno-lint-ignore require-yield
        *onAttach() {
          throw new Error("the composite could not be shown");
        },
      },
    });

    expect(failureOf(run)).toContain("the composite could not be shown");
    expect(run.events).toContain("destroy:0");
  });

  it("TG9: simultaneous startup failures report the first authored ordinal", function* () {
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

    // Both panes fail to start. The one reported is the first authored, not
    // whichever settled first.
    expect(failureOf(run)).toContain('pane 0 ("First")');
    expect(failureOf(run)).not.toContain('pane 1 ("Second")');
  });

  it("TG12: close cancels a live pane as closed, then destroys and continues", function* () {
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
        composite: {
          // The reader leaves while the pane is still live.
          close: immediateClose(),
        },
      },
    );

    expect(run.outcome.ok).toBe(true);
    // Teardown cancellation is not a pane failure.
    expect(run.events).toContain("state:0:0:closed");
    const destroyed = run.events.indexOf("destroy:0");
    expect(run.events.indexOf("closed:0")).toBeLessThan(destroyed);
    // The following sibling started only after the composite came down.
    expect(run.ran).toEqual(["after the grid"]);
  });

  it("TG13: an active provider failure cancels every pane and fails the grid", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(dir, TWO, {
      composite: {
        // The reader's close operation is where an active provider can fail.
        // deno-lint-ignore require-yield
        *close() {
          throw new Error("the terminal provider lost its server");
        },
      },
    });

    expect(failureOf(run)).toContain("the terminal provider lost its server");
    expect(run.events).toContain("destroy:0");
  });
});

describe("Tier TG — durability and replay", () => {
  const GRID = heldDocument(2, PANES);
  /**
   * A grid whose only pane never starts, with its failure contained.
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

  /** The pane outcomes the grid retained, in authored order. */
  function paneOutcomes(run: DocumentRun): unknown[] {
    const panes = retainedGrid(run)?.panes;
    return Array.isArray(panes) ? panes : [];
  }

  /**
   * How every `Close` at this coroutine depth ended, in journal order.
   *
   * Depth 2 is the grid child and depth 3 its panes, so a row reads these to
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

    // No provider was asked for a grid, nothing was prepared or attached, no
    // pane content expanded, no shell or launcher ran, and nothing displayed.
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
      shellFailsAfterAttach: 0,
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

  it("TG16: each pane is a durable child of the grid, in authored order", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    // Both panes settle, so both pane children have written their records.
    const first = yield* runInterrupted(dir, GRID, stream, { settled: 2 });

    const closes = first.journal.filter((event) => event.type === "close");
    const paneIds = closes
      .map((event) => String(event.coroutineId))
      .filter((id) => id.split(".").length >= 3)
      .sort();
    expect(paneIds).toHaveLength(2);
    const [left, right] = paneIds;
    // Authored order, not scheduling order, and both beneath one grid child.
    expect(left!.endsWith(".0")).toBe(true);
    expect(right!.endsWith(".1")).toBe(true);
    expect(left!.slice(0, left!.lastIndexOf("."))).toBe(right!.slice(0, right!.lastIndexOf(".")));
  });

  it("TG16: an interrupted grid rebuilds a fresh composite rather than hanging", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    // Interrupted while the grid is open, so its child records a cancelled
    // close. Under the repaired spawn policy the resumed run continues that
    // region instead of suspending on it forever.
    const first = yield* runInterrupted(dir, GRID, stream);
    expect(first.requests).toHaveLength(1);

    const second = yield* runInterrupted(dir, GRID, stream);

    // A fresh composite, built by this run.
    expect(second.requests).toHaveLength(1);
    expect(second.events).toContain("prepare:0:2x1");
  });

  it("TG16: a completed pane is restored; an incomplete shell starts again", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const source = heldDocument(2, [
      '<Terminal title="Left"><Ran mark="left ran" /><Interactive /></Terminal>',
      '<Terminal title="Right" />',
    ]);
    const holdingShell: ControlledCompositeOptions["shell"] = function* (_ordinal, spawned) {
      spawned();
      yield* suspend();
      return { exitCode: 0 };
    };

    // The left pane settles; the shell holds, so only one pane record exists.
    const first = yield* runInterrupted(dir, source, stream, {
      shell: holdingShell,
      settled: 1,
    });
    expect(first.ran).toContain("left ran");

    const second = yield* runInterrupted(dir, source, stream, {
      shell: holdingShell,
      settled: 1,
    });

    // The completed pane came back from its retained outcome: its body did not
    // run again.
    expect(second.ran).not.toContain("left ran");
    // The incomplete shell starts again under current host policy, claiming no
    // continuity with the terminal history it had before.
    expect(second.events.some((event) => event.startsWith("shell:"))).toBe(true);
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
    // prepared, attached or displayed.
    expect(second.requests).toEqual([]);
    expect(second.events).toEqual([]);
    expect(second.shown.size).toBe(0);
    // A replay refusal, not a run that opened something and then failed. The
    // sentence is the divergence report's: a refusal raised while retained
    // children are still being replayed loses to it, which is established
    // behaviour rather than something this row can change.
    expect(failureOf(second)).toContain("Divergence");
    expect(second.events).toEqual([]);
    expect(second.shown.size).toBe(0);
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
    expect(failureOf(second)).toContain("Divergence");
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
      ["pane count", [...PANES, '<Terminal title="Extra" />']],
      ["pane order", ['<Terminal title="Right" />', ...PANES.slice(0, 1)]],
      ["pane form", ['<Terminal title="Left" />', '<Terminal title="Right" />']],
    ];

    for (const [what, panes] of structural) {
      const dir = yield* useDir();
      const stream = new InMemoryStream();
      const first = yield* runInterrupted(dir, GRID, stream);
      const retained = first.requests[0]!;

      // The file now says something else. A continuation executes the root the
      // journal retained, so the grid it opens is the one that was recorded.
      const second = yield* runInterrupted(dir, heldDocument(2, panes), stream);

      expect(`${what}: ${second.requests.length}`).toBe(`${what}: 1`);
      expect(`${what}: ${JSON.stringify(second.requests[0])}`).toBe(
        `${what}: ${JSON.stringify(retained)}`,
      );
    }
  });

  it("TG17: the retained record holds the complete authored pane structure", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const run = yield* runInterrupted(dir, GRID, stream);

    const layout = run.journal.find(
      (event) => event.type === "yield" && String(event.description.name).endsWith(":layout"),
    );
    expect(layout).toBeDefined();
    const value =
      layout?.type === "yield" && layout.result.status === "ok" ? layout.result.value : undefined;
    // Every authored pane, with its ordinal, title, form and derived position.
    expect(value).toEqual({
      columns: 2,
      rows: 1,
      panes: [
        { ordinal: 0, title: "Left", form: "paired", row: 0, column: 0 },
        { ordinal: 1, title: "Right", form: "self-closing", row: 0, column: 1 },
      ],
    });
  });

  it("TG17: a malformed retained layout refuses before provider observation", function* () {
    /** The retained layout, replaced by something the record cannot mean. */
    const damaged: [string, Json][] = [
      ["a missing member", { columns: 2, panes: [] }],
      [
        "an extra member",
        {
          columns: 2,
          rows: 1,
          extra: true,
          panes: [
            { ordinal: 0, title: "Left", form: "paired", row: 0, column: 0 },
            { ordinal: 1, title: "Right", form: "self-closing", row: 0, column: 1 },
          ],
        },
      ],
      [
        "a mistyped member",
        {
          columns: "two",
          rows: 1,
          panes: [
            { ordinal: 0, title: "Left", form: "paired", row: 0, column: 0 },
            { ordinal: 1, title: "Right", form: "self-closing", row: 0, column: 1 },
          ],
        },
      ],
      [
        "a pane out of position",
        {
          columns: 2,
          rows: 1,
          panes: [
            { ordinal: 1, title: "Left", form: "paired", row: 0, column: 0 },
            { ordinal: 0, title: "Right", form: "self-closing", row: 0, column: 1 },
          ],
        },
      ],
      [
        "a record that disagrees with itself",
        {
          columns: 2,
          rows: 5,
          panes: [
            { ordinal: 0, title: "Left", form: "paired", row: 3, column: 1 },
            { ordinal: 1, title: "Right", form: "self-closing", row: 0, column: 1 },
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
      '<Terminal title="Live"><Interactive /><Ran mark="pane body" /><SlowTeardown /></Terminal>',
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
      // 1. The live pane arms its blocking finalizer, and 2. only then does the
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
    expect(first.ran).toEqual(["pane body"]);

    // One grid child, completed, and it says what closed it.
    expect(closeStatuses(first, 2)).toEqual(["ok"]);
    expect(retainedGrid(first)?.close).toBe("reader");
    // Two pane children, both completed. Neither they nor the grid recorded a
    // cancellation: a cancelled child is what a later run would have to revive,
    // and these have nothing left to do.
    expect(closeStatuses(first, 3)).toEqual(["ok", "ok"]);
    expect(paneOutcomes(first)).toEqual([
      { status: "closed", reason: "" },
      { status: "succeeded", reason: "" },
    ]);

    // The provider's counters went up and came back down. Reading them only at
    // the end would be true of counters that never moved.
    expect(heldWhenBlocked).toEqual({ composites: 1, attached: 1, shells: 0 });
    expect(first.live).toEqual({ composites: 0, attached: 0, shells: 0 });
    // And the foreground lease came back: it was taken and given back twice
    // over once the run was done.
    expect(leases).toBe(2);

    // 7. Resumed with three tripwires: no provider at all, so a replay that
    //    asked for a grid would refuse; a mark inside the pane body, so a pane
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

  it("TG17: the retained layout and pane outcomes are provider-neutral", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const run = yield* runInterrupted(dir, GRID, stream);

    const written = JSON.stringify(run.journal);
    expect(written).toContain('"columns":2');
    expect(written).toContain('"Left"');
    for (const leak of ["socket", "tmux", "attach-key", "argv", "multiplexer"]) {
      expect(`${leak}: ${written.includes(leak)}`).toBe(`${leak}: false`);
    }
  });
});
