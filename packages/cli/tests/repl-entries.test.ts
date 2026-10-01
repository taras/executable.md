/**
 * Where one entry's history stops, and what the next one inherits (#827).
 *
 * Every journal here is written by really executing entries over one physical
 * stream, each through its own segment view, because the whole claim is that the
 * boundary is already in the records the current runtime writes. A frozen event
 * array would keep passing on the day core changed the shape of a root
 * admission or a close — which is the day the claim stopped being true.
 *
 * The rows are named for the frozen evidence matrix: ES1 the exact segments, ES2
 * the malformed prefixes that refuse whole, EM1 the stable keys and markers, EP1
 * the projection and its inheritance, and BC1 what a one-entry history still
 * does. EB1 — the trusted-host input itself — lives in core's own binding suite,
 * beside the rules it behaves like.
 *
 * Two facts are doctored rather than performed, and both say so where they are
 * used: a cancelled root close, because cancelling a live run is the lifecycle
 * boundary a later slice owns, and the malformed prefixes, which by definition
 * no run produces.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { collect, inlineSource, useTempFileCompiler } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import {
  createScope,
  ensure,
  race,
  scoped,
  sleep,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result } from "effection";

import { EntrySegmentStream, partitionEntrySegments, ROOT_IMPORT } from "../src/repl/entries.ts";
import type { EntrySegment } from "../src/repl/entries.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import type { ReplExecution } from "../src/repl/journal.ts";
import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import {
  admitted,
  describeApplication,
  initialState,
  NO_AGENT,
  reduceRepl,
  replSurface,
  viewFor,
  withoutAbsentEntry,
} from "../src/repl/application.ts";
import type { ReplAction, ReplLive, ReplState, ReplView } from "../src/repl/application.ts";
import { layout, NARROW } from "../src/repl/layout.ts";
import type { ReplPlacedCell, ReplSemanticFrame } from "../src/repl/layout.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { fields, readDescription } from "../src/repl/description.ts";
import type { ReplDescription } from "../src/repl/description.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import type { ReplTree } from "../src/repl/reconcile.ts";

/** One entry that publishes two root values and renders one of them. */
const FIRST = [
  "```js eval",
  'const token = "alpha";',
  'const kept = "first";',
  "```",
  "",
  "One: {token}",
  "",
].join("\n");

/**
 * One entry that publishes a root value and then fails.
 *
 * Two blocks, so the journal holds one durable publication *before* the
 * failure: `token` is retained, and `lost` is a name the failing block never
 * got to publish.
 */
const FAILING = [
  "```js eval",
  'const token = "beta";',
  "```",
  "",
  "```js eval",
  "const lost = undeclaredInEntryTwo;",
  "```",
  "",
  "Two: {token}",
  "",
].join("\n");

/** One entry that reads what earlier entries published, and renders it. */
const INHERITING = [
  "```js eval",
  "const seen = `${token}/${kept}`;",
  "```",
  "",
  "Three: {seen}",
  "",
].join("\n");

/** One entry that publishes a nested value a later entry will edit. */
const PUBLISHES_NESTED = [
  "```js eval",
  'const plan = { steps: ["draft"], counts: { runs: 1 } };',
  "```",
  "",
  "One: {plan.steps[0]}",
  "",
].join("\n");

/** One entry that edits the nested value it inherited, and reports the result. */
const EDITS_INHERITED = [
  "```js eval",
  'plan.steps.push("build");',
  "plan.counts.runs += 1;",
  'const seen = `${plan.steps.join("/")}/${plan.counts.runs}`;',
  "```",
  "",
  "Two: {seen}",
  "",
].join("\n");

/**
 * One entry that durably publishes a root value named `props`.
 *
 * Ordinary authoring: a block declares the name, so the run retains it like any
 * other export. What it must not become is something a later entry inherits.
 */
const PUBLISHES_PROPS = [
  "```js eval",
  'const props = "retained";',
  'const token = "gamma";',
  "```",
  "",
  "Named it.",
  "",
].join("\n");

/** One entry that inherits a value and reports what its own `props` is. */
const INHERITING_PROPS = [
  "```js eval",
  "const seen = `${token}/${typeof props}`;",
  "```",
  "",
  "Two: {seen}",
  "",
].join("\n");

/** What running one entry over its own segment view produced. */
interface EntryRun {
  readonly view: EntrySegmentStream;
  readonly output: string;
  readonly failure: Error | undefined;
}

/**
 * Run one entry at the end of `physical`, through a view of its own segment.
 *
 * A new entry's view starts empty and final, which is what makes the execution
 * replay nothing and append at the physical end. Failures are captured rather
 * than raised: how far an entry got is most of what these rows are about.
 */
