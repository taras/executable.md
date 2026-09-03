/**
 * Tier GN — native Agent sessions in terminal panes
 * (specs/native-agent-session-launch-spec.md §Terminal-grid composition).
 *
 * The journey is `packages/test-agent/src/TerminalGridNativeLaunch.test.md`,
 * and it runs here against the whole TestAgent stack: a real worker over a real
 * ACP connection, the deterministic session coordinator, and four panes — three
 * launching a native Agent session of their own, one running the host's default
 * shell. Two things are substituted, and only two: the launcher, which records
 * what it was asked to start, and the terminal provider, which presents
 * nothing.
 *
 * The document says what a reader can read. What a document cannot say is
 * *when* — whether four children held their pane terminals at the same time,
 * whether the grid waited for all of them before it showed anything, and
 * whether a cancelled launch had finished with its session before the document
 * carried on. So the harness supplies those as signals, and every one of them
 * is an event this run produced. Nothing here waits for a duration: a lifecycle
 * that never reached a step hangs its row rather than passing it.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
import { copyFile, ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  agentIdentityComponents,
  installAgentComponents,
  installTerminalGridProfile,
  registerTerminalProvider,
  useTempFileCompiler,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { Json } from "@executablemd/core";
import {
  API,
  installControlledLauncher,
  prepareControlledComposite,
  TerminalGrids,
  terminalProviderLog,
  useHostFiles,
} from "@executablemd/runtime";
import type {
  NativeLaunchOutcome,
  NativeLaunchRequest,
  TerminalGridRequest,
  TerminalPaneState,
} from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { installTestAgentComponents } from "../src/components.ts";
import { NativeLaunchObserver, NativeSessionObserver } from "../src/controller.ts";
import type { NativeSessionReport } from "../src/controller.ts";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { useCommand } from "./command.ts";
import { cliBase } from "@executablemd/test-support/launch";

const WORKER = cliBase();

/** The checked-in journey, and the directory its `src=` paths resolve against. */
const JOURNEY = path.resolve("packages/test-agent/src/TerminalGridNativeLaunch.test.md");
const JOURNEY_DIR = path.dirname(JOURNEY);

/** The scenario documents a generated variant resolves `src=` against. */
const SCENARIOS = [
  "TerminalGridNativeLaunch.planner.md",
  "TerminalGridNativeLaunch.implementor.md",
  "TerminalGridNativeLaunch.reviewer.md",
];

/** How many interactive children the checked-in journey starts. */
const JOURNEY_CHILDREN = 4;

interface Run {
  result: Result<Json>;
  results: readonly TestResult[];
  /** Every native launch the component's launcher was asked to start. */
  launches: NativeLaunchRequest[];
  /** Every launch the *host's* launcher was asked to start. */
  hostLaunches: NativeLaunchRequest[];
  sessions: NativeSessionReport[];
  events: DurableEvent[];
  /** Everything the controlled composite did, in order. */
  composite: string[];
  /** Each pane state the composite was told to show, as `ordinal:state`. */
  states: string[];
  /** The layout the provider was asked to present. */
  request?: TerminalGridRequest;
  /** Whether a terminal provider was asked for a grid at all. */
  grids: number;
  /** The lifecycle marks this run produced, in the order they happened. */
  order: string[];
}

/**
 * What one interactive child does, once it has started.
 *
 * `marker` is the pane's own word for itself, read back from the session the
 * launch prepared; the shell pane's is `shell`. A row keys its signals by that
 * rather than by an ordinal, because a launch request carries no ordinal and
 * must not.
 */
type Child = (marker: string, order: string[]) => Operation<void>;

interface RunOptions {
  /** The document to run. Defaults to the checked-in journey. */
  source?: string;
  /**
   * Where a generated document lives.
   *
   * A launch retains the directory it was asked for, so two runs that share a
   * journal have to share this one — a second directory replays nothing.
   */
  dir?: string;
  stream?: InMemoryStream;
  /** Install a terminal provider; omit for a host that cannot present one. */
  provider?: false;
  /** How many interactive children the document starts. */
  children?: number;
  /**
   * What each child does once it has started.
   *
   * The default holds every one of them until every pane has one, which is the
   * concurrency claim: a child that had to wait for a sibling's terminal would
   * be waiting for a start that cannot happen.
   */
  child?: Child;
  /** How a named pane's native UI ended. Others exit successfully. */
  exits?: Record<string, NativeLaunchOutcome>;
  /** Called as each pane state is shown, so a row can signal on one. */
  onState?: (ordinal: number, state: TerminalPaneState) => void;
  /** Let the reader leave; the default waits for every pane to settle. */
  close?: (order: string[], states: string[]) => Operation<void>;
  /** Interrupt the run when this settles, instead of letting it finish. */
  interruptWhen?: (order: string[]) => Operation<void>;
}

