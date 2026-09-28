/**
 * Tier ALL — spawned document work running at the same time
 * (spec §6.5 `<All>` and `<Spawn>`).
 *
 * Every case here drives the ordinary scanner, the structural rules, the
 * expansion engine and the durable stream. Concurrency is established with
 * signals the children and the journal publish — never with a sleep — and the
 * releases are ordered so that the child which finishes *second* is the one the
 * document renders *first*. Calling the durable substrate directly would prove
 * the substrate rather than the language, so nothing here does.
 *
 * Each test names the defect it kills: expanding the children in sequence,
 * emitting them in completion order, running them on the parent coroutine,
 * sharing one block counter, sharing the binding environment, leaving a held
 * sibling alive after a failure, publishing one child's output before the join,
 * and letting a `<Return>` or `<Break>` claim an owner outside the spawn.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { race, resource, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { createDurableOperation, ephemeral, InMemoryStream } from "@executablemd/durable-streams";
import type {
  DurableEvent,
  EffectDescription,
  Json,
  Workflow,
} from "@executablemd/durable-streams";
import { useHostFiles } from "@executablemd/runtime";
import { useEchoExec, useStubFs } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { executeInstalled } from "../host.ts";
import { evaluateGeneratedXmd, pinnedComponent } from "../host.ts";
import type {
  DurablePreparation,
  ExecutionInstallation,
  GeneratedObservation,
  GeneratedXmdRequest,
  RetainedFragmentIdentity,
} from "../host.ts";
import { forEach } from "@effectionx/stream-helpers";
import { collect } from "../src/collect.ts";
import { retain } from "../src/component-api.ts";
import { getExpansion } from "../src/expansion.ts";
import { retainedSource } from "../src/root-source.ts";
import { registerComponents } from "../src/components/registration.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { AgentPromptEvent } from "../src/agent/agent-api.ts";
import { agentIdentityComponents, installAgentComponents } from "../src/agent/components.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { inspectSyntax } from "../src/inspect.ts";
import { RESERVED_STRUCTURAL } from "../src/structural.ts";
import { validateDocument } from "../src/document-validation.ts";
import { inlineSource } from "../src/root-source.ts";
import type { FunctionComponentDefinition, JsonObject } from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };
const NAMED = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
};

/**
 * How long a signal that a correct engine publishes immediately may go
 * unpublished before the wait is called a deadlock.
 *
 * Never reached by a passing run: every barrier below is opened by the children
 * themselves or by the journal, so this bounds only the failure mode. A
 * sequential expansion would otherwise hold its first child at a barrier its
 * sibling can no longer reach, and the suite would hang instead of saying what
 * went wrong.
 */
const DEADLOCK_MS = 10_000;

/** A one-shot signal two operations coordinate through. */
interface Signal {
  publish(): void;
  readonly published: Operation<boolean>;
}

function signal(): Signal {
  const resolvers = withResolvers<boolean>();
  let settled = false;
  return {
    publish() {
      if (!settled) {
        settled = true;
        resolvers.resolve(true);
      }
    },
    get published() {
      return resolvers.operation;
    },
  };
}

/** Wait for a signal, reporting a deadlock rather than hanging on one. */
function* awaiting(what: string, waited: Operation<boolean>): Operation<void> {
  const reached = yield* race([
    waited,
    (function* (): Operation<boolean> {
      yield* sleep(DEADLOCK_MS);
      return false;
    })(),
  ]);
  if (!reached) {
    throw new Error(`${what} never happened: the spawned children did not run at the same time`);
  }
}

/**
 * The gates, tripwires and timelines one document's registered components
 * share.
 *
 * Three facts about one child are kept apart on purpose: that it reached its
 * barrier, that it was let go, and that its own durable record landed. A
 * driver that could only see the last of them could not tell a document whose
 * children ran together from one whose children ran in turn.
 */
class Harness {
  /** Every `<Gate>` and `<Fail>` that reached its barrier, in arrival order. */
  readonly arrived: string[] = [];
  /** Every registered component invocation, in order. */
  readonly ran: string[] = [];
  /** The expansion identifier each `<Probe>` saw, by its name. */
  readonly identities = new Map<string, string>();
  /** `start:`/`stop:` marks the retained resources published. */
  readonly timeline: string[] = [];
  /** What each `<Observe>` saw of a retained resource. */
  readonly observed: string[] = [];

  readonly #arrivals = new Map<string, Signal>();
  readonly #releases = new Map<string, Signal>();
  readonly #records = new Map<string, Signal>();