function* runEntry(
  physical: DurableStream,
  source: string,
  initialBindings: Readonly<Record<string, Json>> = {},
): Operation<EntryRun> {
  const view = new EntrySegmentStream(physical);
  try {
    const execution = yield* executeInstalled({ ...inlineSource(source), stream: view }, [], {
      initialBindings,
    });
    return { view, output: String(yield* collect(execution)), failure: undefined };
  } catch (error) {
    return {
      view,
      output: "",
      failure: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Three real entries over one physical stream: one succeeds, one fails, one
 * inherits.
 *
 * The third is given the record the projection derives from the first two, which
 * is the same record a cold command would derive from the same bytes — so what
 * it reads is a fact about the journal rather than about this process.
 */
function* threeEntries(): Operation<{
  readonly physical: InMemoryStream;
  readonly events: DurableEvent[];
  readonly runs: readonly EntryRun[];
}> {
  const physical = new InMemoryStream();
  const first = yield* runEntry(physical, FIRST);
  const second = yield* runEntry(physical, FAILING, inherited(yield* physical.readAll()));
  const third = yield* runEntry(physical, INHERITING, inherited(yield* physical.readAll()));
  return { physical, events: yield* physical.readAll(), runs: [first, second, third] };
}

/** Two real entries over one physical stream, both succeeding. */
function* twoEntries(): Operation<{
  readonly physical: InMemoryStream;
  readonly events: DurableEvent[];
}> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, FIRST);
  yield* runEntry(physical, INHERITING, inherited(yield* physical.readAll()));
  return { physical, events: yield* physical.readAll() };
}

/** What a next entry inherits from this prefix, through the public projection. */
function inherited(events: readonly DurableEvent[]): Readonly<Record<string, Json>> {
  return entryInitialBindings(projected(events));
}

/** The projected model, or a failure the test reports instead of asserting past. */
function projected(events: readonly DurableEvent[], selection?: string): ReplModel {
  const result = projectRepl(events, selection);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * The refusal a malformed prefix produced, with no model of any kind beside it.
 *
 * The absence is asserted here rather than in each row: "refuses the whole
 * projection" means there is no value to read at all, not a value holding the
 * entries that happened to parse.
 */
function refusal(events: readonly DurableEvent[], selection?: string): string {
  const result: Result<ReplModel> = projectRepl(events, selection);
  if (result.ok) {
    throw new Error("the projection accepted a prefix it must refuse");
  }
  expect(Object.hasOwn(result, "value")).toBe(false);
  return result.error.message;
}

/** The segments one prefix holds, or a failure naming why it holds none. */
function partitioned(events: readonly DurableEvent[]): readonly EntrySegment[] {
  const result = partitionEntrySegments(events);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Every event's marker inside one range, derived independently of the
 * projection.
 *
 * Spelled the way a one-entry history has always spelled it, which is what makes
 * it a control: the first entry's markers must still come out of the projection
 * exactly like this.
 */
function localMarkers(events: readonly DurableEvent[]): string[] {
  const ordinals = new Map<string, number>();
  return events.map((event) => {
    if (event.type === "close") {
      return `close:${event.coroutineId}`;
    }
    const ordinal = ordinals.get(event.coroutineId) ?? 0;
    ordinals.set(event.coroutineId, ordinal + 1);
    return `yield:${event.coroutineId}:${ordinal}`;
  });
}

/** One root close, as the protocol writes a cancelled one. */
function cancelled(coroutineId: string): DurableEvent {
  return { type: "close", coroutineId, result: { status: "cancelled" } };
}

/** The same journal with the close of one entry replaced. */
function withClose(
  events: readonly DurableEvent[],
  segment: EntrySegment,
  close: DurableEvent,
): DurableEvent[] {
  return events.map((event, index) => (index === segment.end - 1 ? close : event));
}

/** The one binding this entry holds under `name`, or a failure saying so. */
function value(bindings: readonly { name: string; value: Json }[], name: string): Json {
  const found = bindings.find((binding) => binding.name === name);
  if (found === undefined) {
    throw new Error(`these bindings hold ${bindings.map((one) => one.name).join(", ")}`);
  }
  return found.value;
}

describe("REPL entries: the segments one physical journal holds", () => {
  beforeAll(() => useTempFileCompiler());

  it("ES1: partitions two and three segments in admission order", function* () {
    const two = yield* twoEntries();
    const pair = partitioned(two.events);
    expect(pair.map((segment) => segment.key)).toEqual(["entry-1", "entry-2"]);
    expect(pair.map((segment) => segment.order)).toEqual([1, 2]);
    expect(pair.every((segment) => segment.settled)).toBe(true);

    const three = yield* threeEntries();
    const all = partitioned(three.events);
    expect(all.map((segment) => segment.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
    // The ranges tile the file: no event belongs to two entries and none to none.
    expect(all[0].start).toBe(0);
    expect(all.map((segment) => segment.start)).toEqual([0, all[0].end, all[1].end]);
    expect(all[all.length - 1].end).toBe(three.events.length);
    // Each range begins with its own root admission on the root coroutine, and
    // the record that began it is the one the segment carries.
    for (const segment of all) {
      expect(segment.admission).toBe(segment.events[0]);
      expect(segment.admission.coroutineId).toBe("root");
      expect(segment.admission.description.name).toBe("__root__");
    }
  });

  it("ES1: each segment view reads only its own events", function* () {
    const { events, runs } = yield* threeEntries();
    const all = partitioned(events);

    for (let order = 0; order < all.length; order++) {
      const read = yield* runs[order].view.readAll();
      expect(read).toEqual([...all[order].events]);
    }
    // What the three views read, concatenated, is the whole file and nothing more
    // — so no view was shown another entry's work.
    const seen: DurableEvent[] = [];
    for (const run of runs) {
      seen.push(...(yield* run.view.readAll()));
    }
    expect(seen).toEqual(events);
  });

  it("ES1: a successful append becomes locally visible only after acknowledgement", function* () {
    const { events } = yield* twoEntries();
    const [first] = partitioned(events);

    const held: DurableEvent[] = [];
    /** What the view already held at the moment of each physical append. */
    const during: number[] = [];
    const views: EntrySegmentStream[] = [];
    const physical: DurableStream = {
      // deno-lint-ignore require-yield
      *readAll() {
        return [...held];
      },
      *append(event: DurableEvent) {
        const view = views[0];
        during.push(view === undefined ? -1 : (yield* view.readAll()).length);
        held.push(event);
      },
    };
    views.push(new EntrySegmentStream(physical));

    yield* views[0].append(first.events[0]);
    expect((yield* views[0].readAll()).length).toBe(1);
    yield* views[0].append(first.events[1]);
    expect((yield* views[0].readAll()).length).toBe(2);

    // Nothing was visible locally until the physical stream had taken it.
    expect(during).toEqual([0, 1]);
    expect(held.length).toBe(2);
  });

  it("ES1: a failed physical append does not advance local state", function* () {
    const { events } = yield* twoEntries();
    const [first] = partitioned(events);

    const physical = new InMemoryStream();
    const view = new EntrySegmentStream(physical);
    physical.injectFailure = new Error("the file could not be written");

    let raised: Error | undefined;
    try {
      yield* view.append(first.events[0]);
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }

    expect(raised?.message).toContain("could not be written");
    expect(yield* view.readAll()).toEqual([]);
    expect(yield* physical.readAll()).toEqual([]);
    expect(view.settled).toBe(false);
  });

  it("ES1: a settled or non-final segment refuses every append", function* () {
    const { events } = yield* twoEntries();
    const [first, second] = partitioned(events);
    const physical = new InMemoryStream(events);

    // Settled, because its own range holds its terminal close.
    const closed = new EntrySegmentStream(physical, { retained: second.events, final: true });
    expect(closed.settled).toBe(true);
    expect(yield* refusedAppend(closed, first.events[1])).toContain("already settled");

    // Not final, because another entry already follows it in the file.
    const earlier = new EntrySegmentStream(physical, { retained: first.events, final: false });
    expect(yield* refusedAppend(earlier, first.events[1])).toContain("not the last one");

    // And an open final segment closes itself on its own terminal close, so the
    // append after it is refused for the first reason rather than accepted.
    const live = new EntrySegmentStream(physical, {
      retained: first.events.slice(0, -1),
      final: true,
    });
    expect(live.settled).toBe(false);
    yield* live.append(first.events[first.events.length - 1]);
    expect(live.settled).toBe(true);
    expect(yield* refusedAppend(live, first.events[1])).toContain("already settled");
    // Nothing a refused append attempted reached the file.
    expect((yield* physical.readAll()).length).toBe(events.length + 1);
  });
});

/** The refusal one append produced, or a failure naming that it was accepted. */
function* refusedAppend(view: EntrySegmentStream, event: DurableEvent): Operation<string> {
  try {
    yield* view.append(event);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the segment accepted an append it must refuse");
}

describe("REPL entries: the prefixes it refuses whole", () => {
  beforeAll(() => useTempFileCompiler());

  it("ES2: every malformed boundary refuses with no partial entries", function* () {
    const { events } = yield* twoEntries();
    const [first, second] = partitioned(events);
    const admission = first.events[0];
    const close = events[first.end - 1];

    // Each row is one of the frozen malformed forms, built out of the real
    // journal so the only thing wrong with it is its boundary.
    const nested: DurableEvent = { ...admission, coroutineId: "root.0" };
    const forms: readonly { readonly what: string; readonly prefix: DurableEvent[] }[] = [
      { what: "work before the first admission", prefix: events.slice(1) },
      { what: "a nested root admission", prefix: [admission, nested, ...first.events.slice(1)] },
      { what: "a repeated root admission", prefix: [admission, ...events] },
      { what: "a second unfinished segment", prefix: [...first.events.slice(0, -1), admission] },
      { what: "a root close with no open segment", prefix: [...events, close] },
      {
        what: "work between one outcome and the next admission",
        prefix: [...first.events, first.events[1], ...second.events],
      },
    ];

    for (const form of forms) {
      expect(refusal(form.prefix)).not.toBe("");
    }

    // The exact sentences, because each names damage a reader has to tell apart.
    expect(refusal(forms[0].prefix)).toContain("before it admitted its entry");
    expect(refusal(forms[1].prefix)).toContain("from inside work another entry had already");
    expect(refusal(forms[2].prefix)).toContain("a second entry before the first one settled");
    expect(refusal(forms[3].prefix)).toContain("a second entry before the first one settled");
    expect(refusal(forms[4].prefix)).toContain("records an entry settling that it never admitted");
    expect(refusal(forms[5].prefix)).toContain("after the entry settled");
  });

  it("ES2: a segment the one-entry reader cannot read refuses the whole prefix", function* () {
    const { events } = yield* twoEntries();
    const [, second] = partitioned(events);

    expect(refusal(unreadableAt(events, second.start))).toContain(
      "entry's recorded source cannot be read",
    );
  });

  it("ES2: an earlier selection does not escape a later entry nothing can read", function* () {
    const { events } = yield* twoEntries();
    const [first, second] = partitioned(events);
    const doctored = unreadableAt(events, second.start);

    // The whole file is still partitioned into two ranges, and the first range is
    // byte-identical to the one that projects perfectly on its own.
    expect(partitioned(doctored).map((segment) => segment.key)).toEqual(["entry-1", "entry-2"]);
    expect(projected(first.events).entries).toHaveLength(1);

    // So a selection naming the first entry's close is a position a reader could
    // plausibly be standing at — and it must still refuse, because the file
    // behind that position is one this version cannot read. Being shown a whole
    // catalog here and told the truth only on returning to the head is the
    // failure this row exists for.
    expect(refusal(doctored, "close:root")).toContain("entry's recorded source cannot be read");
    // Every position inside the readable first entry refuses the same way.
    for (const marker of localMarkers(first.events)) {
      expect(refusal(doctored, marker)).toContain("entry's recorded source cannot be read");
    }
  });
});

/**
 * The same journal with the record at `at` retaining something unreadable.
 *
 * Built by replacing one event's result with a value of the wrong shape, which
 * is the only thing wrong with the prefix: the entry before it is untouched, and
 * that is the point — a readable entry beside an unreadable one must not be
 * published on its own.
 */
/**
 * The same journal with its one evaluation's published values renamed.
 *
 * Every member moves under `name`, so the record stays the shape the projector
 * reads and the only thing wrong with it is what the value is called.
 */
function renamedExport(events: readonly DurableEvent[], name: string): DurableEvent[] {
  return events.map((event) => {
    if (event.type !== "yield" || event.description.type !== "eval") {
      return event;
    }
    if (event.result.status !== "ok" || !isRecord(event.result.value)) {
      throw new Error("the reference journal records one successful evaluation");
    }
    const held = event.result.value;
    const published = held["value"];
    if (!isRecord(published)) {
      throw new Error("a recorded evaluation publishes a record of its values");
    }
    const moved: { [key: string]: Json } = {};
    for (const member of Object.values(published)) {
      moved[name] = member;
    }
    const doctored: DurableEvent = {
      ...event,
      result: { status: "ok", value: { ...held, value: moved } },
    };
    return doctored;
  });
}

function isRecord(member: Json | undefined): member is { [key: string]: Json } {
  return (
    member !== null && member !== undefined && typeof member === "object" && !Array.isArray(member)
  );
}

function unreadableAt(events: readonly DurableEvent[], at: number): DurableEvent[] {
  return events.map((event, index) => {
    if (index !== at || event.type !== "yield") {
      return event;
    }
    const doctored: DurableEvent = {
      ...event,
      result: { status: "ok", value: "not a selection" },
    };
    return doctored;
  });
}

describe("REPL entries: the keys and markers it assigns", () => {
  beforeAll(() => useTempFileCompiler());

  it("EM1: keys follow admission order whatever each entry settled to", function* () {
    const { events } = yield* threeEntries();
    const model = projected(events);

    expect(model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(model.entries.map((entry) => entry.order)).toEqual([1, 2, 3]);
    // The middle one failed and the last one succeeded. Completion did not
    // rename or reorder anything.
    expect(model.entries.map((entry) => entry.terminal?.status)).toEqual(["ok", "err", "ok"]);
    expect(model.entries.map((entry) => entry.scope.key)).toEqual([
      "entry-1",
      "entry-2",
      "entry-3",
    ]);
  });

  it("EM1: the first entry keeps every marker spelling a one-entry history had", function* () {
    const { events } = yield* twoEntries();
    const [first, second] = partitioned(events);
    const model = projected(events);

    // Computed independently of the projection, in the spelling that is already
    // in people's locations.
    const raw = localMarkers(first.events);
    expect(model.entries[0].scope.marker).toBe(raw[0]);
    // Nothing the first entry retains names a position outside the raw spellings.
    expect(
      model.entries[0].checkpoints.filter((checkpoint) => !raw.includes(checkpoint.marker)),
    ).toEqual([]);
    expect(model.entries[0].transcript.filter((row) => !raw.includes(row.marker))).toEqual([]);
    expect(model.entries[0].terminal).toBeDefined();
    expect(
      model.entries[0].transcript.filter((row) => row.kind === "terminal").map((row) => row.marker),
    ).toEqual(["close:root"]);

    // And the second entry's own spellings carry its key, over the same
    // segment-local ordinals its execution replayed against.
    const inner = localMarkers(second.events);
    expect(inner[0]).toBe("yield:root:0");
    expect(inner[inner.length - 1]).toBe("close:root");
    expect(model.entries[1].scope.marker).toBe("entry-2:yield:root:0");
    expect(
      model.entries[1].transcript.filter((row) => row.kind === "terminal").map((row) => row.marker),
    ).toEqual(["entry-2:close:root"]);
    expect(model.entries[1].transcript.every((row) => row.marker.startsWith("entry-2:"))).toBe(
      true,
    );
  });

  it("EM1: a raw close:root cannot select the second entry's close", function* () {
    const { events } = yield* twoEntries();
    const model = projected(events);

    // The raw spelling is the first entry's close, and selecting it stops there.
    const atFirst = projected(events, "close:root");
    expect(atFirst.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
    expect(atFirst.head).toBe(false);
    expect(atFirst.terminal?.status).toBe("ok");

    // Only the namespaced spelling reaches the second entry's close.
    const atSecond = projected(events, "entry-2:close:root");
    expect(atSecond.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
    expect(atSecond.head).toBe(true);
    expect(atSecond.transcript).toEqual(model.transcript);
  });
});

describe("REPL entries: what each entry owns and what the next one inherits", () => {
  beforeAll(() => useTempFileCompiler());

  it("EP1: two successful entries own their own scopes, transcripts and outcomes", function* () {
    const { events } = yield* twoEntries();
    const model = projected(events);
    const [one, two] = model.entries;

    expect(one.source).toBe(FIRST);
    expect(two.source).toBe(INHERITING);
    expect(one.scope.source).toBe(FIRST);
    expect(one.terminal?.output).toContain("One: alpha");
    expect(two.terminal?.output).toContain("Three: alpha/first");
    // Neither transcript holds the other's rows, and together they are the
    // model's one chronology.
    expect(one.transcript.some((row) => row.marker.startsWith("entry-2:"))).toBe(false);
    expect(two.transcript.every((row) => row.marker.startsWith("entry-2:"))).toBe(true);
    expect([...one.transcript, ...two.transcript]).toEqual([...model.transcript]);
    expect(model.settled).toBe(true);
    expect(model.terminal).toBe(two.terminal);
  });

  it("EP1: the last durably published value wins, and an unpublished one never appears", function* () {
    const { events, runs } = yield* threeEntries();
    const model = projected(events);
    const [one, two, three] = model.entries;

    // The failing entry really failed, after really publishing.
    expect(runs[1].failure?.message).toContain("undeclaredInEntryTwo");
    expect(two.terminal?.status).toBe("err");

    expect(value(one.bindings, "token")).toBe("alpha");
    expect(value(one.bindings, "kept")).toBe("first");
    // Published before the failure, so it survives it.
    expect(value(two.bindings, "token")).toBe("beta");
    // Inherited across the failure untouched.
    expect(value(two.bindings, "kept")).toBe("first");
    // The failing block never published, so no entry holds the name at all.
    expect(two.bindings.map((binding) => binding.name)).not.toContain("lost");
    expect(three.bindings.map((binding) => binding.name)).not.toContain("lost");

    // And the third entry read exactly that, through the record the projection
    // derives — the last value wins.
    expect(three.terminal?.output).toContain("Three: beta/first");
    expect(entryInitialBindings(model)).toEqual({
      token: "beta",
      kept: "first",
      seen: "beta/first",
    });
  });

  it("EP1: a second entry edits its inherited value, and the first entry's does not move", function* () {
    const physical = new InMemoryStream();
    const first = yield* runEntry(physical, PUBLISHES_NESTED);
    expect(first.failure).toBe(undefined);

    // The projection of Entry 1, and the record a next entry starts from, both
    // captured before Entry 2 exists.
    const before = projected(yield* physical.readAll());
    const supplied = entryInitialBindings(before);
    expect(supplied).toEqual({ plan: { steps: ["draft"], counts: { runs: 1 } } });
    const published = value(before.entries[0].bindings, "plan");

    // Entry 2 is handed that record and edits what it inherited: pushing to an
    // inherited array is what any block does to any binding, and a durable eval
    // value it could not write to would not be an ordinary binding.
    const second = yield* runEntry(physical, EDITS_INHERITED, supplied);

    expect(second.failure).toBe(undefined);
    expect(second.output).toContain("Two: draft/build/2");

    // What Entry 2 edited was its own detached graph. Entry 1's projected value
    // is what it always was — in the model captured before, in the record that
    // was handed over, and in a fresh reading of the file now that two entries
    // are in it.
    expect(published).toEqual({ steps: ["draft"], counts: { runs: 1 } });
    expect(supplied).toEqual({ plan: { steps: ["draft"], counts: { runs: 1 } } });

    const after = projected(yield* physical.readAll());
    expect(after.entries).toHaveLength(2);
    expect(value(after.entries[0].bindings, "plan")).toEqual({
      steps: ["draft"],
      counts: { runs: 1 },
    });
    // A mutation is not a publication, and this is where that matters. Entry 2
    // declared `seen`, not `plan`, so the Journal records `seen` and Entry 2's
    // effective `plan` is still the value it inherited. What a later entry or a
    // cold reopen sees is what the file holds, never what a process did to its
    // own copy of it.
    expect(value(after.entries[1].bindings, "plan")).toEqual({
      steps: ["draft"],
      counts: { runs: 1 },
    });
    expect(value(after.entries[1].bindings, "seen")).toBe("draft/build/2");
  });

  it("EP1: a retained `props` is the entry's own and reaches no successor", function* () {
    const physical = new InMemoryStream();
    const run = yield* runEntry(physical, PUBLISHES_PROPS);
    const events = yield* physical.readAll();
    const model = projected(events);
    const [only] = model.entries;

    // It really was published: the run succeeded and the record holds the name.
    expect(run.failure).toBe(undefined);
    expect(only.scope.bindings.map((binding) => binding.name)).toContain("props");
    expect(value(only.scope.bindings, "props")).toBe("retained");

    // And it is absent from the effective bindings and from the record a next
    // entry would start from — rather than listed there and then silently
    // dropped by the execution that already owns its own props namespace.
    expect(only.bindings.map((binding) => binding.name)).toEqual(["token"]);
    expect(entryInitialBindings(model)).toEqual({ token: "gamma" });

    // A second entry therefore starts, and sees its own props rather than the
    // string the first entry published under that name.
    const second = yield* runEntry(physical, INHERITING_PROPS, entryInitialBindings(model));
    expect(second.failure).toBe(undefined);
    expect(second.output).toContain("Two: gamma/object");
  });

  it("EP1: a retained export name no binding can have refuses projection", function* () {
    const physical = new InMemoryStream();
    yield* runEntry(physical, FIRST);
    const events = yield* physical.readAll();

    // The real journal's one eval record, republishing its values under a name
    // no eval block could have bound. Projection has to stop here: carried
    // through, the name reaches a later entry's generated preamble and fails
    // there as a syntax error about a document that never wrote it.
    for (const name of ["not-a-binding", "1st", "with space", "class"]) {
      expect(refusal(renamedExport(events, name))).toContain("no binding can have");
    }

    // `__output` is not a binding name and keeps its own meaning, so the
    // untouched journal still reads.
    expect(projected(events).entries).toHaveLength(1);
  });

  it("EP1: a failed and a cancelled entry each permit a successor", function* () {
    const { events } = yield* threeEntries();
    const [, second] = partitioned(events);

    // A failure already permitted the third entry above. Cancellation is the
    // same boundary with a different outcome, so the second entry's close is
    // replaced by the cancelled close the protocol writes — cancelling a live
    // run is the lifecycle boundary a later slice owns.
    const interrupted = projected(withClose(events, second, cancelled("root")));
    const [one, two, three] = interrupted.entries;

    expect(interrupted.entries.map((entry) => entry.key)).toEqual([
      "entry-1",
      "entry-2",
      "entry-3",
    ]);
    expect(two.terminal?.status).toBe("cancelled");
    expect(two.settled).toBe(true);
    // Values published before the interruption survive it, and the entry after
    // it still inherits them.
    expect(value(one.bindings, "token")).toBe("alpha");
    expect(value(two.bindings, "token")).toBe("beta");
    expect(value(three.bindings, "token")).toBe("beta");
  });

  it("EP1: an unfinished entry followed by another admission refuses atomically", function* () {
    const physical = new InMemoryStream();
    yield* runEntry(physical, FIRST);
    const events = yield* physical.readAll();
    const [first] = partitioned(events);

    // The unfinished entry alone is a readable prefix with no outcome yet.
    const unfinished = projected(first.events.slice(0, -1));
    expect(unfinished.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
    expect(unfinished.settled).toBe(false);
    expect(unfinished.terminal).toBe(undefined);

    // Admitting another entry on top of it refuses the whole prefix.
    expect(refusal([...first.events.slice(0, -1), first.events[0]])).toContain(
      "a second entry before the first one settled",
    );
  });
});

describe("REPL entries: what a one-entry history still does", () => {
  beforeAll(() => useTempFileCompiler());

  it("BC1: a successful one-entry journal projects entry-1 with its own spellings", function* () {
    const physical = new InMemoryStream();
    const run = yield* runEntry(physical, FIRST);
    const events = yield* physical.readAll();
    const model = projected(events);
    const raw = localMarkers(events);

    expect(model.entries).toHaveLength(1);
    const [only] = model.entries;
    expect(only.key).toBe("entry-1");
    expect(only.order).toBe(1);
    expect(only.scope.key).toBe("entry-1");
    expect(only.scope.kind).toBe("entry");
    // Every marker is the spelling a one-entry history has always had: no key
    // prefix anywhere in the model.
    expect(model.transcript.filter((row) => !raw.includes(row.marker))).toEqual([]);
    expect(model.checkpoints.filter((checkpoint) => !raw.includes(checkpoint.marker))).toEqual([]);
    expect(model.checkpoints.some((checkpoint) => checkpoint.marker.includes("entry-"))).toBe(
      false,
    );
    expect(model.checkpoints[0].label).toBe("Entry 1 admitted");
    expect(model.settled).toBe(true);
    expect(model.terminal?.status).toBe("ok");
    expect(model.terminal?.output).toBe(run.output);
    // The whole-model readings and the one entry's readings are the same values.
    expect(model.transcript).toEqual(only.transcript);
    expect(model.checkpoints).toEqual(only.checkpoints);
    expect(model.terminal).toBe(only.terminal);
  });

  it("BC1: a one-entry failure and a one-entry cancellation keep their outcomes", function* () {
    const physical = new InMemoryStream();
    const run = yield* runEntry(physical, FAILING);
    const events = yield* physical.readAll();
    const failed = projected(events);

    expect(run.failure).toBeDefined();
    expect(failed.entries).toHaveLength(1);
    expect(failed.entries[0].key).toBe("entry-1");
    expect(failed.terminal?.status).toBe("err");
    expect(failed.settled).toBe(true);
    // Published before it failed, and still the entry's value.
    expect(value(failed.entries[0].bindings, "token")).toBe("beta");

    const [segment] = partitioned(events);
    const interrupted = projected(withClose(events, segment, cancelled("root")));
    expect(interrupted.entries[0].key).toBe("entry-1");
    expect(interrupted.terminal?.status).toBe("cancelled");
    expect(interrupted.terminal?.output).toBe("");
  });

  it("BC1: a one-entry historical prefix keeps its marker and its head reading", function* () {
    const physical = new InMemoryStream();
    yield* runEntry(physical, FIRST);
    const events = yield* physical.readAll();
    const raw = localMarkers(events);

    const historical = projected(events, raw[1]);
    expect(historical.selection).toBe(raw[1]);
    expect(historical.head).toBe(false);
    expect(historical.settled).toBe(false);
    expect(historical.entries).toHaveLength(1);
    expect(historical.transcript.map((row) => row.marker)).toEqual(raw.slice(0, 2));

    // Selecting the whole file is the head again, with nothing shortened.
    const head = projected(events, raw[raw.length - 1]);
    expect(head.head).toBe(true);
    expect(head.transcript).toEqual(projected(events).transcript);
  });

  it("BC1: an empty journal and the refusals a one-entry history had are unchanged", function* () {
    const empty = projected([]);
    expect(empty.entries).toEqual([]);
    expect(empty.settled).toBe(false);
    expect(empty.terminal).toBe(undefined);
    expect(empty.head).toBe(true);

    const physical = new InMemoryStream();
    yield* runEntry(physical, FIRST);
    const events = yield* physical.readAll();

    expect(refusal(events, "yield:root:99")).toContain("not in this journal");
    expect(refusal(events, "")).toContain("not in this journal");
    expect(refusal(events.slice(1))).toContain("before it admitted its entry");
    expect(refusal([...events, events[events.length - 1]])).toContain(
      "records an entry settling that it never admitted",
    );
  });
});

/**
 * One entry that publishes a value and then waits on a question.
 *
 * The hold every row that needs a *running* entry uses: a question is the one
 * place an ordinary document stops and waits for somebody, and the row answering
 * it is what releases the entry. Nothing here waits on the scheduler.
 */
const ASKS = [
  "```js eval",
  'const token = "held";',
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
  "One: {answer.decision}",
  "",
].join("\n");

/** One entry that publishes nothing and asks nothing. */
const PLAIN = "Plain.\n";

/**
 * How long a wait a correct session opens immediately may go unopened before it
 * is called a deadlock.
 *
 * Never reached by a passing run: every wait below is opened by the session, the
 * document or the execution's own teardown. It bounds the failure mode only, so a
 * defect that stops opening one says which it stopped opening instead of hanging.
 */
const DEADLOCK_MS = 10_000;

/** One gate a row opens itself, so no row depends on scheduler timing. */
interface Gate {
  open(): void;
  readonly opened: Operation<void>;
}

function gate(): Gate {
  const resolvers = withResolvers<void>();
  let settled = false;
  return {
    open(): void {
      if (!settled) {
        settled = true;
        resolvers.resolve();
      }
    },
    get opened(): Operation<void> {
      return resolvers.operation;
    },
  };
}

function* awaiting(what: string, held: Operation<void>): Operation<void> {
  const reached = yield* race([
    (function* (): Operation<boolean> {
      yield* held;
      return true;
    })(),
    (function* (): Operation<boolean> {
      yield* sleep(DEADLOCK_MS);
      return false;
    })(),
  ]);
  if (!reached) {
    throw new Error(`${what} never happened`);
  }
}

/**
 * An installation whose own teardown waits.
 *
 * Its `ensure` is registered inside the execution, so it holds *that
 * execution's* teardown: by the time it is entered the root close is already in
 * the file and the task that wrote it has not finished coming down. That is the
 * one state where "this entry settled" and "this entry's task has been joined"
 * disagree, and the only honest way to stand in it is to hold it open.
 *
 * Every row that installs it releases in a `finally`, because a held finalizer is
 * the session's teardown correctly refusing to finish — which cannot be told
 * from a hang by waiting longer.
 */
function holdingTeardown(entered: Gate, release: Gate): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* ensure(function* () {
        entered.open();
        yield* release.opened;
      });
    },
  };
}

function replExecution(events: readonly DurableEvent[] = []): ReplExecution {
  return { id: "entries", stream: new InMemoryStream([...events]) };
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function refusedSession(result: Result<ReplSession>): Error {
  if (result.ok) {
    throw new Error("this session was handed back, and it must be refused");
  }
  return result.error;
}

function refusedSubmission(result: Result<void>): Error {
  if (result.ok) {
    throw new Error("this submission started an entry, and it must be refused");
  }
  return result.error;
}

function accepted(result: Result<void>): void {
  if (!result.ok) {
    throw result.error;
  }
}

/**
 * How many entry tasks this journal records having been started.
 *
 * One root admission is one task: an execution writes that record before it does
 * anything else, so a second task over one execution leaves a second one behind
 * whatever else it managed to do.
 */
function started(events: readonly DurableEvent[]): number {
  return events.filter(
    (event) =>
      event.type === "yield" &&
      event.description.type === "import_component" &&
      event.description.name === ROOT_IMPORT,
  ).length;
}

/** The question this session is asking, once it is asking one. */
function* asking(session: ReplSession): Operation<ReplQuestion> {
  const changes = yield* session.elicitation.changes;
  const pending = session.overlay.question;
  if (pending !== undefined) {
    return pending;
  }
  yield* awaiting(
    "the entry reaching its question",
    (function* (): Operation<void> {
      let next = yield* changes.next();
      while (!next.done && next.value === undefined) {
        next = yield* changes.next();
      }
    })(),
  );
  const asked = session.overlay.question;
  if (asked === undefined) {
    throw new Error("the session announced a question and then had none");
  }
  return asked;
}

/**
 * What a run really performed, counted where performing it happens.
 *
 * Not at the durable operations: replay enters those and hands back what was
 * recorded, so counting them would count restoration as work. A component's
 * source is read inside the recorded selection and an eval block is compiled
 * inside the recorded evaluation, so both are zero for anything replay restored.
 */
interface Performed {
  readonly reads: string[];
  compiles: number;
}

function* countPerformed(): Operation<Performed> {
  const performed: Performed = { reads: [], compiles: 0 };
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
  return performed;
}

describe("REPL entries: one session, one entry task, in turn", () => {
  beforeAll(() => useTempFileCompiler());

  it("EL1: the first entry starts exactly one task", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: FIRST }));
      yield* session.join();

      expect(session.model.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(session.model.settled).toBe(true);
      expect(session.live).toBe(false);
    });
    expect(started(yield* holder.stream.readAll())).toBe(1);
  });

  it("EL1: a submission while an entry is running refuses and starts nothing", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: ASKS }));
      const question = yield* asking(session);
      const held = yield* holder.stream.readAll();

      const error = refusedSubmission(yield* session.submit(PLAIN));
      // Named for the entry in the way, rather than for which of the two
      // conditions fired: what this row claims is that a submission arriving
      // while an entry runs refuses and starts nothing.
      expect(error.name).toBe("ReplLifecycleError");
      expect(error.message).toContain("entry-1");
      // Nothing started: the file has not moved, no second root was admitted, and
      // the question this entry is waiting on is the one it was waiting on.
      expect(yield* holder.stream.readAll()).toEqual(held);
      expect(started(held)).toBe(1);
      expect(session.overlay.question).toBe(question);

      question.submit({ decision: "go" });
      yield* session.join();
    });
    expect(started(yield* holder.stream.readAll())).toBe(1);
  });

  it("EL1: terminal and unjoined still refuses; the join lets the next one start", function* () {
    const holder = replExecution();
    const entered = gate();
    const release = gate();
    try {
      yield* scoped(function* () {
        // Released from inside this scope as well as outside it. An assertion
        // that throws while a finalizer is parked would otherwise deadlock the
        // teardown it is holding, and a deadlock reports as a timeout rather
        // than as the assertion that failed.
        try {
          const session = opened(
            yield* submitReplEntry({
              execution: holder,
              source: FIRST,
              installations: [holdingTeardown(entered, release)],
            }),
          );
          yield* awaiting("the first entry reaching its own teardown", entered.opened);

          // The history says this entry settled, and the session still owns the
          // task that settled it.
          expect(session.model.entries[0]?.settled).toBe(true);
          expect(session.model.entries[0]?.terminal?.status).toBe("ok");
          expect(session.live).toBe(true);

          const error = refusedSubmission(yield* session.submit(INHERITING));
          expect(error.name).toBe("ReplLifecycleError");
          expect(started(yield* holder.stream.readAll())).toBe(1);

          release.open();
          // The join is the second fact, and it is what makes the next submission
          // a start rather than an overlap.
          yield* session.join();
          accepted(yield* session.submit(INHERITING));
          yield* session.join();

          expect(session.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
          expect(session.model.entries[1]?.terminal?.output).toContain("Three: alpha/first");
        } finally {
          release.open();
        }
      });
    } finally {
      release.open();
    }
    expect(started(yield* holder.stream.readAll())).toBe(2);
  });

  it("EL1: a later entry receives only what earlier entries durably published", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: FIRST }));
      yield* session.join();
      accepted(yield* session.submit(INHERITING));
      yield* session.join();

      const [first, second] = session.model.entries;
      expect(second.terminal?.output).toContain("Three: alpha/first");
      // Exactly the two names the first entry retained, and nothing else: the
      // record handed to the second entry is the one a cold command derives from
      // the same bytes, not a reading of what this process had in memory.
      expect(entryInitialBindings(session.model, second)).toEqual({
        token: "alpha",
        kept: "first",
      });
      expect(first.bindings.map((binding) => binding.name)).toEqual(["token", "kept"]);
      // And the first entry inherits nothing, because nothing precedes it.
      expect(entryInitialBindings(session.model, first)).toEqual({});
    });
  });

  it("EL1: a failed entry permits the next one; an interrupted one permits none", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: FIRST }));
      yield* session.join();

      accepted(yield* session.submit(FAILING));
      expect((yield* session.join()).ok).toBe(false);
      expect(session.model.entries[1]?.terminal?.status).toBe("err");

      // A failure is an outcome, and an outcome is what a successor waits for.
      // What the failing entry published before failing survives.
      accepted(yield* session.submit(INHERITING));
      yield* session.join();
      expect(session.model.entries.map((entry) => entry.key)).toEqual([
        "entry-1",
        "entry-2",
        "entry-3",
      ]);
      expect(session.model.entries[2]?.terminal?.output).toContain("Three: beta/first");
    });

    // Measured rather than assumed: cancelling a held REPL entry appends no
    // terminal record at all, so what it leaves is an *unfinished* entry — and
    // nothing may follow one of those.
    const interrupted = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: interrupted, source: ASKS }));
      yield* asking(session);
    });
    const events = yield* interrupted.stream.readAll();
    expect(events.some((event) => event.type === "close")).toBe(false);
    expect(partitioned(events).map((segment) => segment.settled)).toEqual([false]);
    const blocked = refusedSession(
      yield* submitReplEntry({ execution: replExecution(events), source: PLAIN }),
    );
    expect(blocked.name).toBe("ReplLifecycleError");
    expect(blocked.message).toContain("has not settled");
  });

  it("EL1: a cancelled close permits a successor once its task has joined", function* () {
    // The close is doctored and only the close: the entry before it really ran,
    // and what is replaced is the terminal record a cancelled root writes. The
    // row above measures that this REPL's own cancellation appends no close, so
    // this is the one way to stand where a cancelled entry has settled.
    const physical = new InMemoryStream();
    yield* runEntry(physical, FIRST);
    const events = yield* physical.readAll();
    const [only] = partitioned(events);
    const holder = replExecution(withClose(events, only, cancelled("root")));

    yield* scoped(function* () {
      const session = opened(yield* openReplSession({ execution: holder }));
      expect(session.model.entries[0]?.terminal?.status).toBe("cancelled");
      // Nothing is running: a settled entry is read, never resumed.
      expect(session.live).toBe(false);

      accepted(yield* session.submit(INHERITING));
      yield* session.join();
      expect(session.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      expect(session.model.entries[1]?.terminal?.output).toContain("Three: alpha/first");
    });
  });

  it("EL1: opening a settled two-entry history executes neither segment", function* () {
    const built = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: built, source: FIRST }));
      yield* session.join();
      accepted(yield* session.submit(INHERITING));
      yield* session.join();
    });
    const events = yield* built.stream.readAll();

    const holder = replExecution(events);
    yield* scoped(function* () {
      const performed = yield* countPerformed();
      const session = opened(yield* openReplSession({ execution: holder }));

      expect(session.live).toBe(false);
      expect(session.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      expect(session.model.entries[1]?.terminal?.output).toContain("Three: alpha/first");
      yield* session.join();

      // Nothing was executed: no block compiled, no source read, and the file is
      // the bytes it was.
      expect(performed.compiles).toBe(0);
      expect(performed.reads).toEqual([]);
      expect(yield* holder.stream.readAll()).toEqual(events);
    });
  });

  it("EL1: opening an unfinished final segment resumes only that segment", function* () {
    const built = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: built, source: FIRST }));
      yield* session.join();
      accepted(yield* session.submit(ASKS));
      yield* asking(session);
    });
    const events = yield* built.stream.readAll();
    expect(partitioned(events).map((segment) => segment.settled)).toEqual([true, false]);

    const holder = replExecution(events);
    yield* scoped(function* () {
      const performed = yield* countPerformed();
      const session = opened(yield* openReplSession({ execution: holder }));

      // Resumed: the question this history never answered is being asked again by
      // the one segment that never finished.
      const question = yield* asking(session);
      expect(session.live).toBe(true);
      expect(session.model.entries.map((entry) => entry.settled)).toEqual([true, false]);
      // The settled segment did nothing, and the resumed one restored its own
      // work rather than doing it again. An execution handed the whole file would
      // have read the first entry's records as its own and diverged instead.
      expect(performed.compiles).toBe(0);

      question.submit({ decision: "go" });
      yield* session.join();
      expect(session.model.entries[1]?.terminal?.output).toContain("One: go");
      expect(started(yield* holder.stream.readAll())).toBe(2);
    });
  });

  it("EL1: teardown racing a submission starts no task and joins the one running", function* () {
    const holder = replExecution();
    const entered = gate();
    const release = gate();
    // A child of this row's own scope, so the session it holds runs under the
    // same compiler and host the rest of the suite does. Teardown is then this
    // row's to begin, which is the whole point.
    const [scope, dispose] = createScope(yield* useScope());
    const held = withResolvers<ReplSession>();
    try {
      scope.run(function* () {
        const session = opened(
          yield* submitReplEntry({
            execution: holder,
            source: ASKS,
            installations: [holdingTeardown(entered, release)],
          }),
        );
        held.resolve(session);
        yield* suspend();
      });
      const session = yield* held.operation;
      yield* asking(session);
      const before = yield* holder.stream.readAll();

      const tearing = dispose();
      // Teardown has reached the running entry's own finalizers, which is as far
      // in as anything gets before the task is joined.
      yield* awaiting("this session reaching its teardown", entered.opened);

      const error = refusedSubmission(yield* session.submit(PLAIN));
      expect(error.name).toBe("ReplLifecycleError");
      expect(yield* holder.stream.readAll()).toEqual(before);

      release.open();
      // And the active task is joined, rather than abandoned: observing the
      // teardown is what says so.
      yield* until(tearing);
      expect(started(yield* holder.stream.readAll())).toBe(1);
      expect(holder.stream.onAppend).toBe(null);
    } finally {
      release.open();
    }
  });

  it("EL1: an append the journal refuses opens no successor and mounts no task", function* () {
    const stream = new InMemoryStream();
    const appended = stream.append.bind(stream);
    stream.append = function* (event: DurableEvent): Operation<void> {
      if (event.type === "close" && event.coroutineId === "root") {
        throw new Error("this journal refused the record");
      }
      yield* appended(event);
    };
    const holder: ReplExecution = { id: "entries", stream };

    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: FIRST }));
      expect((yield* session.join()).ok).toBe(false);

      // The close never landed, so this entry has no outcome — and an entry with
      // no outcome is one nothing may follow, however the append failed.
      expect(session.model.entries[0]?.settled).toBe(false);
      expect(session.model.terminal).toBe(undefined);
      const error = refusedSubmission(yield* session.submit(PLAIN));
      expect(error.name).toBe("ReplLifecycleError");
      expect(error.message).toContain("has not settled");

      // And nothing of the failed entry is still mounted: no execution is live
      // and no further task was started on its behalf.
      expect(session.live).toBe(false);
      expect(session.agent.turns).toEqual([]);
      expect(started(yield* holder.stream.readAll())).toBe(1);
    });
  });
});

