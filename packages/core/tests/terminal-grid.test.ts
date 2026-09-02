/**
 * Tier TG — running a terminal grid through a replaceable provider
 * (spec §6.21, architecture.md §Atomic presentation and settlement).
 *
 * The provider here is controlled and is not tmux: it opens no terminal, starts
 * no process, and records what it was asked to do in the order it was asked.
 * Every ordering claim is read off that record. Nothing is inferred from
 * timing, because a grid that attached too early and one that attached on time
 * take the same wall clock.
 *
 * Readiness is the claim these rows care about most, so it is always driven
 * explicitly: a pane becomes ready because something called the latch it was
 * handed, never because it got far enough. That is what lets "started" and
 * "did some work" be told apart at all.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, sleep, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import {
  installControlledLauncher,
  installControlledTerminalProvider,
} from "@executablemd/runtime";
import type { TerminalGridRequest, TerminalProviderLog } from "@executablemd/runtime";

import { execute } from "../src/execute.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { Json } from "../src/types.ts";

import { createTerminalGridClaims, TerminalAuthorityError } from "../src/terminal/authority.ts";
import { runTerminalGrid } from "../src/terminal/grid.ts";
import type { GridResult, PaneWork } from "../src/terminal/grid.ts";
import { paneTerminal, usePaneTerminal } from "../src/terminal/pane.ts";
import { terminalGridLayout } from "../src/terminal-grid.ts";
import type { TerminalGridLayout } from "../src/terminal-grid.ts";

function log(): TerminalProviderLog {
  return { events: [], shown: new Map<number, string>() };
}

/** A layout of `count` panes across `columns`, titled by ordinal. */
function layoutOf(columns: number, count: number): TerminalGridLayout {
  return terminalGridLayout(
    columns,
    Array.from({ length: count }, (_unused, index) => ({
      title: `pane ${index}`,
      form: "self-closing" as const,
    })),
  );
}

/** A pane that starts, does what `body` says, and settles. */
function pane(ordinal: number, body?: () => Operation<void>): PaneWork {
  return {
    ordinal,
    *run(claim) {
      yield* claim.admit(function* () {
        claim.ready();
        if (body) {
          yield* body();
        }
      });
    },
  };
}

/** Everything a grid run needs installed, with the reader's close under control. */
function* useGridHost(record: TerminalProviderLog, close: () => Operation<void>): Operation<void> {
  // A grid takes the same one foreground lease a root <Session.Launch> takes,
  // so a host that offers a grid still has to offer that lease.
  yield* installControlledLauncher();
  yield* installControlledTerminalProvider({ log: record, close });
}

/** A pane that records when it started, so ordering is read rather than timed. */
function readyPane(ordinal: number, timeline: string[]): PaneWork {
  return {
    ordinal,
    *run(claim) {
      yield* claim.admit(function* () {
        timeline.push(`ready:${ordinal}`);
        claim.ready();
        yield* suspend();
      });
    },
  };
}

/** Close as soon as the reader is asked, which is the ordinary journey. */
function immediateClose(): () => Operation<void> {
  // deno-lint-ignore require-yield
  return function* () {};
}