  static #slot(map: Map<string, Signal>, name: string): Signal {
    const existing = map.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = signal();
    map.set(name, created);
    return created;
  }

  announce(name: string): void {
    this.arrived.push(name);
    Harness.#slot(this.#arrivals, name).publish();
  }

  held(name: string): Operation<void> {
    return awaiting(`<${name}> being released`, Harness.#slot(this.#releases, name).published);
  }

  recorded(name: string): void {
    Harness.#slot(this.#records, name).publish();
  }

  arrival(name: string): Operation<void> {
    return awaiting(`${name} arriving`, Harness.#slot(this.#arrivals, name).published);
  }

  append(name: string): Operation<void> {
    return awaiting(`${name} recording its work`, Harness.#slot(this.#records, name).published);
  }

  release(name: string): void {
    Harness.#slot(this.#releases, name).publish();
  }
}

function harness(): Harness {
  return new Harness();
}

type Gated = Harness;

/** Append one entry to the journal, the way any durable operation does. */
function* mark(description: EffectDescription, value: Json): Workflow<unknown> {
  return yield createDurableOperation(description, function* () {
    return value;
  });
}

/** A resource whose start and stop are both on the record. */
function useWatch(timeline: string[], label: string): Operation<string> {
  return resource(function* (provide) {
    timeline.push(`start:${label}`);
    try {
      yield* provide(`held:${label}`);
    } finally {
      timeline.push(`stop:${label}`);
    }
  });
}

/**
 * The components every document below is written against.
 *
 * `<Gate>` is the barrier: it announces that it is live, waits to be released,
 * and only then appends its own durable record — so which child reached the
 * document first, which was released first and which appended first are three
 * separately observable facts.
 */
function* useComponents(shared: Gated): Operation<void> {
  yield* registerComponents([
    {
      name: "Gate",
      origin: "tier-all",
      props: NAMED,
      *fn(props) {
        const name = String(props.name);
        shared.ran.push(`gate:${name}`);
        shared.announce(name);
        yield* shared.held(name);
        yield* mark({ type: "gate", name: `gate:${name}` }, name);
        shared.recorded(name);
        return `[${name}]`;
      },
    },
    {
      name: "Probe",
      origin: "tier-all",
      props: NAMED,
      *fn(props) {
        const name = String(props.name);
        shared.ran.push(`probe:${name}`);
        shared.identities.set(name, (yield* getExpansion()).id);
        return `(${name})`;
      },
    },
    {
      name: "Keep",
      origin: "tier-all",
      props: NAMED,
      *fn(props) {
        const name = String(props.name);
        shared.ran.push(`keep:${name}`);
        return yield* retain(() => useWatch(shared.timeline, name));
      },
    },
    {
      name: "Observe",
      origin: "tier-all",
      props: NAMED,
      // deno-lint-ignore require-yield
      *fn(props) {
        const name = String(props.name);
        shared.observed.push(
          `${name}:${shared.timeline.includes("stop:kept") ? "released" : "live"}`,
        );
        return "";
      },
    },
    {
      name: "Fail",
      origin: "tier-all",
      props: NAMED,
      *fn(props) {
        const name = String(props.name);
        shared.ran.push(`fail:${name}`);
        shared.announce(name);
        yield* shared.held(name);
        throw new Error(`FAILED:${name}`);
      },
    },
  ]);
}

/** What one document run produced. */
interface Run {
  readonly ok: boolean;
  readonly output: string;
  readonly failure: string;
  readonly events: DurableEvent[];
}

/**
 * Run one document to completion, with the gate components registered and a
 * driver task free to open the barriers while the run is still live.
 */
function run(
  source: string,
  options: {
    shared?: Gated;
    stream?: InMemoryStream;
    files?: Record<string, string>;
    drive?: (shared: Gated, stream: InMemoryStream) => Operation<void>;
  } = {},
): Operation<Run> {
  return scoped(function* () {
    const shared = options.shared ?? harness();
    const stream = options.stream ?? new InMemoryStream();
    yield* useHostFiles();
    yield* useStubFs({ "test.md": source, ...options.files });
    yield* useEchoExec();
    yield* useComponents(shared);
    if (options.drive) {
      yield* spawn(() => options.drive!(shared, stream));
    }
    // Drained chunk by chunk rather than collected: a run that fails still
    // emitted whatever it emitted, and a test asking whether `<All>` published
    // a child early has to be able to see it.
    const chunks: string[] = [];
    const result = yield* scoped(function* () {
      const execution = yield* execute({ path: "test.md", stream });
      try {
        yield* forEach(function* (chunk: string) {
          chunks.push(chunk);
        }, execution.output);
      } catch {
        // The execution's own outcome below says why the stream stopped.
      }
      return yield* execution;
    });
    return {
      ok: result.ok,
      output: chunks.join(""),
      failure: result.ok ? "" : result.error.message,
      events: stream.snapshot(),
    };
  });
}

/** The name one durable record settled with, or `undefined` for anything else. */
function recordedName(event: DurableEvent): string | undefined {
  if (event.type !== "yield" || event.description.type !== "gate") {
    return undefined;
  }
  return event.result.status === "ok" ? String(event.result.value ?? "") : undefined;
}

/** Every durable record one gate appended, in journal order. */
function gateOrder(events: DurableEvent[]): string[] {
  const found: string[] = [];
  for (const event of events) {
    const name = recordedName(event);
    if (name !== undefined) {
      found.push(name);
    }
  }
  return found;
}

/** The coroutine each gate record was written under, by gate name. */
function gateCoroutines(events: DurableEvent[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const event of events) {
    const name = recordedName(event);
    if (name !== undefined) {
      found.set(name, event.coroutineId);
    }
  }
  return found;
}

interface EvalEntry {
  readonly name: string;
  readonly coroutineId: string;
}

function evalEntries(events: DurableEvent[]): EvalEntry[] {
  return events
    .filter((event) => event.type === "yield" && event.description.type === "eval")
    .map((event) => ({
      name: event.type === "yield" ? event.description.name : "",
      coroutineId: event.coroutineId,
    }));
}

/** Every coroutine this run closed, with the status it closed under. */
function closes(events: DurableEvent[]): Array<{ id: string; status: string }> {
  return events
    .filter((event) => event.type === "close")
    .map((event) => ({ id: event.coroutineId, status: event.result.status }));
}

/** The value each closed child coroutine settled with, in journal order. */
function childCloseValues(events: DurableEvent[]): Array<[string, Json]> {
  const found: Array<[string, Json]> = [];
  for (const event of events) {
    if (event.type === "close" && event.coroutineId.includes(".") && event.result.status === "ok") {
      found.push([event.coroutineId, event.result.value ?? null]);
    }
  }
  return found;
}

const TWO_GATES = [
  "<All>",
  '<Spawn><Gate name="one" /></Spawn>',
  '<Spawn><Gate name="two" /></Spawn>',
  "</All>",
].join("\n");

describe("Tier ALL — PA1: both children are live, and output follows the source", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL1: releasing the second child first appends it first and renders it second", function* () {
    const result = yield* run(TWO_GATES, {
      *drive(shared) {
        // Both children have to be live at once before either is released:
        // a sequential expansion can never satisfy this, because the second
        // child would not start until the first had finished.
        yield* shared.arrival("one");
        yield* shared.arrival("two");
        expect(shared.arrived).toEqual(["one", "two"]);
        shared.release("two");
        yield* shared.append("two");
        shared.release("one");
      },
    });

    expect(result.ok).toBe(true);
    // Completion order decided the journal; it did not decide the document.
    expect(gateOrder(result.events)).toEqual(["two", "one"]);
    expect(result.output).toContain("[one][two]");
    expect(result.output).not.toContain("[two][one]");
  });

  it("ALL2: no child output is published before the join succeeds", function* () {
    const emitted: string[] = [];
    const result = yield* run(TWO_GATES, {
      *drive(shared, stream) {
        stream.onAppend = (event) => {
          const name = recordedName(event);
          if (name !== undefined) {
            // What the document has emitted at the moment one child's own
            // durable work lands: nothing of either child's, because the join
            // has not returned.
            emitted.push(`append:${name}`);
          }
        };
        yield* shared.arrival("one");
        yield* shared.arrival("two");
        shared.release("two");
        shared.release("one");
      },
    });

    expect(result.ok).toBe(true);
    expect(emitted).toHaveLength(2);
    expect(result.output).toContain("[one][two]");
  });
});