/**
 * The widest accepted frame, stated here because layout keeps it private.
 *
 * The two sizes below are the two this Story's catalog has to work at: the
 * sidebar, where the catalog shares a column with the Sessions reading, and the
 * narrow outlet, where it has the screen to itself under the location and the
 * two surface controls.
 */
const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };

/** A process holding nothing live, which is also what a frozen prefix shows. */
const NOTHING_LIVE: ReplLive = Object.freeze({
  output: "",
  question: undefined,
  expansion: "playing",
  pausable: false,
  agent: NO_AGENT,
});

/** This process's overlay, exactly as the program reads it into a view. */
function liveReading(session: ReplSession): ReplLive {
  return {
    output: session.overlay.output,
    question: session.overlay.question,
    expansion: session.expansion.state,
    pausable: session.controller !== undefined,
    agent: session.agent,
  };
}

/** The view this state reads as, or the failure that stopped it. */
function reading(
  state: ReplState,
  model: ReplModel,
  live: ReplLive = NOTHING_LIVE,
  size: ReplTerminalSize = NARROW,
  focused?: string,
): ReplView {
  const resolved = viewFor(state, model, live, size, focused);
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.value;
}

/** Why this state has no view at all, which is what an atomic refusal leaves. */
function unreadable(state: ReplState, model: ReplModel): string {
  const resolved = viewFor(state, model, NOTHING_LIVE, NARROW);
  if (resolved.ok) {
    throw new Error("this state produced a view, and this model cannot answer it");
  }
  return resolved.error.message;
}