describe("Tier TG — pane claims and readiness", () => {
  it("TG8: a claim admits one interactive operation at a time", function* () {
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
        // A second operation on the same pane is refused while this one is live.
        try {
          yield* first.admit(function* () {});
        } catch (error) {
          refusal = error;
        }
        // A different pane does not contend at all, which is the whole reason a
        // grid exists.
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

  it("TG8: a pane admits again once its first operation has settled", function* () {
    const grid = createTerminalGridClaims({
      columns: 1,
      rows: 1,
      panes: [{ ordinal: 0, title: "a", row: 0, column: 0, form: "paired" }],
    });
    const claim = grid.claims[0]!;
    let second = false;

    yield* scoped(function* () {
      yield* claim.admit(function* () {});
      yield* claim.admit(function* () {
        second = true;
      });
    });

    // Sequential work in one pane is ordinary composition, not contention.
    expect(second).toBe(true);
  });

  it("TG8: a sealed grid admits nothing, however the claim was obtained", function* () {
    const grid = createTerminalGridClaims({
      columns: 1,
      rows: 1,
      panes: [{ ordinal: 0, title: "a", row: 0, column: 0, form: "paired" }],
    });
    const claim = grid.claims[0]!;
    grid.seal();
    let refusal: unknown;

    yield* scoped(function* () {
      try {
        yield* claim.admit(function* () {});
      } catch (error) {
        refusal = error;
      }
    });

    // A claim kept past its grid is a claim to a terminal nobody owns.
    expect(refusal instanceof Error ? refusal.message : "").toContain("its grid has stopped");
  });

  it("TG8: readiness is the acknowledgement, and acknowledging twice is one event", function* () {
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

  it("TG8: a request whose ordinals are not its positions is refused", function* () {
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

describe("Tier TG — atomic startup", () => {
  it("TG9: nothing attaches until every pane has reported a spawn", function* () {
    const record = log();
    // One ordered record both the panes and the provider write to, so
    // "readiness came first" is read rather than assumed. The grid emits
    // `running` for every pane immediately before it attaches, so asserting on
    // that would prove nothing — a pane says when it actually started.
    const timeline: string[] = [];
    const slow = withResolvers<void>();

    const result = yield* scoped(function* (): Operation<GridResult> {
      yield* installControlledLauncher();
      yield* installControlledTerminalProvider({
        log: record,
        close: immediateClose(),
        // deno-lint-ignore require-yield
        *onAttach() {
          timeline.push("attach");
        },
      });
      return yield* runTerminalGrid(layoutOf(2, 3), [
        readyPane(0, timeline),
        {
          ordinal: 1,
          *run(claim) {
            yield* claim.admit(function* () {
              // Plenty of work before anything starts, and none of it makes the
              // grid attachable. The delay is long enough that a grid which
              // skipped the barrier would demonstrably attach first.
              yield* sleep(25);
              timeline.push("ready:1");
              claim.ready();
              yield* slow.operation;
            });
          },
        },
        readyPane(2, timeline),
      ]);
    });

    expect(timeline).toEqual(["ready:0", "ready:2", "ready:1", "attach"]);
    expect(result.failure).toBeUndefined();
  });

  it("TG9: a pane that never starts fails the grid, and nothing attaches", function* () {
    const record = log();
    let failure: unknown;

    yield* scoped(function* () {
      yield* useGridHost(record, immediateClose());
      try {
        yield* runTerminalGrid(layoutOf(2, 2), [
          pane(0),
          {
            ordinal: 1,
            // Runs, settles, and never reports a spawn.
            *run() {},
          },
        ]);
      } catch (error) {
        failure = error;
      }
    });

    expect(failure instanceof Error ? failure.message : "").toContain(
      "finished without starting anything interactive",
    );
    // No partial grid was ever shown, and the hidden composite was destroyed.
    expect(record.events).not.toContain("attach:0");
    expect(record.events).toContain("destroy:0");
  });

  it("TG9: a preparation failure starts no pane at all", function* () {
    const started: number[] = [];
    let failure: unknown;

    yield* scoped(function* () {
      yield* installControlledLauncher();
      yield* installControlledTerminalProvider({
        // deno-lint-ignore require-yield
        *onPrepare() {
          throw new Error("no pane endpoint could be created");
        },
      });
      try {
        yield* runTerminalGrid(layoutOf(2, 2), [
          pane(0, function* () {
            started.push(0);
          }),
          pane(1, function* () {
            started.push(1);
          }),
        ]);
      } catch (error) {
        failure = error;
      }
    });

    expect(failure instanceof Error ? failure.message : "").toBe(
      "no pane endpoint could be created",
    );
    expect(started).toEqual([]);
  });

  it("TG9: a grid refuses before preparation when no provider is installed", function* () {
    const started: number[] = [];
    let failure: unknown;

    yield* scoped(function* () {
      yield* installControlledLauncher();
      try {
        yield* runTerminalGrid(layoutOf(1, 1), [
          pane(0, function* () {
            started.push(0);
          }),
        ]);
      } catch (error) {
        failure = error;
      }
    });

    expect(failure instanceof Error ? failure.message : "").toContain(
      "no terminal provider is installed",
    );
    expect(started).toEqual([]);
  });
});

describe("Tier TG — settlement and close", () => {
  it("TG10: a pane fails after attach while its siblings stay live", function* () {
    const record = log();
    // The reader leaves once the grid has displayed the failure, so the sibling
    // is provably still live when that happens rather than probably still live.
    const failed = withResolvers<void>();
    let siblingLiveAtFailure = false;
    let siblingLive = false;

    const result = yield* scoped(function* (): Operation<GridResult> {
      yield* installControlledLauncher();
      yield* installControlledTerminalProvider({
        log: record,
        close: () => failed.operation,
        onUpdate(ordinal, state) {
          if (ordinal === 0 && state === "failed") {
            siblingLiveAtFailure = siblingLive;
            failed.resolve();
          }
        },
      });
      return yield* runTerminalGrid(layoutOf(2, 2), [
        {
          ordinal: 0,
          *run(claim) {
            yield* claim.admit(function* () {
              claim.ready();
              yield* sleep(1);
              throw new Error("pane 0 stopped");
            });
          },
        },
        {
          ordinal: 1,
          *run(claim) {
            yield* claim.admit(function* () {
              claim.ready();
              siblingLive = true;
              try {
                yield* suspend();
              } finally {
                siblingLive = false;
              }
            });
          },
        },
      ]);
    });

    expect(record.events).toContain("attach:0");
    expect(record.events).toContain("state:0:0:failed");
    // The sibling was still running when its neighbour failed: an ordinary pane
    // failure after attach is contained as that pane's status.
    expect(siblingLiveAtFailure).toBe(true);
    expect(result.outcomes[0]?.kind).toBe("failed");
    expect(result.outcomes[1]?.kind).toBe("closed");
    // The grid fails with the first failed pane in authored order.
    expect(result.failure?.message).toBe("pane 0 stopped");
  });

  it("TG12: close cancels a live pane as closed rather than failed", function* () {
    const record = log();

    const result = yield* scoped(function* (): Operation<GridResult> {
      yield* useGridHost(record, immediateClose());
      return yield* runTerminalGrid(layoutOf(1, 1), [
        {
          ordinal: 0,
          *run(claim) {
            yield* claim.admit(function* () {
              claim.ready();
              // Still live when the reader leaves.
              yield* suspend();
            });
          },
        },
      ]);
    });

    // Teardown cancellation is not a pane failure, and the grid succeeds.
    expect(result.outcomes[0]?.kind).toBe("closed");
    expect(result.failure).toBeUndefined();
    expect(record.events).toContain("state:0:0:closed");
  });

  it("TG12: the composite is destroyed exactly once, after the reader closes", function* () {
    const record = log();

    yield* scoped(function* () {
      yield* useGridHost(record, immediateClose());
      yield* runTerminalGrid(layoutOf(2, 2), [pane(0), pane(1)]);
    });

    const closed = record.events.indexOf("closed:0");
    const destroyed = record.events.indexOf("destroy:0");
    expect(closed).toBeGreaterThan(-1);
    expect(destroyed).toBeGreaterThan(closed);
    expect(record.events.filter((event) => event === "destroy:0")).toHaveLength(1);
  });

  it("TG13: parent cancellation tears the grid down completely", function* () {
    const record = log();

    yield* scoped(function* () {
      yield* useGridHost(record, () => suspend());
      // The grid never closes on its own; the enclosing scope ending is what
      // takes it down, and that has to be a complete teardown.
      yield* scoped(function* () {
        yield* spawnGrid(layoutOf(1, 1), [
          {
            ordinal: 0,
            *run(claim) {
              yield* claim.admit(function* () {
                claim.ready();
                yield* suspend();
              });
            },
          },
        ]);
        yield* sleep(2);
      });
    });

    expect(record.events).toContain("attach:0");
    expect(record.events).toContain("destroy:0");
  });
});

describe("Tier TG — the pane seam", () => {
  it("TG6: work inside a pane runs as that pane's owner", function* () {
    const grid = createTerminalGridClaims({
      columns: 1,
      rows: 1,
      panes: [{ ordinal: 0, title: "a", row: 0, column: 0, form: "paired" }],
    });
    const claim = grid.claims[0]!;
    let sawOrdinal: number | undefined;
    let acknowledged = false;

    yield* scoped(function* () {
      yield* usePaneTerminal(claim);
      const seam = yield* paneTerminal();
      sawOrdinal = seam?.ordinal;
      yield* seam!.interactive(function* (spawned) {
        spawned();
        acknowledged = grid.readiness[0]!.acknowledged;
      });
    });

    expect(sawOrdinal).toBe(0);
    // The seam is how anything interactive reports its spawn, so readiness
    // travels with the work rather than being asserted around it.
    expect(acknowledged).toBe(true);
  });

  it("TG6: outside a grid there is no pane, and nothing pretends otherwise", function* () {
    const seam = yield* scoped(function* () {
      return yield* paneTerminal();
    });
    expect(seam).toBeUndefined();
  });
});

/** Run a grid in a spawned task, so the enclosing scope can cancel it. */
function* spawnGrid(layout: TerminalGridLayout, work: readonly PaneWork[]): Operation<void> {
  yield* spawn(function* () {
    yield* runTerminalGrid(layout, work);
  });
}

/** One document run against a controlled grid host. */
interface DocumentRun {
  outcome: Result<Json>;
  /** Text the consumer received — the root document's own output. */
  output: string;
  /** The grid the provider was actually asked to present. */
  requests: TerminalGridRequest[];
  /** What each pane displayed. */
  shown: Map<number, string>;
  /** Every mark a tripwire component recorded, in order. */
  ran: string[];
}

function useDir(): Operation<string> {
  return resource<string>(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "xmd-tg-")));
    yield* ensure(function* () {
      yield* rm(dir, { recursive: true, force: true });
    });
    yield* provide(dir);
  });
}

/**
 * The controlled interactive child, and a tripwire.
 *
 * A paired pane is ready only when something in it starts and reports a spawn.
 * Until the native-launch Story lands, this is what a suite writes to be that
 * something — and it reaches the pane through the same seam a real launch will.
 */
function useGridComponents(ran: string[]): Operation<void> {
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
        return "";
      },
    },
  ]);
}