describe("Tier ALL — PA2: durable identity follows the source", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL3: children close on source-ordered coroutines under the one that reached <All>", function* () {
    const result = yield* run(TWO_GATES, {
      *drive(shared) {
        yield* shared.arrival("one");
        yield* shared.arrival("two");
        shared.release("two");
        yield* shared.append("two");
        shared.release("one");
      },
    });

    expect(result.ok).toBe(true);
    const coroutines = gateCoroutines(result.events);
    // Source order, not completion order: "two" finished first and is still
    // the second child.
    expect(coroutines.get("one")).toBe("root.0");
    expect(coroutines.get("two")).toBe("root.1");
    expect(closes(result.events)).toEqual([
      { id: "root.1", status: "ok" },
      { id: "root.0", status: "ok" },
      { id: "root", status: "ok" },
    ]);
    // Each child closes with exactly the markdown it rendered.
    expect(new Map(childCloseValues(result.events))).toEqual(
      new Map([
        ["root.1", "[two]"],
        ["root.0", "[one]"],
      ]),
    );
  });

  it("ALL4: nesting produces hierarchical child identities", function* () {
    const result = yield* run(
      [
        "<All>",
        "<Spawn>",
        "<All>",
        '<Spawn><Gate name="inner-a" /></Spawn>',
        '<Spawn><Gate name="inner-b" /></Spawn>',
        "</All>",
        "</Spawn>",
        '<Spawn><Gate name="outer" /></Spawn>',
        "</All>",
      ].join("\n"),
      {
        *drive(shared) {
          yield* shared.arrival("inner-a");
          yield* shared.arrival("inner-b");
          yield* shared.arrival("outer");
          shared.release("inner-a");
          shared.release("inner-b");
          shared.release("outer");
        },
      },
    );

    expect(result.ok).toBe(true);
    const coroutines = gateCoroutines(result.events);
    expect(coroutines.get("inner-a")).toBe("root.0.0");
    expect(coroutines.get("inner-b")).toBe("root.0.1");
    expect(coroutines.get("outer")).toBe("root.1");
  });

  it("ALL5: a complete replay runs no spawned work at all", function* () {
    const stream = new InMemoryStream();
    const live = harness();
    const first = yield* run(TWO_GATES, {
      shared: live,
      stream,
      *drive(shared) {
        yield* shared.arrival("one");
        yield* shared.arrival("two");
        shared.release("two");
        shared.release("one");
      },
    });
    expect(first.ok).toBe(true);
    expect(live.ran).toEqual(["gate:one", "gate:two"]);

    const replayed = yield* run(TWO_GATES, { stream: new InMemoryStream(first.events) });
    expect(replayed.ok).toBe(true);
    expect(replayed.output).toBe(first.output);
    // Nothing spawned ran, so no barrier had to be opened for the replay.
    expect(gateOrder(replayed.events)).toEqual(gateOrder(first.events));
  });
});

const COUNTER_DOC = [
  "```js eval",
  "output('BEFORE');",
  "```",
  "",
  "<All>",
  "<Spawn>",
  "",
  "```js eval",
  "output('S1');",
  "```",
  "",
  '<Probe name="p1" />',
  "",
  "</Spawn>",
  "<Spawn>",
  "",
  "```js eval",
  "output('S2');",
  "```",
  "",
  '<Probe name="p2" />',
  "",
  "</Spawn>",
  "</All>",
  "",
  "```js eval",
  "output('AFTER');",
  "```",
].join("\n");

describe("Tier ALL — PA3: counters, paths and the parent's own numbering", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL6: children reuse local block ids, and later parent work keeps its own", function* () {
    const shared = harness();
    const result = yield* run(COUNTER_DOC, { shared });

    expect(result.ok).toBe(true);
    const entries = evalEntries(result.events);
    const onParent = entries.filter((entry) => entry.coroutineId === "root");
    // The parent's counter never saw the children: the block after `</All>` is
    // numbered as though no child had run.
    expect(onParent.map((entry) => entry.name)).toEqual(["eval:eval:root:0", "eval:eval:root:1"]);

    const inChildren = entries.filter((entry) => entry.coroutineId !== "root");
    // `sort()` rather than `toSorted()`: the Node typecheck targets ES2022, where
    // the latter does not exist, and the array being sorted is the one `map` just
    // made — so there is nothing of anyone else's to mutate.
    expect(inChildren.map((entry) => entry.coroutineId).sort()).toEqual(["root.0", "root.1"]);
    // Both children number their own first block the same way and collide with
    // nothing, because the child coroutine namespaces it.
    expect(new Set(inChildren.map((entry) => entry.name))).toEqual(new Set(["eval:eval:root:0"]));

    // Two spawns, two stable and distinct expansion identities.
    const p1 = shared.identities.get("p1");
    const p2 = shared.identities.get("p2");
    expect(typeof p1).toBe("string");
    expect(typeof p2).toBe("string");
    expect(p1).not.toBe(p2);

    // A second run of the same document derives all three again.
    const again = harness();
    const rerun = yield* run(COUNTER_DOC, { shared: again });
    expect(rerun.ok).toBe(true);
    expect(again.identities.get("p1")).toBe(p1);
    expect(again.identities.get("p2")).toBe(p2);
    // The same identities on the same coroutines. Compared as a set, because
    // which child appends first is exactly what scheduling is allowed to
    // decide — the contract fixes what a block is called and where, never the
    // order two independent children reach the journal.
    // `sort()` for the same reason, on the array `map` just made.
    const identify = (found: EvalEntry[]): string[] =>
      found.map((entry) => `${entry.coroutineId}/${entry.name}`).sort();
    expect(identify(evalEntries(rerun.events))).toEqual(identify(entries));

    // And a replay reproduces the rendering without running any of it.
    const idle = harness();
    const replayed = yield* run(COUNTER_DOC, {
      shared: idle,
      stream: new InMemoryStream(result.events),
    });
    expect(replayed.output).toBe(result.output);
    expect(idle.ran).toEqual([]);
  });
});