/** Every described row, flattened, with its key and label. */
function rowsOf(descriptions: readonly ReplDescription<ReplAction>[]): Array<{
  key: string;
  label: string;
}> {
  const found: Array<{ key: string; label: string }> = [];
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    const named = fields(read.input);
    const label = named?.["label"] ?? named?.["text"] ?? "";
    found.push({ key: read.key, label: typeof label === "string" ? label : "" });
    for (const child of read.children ?? []) {
      walk(child);
    }
  };
  for (const description of descriptions) {
    walk(description);
  }
  return found;
}

/** The keys this view describes, in order. */
function keysOf(view: ReplView): string[] {
  return rowsOf(describeApplication(view)).map((one) => one.key);
}

/** The catalog rows this view describes, in the order it describes them. */
function catalogOf(view: ReplView): Array<{ key: string; label: string }> {
  return rowsOf(describeApplication(view)).filter(
    (one) => one.key.startsWith("entry:") || one.key.startsWith("scope:"),
  );
}

/** Commit one view into the real tree, refusing to assert past a rejected set. */
function* applied(tree: ReplTree<ReplAction>, view: ReplView): Operation<void> {
  const result = yield* tree.apply(describeApplication(view));
  if (!result.ok) {
    throw result.error;
  }
}

/** The mounted node this key names, or none, which is what absence looks like. */
function nodeOf(tree: ReplTree<ReplAction>, key: string): string | undefined {
  return tree.mounted().find((id) => tree.keyOf(id) === key);
}