/** The word a launch's own instruction layer uses for its pane. */
function markerOf(request: NativeLaunchRequest, sessions: NativeSessionReport[]): string {
  const native = request.command.at(-1);
  const report = sessions.find(
    (candidate) => candidate.nativeSessionId === native && candidate.systemPrompt !== undefined,
  );
  const instructions = report?.systemPrompt ?? "";
  for (const marker of ["planner", "implementor", "reviewer", "failing", "surviving"]) {
    if (instructions.includes(marker)) {
      return marker;
    }
  }
  return "unknown";
}

function* runJourney(options: RunOptions = {}): Operation<Run> {
  const launches: NativeLaunchRequest[] = [];
  const hostLaunches: NativeLaunchRequest[] = [];
  const sessions: NativeSessionReport[] = [];
  const providerLog = terminalProviderLog();
  const states: string[] = [];
  const order: string[] = [];
  const stream = options.stream ?? new InMemoryStream();
  let grids = 0;
  let request: TerminalGridRequest | undefined;

  // Every interactive child has started. Resolved by the starts themselves, so
  // nothing here waits for a duration.
  const children = options.children ?? JOURNEY_CHILDREN;
  const everyChild = withResolvers<void>();
  let started = 0;
  const child: Child =
    options.child ??
    (() =>
      (function* () {
        yield* everyChild.operation;
      })());

  /** Record a start, and settle the barrier once every pane has one. */
  const startedOne = (marker: string): void => {
    order.push(`start:${marker}`);
    started++;
    if (started >= children) {
      everyChild.resolve();
    }
  };

  return yield* scoped(function* () {
    // A variant is written to a directory of its own, with copies of the
    // scenarios its `src=` paths name. Nothing a row generates is ever written
    // into the repository, so a run that is killed leaves nothing behind.
    let docPath = JOURNEY;
    let docDir = JOURNEY_DIR;
    if (options.source !== undefined) {
      docDir = options.dir ?? path.join(os.tmpdir(), `xmd-gn-${randomUUID()}`);
      yield* ensureDir(docDir);
      if (options.dir === undefined) {
        yield* ensure(() => rm(docDir, { recursive: true, force: true }));
      }
      for (const scenario of SCENARIOS) {
        yield* copyFile(path.join(JOURNEY_DIR, scenario), path.join(docDir, scenario));
      }
      docPath = path.join(docDir, "generated.test.md");
      yield* writeTextFile(docPath, options.source);
    }

    return yield* scoped(function* () {
      yield* API.Env.around({
        // deno-lint-ignore require-yield
        *cwd() {
          return docDir;
        },
      });
      yield* useHostFiles();
      yield* NativeSessionObserver.set((report) => sessions.push(report));
      // The launcher `<TestAgent>` installs for its own scope. A pane's
      // launcher composes in front of it, so this is what a pane launch
      // reaches once the pane has answered for the terminal.
      yield* NativeLaunchObserver.set({
        record: (asked) => launches.push(asked),
        wait: (asked) =>
          (function* () {
            const marker = markerOf(asked, sessions);
            startedOne(marker);
            try {
              yield* child(marker, order);
            } finally {
              // Reached however the launch left — returned, or cancelled by the
              // reader closing the grid.
              order.push(`left:${marker}`);
            }
          })(),
        outcome: (asked) => options.exits?.[markerOf(asked, sessions)] ?? { exitCode: 0 },
      });
      // A host launcher too, which is the wrong one for any of this to reach:
      // the terminal it would hand over belongs to whoever is running the
      // tests, and under `xmd test` there is no host launcher at all.
      yield* installControlledLauncher({
        record: (asked) => hostLaunches.push(asked),
        outcome: () => ({ exitCode: 0 }),
      });

      if (options.provider !== false) {
        // The reader stays until every pane has settled. Leaving sooner is a
        // real thing a reader does, and the rows about it say so themselves.
        const settled = withResolvers<void>();
        let panes = 0;
        let done = 0;
        yield* registerTerminalProvider("controlled", function* (_settings, authority) {
          yield* TerminalGrids.around(
            {
              *open([asked]) {
                grids++;
                const composite = yield* prepareControlledComposite(asked, {
                  log: providerLog,
                  close: () =>
                    options.close === undefined ? settled.operation : options.close(order, states),
                  // deno-lint-ignore require-yield
                  *onPrepare(seen) {
                    request = seen;
                    panes = seen.panes.length;
                  },
                  // deno-lint-ignore require-yield
                  *onAttach() {
                    order.push("attach");
                  },
                  // deno-lint-ignore require-yield
                  *onDestroy() {
                    order.push("destroy");
                  },
                  onUpdate(ordinal: number, state: TerminalPaneState) {
                    states.push(`${ordinal}:${state}`);
                    options.onState?.(ordinal, state);
                    if (state === "succeeded" || state === "failed" || state === "closed") {
                      done++;
                      if (done >= panes) {
                        settled.resolve();
                      }
                    }
                  },
                  // The host's default shell, a fiction here in exactly the way
                  // the native UI is. It reports its start the same way and then
                  // stays live, so the fourth pane is as concurrent as the three
                  // that launched.
                  *shell(_ordinal, spawned) {
                    spawned();
                    startedOne("shell");
                    try {
                      yield* child("shell", order);
                    } finally {
                      order.push("left:shell");
                    }
                    return { exitCode: 0 };
                  },
                });
                yield* authority.present(asked, composite);
                return undefined;
              },
            },
            { at: "min" },
          );
        });
        yield* installTerminalGridProfile({ provider: "controlled" });
      }

      const testing = yield* useTesting();
      yield* useCommand(WORKER);
      yield* installTestAgentComponents();
      yield* installAgentComponents();

      const execution = yield* executeInstalled({ path: docPath, stream }, [
        { components: agentIdentityComponents() },
      ]);

      if (options.interruptWhen !== undefined) {
        // Halted with the child still going, which is the state a crashed run
        // leaves its journal in.
        const running: Task<void> = yield* spawn(function* () {
          const subscription = yield* execution.output;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
          yield* execution;
        });
        yield* options.interruptWhen(order);
        yield* running.halt();
        return {
          result: Err(new Error("interrupted")),
          results: yield* testing.results,
          launches,
          hostLaunches,
          sessions,
          events: yield* stream.readAll(),
          composite: providerLog.events,
          states,
          ...(request === undefined ? {} : { request }),
          grids,
          order,
        };
      }

      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      return {
        result: yield* execution,
        results: yield* testing.results,
        launches,
        hostLaunches,
        sessions,
        events: yield* stream.readAll(),
        composite: providerLog.events,
        states,
        ...(request === undefined ? {} : { request }),
        grids,
        order,
      };
    });
  });
}