/**
 * Run one document against a controlled grid host.
 *
 * `provider: false` installs no terminal provider, which is how "a host that
 * cannot open a grid refuses" is asked for.
 */
function runDocument(
  dir: string,
  source: string,
  options: { provider?: boolean } = {},
): Operation<DocumentRun> {
  return scoped(function* () {
    const path = join(dir, "doc.md");
    yield* writeTextFile(path, source);
    const requests: TerminalGridRequest[] = [];
    const record = log();
    const ran: string[] = [];
    yield* useGridComponents(ran);
    yield* installControlledLauncher();
    // The reader stays until every pane has settled. Leaving sooner is a real
    // thing a reader does — TG12 covers it — but a row about what a pane
    // rendered must not race the close that cancels it.
    const settled = withResolvers<void>();
    let expected = 0;
    let done = 0;
    if (options.provider !== false) {
      yield* installControlledTerminalProvider({
        log: record,
        close: () => settled.operation,
        *onPrepare(asked) {
          expected = asked.panes.length;
          requests.push(asked);
          yield* sleep(0);
        },
        onUpdate(_ordinal, state) {
          if (state === "succeeded" || state === "failed") {
            done++;
            if (done >= expected) {
              settled.resolve();
            }
          }
        },
      });
    }
    const execution = yield* execute({ path, stream: new InMemoryStream(), includes: [dir] });
    const outcome = yield* execution;
    const output = yield* forEach(function* (_chunk: string) {}, execution.output);
    return { outcome, output, requests, shown: record.shown, ran };
  });
}