/** The cell this frame placed for one key, or none, which is what a map holds. */
function placedFor(
  tree: ReplTree<ReplAction>,
  frame: ReplSemanticFrame,
  key: string,
): ReplPlacedCell | undefined {
  return frame.cells.find((cell) => tree.keyOf(cell.node) === key);
}

/** Mount one view and lay it out at one size, the way the program does. */
function* drawn(
  tree: ReplTree<ReplAction>,
  view: ReplView,
  size: ReplTerminalSize,
): Operation<ReplSemanticFrame> {
  yield* applied(tree, view);
  return layout(size, replSurface(tree, view));
}

/**
 * Point at one key the way the renderer's map resolves a pointer.
 *
 * Through the frame rather than through the tree: a cell the frame did not
 * place, or placed and did not offer, is in no target map at all, so reaching
 * for the node directly would prove something no pointer can do.
 */
function* pointed(
  tree: ReplTree<ReplAction>,
  frame: ReplSemanticFrame,
  key: string,
): Operation<ReplAction> {
  const cell = placedFor(tree, frame, key);
  if (cell === undefined) {
    throw new Error(`this frame placed no cell for ${key}`);
  }
  if (!cell.targetable) {
    throw new Error(`${key} is placed but is in no target map`);
  }
  const dispatched = yield* tree.dispatch({
    kind: "pointer",
    target: cell.node,
    frame: tree.frame().id,
  });
  if (!dispatched.ok || dispatched.value.outcome !== "action") {
    throw new Error(`the pointer on ${key} produced no action`);
  }
  return dispatched.value.action;
}

