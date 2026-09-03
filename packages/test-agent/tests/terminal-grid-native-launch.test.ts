/**
 * Tier GN — native Agent sessions in terminal panes
 * (specs/native-agent-session-launch-spec.md §Terminal-grid composition).
 *
 * The journey is `packages/test-agent/src/TerminalGridNativeLaunch.test.md`,
 * and it runs here against the whole TestAgent stack: a real worker over a real
 * ACP connection, the deterministic session coordinator, and two panes each
 * launching a session of its own. Two things are substituted, and only two —
 * the launcher, which records what it was asked to start, and the terminal
 * provider, which presents nothing.
 *
 * The document says what a reader can read. What a document cannot say is
 * *when*: whether the two launches held their pane terminals at the same time,
 * and whether the grid waited for both children before it showed anything. So
 * the harness supplies those as signals — each launch waits for the other to
 * have started — and a pair that contended would wait for a launch that cannot
 * begin, which hangs rather than passes.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { ensureDir } from "@effectionx/fs";
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
import type { NativeLaunchRequest, TerminalPaneState } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { installTestAgentComponents } from "../src/components.ts";
import { NativeLaunchObserver, NativeSessionObserver } from "../src/controller.ts";
import type { NativeSessionReport } from "../src/controller.ts";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { useCommand } from "./command.ts";
import { cliBase } from "@executablemd/test-support/launch";
import { beforeAll } from "@executablemd/test-support/bdd";

const WORKER = cliBase();

/** The checked-in journey, and the directory its `src=` paths resolve against. */
const JOURNEY = path.resolve("packages/test-agent/src/TerminalGridNativeLaunch.test.md");
const JOURNEY_DIR = path.dirname(JOURNEY);

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
  /** Whether a terminal provider was asked for a grid at all. */
  grids: number;
}

interface RunOptions {
  /** The document to run. Defaults to the checked-in journey. */
  source?: string;
  stream?: InMemoryStream;
  /** Install a terminal provider; omit for a host that cannot present one. */
  provider?: false;
  /**
   * What each launch does once its child has started.
   *
   * The default holds every launch until every pane has one, which is the
   * concurrency claim: a launch that had to wait for its sibling's terminal
   * would wait forever instead.
   */
  hold?: (request: NativeLaunchRequest) => Operation<void>;
}

