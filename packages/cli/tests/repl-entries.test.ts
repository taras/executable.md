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
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import type { Operation, Result } from "effection";

import { EntrySegmentStream, partitionEntrySegments } from "../src/repl/entries.ts";
import type { EntrySegment } from "../src/repl/entries.ts";
import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";

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