/** Tab until the control this key names holds focus, the way a person reaches it. */
function* focusTo(tree: ReplTree<ReplAction>, key: string): Operation<void> {
  for (let press = 0; press < 400; press += 1) {
    const node = tree.focused();
    if (node !== undefined && tree.keyOf(node) === key) {
      return;
    }
    yield* tree.dispatch({ kind: "key", key: "Tab" });
  }
  throw new Error(`focus never reached ${key}`);
}

/** Activate the focused control, and answer what it asked for. */
function* activated(tree: ReplTree<ReplAction>): Operation<ReplAction> {
  const dispatched = yield* tree.dispatch({ kind: "key", key: "Enter" });
  if (!dispatched.ok || dispatched.value.outcome !== "action") {
    throw new Error("the focused control produced no action");
  }
  return dispatched.value.action;
}

/** One action reduced, refusing to carry a refusal forward unnoticed. */
function acted(
  state: ReplState,
  action: ReplAction,
  model: ReplModel,
  live: ReplLive = NOTHING_LIVE,
  size: ReplTerminalSize = NARROW,
): ReplState {
  const next = reduceRepl(state, action, model, live, size);
  if (next.state.refusal !== undefined) {
    throw new Error(`${action.kind} was refused: ${next.state.refusal}`);
  }
  return next.state;
}

/** The same state carrying one draft, in the state and in the location together. */
function drafting(state: ReplState, draft: string): ReplState {
  return Object.freeze({
    ...state,
    draft,
    route: Object.freeze({ ...state.route, draft: draft.length === 0 ? undefined : draft }),
  });
}

/** The same state selecting one entry and the scopes beneath it. */
function selecting(state: ReplState, ...scopes: readonly string[]): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, scopes: Object.freeze([...scopes]) }),
  });
}

/** The same state frozen at one history position, the way the action freezes it. */
function frozenAt(state: ReplState, marker: string): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, at: marker, inspect: true }),
  });
}

const EXECUTION = "entries";

/**
 * Enough entries that no accepted frame can place the whole catalog.
 *
 * Each one is trivial and settles immediately: what these rows are about is how
 * many rows the catalog has, not what any of them did.
 */
function* manyEntries(count: number): Operation<DurableEvent[]> {
  const physical = new InMemoryStream();
  for (let at = 1; at <= count; at += 1) {
    yield* runEntry(physical, `Entry ${at}.\n`);
  }
  return yield* physical.readAll();
}