/** The message a run failed with, failing the test if it completed. */
function failureOf(run: DocumentRun): string {
  if (run.outcome.ok) {
    throw new Error(`expected the document to fail, but it completed: ${run.outcome.value}`);
  }
  return run.outcome.error.message;
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
    // Three panes sharing one label are three panes: the ordinal separates
    // them, and the form each was written in travels with it.
    expect(run.requests[0]?.panes).toEqual([
      { ordinal: 0, title: "Agent", row: 0, column: 0, form: "paired" },
      { ordinal: 1, title: "Agent", row: 0, column: 1, form: "self-closing" },
      { ordinal: 2, title: "Agent", row: 1, column: 0, form: "paired" },
    ]);
  });

  it("TG1: both pane forms run, and whitespace between panes is nothing", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Terminal.Grid columns={2}>",
        "",
        '<Terminal title="Agent">Instructions.<Interactive /></Terminal>',
        "",
        '<Terminal title="Shell" />',
        "",
        "</Terminal.Grid>",
        "",
      ].join("\n"),
    );

    expect(run.outcome.ok).toBe(true);
    expect(run.requests[0]).toEqual({
      columns: 2,
      rows: 1,
      panes: [
        { ordinal: 0, title: "Agent", row: 0, column: 0, form: "paired" },
        { ordinal: 1, title: "Shell", row: 0, column: 1, form: "self-closing" },
      ],
    });
  });

  it("TG7: a pane's text reaches that pane, and the grid renders nothing", function* () {
    const dir = yield* useDir();
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
    );

    expect(run.outcome.ok).toBe(true);
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

  it("TG6: a pane's <Break> cannot reach a loop outside the grid", function* () {
    const dir = yield* useDir();
    const run = yield* runDocument(
      dir,
      [
        "<Loop max={2}>",
        '<Ran mark="iteration" />',
        "<Terminal.Grid columns={1}>",
        '<Terminal title="Pane">',
        "<Break />",
        "<Interactive />",
        "</Terminal>",
        "</Terminal.Grid>",
        "</Loop>",
        "",
      ].join("\n"),
    );

    // Refused where it was written. Had the <Break> reached the loop around the
    // grid it would have exited it quietly and the document would have
    // succeeded; instead the pane failed with the stray-<Break> rule, which is
    // what fails the grid and then the document.
    expect(failureOf(run)).toContain("<Break> must be written inside a <Loop>");
    expect(failureOf(run)).toContain("cannot break the loop that invoked it");
    expect(run.ran).toEqual(["iteration"]);
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