const ISOLATION_DOC = [
  "<All>",
  "<Spawn>",
  '<Let as="picked">chosen</Let>',
  '<Keep as="handle" name="kept" />',
  "spawn1({picked}/{handle})",
  "</Spawn>",
  "<Spawn>",
  "spawn2({picked}/{handle})",
  "</Spawn>",
  "</All>",
  "",
  "after({picked}/{handle})",
  "",
  '<Observe name="after" />',
].join("\n");

describe("Tier ALL — PA4: a child's bindings and resources are its own", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL7: a binding and a retained resource live on in their child and nowhere else", function* () {
    const shared = harness();
    const result = yield* run(ISOLATION_DOC, { shared });

    expect(result.ok).toBe(true);
    // Later work in the same child reads both.
    expect(result.output).toContain("spawn1(chosen/held:kept)");
    // The sibling and the work after `</All>` read neither: the names are not
    // bound there, so they render as the text that was written.
    expect(result.output).toContain("spawn2({picked}/{handle})");
    expect(result.output).toContain("after({picked}/{handle})");
    // The resource lived while the child did, and was released when it ended.
    expect(shared.timeline).toEqual(["start:kept", "stop:kept"]);
    expect(shared.observed).toEqual(["after:released"]);
  });
});

describe("Tier ALL — PA5: a partial replay restores one child and resumes the other", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL8: the completed child is restored and only the unrecorded child runs", function* () {
    const stream = new InMemoryStream();
    const live = harness();
    const golden = yield* run(TWO_GATES, {
      shared: live,
      stream,
      *drive(shared, journal) {
        const closedOne = signal();
        journal.onAppend = (event) => {
          if (event.type === "close" && event.coroutineId === "root.0") {
            closedOne.publish();
          }
        };
        yield* shared.arrival("one");
        yield* shared.arrival("two");
        // The first child is released and allowed to close before the second
        // records anything, so the truncation below has exactly one complete
        // child and one that has not started its work.
        shared.release("one");
        yield* awaiting("the first child closing", closedOne.published);
        shared.release("two");
      },
    });
    expect(golden.ok).toBe(true);
    expect(golden.output).toContain("[one][two]");

    const events = golden.events;
    const closedAt = events.findIndex(
      (event) => event.type === "close" && event.coroutineId === "root.0",
    );
    expect(closedAt).toBeGreaterThan(0);
    const partial = events.slice(0, closedAt + 1);
    expect(partial.some((event) => event.type === "close" && event.coroutineId === "root.1")).toBe(
      false,
    );
    expect(gateOrder(partial)).toEqual(["one"]);

    const resumed = harness();
    const replayed = yield* run(TWO_GATES, {
      shared: resumed,
      stream: new InMemoryStream(partial),
      *drive(shared) {
        yield* shared.arrival("two");
        shared.release("two");
      },
    });

    expect(replayed.ok).toBe(true);
    // The completed child's rendering came back from its recorded close, and
    // only the child with no close ran.
    expect(replayed.output).toBe(golden.output);
    expect(resumed.ran).toEqual(["gate:two"]);
    expect(gateCoroutines(replayed.events).get("two")).toBe("root.1");
  });
});