describe("REPL entries: the draft, the gate and the position", () => {
  beforeAll(() => useTempFileCompiler());

  it("ER1: the draft stays editable while an entry runs and while history is read", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: ASKS }));
      const question = yield* asking(session);
      // An entry is running: the question is what is holding it open.
      expect(session.live).toBe(true);
      expect(session.model.entries[0]?.settled).toBe(false);

      // Typing reaches the draft, not the entry. An admitted entry is
      // immutable, so there was never one these keystrokes could edit.
      const live = liveReading(session);
      let state = initialState(EXECUTION);
      for (const text of ["next", " entry"]) {
        state = acted(state, { kind: "type", text }, session.model, live);
      }
      expect(state.draft).toBe("next entry");
      // And the location says so, which is how a second process arrives at it.
      expect(state.route.draft).toBe("next entry");
      expect(reading(state, session.model, live).location).toContain("draft=next%20entry");

      // Backspace is the same keystroke on the same field.
      state = acted(state, { kind: "erase" }, session.model, live);
      expect(state.draft).toBe("next entr");

      // The same while a history position is being inspected: inspection
      // freezes durable state, and the draft is not durable state.
      const marker = session.model.checkpoints[0]?.marker;
      if (marker === undefined) {
        throw new Error("a running entry has offered at least one position");
      }
      const prefix = projected(yield* holder.stream.readAll(), marker);
      let inspecting = frozenAt(drafting(initialState(EXECUTION), "typed"), marker);
      inspecting = acted(inspecting, { kind: "type", text: " more" }, prefix);
      expect(inspecting.draft).toBe("typed more");
      expect(inspecting.route.at).toBe(marker);
      expect(inspecting.route.inspect).toBe(true);

      question.submit({ decision: "go" });
      yield* session.join();
    });
  });

  it("ER1: Run refuses at every closed gate, starts nothing and keeps the exact draft", function* () {
    const holder = replExecution();
    const entered = gate();
    const release = gate();
    const DRAFT = "One: {token}\n";
    try {
      yield* scoped(function* () {
        try {
          const session = opened(
            yield* submitReplEntry({
              execution: holder,
              source: ASKS,
              installations: [holdingTeardown(entered, release)],
            }),
          );
          const question = yield* asking(session);
          const standing = drafting(initialState(EXECUTION), DRAFT);

          // [1] While the entry is running. The reducer asks for the
          // submission, because whether this is a moment to submit is the
          // session's to answer; the session refuses and starts nothing, and
          // the draft is exactly as it was typed.
          const whileRunning = reduceRepl(
            standing,
            { kind: "submit" },
            session.model,
            liveReading(session),
            NARROW,
          );
          expect(whileRunning.intent).toEqual({ kind: "submit", source: DRAFT });
          expect(whileRunning.state.draft).toBe(DRAFT);
          const running = refusedSubmission(yield* session.submit(DRAFT));
          expect(running.name).toBe("ReplLifecycleError");
          expect(running.message).toContain("has not finished");
          expect(started(yield* holder.stream.readAll())).toBe(1);

          // [2] Terminal, and not yet joined. The history says the entry
          // settled and the session still owns the task that settled it.
          question.submit({ decision: "go" });
          yield* awaiting("the first entry reaching its own teardown", entered.opened);
          expect(session.model.entries[0]?.settled).toBe(true);
          expect(session.live).toBe(true);
          const unjoined = refusedSubmission(yield* session.submit(DRAFT));
          expect(unjoined.name).toBe("ReplLifecycleError");
          expect(started(yield* holder.stream.readAll())).toBe(1);

          // [3] At a frozen position, where the reducer itself refuses: there
          // is no inheritance boundary here that is not a fork, so no intent
          // leaves this screen at all.
          const marker = session.model.entries[0]?.scope.marker;
          if (marker === undefined) {
            throw new Error("an admitted entry has an admission marker");
          }
          const historical = reduceRepl(
            frozenAt(standing, marker),
            { kind: "submit" },
            projected(yield* holder.stream.readAll(), marker),
            NOTHING_LIVE,
            NARROW,
          );
          expect(historical.intent).toEqual({ kind: "none" });
          expect(historical.state.refusal).toContain("Return to the live head");
          expect(historical.state.draft).toBe(DRAFT);
          // Byte for byte, and everything beside it stands: the route, the
          // selection, the surface and the position are all untouched.
          expect(historical.state.route.draft).toBe(DRAFT);
          expect(historical.state.route.at).toBe(marker);
          expect(historical.state.route.surface).toBe("repl");
          expect(started(yield* holder.stream.readAll())).toBe(1);
        } finally {
          release.open();
        }
      });
    } finally {
      release.open();
    }
    expect(started(yield* holder.stream.readAll())).toBe(1);
  });

  it("ER1: the preserved draft becomes the exact next entry, and only then clears", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: FIRST }));
      yield* session.join();

      const standing = drafting(initialState(EXECUTION), INHERITING);
      const asked = reduceRepl(
        standing,
        { kind: "submit" },
        session.model,
        liveReading(session),
        NARROW,
      );
      expect(asked.intent).toEqual({ kind: "submit", source: INHERITING });
      // Still there while the submission is in flight: a preflight refusal is
      // the one moment somebody most needs their document back.
      expect(asked.state.draft).toBe(INHERITING);

      accepted(yield* session.submit(INHERITING));
      yield* session.join();

      // The source the journal retained is the draft, character for character.
      const admittedEntry = session.model.entries[1];
      expect(admittedEntry?.source).toBe(INHERITING);
      // And the key is the one the session really assigned, not a constant.
      expect(admittedEntry?.key).toBe("entry-2");
      expect(session.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

      // Only now does it clear — from the state and from the location together.
      const after = admitted(asked.state);
      expect(after.draft).toBe("");
      expect(after.route.draft).toBe(undefined);

      // And the entry that was just admitted is the one navigation reaches.
      const key = admittedEntry?.key ?? "";
      const selected = acted(after, { kind: "select-scope", scopes: [key] }, session.model);
      expect(selected.route.scopes).toEqual([key]);
      expect(reading(selected, session.model).selection.entry?.key).toBe(key);
    });
  });

  it("ER1: a prefix before the selected entry clears only that suffix", function* () {
    const { events } = yield* twoEntries();
    const head = projected(events);
    const second = head.entries[1];
    if (second === undefined) {
      throw new Error("this journal admits two entries");
    }
    // A position strictly before the second entry's admission: the first
    // entry's own close, which is the last thing that happened before it.
    const before = head.entries[0]?.terminal === undefined ? undefined : "close:root";
    if (before === undefined) {
      throw new Error("the first entry settled");
    }
    const prefix = projected(events, before);
    expect(prefix.entries.map((entry) => entry.key)).toEqual(["entry-1"]);

    // Standing on the second entry, with a draft, on this surface.
    const standing = frozenAt(
      selecting(drafting(initialState(EXECUTION), "still typing"), second.key),
      before,
    );
    // Nothing resolves there, which is what makes the clearing necessary rather
    // than cosmetic.
    expect(unreadable(standing, prefix)).toContain("no entry-2");

    const cleared = withoutAbsentEntry(standing, prefix);
    if (cleared === undefined) {
      throw new Error("a selected entry absent from this prefix has a suffix to clear");
    }
    // Exactly the suffix, and no replacement guessed in its place.
    expect(cleared.route.scopes).toEqual([]);
    expect(reading(cleared, prefix).selection.entry).toBe(undefined);
    // Everything else stands.
    expect(cleared.draft).toBe("still typing");
    expect(cleared.route.draft).toBe("still typing");
    expect(cleared.route.surface).toBe("repl");
    expect(cleared.route.at).toBe(before);
    expect(cleared.route.inspect).toBe(true);
    expect(cleared.route.session).toBe(standing.route.session);

    // A prefix that still holds the selected entry has nothing to clear, so
    // this never fires on an ordinary history action.
    expect(withoutAbsentEntry(frozenAt(selecting(standing, "entry-1"), before), prefix)).toBe(
      undefined,
    );
    // And it is the history action's remedy alone: a location opened directly
    // at the live head naming an absent entry is refused whole, never adjusted.
    expect(withoutAbsentEntry(selecting(initialState(EXECUTION), "entry-9"), head)).toBe(undefined);
  });

  it("ER1: returning live restores the catalog and keeps the draft", function* () {
    const { events } = yield* twoEntries();
    const head = projected(events);
    const prefix = projected(events, "close:root");

    const standing = frozenAt(drafting(initialState(EXECUTION), "kept"), "close:root");
    // One entry is all this prefix holds.
    expect(catalogOf(reading(standing, prefix)).map((one) => one.key)).toEqual(["entry:entry-1"]);

    const live = acted(standing, { kind: "go-live" }, prefix);
    expect(live.route.at).toBe(undefined);
    expect(live.route.inspect).toBe(false);
    // The head catalog is back, whole.
    expect(catalogOf(reading(live, head)).map((one) => one.key)).toEqual([
      "entry:entry-1",
      "entry:entry-2",
    ]);
    // And the draft came with it, in the state and in the location.
    expect(live.draft).toBe("kept");
    expect(live.route.draft).toBe("kept");
    expect(reading(live, head).location).toContain("draft=kept");
  });

  it("ER1: submission inherits from the live head, never from the inspected prefix", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: FIRST }));
      yield* session.join();

      const head = session.model;
      const before = head.entries[0]?.scope.marker;
      if (before === undefined) {
        throw new Error("an admitted entry has an admission marker");
      }
      // A prefix at the first entry's admission, where it has published nothing
      // at all. If a historical prefix could become an inheritance boundary,
      // this is the one that would show it.
      const prefix = projected(yield* holder.stream.readAll(), before);
      expect(entryInitialBindings(prefix)).toEqual({});
      expect(entryInitialBindings(head)).toEqual({ token: "alpha", kept: "first" });

      // Submitted while that prefix is what the screen is showing. The entry
      // reads `token` and `kept`, which only the live head holds.
      accepted(yield* session.submit(INHERITING));
      yield* session.join();
      expect(session.model.entries[1]?.terminal?.status).toBe("ok");
      expect(session.model.entries[1]?.terminal?.output).toContain("Three: alpha/first");
    });
  });
});