/** Every `agent_session_launch` record the run retained, with its phase name. */
function launchRecords(events: DurableEvent[]): { name: string; value: Json | undefined }[] {
  return events.flatMap((event) =>
    event.type === "yield" &&
    event.description.type === "agent_session_launch" &&
    event.result.status === "ok"
      ? [{ name: event.description.name, value: event.result.value }]
      : [],
  );
}

/** The members of one retained record, or nothing when it is not readable. */
function members(value: Json | undefined): Record<string, Json> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return { ...value };
}

/** Every retained `prepared` record, in order. */
function preparations(events: DurableEvent[]): Record<string, Json>[] {
  return launchRecords(events).flatMap((entry) => {
    if (!entry.name.endsWith("/prepared")) {
      return [];
    }
    const record = members(entry.value);
    return record === undefined ? [] : [record];
  });
}

/** One document that launches the same logical session from both panes. */
const ONE_SESSION = [
  "<TestAgent>",
  '<TestAgent.Scenario session="planner" src="./TerminalGridNativeLaunch.planner.md" />',
  "",
  '<Test name="one session, two panes">',
  "<Terminal.Grid columns={2}>",
  '<Terminal title="Left">',
  '<Session.Launch session="planner">You are the repository planner.</Session.Launch>',
  "</Terminal>",
  '<Terminal title="Right">',
  '<Session.Launch session="planner">You are the repository planner.</Session.Launch>',
  "</Terminal>",
  "</Terminal.Grid>",
  "</Test>",
  "</TestAgent>",
  "",
].join("\n");