function* runJourney(options: RunOptions = {}): Operation<Run> {
  const launches: NativeLaunchRequest[] = [];
  const hostLaunches: NativeLaunchRequest[] = [];
  const sessions: NativeSessionReport[] = [];
  const providerLog = terminalProviderLog();
  const stream = options.stream ?? new InMemoryStream();
  let grids = 0;

  // Every pane has launched. Resolved from the launches themselves, so nothing
  // here waits for a duration.
  const everyPane = withResolvers<void>();
  const PANES = 2;
  const hold =
    options.hold ??
    ((_request: NativeLaunchRequest) =>
      (function* () {
        if (launches.length >= PANES) {
          everyPane.resolve();
        }
        yield* everyPane.operation;
      })());

  return yield* scoped(function* () {
    // The document is read from the repository, so only what it needs written
    // is written: a directory for the journal-bearing runs to call their own.
    const dir = path.join(os.tmpdir(), `xmd-gn-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    let docPath = JOURNEY;
    if (options.source !== undefined) {
      docPath = path.join(JOURNEY_DIR, `generated-${randomUUID()}.test.md`);
      yield* writeTextFile(docPath, options.source);
      yield* ensure(() => rm(docPath, { force: true }));
    }

    return yield* scoped(function* () {
      yield* API.Env.around({
        // deno-lint-ignore require-yield
        *cwd() {
          return JOURNEY_DIR;
        },
      });
      yield* useHostFiles();
      yield* NativeSessionObserver.set((report) => sessions.push(report));
      // The launcher `<TestAgent>` installs for its own scope. A pane's
      // launcher composes in front of it, so this is what a pane launch
      // reaches once the pane has answered for the terminal.
      yield* NativeLaunchObserver.set({
        record: (request) => launches.push(request),
        wait: hold,
        outcome: () => ({ exitCode: 0 }),
      });
      // A host launcher too, which is the wrong one for any of this to reach:
      // the terminal it would hand over belongs to whoever is running the
      // tests, and under `xmd test` there is no host launcher at all.
      yield* installControlledLauncher({
        record: (request) => hostLaunches.push(request),
        outcome: () => ({ exitCode: 0 }),
      });

      if (options.provider !== false) {
        // The reader stays until every pane has settled, so a row about what a
        // pane launched is not racing the close that would cancel it.
        const settled = withResolvers<void>();
        let panes = 0;
        let done = 0;
        yield* registerTerminalProvider("controlled", function* (_settings, authority) {
          yield* TerminalGrids.around(
            {
              *open([request]) {
                grids++;
                const composite = yield* prepareControlledComposite(request, {
                  log: providerLog,
                  close: () => settled.operation,
                  // deno-lint-ignore require-yield
                  *onPrepare(asked) {
                    panes = asked.panes.length;
                  },
                  onUpdate(_ordinal: number, state: TerminalPaneState) {
                    if (state === "succeeded" || state === "failed" || state === "closed") {
                      done++;
                      if (done >= panes) {
                        settled.resolve();
                      }
                    }
                  },
                });
                yield* authority.present(request, composite);
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
        grids,
      };
    });
  });
}

/** Every `agent_session_launch` record the run retained, in order. */
function launchRecords(events: DurableEvent[]): (Json | undefined)[] {
  return events.flatMap((event) =>
    event.type === "yield" &&
    event.description.type === "agent_session_launch" &&
    event.result.status === "ok"
      ? [event.result.value]
      : [],
  );
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

describe(
  "Tier GN — native sessions in terminal panes",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    beforeAll(() => useTempFileCompiler());

    it("GN1: two panes launch two sessions, concurrently, before anything is shown", function* () {
      const run = yield* runJourney();

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      expect(run.results.map((result) => result.status)).toEqual(["pass"]);

      // Two launches, two distinct provider-native identities: two sessions,
      // not one shared between the panes.
      expect(run.launches.length).toBe(2);
      const identities = new Set(run.launches.map((request) => request.command.at(-1)));
      expect(identities.size).toBe(2);
      // Both held their pane terminals at once. Each launch waited for the
      // other to have started, which a serialised pair could never do.
      for (const request of run.launches) {
        expect(request.command[0]).toBe("xmd-test-agent-ui");
      }
      // Nothing was shown until both children had started, and one composite
      // presented the whole grid.
      expect(run.composite[0]).toBe("prepare:0:2x1");
      expect(run.composite).toContain("attach:0");
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
        records: launchRecords(run.events),
      });
      // The authored pane titles, the ordinal a layout is keyed by, and the
      // structural names a grid is written with. Not the bare word "pane": the
      // instruction layer is the author's prose and may legitimately say it.
      for (const leak of ["ordinal", "Planner", "Implementor", "Terminal.Grid", "columns"]) {
        expect(`${leak}: ${written.includes(leak)}`).toBe(`${leak}: false`);
      }
      // What is there instead is what a root launch would have had: the
      // document's own working directory.
      for (const request of run.launches) {
        expect(request.cwd).toBe(JOURNEY_DIR);
      }
      // And the argv is the resume vector a root launch builds, unchanged.
      for (const request of run.launches) {
        expect(request.command.length).toBe(3);
        expect(request.command[1]).toBe("--resume");
      }
      expect(launchRecords(run.events).length).toBeGreaterThan(0);
    });

    it("GN3: a pane launch never reaches the host's launcher", function* () {
      const run = yield* runJourney();

      expect(run.result.ok).toBe(true);
      expect(run.hostLaunches).toEqual([]);
      expect(run.launches.length).toBe(2);
    });

    it("GN4: two panes naming one session contend, and one is refused", function* () {
      // Both panes name the same agent, session and directory, so the natural
      // key is one key — and nothing about a pane is in it. One pane takes
      // ownership; the other asks while it is held and is told so rather than
      // queueing behind a UI that may be there for hours.
      const run = yield* runJourney({ source: ONE_SESSION });

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
        JSON.stringify(record).includes("session-busy"),
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
  },
);