describe("REPL entries: the catalog a person reads and reaches", () => {
  beforeAll(() => useTempFileCompiler());

  it("EU1: entries stay in admission order while their outcomes disagree", function* () {
    const { events } = yield* threeEntries();
    const model = projected(events);
    // Three outcomes that do not sort the way admission does: ok, err, ok.
    expect(model.entries.map((entry) => entry.terminal?.status)).toEqual(["ok", "err", "ok"]);

    const catalog = catalogOf(reading(initialState(EXECUTION), model, NOTHING_LIVE, WIDE));
    expect(catalog.map((one) => one.key)).toEqual([
      "entry:entry-1",
      "entry:entry-2",
      "entry:entry-3",
    ]);
    // Each row carries its own place and its own outcome, so the four states a
    // reader must tell apart are told apart.
    expect(catalog.map((one) => one.label.trim().split(" ")[0])).toEqual(["1.", "2.", "3."]);
    expect(catalog[0]?.label).toContain("ok");
    expect(catalog[1]?.label).toContain("err");
    expect(catalog[2]?.label).toContain("ok");

    // An entry whose root has not closed says so rather than borrowing an
    // outcome: at its own admission, the third entry has settled nothing.
    const admission = model.entries[2]?.scope.marker;
    if (admission === undefined) {
      throw new Error("an admitted entry has an admission marker");
    }
    const unfinished = projected(events, admission);
    const last = catalogOf(
      reading(frozenAt(initialState(EXECUTION), admission), unfinished, NOTHING_LIVE, WIDE),
    );
    expect(last.map((one) => one.key)).toEqual(["entry:entry-1", "entry:entry-2", "entry:entry-3"]);
    expect(last[2]?.label).toContain("unfinished");
  });

  it("EU1: wide and narrow keep the input and both surface selectors reachable", function* () {
    const events = yield* manyEntries(14);
    const model = projected(events);
    const state = drafting(initialState(EXECUTION), "typing the next one");
    const tree = yield* useReplTree<ReplAction>();

    for (const size of [WIDE, NARROW]) {
      const view = reading(state, model, NOTHING_LIVE, size);
      const frame = yield* drawn(tree, view, size);
      for (const key of ["footer:input", "sessions:heading", "entries:heading"]) {
        const placed = placedFor(tree, frame, key);
        expect([size.columns, key, placed !== undefined]).toEqual([size.columns, key, true]);
        expect([size.columns, key, placed?.targetable]).toEqual([size.columns, key, true]);
      }
      // Both selectors really take somebody to the other surface.
      expect(yield* pointed(tree, frame, "sessions:heading")).toEqual({
        kind: "select-surface",
        surface: "sessions",
      });
      expect(yield* pointed(tree, frame, "entries:heading")).toEqual({
        kind: "select-surface",
        surface: "repl",
      });
    }
  });

  it("EU1: a catalog longer than one window places and targets every row", function* () {
    const events = yield* manyEntries(14);
    const model = projected(events);
    const whole = model.entries.map((entry) => `entry:${entry.key}`);
    const tree = yield* useReplTree<ReplAction>();

    let state = initialState(EXECUTION);
    const first = reading(state, model, NOTHING_LIVE, NARROW);
    const shown = catalogOf(first).map((one) => one.key);
    // More catalog than this frame can place, and what it places is a prefix of
    // the whole thing rather than a sample of it.
    expect(whole.length).toBeGreaterThan(shown.length);
    expect(whole.slice(0, shown.length)).toEqual(shown);

    // Walked from the first clamped position to the last, through the real tree
    // and the real placement boundary. Only a placed, offered cell counts.
    const reached = new Set<string>();
    for (let press = 0; press < 60; press += 1) {
      const view = reading(state, model, NOTHING_LIVE, NARROW);
      const frame = yield* drawn(tree, view, NARROW);
      for (const key of whole) {
        const placed = placedFor(tree, frame, key);
        if (placed !== undefined && placed.targetable) {
          reached.add(key);
        }
      }
      const next = acted(state, { kind: "scroll-entries", delta: 1 }, model, NOTHING_LIVE, NARROW);
      if (next.viewports.entries === state.viewports.entries) {
        break;
      }
      state = next;
    }
    expect([...whole].filter((key) => !reached.has(key))).toEqual([]);

    // And scrolling back recovers the first window rather than travelling one
    // way only.
    let back = state;
    for (let press = 0; press < 60 && back.viewports.entries > 0; press += 1) {
      back = acted(back, { kind: "scroll-entries", delta: -1 }, model, NOTHING_LIVE, NARROW);
    }
    expect(back.viewports.entries).toBe(0);
    expect(catalogOf(reading(back, model, NOTHING_LIVE, NARROW)).map((one) => one.key)).toEqual(
      shown,
    );
    // None of it reached the location: where somebody scrolled to is this
    // process's, and no second process can be sent to a row of it.
    expect(state.viewports.entries).toBeGreaterThan(0);
    expect(reading(state, model, NOTHING_LIVE, NARROW).location).toBe(
      reading(back, model, NOTHING_LIVE, NARROW).location,
    );
  });

  it("EU1: Enter and a frame-resolved pointer on one row ask for the same thing", function* () {
    const events = yield* manyEntries(14);
    const model = projected(events);
    const tree = yield* useReplTree<ReplAction>();
    const view = reading(initialState(EXECUTION), model, NOTHING_LIVE, NARROW);
    const frame = yield* drawn(tree, view, NARROW);

    const key = catalogOf(view)[2]?.key;
    if (key === undefined) {
      throw new Error("this window places more than two catalog rows");
    }
    yield* focusTo(tree, key);
    const pressed = yield* activated(tree);
    expect(yield* pointed(tree, frame, key)).toEqual(pressed);
    expect(pressed).toEqual({ kind: "select-scope", scopes: [key.slice("entry:".length)] });
  });

  it("EU1: a row outside the window is unmounted, unplaced and in no target map", function* () {
    const events = yield* manyEntries(14);
    const model = projected(events);
    const tree = yield* useReplTree<ReplAction>();
    const state = initialState(EXECUTION);
    const view = reading(state, model, NOTHING_LIVE, NARROW);
    const shown = catalogOf(view).map((one) => one.key);

    const beyond = model.entries
      .map((entry) => `entry:${entry.key}`)
      .find((key) => !shown.includes(key));
    if (beyond === undefined) {
      throw new Error("every entry was inside the first window");
    }
    const frame = yield* drawn(tree, view, NARROW);
    // Not described, so not mounted, not focusable, not drawn and in no map.
    expect(keysOf(view)).not.toContain(beyond);
    expect(nodeOf(tree, beyond)).toBe(undefined);
    expect(placedFor(tree, frame, beyond)).toBe(undefined);
    // The controls that move the window never scroll away from whoever uses them.
    expect(placedFor(tree, frame, "entries:earlier")).toBeDefined();
    expect(placedFor(tree, frame, "entries:later")).toBeDefined();

    // Reached by scrolling, it is mounted, placed and offered.
    let at = state;
    for (let press = 0; press < 60; press += 1) {
      const reachedView = reading(at, model, NOTHING_LIVE, NARROW);
      if (catalogOf(reachedView).some((one) => one.key === beyond)) {
        const reachedFrame = yield* drawn(tree, reachedView, NARROW);
        expect(nodeOf(tree, beyond)).toBeDefined();
        expect(placedFor(tree, reachedFrame, beyond)?.targetable).toBe(true);
        return;
      }
      at = acted(at, { kind: "scroll-entries", delta: 1 }, model, NOTHING_LIVE, NARROW);
    }
    throw new Error(`scrolling never reached ${beyond}`);
  });

  it("EU1: a resize clamps the drawn offset before the first scroll after it", function* () {
    const events = yield* manyEntries(14);
    const model = projected(events);

    // Scrolled to the end of the narrow window, where the offset is as large as
    // that frame allows.
    let narrow = initialState(EXECUTION);
    for (let press = 0; press < 60; press += 1) {
      const next = acted(narrow, { kind: "scroll-entries", delta: 1 }, model, NOTHING_LIVE, NARROW);
      if (next.viewports.entries === narrow.viewports.entries) {
        break;
      }
      narrow = next;
    }
    expect(narrow.viewports.entries).toBeGreaterThan(0);

    // The sidebar holds more of the catalog, so the furthest this offset may go
    // is smaller there — and what was stored is now past it.
    const atEnd = acted(narrow, { kind: "scroll-entries", delta: 1 }, model, NOTHING_LIVE, WIDE);
    const furthest = atEnd.viewports.entries;
    expect(furthest).toBeLessThan(narrow.viewports.entries);

    // One press back from the clamped position the frame is drawing, not from
    // the stale larger number: the screen moves on the first press rather than
    // spending it normalizing state nobody can see.
    const stepped = acted(narrow, { kind: "scroll-entries", delta: -1 }, model, NOTHING_LIVE, WIDE);
    expect(stepped.viewports.entries).toBe(furthest - 1);
    expect(
      catalogOf(reading(stepped, model, NOTHING_LIVE, WIDE)).map((one) => one.key),
    ).not.toEqual(catalogOf(reading(narrow, model, NOTHING_LIVE, WIDE)).map((one) => one.key));
  });
});