describe("Tier ALL — PA6: a failure cancels its siblings and publishes nothing", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL9: a held sibling is cancelled and joined, and <All> renders nothing", function* () {
    const shared = harness();
    const result = yield* run(
      [
        "<All>",
        '<Spawn><Fail name="bad" /></Spawn>',
        '<Spawn><Keep name="kept" /><Gate name="held" /></Spawn>',
        "</All>",
        "",
        "tail",
      ].join("\n"),
      {
        shared,
        *drive(inner) {
          yield* inner.arrival("bad");
          yield* inner.arrival("held");
          // The sibling is still holding at its barrier when the first child
          // fails, and is never released by this driver.
          inner.release("bad");
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("FAILED:bad");
    // Neither child's private buffer reached the document, and nothing after
    // `</All>` ran.
    expect(result.output).not.toContain("[held]");
    expect(result.output).not.toContain("tail");
    // The held sibling's scope was torn down as part of the join.
    expect(shared.timeline).toEqual(["start:kept", "stop:kept"]);
    // The journal holds only what was acknowledged: the failing child closed
    // with its error, the cancelled one as cancelled, and the held gate never
    // recorded work it did not do.
    expect(gateOrder(result.events)).toEqual([]);
    const closed = new Map(closes(result.events).map((entry) => [entry.id, entry.status]));
    expect(closed.get("root.0")).toBe("err");
    expect(closed.get("root.1")).toBe("cancelled");
  });

  it("ALL9b: a child that already succeeded publishes nothing when a sibling fails", function* () {
    const shared = harness();
    const result = yield* run(
      [
        "<All>",
        '<Spawn><Gate name="done" /></Spawn>',
        '<Spawn><Keep name="kept" /><Fail name="bad" /></Spawn>',
        "</All>",
        "",
        "tail",
      ].join("\n"),
      {
        shared,
        *drive(inner) {
          yield* inner.arrival("done");
          yield* inner.arrival("bad");
          // The first child runs to completion, and only then does its sibling
          // fail: its rendering exists, and the join is what decides whether
          // the document ever sees it.
          inner.release("done");
          yield* inner.append("done");
          inner.release("bad");
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("FAILED:bad");
    // The successful child's own markdown was never published: the join failed,
    // so `<All>` emitted none of it.
    expect(result.output).not.toContain("[done]");
    expect(result.output).not.toContain("tail");
    // Its durable record stands, because the journal only ever held work that
    // was acknowledged.
    expect(gateOrder(result.events)).toEqual(["done"]);
    expect(shared.timeline).toEqual(["start:kept", "stop:kept"]);
    const closed = new Map(closes(result.events).map((entry) => [entry.id, entry.status]));
    expect(closed.get("root.0")).toBe("ok");
    expect(closed.get("root.1")).toBe("err");
  });

  it("ALL10: cancelling the document leaves no spawned work alive", function* () {
    const shared = harness();
    const stream = new InMemoryStream();
    const outcome = yield* scoped(function* () {
      yield* useHostFiles();
      yield* useStubFs({
        "test.md": [
          "<All>",
          '<Spawn><Keep name="kept" /><Gate name="one" /></Spawn>',
          '<Spawn><Gate name="two" /></Spawn>',
          "</All>",
        ].join("\n"),
      });
      yield* useEchoExec();
      yield* useComponents(shared);
      return yield* race([
        (function* (): Operation<string> {
          const execution = yield* execute({ path: "test.md", stream });
          yield* collect(execution);
          return "finished";
        })(),
        (function* (): Operation<string> {
          yield* shared.arrival("one");
          yield* shared.arrival("two");
          return "cancelled";
        })(),
      ]);
    });

    expect(outcome).toBe("cancelled");
    // The scope exited while both children were held, and both were joined:
    // the retained resource is released and no gate recorded work.
    expect(shared.timeline).toEqual(["start:kept", "stop:kept"]);
    expect(gateOrder(stream.snapshot())).toEqual([]);
  });
});

describe("Tier ALL — PA7: malformed structure refuses before any child starts", () => {
  beforeAll(() => useTempFileCompiler());

  const cases: Array<[string, string, string]> = [
    [
      "ALL11: fewer than two spawns",
      ["<All>", '<Spawn><Probe name="t1" /></Spawn>', "</All>"].join("\n"),
      "at least two <Spawn>",
    ],
    [
      "ALL12: a prop on <All>",
      [
        "<All limit={2}>",
        '<Spawn><Probe name="t1" /></Spawn>',
        '<Spawn><Probe name="t2" /></Spawn>',
        "</All>",
      ].join("\n"),
      "<All> accepts no props",
    ],
    ["ALL13: a self-closing <All>", "<All />", "written paired"],
    [
      "ALL14: a self-closing <Spawn>",
      ["<All>", "<Spawn />", '<Spawn><Probe name="t2" /></Spawn>', "</All>"].join("\n"),
      "<Spawn> holds the markdown",
    ],
    [
      "ALL15: a prop on <Spawn>",
      [
        "<All>",
        '<Spawn name="x"><Probe name="t1" /></Spawn>',
        '<Spawn><Probe name="t2" /></Spawn>',
        "</All>",
      ].join("\n"),
      "<Spawn> accepts no props",
    ],
    [
      "ALL16: substantive direct text",
      [
        "<All>",
        "stray words",
        '<Spawn><Probe name="t1" /></Spawn>',
        '<Spawn><Probe name="t2" /></Spawn>',
        "</All>",
      ].join("\n"),
      "<All> holds only <Spawn> children",
    ],
    [
      "ALL17: a direct component child",
      [
        "<All>",
        '<Probe name="t0" />',
        '<Spawn><Probe name="t1" /></Spawn>',
        '<Spawn><Probe name="t2" /></Spawn>',
        "</All>",
      ].join("\n"),
      "<All> holds only <Spawn> children",
    ],
    [
      "ALL18: a <Spawn> with no <All>",
      '<Spawn><Probe name="t1" /></Spawn>',
      "direct child of <All>",
    ],
    [
      "ALL19: a <Spawn> below its <All> rather than directly inside it",
      [
        "<All>",
        '<Spawn><If condition={true}><Spawn><Probe name="t1" /></Spawn></If></Spawn>',
        '<Spawn><Probe name="t2" /></Spawn>',
        "</All>",
      ].join("\n"),
      "direct child of <All>",
    ],
  ];

  for (const [title, source, expected] of cases) {
    it(title, function* () {
      const shared = harness();
      const result = yield* run(source, { shared });
      expect(result.ok).toBe(false);
      expect(result.failure).toContain(expected);
      // No tripwire in any child ran: the refusal is decided from source
      // before a child is constructed.
      expect(shared.ran).toEqual([]);
    });
  }

  it("ALL20: a repository file cannot supply <All> or <Spawn>", function* () {
    const shared = harness();
    const result = yield* run("<Spawn>from a file</Spawn>", {
      shared,
      files: { "components/Spawn.md": "a repository spawn\n" },
    });
    expect(result.output).not.toContain("a repository spawn");
    expect(result.failure).toContain("never resolves a component");
    expect(shared.ran).toEqual([]);
  });
});

describe("Tier ALL — PA8: <Return> and <Break> cannot cross a spawn", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL21: a <Break> in a spawn cannot exit a loop outside <All>", function* () {
    const shared = harness();
    const result = yield* run(
      [
        "<Loop max={2}>",
        "<All>",
        "<Spawn><Break /></Spawn>",
        '<Spawn><Probe name="t2" /></Spawn>',
        "</All>",
        "</Loop>",
      ].join("\n"),
      { shared },
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("<Break> cannot cross <Spawn>");
    expect(shared.ran).toEqual([]);
  });

  it("ALL22: a loop wholly inside a spawn is broken by its own <Break>", function* () {
    const result = yield* run(
      [
        "<All>",
        "<Spawn><Loop max={3}>a<Break /></Loop></Spawn>",
        "<Spawn>b</Spawn>",
        "</All>",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ab");
    expect(result.output).not.toContain("ERROR");
  });

  it("ALL23: a <Return> in a spawn satisfies no value root", function* () {
    const result = yield* run(
      [
        "---",
        "returns:",
        "  type: string",
        "---",
        "",
        "<All>",
        '<Spawn><Return value={"from the spawn"} /></Spawn>',
        "<Spawn>b</Spawn>",
        "</All>",
      ].join("\n"),
    );
    expect(result.ok).toBe(false);
    // The body still owes its own `<Return>`: the one inside the spawn neither
    // satisfies the declaration nor stands in for it.
    expect(result.failure).toContain("no <Return>");
  });

  it("ALL24: a value component invoked inside a spawn keeps its own <Return>", function* () {
    const result = yield* run(
      [
        "<All>",
        '<Spawn><Answerer as="picked" />got {picked}</Spawn>',
        "<Spawn>b</Spawn>",
        "</All>",
      ].join("\n"),
      {
        files: {
          "components/Answerer.md": [
            "---",
            "returns:",
            "  type: string",
            "---",
            "",
            '<Return value={"an answer"} />',
          ].join("\n"),
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("got an answer");
    expect(result.output).toContain("b");
  });

  it("ALL25: non-executing validation reports both boundaries where they were written", function* () {
    const shared = harness();
    const source = [
      "<Loop max={2}>",
      "<All>",
      "<Spawn><Break /></Spawn>",
      '<Spawn><Return value={"x"} /></Spawn>',
      "</All>",
      "</Loop>",
    ].join("\n");
    yield* useComponents(shared);
    const validation = yield* validateDocument(inlineSource(source));
    const messages = validation.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages.some((message) => message.includes("<Break> cannot cross <Spawn>"))).toBe(true);
    expect(messages.some((message) => message.includes("<Return> cannot cross <Spawn>"))).toBe(
      true,
    );
    // One mistake, one diagnostic: the stray-element sentences are not also
    // reported for the same two elements.
    expect(messages.some((message) => message.includes("must be written inside a <Loop>"))).toBe(
      false,
    );
  });
});

const GENERATED_ROOT = "workflows/agent.md";
const GENERATED_SOURCE = "The host ran a generated fragment.\n";

function hostIdentity(origin: string, key: string): RetainedFragmentIdentity {
  return { kind: "component-answer", origin, key, revision: "1" };
}

const GENERATED_PROBE: FunctionComponentDefinition = {
  kind: "function",
  name: "Probe",
  props: NO_PROPS,
  // deno-lint-ignore require-yield
  *fn() {
    return "probed";
  },
};

function generatedProbe(): GeneratedObservation {
  return pinnedComponent("Probe", hostIdentity("test://probe", "Probe"), GENERATED_PROBE);
}

function generatedRequest(source: string): GeneratedXmdRequest {
  return {
    id: "turn-1",
    source,
    workspaceRoots: ["workspace://primary"],
    selectedRoot: "workspace://primary",
    observations: [generatedProbe()],
  };
}

interface Attempt {
  readonly output?: string;
  readonly failure?: string;
  readonly events: DurableEvent[];
}

function evaluateFragment(source: string): Operation<Attempt> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const captured: { result?: string } = {};
    // A preparation yields durable effects, and the evaluator is an ordinary
    // operation whose *own* effects identify themselves against the durable
    // root they run in. `ephemeral()` is the bridge for exactly that: the
    // wrapper writes no journal entry of its own, and the evaluator's
    // admission record still lands under the root coroutine.
    const prepare: DurablePreparation = function* () {
      captured.result = yield* ephemeral(evaluateGeneratedXmd(generatedRequest(source)));
    };
    const installation: ExecutionInstallation = { prepare };
    const execution = yield* executeInstalled(
      { ...retainedSource(GENERATED_ROOT, GENERATED_SOURCE), stream, includes: [] },
      [installation],
    );
    const result = yield* execution;
    const events = stream.snapshot();
    return result.ok
      ? { output: captured.result ?? "", events }
      : { failure: result.error.message, events };
  });
}

/** What each generated-XMD admission decided. */
function decisions(events: DurableEvent[]): string[] {
  const found: string[] = [];
  for (const event of events) {
    if (
      event.type !== "yield" ||
      event.description.type !== "generated_xmd" ||
      event.result.status !== "ok"
    ) {
      continue;
    }
    const value = event.result.value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record: JsonObject = value;
      found.push(typeof record.decision === "string" ? record.decision : "");
    }
  }
  return found;
}

describe("Tier ALL — PA9: the construct exists everywhere the language does", () => {
  beforeAll(() => useTempFileCompiler());

  it("ALL26: the canonical syntax surface lists both names as structural", function* () {
    const catalog = yield* inspectSyntax({ includes: [] });
    const names = catalog.categories[0].entries.map((entry) => entry.name);
    expect(names).toContain("All");
    expect(names).toContain("Spawn");
    expect(RESERVED_STRUCTURAL.has("All")).toBe(true);
    expect(RESERVED_STRUCTURAL.has("Spawn")).toBe(true);
  });

  it("ALL27: admitted generated XMD runs a valid <All>", function* () {
    const attempt = yield* evaluateFragment(
      ["<All>", "<Spawn><Probe /></Spawn>", "<Spawn><Probe /></Spawn>", "</All>"].join("\n"),
    );
    expect(attempt.failure).toBe(undefined);
    expect(attempt.output).toContain("probed");
    expect(decisions(attempt.events)).toEqual(["admitted"]);
  });

  it("ALL28: a malformed <All> refuses the fragment before its first effect", function* () {
    const attempt = yield* evaluateFragment(
      ["<All>", "<Spawn><Probe /></Spawn>", "</All>"].join("\n"),
    );
    expect(decisions(attempt.events)).toEqual(["refused"]);
    expect(attempt.output ?? "").not.toContain("probed");
  });

  it("ALL29: a stray <Spawn> refuses the fragment", function* () {
    const attempt = yield* evaluateFragment("<Spawn><Probe /></Spawn>\n");
    expect(decisions(attempt.events)).toEqual(["refused"]);
    expect(attempt.output ?? "").not.toContain("probed");
  });
});

/**
 * Tier PA10a/c — the Story's own example: ordinary `<Session>` in each branch.
 *
 * `<Session>` is a capability-backed identity component, so two of them running
 * at once is the case where canonical resolution has to attribute each answer
 * and each selection to the exact import that opened it. These rows drive the
 * real components over a real journal; nothing here stands in for `<Session>`.
 */

/** One conversation the stubbed provider holds, and how it is let go. */
interface Conversation {
  /** Session keys that reached the provider, in arrival order. */
  readonly arrived: string[];
  /** Whether a provider factory was materialized, and how often. */
  activations: () => number;
  /** How many implementations the declared `<Session>` factory built. */
  sessions: () => number;
  reached(sessionKey: string): Operation<void>;
  release(sessionKey: string): void;
  readonly installation: ExecutionInstallation;
  readonly declaration: ExecutionInstallation;
}

function conversations(options: { gated?: boolean } = {}): Conversation {
  const arrived: string[] = [];
  const arrivals = new Map<string, Signal>();
  const releases = new Map<string, Signal>();
  const slot = (map: Map<string, Signal>, key: string): Signal => {
    const existing = map.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = signal();
    map.set(key, created);
    return created;
  };
  let activations = 0;
  let built = 0;

  const declared = agentIdentityComponents().map((component) => ({
    ...component,
    factory: (claim: Parameters<typeof component.factory>[0]) => {
      // One implementation per declared component per execution, however many
      // branches invoke it. A domain minted per `<Spawn>` would show up here.
      built += 1;
      return component.factory(claim);
    },
  }));

  return {
    arrived,
    activations: () => activations,
    sessions: () => built,
    reached(sessionKey: string) {
      return awaiting(`${sessionKey} reaching the provider`, slot(arrivals, sessionKey).published);
    },
    release(sessionKey: string) {
      slot(releases, sessionKey).publish();
    },
    declaration: { components: declared },
    installation: {
      *install(): Operation<void> {
        yield* installAgentComponents({
          defaultAgent: "stub-agent",
          rootProvider: {
            options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
            factory: function* () {
              activations += 1;
              yield* Agent.around(
                {
                  // deno-lint-ignore require-yield
                  *agent([name]) {
                    return name ?? "stub-agent";
                  },
                  // deno-lint-ignore require-yield
                  *session([routed]) {
                    const name = typeof routed === "string" ? routed : routed?.name;
                    return { sessionKey: `stub:${name ?? "default"}`, cwd: "/stub" };
                  },
                  // deno-lint-ignore require-yield
                  *prompt([_content, promptOptions]) {
                    const session = promptOptions?.session;
                    const key =
                      typeof session === "object" && session !== null && "sessionKey" in session
                        ? String(session.sessionKey)
                        : "stub:default";
                    return {
                      *[Symbol.iterator]() {
                        arrived.push(key);
                        slot(arrivals, key).publish();
                        if (options.gated === true) {
                          yield* awaiting(`${key} being released`, slot(releases, key).published);
                        }
                        // Declared as the events they are, rather than as
                        // literals narrowed at the return: the provider's own
                        // vocabulary is what a turn produces.
                        const turn: AgentPromptEvent[] = [
                          {
                            type: "started",
                            agent: "stub-agent",
                            session: { sessionKey: key, cwd: "/stub" },
                          },
                          { type: "text_delta", text: `[${key}]` },
                          { type: "terminal", status: "completed" },
                        ];
                        let stage = 0;
                        return {
                          // deno-lint-ignore require-yield
                          *next() {
                            const event = turn[stage];
                            if (event === undefined) {
                              return { done: true, value: `[${key}]` };
                            }
                            stage += 1;
                            return { done: false, value: event };
                          },
                        };
                      },
                    };
                  },
                },
                { at: "min" },
              );
            },
          },
        });
      },
    },
  };
}

/** What one Session document produced. */
interface Talked {
  readonly ok: boolean;
  readonly failure: string;
  readonly output: string;
  readonly events: DurableEvent[];
}

function talking(
  source: string,
  held: Conversation,
  options: { stream?: InMemoryStream; drive?: () => Operation<void> } = {},
): Operation<Talked> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    if (options.drive) {
      yield* spawn(options.drive);
    }
    const chunks: string[] = [];
    const result = yield* scoped(function* () {
      const execution = yield* executeInstalled({ ...inlineSource(source), stream }, [
        held.declaration,
        held.installation,
      ]);
      try {
        yield* forEach(function* (chunk: string) {
          chunks.push(chunk);
        }, execution.output);
      } catch {
        // The outcome below says why the stream stopped.
      }
      return yield* execution;
    });
    return {
      ok: result.ok,
      failure: result.ok ? "" : result.error.message,
      output: chunks.join(""),
      events: stream.snapshot(),
    };
  });
}