/** Two panes: one whose native UI ends badly, and one that stays live. */
const FAILING_AND_SURVIVING = [
  "<TestAgent>",
  '<TestAgent.Scenario session="planner" src="./TerminalGridNativeLaunch.planner.md" />',
  '<TestAgent.Scenario session="implementor" src="./TerminalGridNativeLaunch.implementor.md" />',
  "",
  '<Test name="one pane ends badly">',
  "<Terminal.Grid columns={2}>",
  '<Terminal title="Left">',
  '<Session.Launch session="planner">You are the failing pane.</Session.Launch>',
  "</Terminal>",
  '<Terminal title="Right">',
  '<Session.Launch session="implementor">You are the surviving pane.</Session.Launch>',
  "</Terminal>",
  "</Terminal.Grid>",
  "</Test>",
  "</TestAgent>",
  "",
].join("\n");

/** Two live panes, and the sessions they used, asked for again afterwards. */
const CLOSE_THEN_CONTINUE = [
  "<TestAgent>",
  '<TestAgent.Scenario session="planner" src="./TerminalGridNativeLaunch.planner.md" />',
  '<TestAgent.Scenario session="implementor" src="./TerminalGridNativeLaunch.implementor.md" />',
  "",
  '<Test name="the reader leaves, and the document goes on">',
  "<Terminal.Grid columns={2}>",
  '<Terminal title="Left">',
  '<Session.Launch session="planner">You are the repository planner.</Session.Launch>',
  "</Terminal>",
  '<Terminal title="Right">',
  '<Session.Launch session="implementor">You are the repository implementor.</Session.Launch>',
  "</Terminal>",
  "</Terminal.Grid>",
  "",
  // The same prepared instructions the pane launched, so this is the same
  // conversation continuing rather than a second one asking for the name.
  '<Session.Launch session="planner">You are the repository planner.</Session.Launch>',
  "</Test>",
  "</TestAgent>",
  "",
].join("\n");

/** One pane, launching the same session twice in a row. */
const SEQUENTIAL = [
  "<TestAgent>",
  '<TestAgent.Scenario session="planner" src="./TerminalGridNativeLaunch.planner.md" />',
  "",
  '<Test name="one pane, two launches in a row">',
  "<Terminal.Grid columns={1}>",
  '<Terminal title="Only">',
  '<Session.Launch session="planner">You are the repository planner.</Session.Launch>',
  "",
  '<Session name="planner">',
  '<Prompt as="answer">which pane are you in?</Prompt>',
  "</Session>",
  "</Terminal>",
  "</Terminal.Grid>",
  "</Test>",
  "</TestAgent>",
  "",
].join("\n");

/** One pane whose launch is interrupted while the native child is still live. */
const ONE_PANE = [
  "<TestAgent>",
  '<TestAgent.Scenario session="planner" src="./TerminalGridNativeLaunch.planner.md" />',
  "",
  '<Test name="one pane, one launch">',
  "<Terminal.Grid columns={1}>",
  '<Terminal title="Only">',
  '<Session.Launch session="planner">You are the repository planner.</Session.Launch>',
  "</Terminal>",
  "</Terminal.Grid>",
  "</Test>",
  "</TestAgent>",
  "",
].join("\n");

