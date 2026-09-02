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
  TerminalGrids,
  terminalProviderLog,
} from "@executablemd/runtime";
import type {
  ControlledCompositeOptions,
  TerminalComposite,
  TerminalGridRequest,
  TerminalProviderLog,
} from "@executablemd/runtime";

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
  /** The journal this run read and appended to. */
  journal: DurableEvent[];
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

/** The controlled interactive child, and a tripwire. */
function useGridComponents(ran: string[], slowMarks: string[] = []): Operation<void> {
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
  } = {},
): Operation<DocumentRun> {
  return scoped(function* () {
    const path = join(dir, "doc.md");
    yield* writeTextFile(path, source);
    const requests: TerminalGridRequest[] = [];
    const log = terminalProviderLog();
    const ran: string[] = [];
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
    const execution = yield* execute({ path, stream, includes: [dir] });
    const outcome = yield* execution;
    const output = yield* forEach(function* (_chunk: string) {}, execution.output);
    return {
      outcome,
      output,
      requests,
      shown: log.shown,
      events: log.events,
      ran,
      journal: yield* stream.readAll(),
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
  options: { provider?: boolean } = {},
): Operation<DocumentRun> {
  return scoped(function* () {
    const requests: TerminalGridRequest[] = [];
    const log = terminalProviderLog();
    const ran: string[] = [];
    const opened = withResolvers<void>();
    yield* useGridComponents(ran);
    yield* installControlledLauncher();
    if (options.provider !== false) {
      yield* useControlledProvider({
        log,
        close: () => suspend(),
        *onPrepare(asked) {
          requests.push(asked);
          yield* sleep(0);
        },
        // Attach is the signal, not `running`: a pane that settles before the
        // barrier keeps its own status and never becomes runnable.
        // deno-lint-ignore require-yield
        *onAttach() {
          opened.resolve();
        },
      });
    }
    yield* installTerminalGridProfile(options.provider === false ? {} : { provider: "controlled" });

    const path = join(dir, "doc.md");
    yield* writeTextFile(path, source);
    const task: Task<void> = yield* spawn(function* () {
      const execution = yield* execute({ path, stream, includes: [dir] });
      yield* execution;
    });
    // The grid is open and its panes have settled, so the journal now holds the
    // pane children's own entries. A resumed run never attaches at all — the
    // region short-circuits — so this is bounded rather than waited on.
    yield* race([opened.operation, sleep(120)]);
    yield* sleep(5);
    yield* task.halt();
    return {
      outcome: { ok: false, error: new Error("interrupted") } as Result<Json>,
      output: "",
      requests,
      shown: log.shown,
      events: log.events,
      ran,
      journal: yield* stream.readAll(),
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
    // Ready enough to attach, and settled enough to be `succeeded`.
    expect(run.events).toContain("attach:0");
    expect(run.events).toContain("state:0:0:succeeded");
    // A pane that already settled keeps the status it settled to.
    expect(run.events.indexOf("state:0:0:succeeded")).toBeLessThan(run.events.indexOf("attach:0"));
    expect(run.events).not.toContain("state:0:0:running");
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

  /** Every terminal-grid entry the journal holds. */
  function gridEntries(run: DocumentRun): DurableEvent[] {
    return run.journal.filter(
      (event) =>
        event.type === "yield" && String(event.description.name).startsWith("terminal_grid:"),
    );
  }

  it("TG15: a completed grid replays without contacting a provider at all", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    // The grid opened and its panes ran; the document was then interrupted, so
    // the root reached no outcome and a resumed run reaches the grid again.
    const first = yield* runInterrupted(dir, GRID, stream);
    expect(first.requests).toHaveLength(1);

    const second = yield* runInterrupted(dir, GRID, stream);

    // The region's retained result is the answer: no provider was asked for a
    // grid, no pane content expanded, and nothing was displayed.
    expect(second.requests).toEqual([]);
    expect(second.shown.size).toBe(0);
    expect(second.events).toEqual([]);
  });

  it("TG15: a completed grid replays even where no provider could open one", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();

    yield* runInterrupted(dir, GRID, stream);
    // This host installs no provider at all. A replay that contacted one would
    // refuse here; the retained result does not need one.
    const second = yield* runInterrupted(dir, GRID, stream, { provider: false });

    expect(second.requests).toEqual([]);
    expect(second.shown.size).toBe(0);
    expect(second.events).toEqual([]);
  });

  it("TG16: each pane is a durable child of the grid, in authored order", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const first = yield* runInterrupted(dir, GRID, stream);

    const closes = first.journal.filter((event) => event.type === "close");
    const ids = closes.map((event) => String(event.coroutineId)).sort();
    // Two pane children beneath one grid child: `<parent>.<n>.<ordinal>`.
    const paneIds = ids.filter((id) => id.split(".").length >= 3);
    expect(paneIds).toHaveLength(2);
    const [left, right] = paneIds;
    // Authored order, not scheduling order.
    expect(left!.endsWith(".0")).toBe(true);
    expect(right!.endsWith(".1")).toBe(true);
    expect(left!.slice(0, left!.lastIndexOf("."))).toBe(right!.slice(0, right!.lastIndexOf(".")));
  });

  it("TG17: the layout is recorded before any provider is contacted", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const run = yield* runInterrupted(dir, GRID, stream);

    const layout = run.journal.find(
      (event) => event.type === "yield" && String(event.description.name).endsWith(":layout"),
    );
    expect(layout).toBeDefined();
    // Written before the grid child that opens anything, so a comparison
    // against it happens while nothing has been presented.
    const layoutIndex = run.journal.indexOf(layout!);
    const opened = run.journal.findIndex(
      (event) => event.type === "close" && String(event.coroutineId).includes("."),
    );
    expect(layoutIndex).toBeGreaterThan(-1);
    if (opened > -1) {
      expect(layoutIndex).toBeLessThan(opened);
    }
  });

  it("TG17: the retained record holds provider-neutral facts only", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const run = yield* runInterrupted(dir, GRID, stream);

    const entries = gridEntries(run);
    expect(entries.length).toBeGreaterThan(0);

    const written = JSON.stringify(run.journal);
    // The layout the author wrote, and nothing about whatever presented it.
    expect(written).toContain('"columns":2');
    expect(written).toContain('"Left"');
    for (const leak of ["socket", "tmux", "attach-key", "argv", "multiplexer"]) {
      expect(`${leak}: ${written.includes(leak)}`).toBe(`${leak}: false`);
    }
  });
});