/** Every appended `agent_prompt`, in journal order, with its coroutine. */
function prompts(events: readonly DurableEvent[]): Array<{ name: string; coroutineId: string }> {
  return events
    .filter((event) => event.type === "yield" && event.description.type === "agent_prompt")
    .map((event) => ({
      name: event.type === "yield" ? event.description.name : "",
      coroutineId: event.coroutineId,
    }));
}

const TWO_SESSIONS = [
  "<All>",
  '<Spawn><Session name="planner"><Prompt text="same" /></Session></Spawn>',
  '<Spawn><Session name="reviewer"><Prompt text="same" /></Session></Spawn>',
  "</All>",
].join("\n");

describe("Tier PA10a — two ordinary Sessions at the same time", () => {
  beforeAll(() => useTempFileCompiler());

  it("PA10a: both conversations are live, and releasing the second first renders in source order", function* () {
    const held = conversations({ gated: true });
    const stream = new InMemoryStream();
    // The journal says when a record lands, so the second release waits on the
    // first append rather than on a clock.
    const recordedOne = signal();
    stream.onAppend = (event) => {
      if (event.type === "yield" && event.description.type === "agent_prompt") {
        recordedOne.publish();
      }
    };
    const result = yield* talking(TWO_SESSIONS, held, {
      stream,
      *drive() {
        // Both ordinary `<Session><Prompt />` paths reach the provider before
        // either is let go, which a sequential engine could never produce.
        yield* held.reached("stub:planner");
        yield* held.reached("stub:reviewer");
        expect([...held.arrived].sort()).toEqual(["stub:planner", "stub:reviewer"]);
        // The second spawn goes first, so its record appends first.
        held.release("stub:reviewer");
        yield* awaiting("the reviewer recording its turn", recordedOne.published);
        held.release("stub:planner");
      },
    });

    expect(result.ok).toBe(true);
    // One declared component, one implementation, one provider installation
    // serving both branches — not a domain per spawn.
    expect(held.sessions()).toBe(1);
    expect(held.activations()).toBe(1);

    const recorded = prompts(result.events);
    expect(recorded).toHaveLength(2);
    // Completion order in the journal: the second spawn's child coroutine
    // appended first, and each record is its own authored invocation.
    expect(recorded.map((entry) => entry.coroutineId)).toEqual(["root.1", "root.0"]);
    expect(new Set(recorded.map((entry) => entry.name)).size).toBe(2);
    // And the document still renders in the order the spawns were written.
    expect(result.output.indexOf("[stub:planner]")).toBeGreaterThanOrEqual(0);
    expect(result.output.indexOf("[stub:planner]")).toBeLessThan(
      result.output.indexOf("[stub:reviewer]"),
    );
  });
});