describe(
  "Tier GN — native sessions in terminal panes",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    beforeAll(() => useTempFileCompiler());

    it("GN1: four panes start together and stay live, in the authored positions", function* () {
      const run = yield* runJourney();

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      expect(run.results.map((result) => result.status)).toEqual(["pass"]);

      // Three launches, three distinct provider-native identities: three
      // sessions, not one shared between the panes.
      expect(run.launches.length).toBe(3);
      const identities = new Set(run.launches.map((asked) => asked.command.at(-1)));
      expect(identities.size).toBe(3);

      // Every one of the four children started before anything was shown, and
      // each was waiting for its siblings while it did — a serialised set could
      // never have reached the barrier at all.
      const attached = run.order.indexOf("attach");
      expect(attached).toBeGreaterThan(-1);
      const starts = run.order.slice(0, attached).filter((mark) => mark.startsWith("start:"));
      expect(new Set(starts)).toEqual(
        new Set(["start:planner", "start:implementor", "start:reviewer", "start:shell"]),
      );
      // None of them had left by then, so all four held their terminals at once.
      expect(run.order.slice(0, attached).some((mark) => mark.startsWith("left:"))).toBe(false);

      // The authored row-major layout, as the provider was asked for it.
      expect(run.request?.columns).toBe(2);
      expect(run.request?.rows).toBe(2);
      expect(run.request?.panes.map((pane) => `${pane.row},${pane.column} ${pane.title}`)).toEqual([
        "0,0 Planner",
        "0,1 Implementor",
        "1,0 Reviewer",
        "1,1 Shell",
      ]);
      expect(run.request?.panes.map((pane) => pane.form)).toEqual([
        "paired",
        "paired",
        "paired",
        "self-closing",
      ]);
      expect(run.composite[0]).toBe("prepare:0:2x2");
      expect(run.composite).toContain("destroy:0");
      expect(run.grids).toBe(1);
    });

    it("GN2: no pane identity reaches the launch request or the retained record", function* () {
      const run = yield* runJourney();

      // The launch's own surfaces: what the provider was asked to start, and
      // what the launch retained. The grid's layout record is a different thing
      // and legitimately names its panes — this is about what the *launch*
      // carries.
      const written = JSON.stringify({
        launches: run.launches,
        records: launchRecords(run.events).map((entry) => entry.value),
      });
      // The authored pane titles, the ordinal a layout is keyed by, and the
      // structural names a grid is written with. Not the bare word "pane": the
      // instruction layer is the author's prose and may legitimately say it.
      for (const leak of ["ordinal", "Planner", "Implementor", "Reviewer", "columns"]) {
        expect(`${leak}: ${written.includes(leak)}`).toBe(`${leak}: false`);
      }
      // What is there instead is what a root launch would have had: the
      // document's own working directory, and the resume vector.
      for (const asked of run.launches) {
        expect(asked.cwd).toBe(JOURNEY_DIR);
        expect(asked.command.length).toBe(3);
        expect(asked.command[1]).toBe("--resume");
      }
      expect(preparations(run.events).length).toBe(3);
    });

    it("GN3: a pane launch never reaches the host's launcher", function* () {
      const run = yield* runJourney();

      expect(run.result.ok).toBe(true);
      expect(run.hostLaunches).toEqual([]);
      expect(run.launches.length).toBe(3);
    });

    it("GN4: two panes naming one session contend, and one is refused", function* () {
      // Both panes name the same agent, session and directory, so the natural
      // key is one key — and nothing about a pane is in it. One pane takes
      // ownership; the other asks while it is held and is told so rather than
      // queueing behind a UI that may be there for hours.
      const run = yield* runJourney({ source: ONE_SESSION, children: 2 });

      const failures = run.results.filter((result) => result.status === "fail");
      expect(failures.length).toBe(1);
      const refusal = JSON.stringify(failures[0]);
      expect(refusal).toContain("another owner is using session");
      // The refusal names the session, not the pane that asked for it.
      expect(refusal).not.toContain("Left");
      expect(refusal).not.toContain("Right");
      // Exactly one owner was refused: the other held the session, which is
      // what "one owner at a time" means. Two refusals would mean neither did.
      const busy = launchRecords(run.events).filter((record) =>
        JSON.stringify(record.value).includes("session-busy"),
      );
      expect(busy.length).toBe(1);
      // A pane that never started is a startup failure, so the grid was never
      // shown — the reader sees no half-built composite.
      expect(run.composite).not.toContain("attach:0");
    });

    it("GN5: with no terminal provider, a pane launch starts nothing at all", function* () {
      const run = yield* runJourney({ provider: false });

      expect(run.result.ok).toBe(false);
      // Refused where a grid is refused — before a pane, so before a launch.
      expect(run.launches).toEqual([]);
      expect(run.hostLaunches).toEqual([]);
      expect(run.grids).toBe(0);
    });

    it("GN6: a completed grid replays with no provider, launcher or agent contact", function* () {
      const stream = new InMemoryStream();
      const first = yield* runJourney({ stream });
      expect(first.result.ok ? "" : first.result.error.message).toBe("");

      const second = yield* runJourney({ stream });

      expect(second.result.ok).toBe(true);
      // Nothing was presented, nothing was started, and no session was touched.
      expect(second.grids).toBe(0);
      expect(second.composite).toEqual([]);
      expect(second.launches).toEqual([]);
      expect(second.hostLaunches).toEqual([]);
      expect(second.sessions).toEqual([]);
    });

    it("GN7: one pane's native exit fails that pane, and the sibling lives on", function* () {
      const bothLive = withResolvers<void>();
      const paneFailed = withResolvers<void>();
      const survivedIt = withResolvers<void>();
      const closeNow = withResolvers<void>();
      let live = 0;
      const run = yield* runJourney({
        source: FAILING_AND_SURVIVING,
        children: 2,
        exits: { failing: { exitCode: 4 } },
        child: (marker, marks) =>
          (function* () {
            live++;
            if (live === 2) {
              bothLive.resolve();
            }
            // Both are live and shown before either of them ends.
            yield* bothLive.operation;
            if (marker === "failing") {
              return;
            }
            // The sibling outlives the failure, and says so from the far side
            // of it rather than from before.
            yield* paneFailed.operation;
            marks.push("surviving:still live");
            survivedIt.resolve();
            yield* closeNow.operation;
          })(),
        onState: (ordinal, state) => {
          if (ordinal === 0 && state === "failed") {
            paneFailed.resolve();
          }
        },
        close: (marks) =>
          (function* () {
            // The reader leaves only once the sibling has been observed alive
            // after the failure, so nothing here is a race.
            yield* survivedIt.operation;
            marks.push("close");
            closeNow.resolve();
          })(),
      });

      // The failing pane's exit is its own status, and it did not cancel the
      // pane beside it: the sibling was still live afterwards and stopped only
      // when the reader left.
      expect(run.states).toContain("0:failed");
      expect(run.states).toContain("1:closed");
      // Which panes, not how many messages: a pane that had not settled when
      // the reader left is told twice — once from the outcome close decided,
      // once from its own settlement — and that is display, not a second
      // settlement.
      expect(new Set(run.states.filter((state) => state.endsWith(":failed")))).toEqual(
        new Set(["0:failed"]),
      );
      expect(run.order).toContain("surviving:still live");
      expect(run.order.indexOf("close")).toBeGreaterThan(run.order.indexOf("surviving:still live"));
      // The grid ends on the pane that failed — the cancellation the close
      // caused is not a second failure.
      const message = run.result.ok ? "" : run.result.error.message;
      expect(message).toContain("status 4");
      expect(run.results.filter((result) => result.status === "fail").length).toBe(1);
    });

    it("GN8: reader close finishes both launches, and the document goes on", function* () {
      const bothStarted = withResolvers<void>();
      let started = 0;
      const run = yield* runJourney({
        source: CLOSE_THEN_CONTINUE,
        children: 2,
        child: (_marker, marks) =>
          (function* () {
            started++;
            if (started > 2) {
              // The launch after the grid. It is the sibling this row is
              // waiting to see run, so it runs.
              return;
            }
            if (started === 2) {
              bothStarted.resolve();
            }
            try {
              // Nothing here ever completes it. The only thing that stops this
              // child is the reader closing the grid, so a close that did not
              // cancel it would hang this row rather than pass it.
              yield* suspend();
            } finally {
              // Reached as the child is torn down: this is the child actually
              // being gone, not the request that it stop.
              marks.push("gone");
            }
          })(),
        close: (marks) =>
          (function* () {
            yield* bothStarted.operation;
            marks.push("close");
          })(),
      });

      // Both children were cancelled and both are gone, and neither pane
      // failed: a reader leaving is not a pane failure.
      expect(run.order.filter((mark) => mark === "gone").length).toBe(2);
      expect(run.states.filter((state) => state.endsWith(":failed"))).toEqual([]);
      expect(new Set(run.states.filter((state) => state.endsWith(":closed")))).toEqual(
        new Set(["0:closed", "1:closed"]),
      );
      // Teardown finished after they were gone, not merely after they were
      // asked to stop.
      const destroyed = run.order.indexOf("destroy");
      expect(destroyed).toBeGreaterThan(-1);
      expect(run.order.lastIndexOf("gone")).toBeLessThan(destroyed);

      // The sibling after the grid is a *root* launch naming a session one of
      // those panes was holding. It needs three things back: the run's
      // foreground terminal, that pane's terminal, and that session's
      // ownership — and it gets them, so the grid released every one.
      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      expect(run.results.map((result) => result.status)).toEqual(["pass"]);
      expect(run.launches.length).toBe(3);
      // Neither refusal: not one still held by another owner, and not one left
      // owned by work that did not finish. An orderly close that finished is a
      // finish, and the session it used is ordinarily usable afterwards.
      const written = JSON.stringify(run.results);
      expect(written).not.toContain("another owner is using session");
      expect(written).not.toContain("was left owned by work that did not finish");
      expect(written).not.toContain("already holds this run's terminal");
      expect(run.hostLaunches).toEqual([]);
    });

    it("GN9: a pane admits the next user only once the last one is wholly done", function* () {
      // Sequential composition in one pane, through the real coordinator. The
      // prompt after the launch needs two things the launch was holding: that
      // pane's terminal, and that session's ownership. It gets an answer, so
      // the launch released both — and GN4 is the other half of the same claim,
      // where a second owner asking while the first still holds it is refused.
      const run = yield* runJourney({ source: SEQUENTIAL, children: 1 });

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      expect(run.results.map((result) => result.status)).toEqual(["pass"]);
      expect(run.launches.length).toBe(1);
      // The launch had wholly left before the session was used again: a pane
      // admits one live user, and the next only once that one is done.
      expect(run.order).toContain("left:planner");
      expect(run.order.indexOf("left:planner")).toBeGreaterThan(run.order.indexOf("start:planner"));
      // The same conversation the launch prepared answered afterwards.
      const native = run.launches[0]?.command.at(-1);
      expect(run.sessions.at(-1)?.nativeSessionId).toBe(native);
    });

    it("GN10: an interrupted pane launch resumes its own conversation", function* () {
      const stream = new InMemoryStream();
      const live = withResolvers<void>();
      const never = withResolvers<void>();
      // One journal, and one directory for both attempts: a launch retains the
      // directory it was asked for, and a second one would replay nothing.
      const dir = path.join(os.tmpdir(), `xmd-gn-${randomUUID()}`);
      yield* ensure(() => rm(dir, { recursive: true, force: true }));

      const interrupted = yield* runJourney({
        source: ONE_PANE,
        stream,
        dir,
        children: 1,
        child: () =>
          (function* () {
            live.resolve();
            // Never returns: the run is halted with the child still going.
            yield* never.operation;
          })(),
        interruptWhen: () => live.operation,
      });

      expect(interrupted.launches.length).toBe(1);
      const native = interrupted.launches[0]?.command.at(-1);
      expect(native).toBeDefined();
      // The launch got as far as handing the session over, and no further.
      const crashed = launchRecords(interrupted.events).map((entry) => entry.name);
      expect(crashed.some((name) => name.endsWith("/prepared"))).toBe(true);
      expect(crashed.some((name) => name.endsWith("/detached"))).toBe(true);
      expect(crashed.some((name) => name.endsWith("/exited"))).toBe(false);
      const before = preparations(interrupted.events)[0];
      expect(before).toBeDefined();

      const resumed = yield* runJourney({ source: ONE_PANE, stream, dir, children: 1 });

      expect(resumed.result.ok ? "" : resumed.result.error.message).toBe("");
      // A fresh composite was built for the pane that had not finished.
      expect(resumed.grids).toBe(1);
      expect(resumed.composite[0]).toBe("prepare:0:1x1");
      // The native child started again, on the identity the first attempt
      // retained — not on a conversation this run made.
      expect(resumed.launches.length).toBe(1);
      expect(resumed.launches[0]?.command.at(-1)).toBe(native);
      expect(resumed.sessions.filter((report) => report.systemPrompt !== undefined)).toEqual([]);
      // Nothing was prepared a second time, and everything the first attempt
      // retained about how this session was made came back unchanged — the
      // provider-native identity, the construction route, the executable
      // binding and the phase itself.
      const after = preparations(resumed.events);
      expect(after.length).toBe(1);
      expect(after[0]).toEqual(before);
      // The resumed attempt is what added the exit.
      const names = launchRecords(resumed.events).map((entry) => entry.name);
      expect(names.filter((name) => name.endsWith("/prepared")).length).toBe(1);
      expect(names.filter((name) => name.endsWith("/exited")).length).toBe(1);
    });
  },
);