describe("Tier PA10c — nesting and replay with ordinary Sessions", () => {
  beforeAll(() => useTempFileCompiler());

  it("PA10c: a nested <All> resolves two capability-backed children concurrently", function* () {
    const held = conversations();
    const result = yield* talking(
      [
        "<All>",
        "<Spawn>",
        "<All>",
        '<Spawn><Session name="inner-a"><Prompt text="x" /></Session></Spawn>',
        '<Spawn><Session name="inner-b"><Prompt text="y" /></Session></Spawn>',
        "</All>",
        "</Spawn>",
        '<Spawn><Session name="outer"><Prompt text="z" /></Session></Spawn>',
        "</All>",
      ].join("\n"),
      held,
    );

    expect(result.ok).toBe(true);
    expect(held.sessions()).toBe(1);
    const recorded = prompts(result.events);
    expect(recorded).toHaveLength(3);
    // Hierarchical child identity, source-ordered: a branch inside a branch
    // owns its own frames as much as a top-level one does.
    expect(new Set(recorded.map((entry) => entry.coroutineId))).toEqual(
      new Set(["root.0.0", "root.0.1", "root.1"]),
    );
    expect(new Set(recorded.map((entry) => entry.name)).size).toBe(3);
  });

  it("PA10c: a full replay calls no provider, and a partial one reaches only the unrecorded child", function* () {
    const golden = conversations({ gated: true });
    const stream = new InMemoryStream();
    // The first child is released and allowed to close before the second does
    // anything, so the truncation below has exactly one complete child and one
    // that has not started its work.
    const closedFirst = signal();
    stream.onAppend = (event) => {
      if (event.type === "close" && event.coroutineId === "root.0") {
        closedFirst.publish();
      }
    };
    const first = yield* talking(TWO_SESSIONS, golden, {
      stream,
      *drive() {
        yield* golden.reached("stub:planner");
        yield* golden.reached("stub:reviewer");
        golden.release("stub:planner");
        yield* awaiting("the first child closing", closedFirst.published);
        golden.release("stub:reviewer");
      },
    });
    expect(first.ok).toBe(true);
    expect(golden.arrived).toHaveLength(2);

    // Nothing spawned runs again: both children closed, so replay reads their
    // recorded results.
    const replayed = conversations();
    const whole = yield* talking(TWO_SESSIONS, replayed, {
      stream: new InMemoryStream(first.events),
    });
    expect(whole.ok).toBe(true);
    expect(replayed.arrived).toEqual([]);
    expect(whole.output).toBe(first.output);

    // Cut after the first child closed. The completed child is restored and
    // only the other one reaches a provider, under the same child identity.
    const closedAt = first.events.findIndex(
      (event) => event.type === "close" && event.coroutineId === "root.0",
    );
    expect(closedAt).toBeGreaterThan(0);
    const cut = first.events.slice(0, closedAt + 1);
    // Exactly one complete child, and nothing recorded for the other.
    expect(cut.some((event) => event.type === "close" && event.coroutineId === "root.1")).toBe(
      false,
    );
    expect(prompts(cut).map((entry) => entry.coroutineId)).toEqual(["root.0"]);

    const resumed = conversations();
    const partial = yield* talking(TWO_SESSIONS, resumed, { stream: new InMemoryStream(cut) });
    expect(partial.ok).toBe(true);
    // Only the child with no close reached a provider, and it is the other one.
    expect(resumed.arrived).toEqual(["stub:reviewer"]);
    expect(partial.output).toBe(first.output);
    expect(prompts(partial.events).map((entry) => entry.coroutineId)).toEqual(["root.0", "root.1"]);
  });
});
