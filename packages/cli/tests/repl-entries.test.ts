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
import {
  lifecycleRefusal,
  markLifecycleRefusal,
  openReplSession,
  ReplLifecycleError,
  submitReplEntry,
} from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import {
  admitted,
  describeApplication,
  ENTRIES_WINDOW,
  entriesRowCount,
  focusClaim,
  focusSettled,
  initialState,
  NO_AGENT,
  reduceRepl,
  presentationFor,
  viewFor,
  withoutAbsentEntry,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplAction, ReplLive, ReplState, ReplView } from "../src/repl/application.ts";
import { flatten, inspectionWidth, NARROW, sidebarWidth } from "../src/repl/layout.ts";
import type { ReplBounds, ReplRegion } from "../src/repl/layout.ts";
import type { ReplPresentationContext } from "../src/repl/application.ts";
import { commitReplFrame } from "../src/repl/program.ts";
import type { ReplCommitted } from "../src/repl/program.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import { committedContext } from "./fixtures/repl/presentation.ts";
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
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
});

/** This process's overlay, exactly as the program reads it into a view. */
function liveReading(session: ReplSession): ReplLive {
  return {
    output: session.overlay.output,
    question: session.overlay.question,
    expansion: session.expansion.state,
    pausable: session.controller !== undefined,
    running: session.live,
    agent: session.agent,
    lifecycle: NO_LIFECYCLE,
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

/**
 * Measure one view with a real engine pair, as the product does.
 *
 * A window's rows are the rows the measurement left room for, so a test asking
 * what a view describes has to measure it. An engine may be handed in where one
 * test takes many frames; otherwise one is built for the question.
 */
function* measuring<T>(
  size: ReplTerminalSize,
  engine: ReplRenderer | undefined,
  body: (renderer: ReplRenderer) => Operation<T>,
): Operation<T> {
  if (engine !== undefined) {
    return yield* body(engine);
  }
  return yield* scoped(function* (): Operation<T> {
    return yield* body(yield* useReplRenderer(size));
  });
}

/** What one view's frame settled on: its measured widths and its admission. */
function* contextOf(view: ReplView, engine?: ReplRenderer): Operation<ReplPresentationContext> {
  return yield* measuring(view.size, engine, (renderer) => committedContext(renderer, view));
}

/** The descriptions this view produces, measured. */
function* describedBy(view: ReplView, engine?: ReplRenderer) {
  return rowsOf(presentationFor(view, yield* contextOf(view, engine)).descriptions);
}

/** The keys this view describes, in order. */
function* keysOf(view: ReplView, engine?: ReplRenderer): Operation<string[]> {
  return (yield* describedBy(view, engine)).map((one) => one.key);
}

/** The catalog rows this view describes, in the order it describes them. */
function* catalogOf(
  view: ReplView,
  engine?: ReplRenderer,
): Operation<Array<{ key: string; label: string }>> {
  return (yield* describedBy(view, engine)).filter(
    (one) => one.key.startsWith("entry:") || one.key.startsWith("scope:"),
  );
}

/**
 * One committed frame, as a test reads it back.
 *
 * Everything here comes from the frame that was drawn: which boxes the manifest
 * placed, which of them mounted a live node, and the geometry the engine gave
 * each one. Nothing works out where a row ought to be.
 */
interface Frame {
  readonly committed: ReplCommitted;
  /** The live node one placed key mounted, or none. */
  node(key: string): string | undefined;
  /** Whether this frame placed that key and offered it to a pointer. */
  targetable(key: string): boolean;
  /**
   * What one placed row drew, clipped to the width the frame gave it.
   *
   * The cell its own node contributed, cut to the geometry the engine reported:
   * a region clips horizontally, so text past its edge is painted nowhere. A
   * promise that falls outside the row is a promise this frame does not keep.
   */
  visible(key: string): string | undefined;
  /** The whole cell one placed row contributed, before any clipping. */
  cell(key: string): string | undefined;
  /** The geometry one placed row was given, or none. */
  bounds(key: string): ReplBounds | undefined;
  /** Where one named region landed, read from the committed frame. */
  region(name: ReplRegion): ReplBounds | undefined;
  /** Every key this frame placed. */
  readonly keys: readonly string[];
}

/** Commit one view into the real tree, refusing to assert past a rejected set. */
function* applied(
  tree: ReplTree<ReplAction>,
  view: ReplView,
  engine?: ReplRenderer,
): Operation<void> {
  yield* drawn(tree, view, view.size, engine);
}

/** The key of whatever holds focus now, as the root reads it. */
function keyedBy(tree: ReplTree<ReplAction>): string | undefined {
  const node = tree.focused();
  return node === undefined ? undefined : tree.keyOf(node);
}

/** The mounted node this key names, or none, which is what absence looks like. */
function nodeOf(tree: ReplTree<ReplAction>, key: string): string | undefined {
  return tree.mounted().find((id) => tree.keyOf(id) === key);
}

/** Mount one view and draw it at one size, exactly the way the program does. */
function* drawn(
  tree: ReplTree<ReplAction>,
  view: ReplView,
  _size: ReplTerminalSize,
  engine?: ReplRenderer,
): Operation<Frame> {
  const committed = yield* measuring(view.size, engine, (renderer) =>
    commitReplFrame(tree, renderer, view, 0, undefined),
  );
  if (!committed.ok) {
    throw committed.error;
  }
  const mounted = new Set(tree.mounted());
  const nodeByKey = new Map<string, string>();
  for (const node of mounted) {
    const key = tree.keyOf(node);
    if (key !== undefined) {
      nodeByKey.set(key, node);
    }
  }
  const placed = new Map<string, { node: string; control: boolean }>();
  for (const box of flatten(committed.value.manifest.root)) {
    if (box.key === undefined) {
      continue;
    }
    const node = nodeByKey.get(box.key);
    if (node !== undefined) {
      placed.set(box.key, { node, control: box.control });
    }
  }
  const cells = new Map<string, string>();
  for (const cell of tree.frame().cells) {
    cells.set(cell.node, cell.cell);
  }
  return {
    committed: committed.value,
    node: (key: string) => placed.get(key)?.node,
    targetable: (key: string) => placed.get(key)?.control === true,
    visible(key: string) {
      const node = placed.get(key)?.node;
      if (node === undefined) {
        return undefined;
      }
      const text = cells.get(node) ?? "";
      const { map } = committed.value.rendered;
      const bounds = map.boundsOf(node) ?? map.regionOf(node);
      return bounds === undefined ? text : text.slice(0, bounds.width);
    },
    cell(key: string) {
      const node = placed.get(key)?.node;
      return node === undefined ? undefined : cells.get(node);
    },
    bounds(key: string) {
      const node = placed.get(key)?.node;
      if (node === undefined) {
        return undefined;
      }
      // A control's geometry is in the target map; every other drawn row's is
      // published beside it, because where a row landed and whether it can be
      // activated are two different questions.
      const { map } = committed.value.rendered;
      return map.boundsOf(node) ?? map.regionOf(node);
    },
    region(name: ReplRegion) {
      const found = committed.value.manifest.regions.find((one) => one.region === name);
      return found === undefined ? undefined : committed.value.rendered.map.regionOf(found.id);
    },
    keys: Object.freeze([...placed.keys()]),
  };
}

/**
 * Point at one key the way the renderer's map resolves a pointer.
 *
 * Through the frame rather than through the tree: a row the frame did not place,
 * or placed and did not offer, is in no target map at all, so reaching for the
 * node directly would prove something no pointer can do.
 */
function* pointed(tree: ReplTree<ReplAction>, frame: Frame, key: string): Operation<ReplAction> {
  const node = frame.node(key);
  if (node === undefined) {
    throw new Error(`this frame placed no cell for ${key}`);
  }
  if (!frame.targetable(key)) {
    throw new Error(`${key} is placed but is in no target map`);
  }
  if (frame.committed.rendered.map.boundsOf(node) === undefined) {
    throw new Error(`${key} is a control this frame published no geometry for`);
  }
  const dispatched = yield* tree.dispatch({
    kind: "pointer",
    target: node,
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
function* acted(
  state: ReplState,
  action: ReplAction,
  model: ReplModel,
  live: ReplLive = NOTHING_LIVE,
  size: ReplTerminalSize = NARROW,
  engine?: ReplRenderer,
): Operation<ReplState> {
  // Measured for the state this action is answered at, which is what the program
  // does before it reduces: a window moves within the capacity the screen is
  // showing, not one left over from an earlier size or reading.
  const view = reading(state, model, live, size);
  const next = reduceRepl(state, action, model, live, (yield* contextOf(view, engine)).admission);
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
        state = yield* acted(state, { kind: "type", text }, session.model, live);
      }
      expect(state.draft).toBe("next entry");
      // And the location says so, which is how a second process arrives at it.
      expect(state.route.draft).toBe("next entry");
      expect(reading(state, session.model, live).location).toContain("draft=next%20entry");

      // Backspace is the same keystroke on the same field.
      state = yield* acted(state, { kind: "erase" }, session.model, live);
      expect(state.draft).toBe("next entr");

      // The same while a history position is being inspected: inspection
      // freezes durable state, and the draft is not durable state.
      const marker = session.model.checkpoints[0]?.marker;
      if (marker === undefined) {
        throw new Error("a running entry has offered at least one position");
      }
      const prefix = projected(yield* holder.stream.readAll(), marker);
      let inspecting = frozenAt(drafting(initialState(EXECUTION), "typed"), marker);
      inspecting = yield* acted(inspecting, { kind: "type", text: " more" }, prefix);
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
          );
          expect(historical.intent).toEqual({ kind: "none" });
          expect(historical.state.refusal).toContain("Return to the live head");
          expect(historical.state.draft).toBe(DRAFT);
          // Byte for byte, and everything beside it stands: the route, the
          // selection, the surface and the position are all untouched.
          expect(historical.state.route.draft).toBe(DRAFT);
          expect(historical.state.route.at).toBe(marker);
          expect(historical.state.route.surface).toBe("entries");
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
      const asked = reduceRepl(standing, { kind: "submit" }, session.model, liveReading(session));
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
      const selected = yield* acted(after, { kind: "select-scope", scopes: [key] }, session.model);
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
    expect(cleared.route.surface).toBe("entries");
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
    expect((yield* catalogOf(reading(standing, prefix))).map((one) => one.key)).toEqual([
      "entry:entry-1",
    ]);

    const live = yield* acted(standing, { kind: "go-live" }, prefix);
    expect(live.route.at).toBe(undefined);
    expect(live.route.inspect).toBe(false);
    // The head catalog is back, whole.
    expect((yield* catalogOf(reading(live, head))).map((one) => one.key)).toEqual([
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

    const catalog = yield* catalogOf(reading(initialState(EXECUTION), model, NOTHING_LIVE, WIDE));
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
    const last = yield* catalogOf(
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
        const placed = frame.node(key);
        expect([size.columns, key, placed !== undefined]).toEqual([size.columns, key, true]);
        expect([size.columns, key, frame.targetable(key)]).toEqual([size.columns, key, true]);
      }
      // Both selectors really take somebody to the other surface.
      expect(yield* pointed(tree, frame, "sessions:heading")).toEqual({
        kind: "select-surface",
        surface: "sessions",
      });
      expect(yield* pointed(tree, frame, "entries:heading")).toEqual({
        kind: "select-surface",
        surface: "entries",
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
    const shown = (yield* catalogOf(first)).map((one) => one.key);
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
        const placed = frame.node(key);
        if (placed !== undefined && frame.targetable(key)) {
          reached.add(key);
        }
      }
      const next = yield* acted(
        state,
        { kind: "scroll-entries", delta: 1 },
        model,
        NOTHING_LIVE,
        NARROW,
      );
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
      back = yield* acted(back, { kind: "scroll-entries", delta: -1 }, model, NOTHING_LIVE, NARROW);
    }
    expect(back.viewports.entries).toBe(0);
    expect(
      (yield* catalogOf(reading(back, model, NOTHING_LIVE, NARROW))).map((one) => one.key),
    ).toEqual(shown);
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

    const key = (yield* catalogOf(view))[2]?.key;
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
    const shown = (yield* catalogOf(view)).map((one) => one.key);

    const beyond = model.entries
      .map((entry) => `entry:${entry.key}`)
      .find((key) => !shown.includes(key));
    if (beyond === undefined) {
      throw new Error("every entry was inside the first window");
    }
    const frame = yield* drawn(tree, view, NARROW);
    // Not described, so not mounted, not focusable, not drawn and in no map.
    expect(yield* keysOf(view)).not.toContain(beyond);
    expect(nodeOf(tree, beyond)).toBe(undefined);
    expect(frame.node(beyond)).toBe(undefined);
    // The controls that move the window never scroll away from whoever uses them.
    expect(frame.node("entries:earlier")).toBeDefined();
    expect(frame.node("entries:later")).toBeDefined();

    // Reached by scrolling, it is mounted, placed and offered.
    let at = state;
    for (let press = 0; press < 60; press += 1) {
      const reachedView = reading(at, model, NOTHING_LIVE, NARROW);
      if ((yield* catalogOf(reachedView)).some((one) => one.key === beyond)) {
        const reachedFrame = yield* drawn(tree, reachedView, NARROW);
        expect(nodeOf(tree, beyond)).toBeDefined();
        expect(reachedFrame.targetable(beyond)).toBe(true);
        return;
      }
      at = yield* acted(at, { kind: "scroll-entries", delta: 1 }, model, NOTHING_LIVE, NARROW);
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
      const next = yield* acted(
        narrow,
        { kind: "scroll-entries", delta: 1 },
        model,
        NOTHING_LIVE,
        NARROW,
      );
      if (next.viewports.entries === narrow.viewports.entries) {
        break;
      }
      narrow = next;
    }
    expect(narrow.viewports.entries).toBeGreaterThan(0);

    // The sidebar holds more of the catalog, so the furthest this offset may go
    // is smaller there — and what was stored is now past it.
    const atEnd = yield* acted(
      narrow,
      { kind: "scroll-entries", delta: 1 },
      model,
      NOTHING_LIVE,
      WIDE,
    );
    const furthest = atEnd.viewports.entries;
    expect(furthest).toBeLessThan(narrow.viewports.entries);

    // One press back from the clamped position the frame is drawing, not from
    // the stale larger number: the screen moves on the first press rather than
    // spending it normalizing state nobody can see.
    const stepped = yield* acted(
      narrow,
      { kind: "scroll-entries", delta: -1 },
      model,
      NOTHING_LIVE,
      WIDE,
    );
    expect(stepped.viewports.entries).toBe(furthest - 1);
    expect(
      (yield* catalogOf(reading(stepped, model, NOTHING_LIVE, WIDE))).map((one) => one.key),
    ).not.toEqual(
      (yield* catalogOf(reading(narrow, model, NOTHING_LIVE, WIDE))).map((one) => one.key),
    );
  });
});

/**
 * One entry that prints before it waits on a question.
 *
 * The prose above the question is output the Journal has not settled, so a
 * session holding this entry at its question has a real live overlay — which
 * is the thing a reader looking at an *earlier* entry must not be shown.
 */
const PRINTS_THEN_ASKS = [
  "CHARLIE-LIVE",
  "",
  "```js eval",
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
].join("\n");

/** One entry whose output names itself and nothing else. */
function saying(what: string): string {
  return `${what}\n`;
}

/** The transcript lines this view draws, in order. */
function* transcriptOf(view: ReplView): Operation<string[]> {
  return (yield* describedBy(view))
    .filter((one) => one.key.startsWith("line:") && !one.key.startsWith("line:live:"))
    .map((one) => one.label.trim())
    .filter((label) => label.length > 0);
}

/** The live overlay lines this view draws, in order. */
function* overlayOf(view: ReplView): Operation<string[]> {
  return (yield* describedBy(view))
    .filter((one) => one.key.startsWith("line:live:"))
    .map((one) => one.label.trim());
}

/** The Sessions rows this view draws, in order, with their labels. */
function* sessionsOf(view: ReplView): Operation<Array<{ key: string; label: string }>> {
  return (yield* describedBy(view)).filter((one) => one.key.startsWith("sessions:"));
}

describe("REPL entries: the transcript belongs to the entry that is selected", () => {
  beforeAll(() => useTempFileCompiler());

  it("EU1: each entry shows its own retained transcript, and no other entry's", function* () {
    const physical = new InMemoryStream();
    yield* runEntry(physical, saying("ALPHA-ONE"));
    yield* runEntry(physical, saying("BRAVO-TWO"));
    const model = projected(yield* physical.readAll());
    expect(model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

    const standing = initialState(EXECUTION);
    // Nothing selected is the whole execution, which is what a one-entry
    // execution has always shown and what this must not change.
    const whole = yield* transcriptOf(reading(standing, model, NOTHING_LIVE, WIDE));
    expect(whole).toContain("ALPHA-ONE");
    expect(whole).toContain("BRAVO-TWO");

    const first = yield* transcriptOf(
      reading(selecting(standing, "entry-1"), model, NOTHING_LIVE, WIDE),
    );
    expect(first).toContain("ALPHA-ONE");
    expect(first).not.toContain("BRAVO-TWO");

    const second = yield* transcriptOf(
      reading(selecting(standing, "entry-2"), model, NOTHING_LIVE, WIDE),
    );
    expect(second).toContain("BRAVO-TWO");
    expect(second).not.toContain("ALPHA-ONE");

    // Selecting is what moved it, and it really is a different reading rather
    // than the same one twice.
    expect(first).not.toEqual(second);
  });

  it("EU1: a live overlay belongs to the entry running it, not to the one being read", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(
        yield* submitReplEntry({ execution: holder, source: saying("ALPHA-ONE") }),
      );
      yield* session.join();
      accepted(yield* session.submit(PRINTS_THEN_ASKS));
      const question = yield* asking(session);

      // A real overlay: the second entry has printed and the Journal has not
      // settled that text, which is exactly the state this row is about.
      const live = liveReading(session);
      expect(live.output).toContain("CHARLIE-LIVE");
      const model = session.model;
      expect(model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

      const standing = initialState(EXECUTION);
      // Reading the entry that is running: the overlay is its own, so it shows.
      const running = reading(selecting(standing, "entry-2"), model, live, WIDE);
      expect(yield* overlayOf(running)).toContain("… CHARLIE-LIVE");

      // Reading the settled entry before it: the overlay is somebody else's
      // run, and attributing it here would show text this entry never produced.
      const earlier = reading(selecting(standing, "entry-1"), model, live, WIDE);
      expect(yield* overlayOf(earlier)).toEqual([]);
      expect(yield* transcriptOf(earlier)).toContain("ALPHA-ONE");
      expect(yield* transcriptOf(earlier)).not.toContain("CHARLIE-LIVE");

      // With nothing selected the locus is the execution, which includes
      // whatever is running in it — unchanged from a one-entry execution.
      expect(yield* overlayOf(reading(standing, model, live, WIDE))).toContain("… CHARLIE-LIVE");

      // Sessions is execution-wide and the same reading under every selection,
      // row for row and label for label.
      const sessions = yield* sessionsOf(reading(standing, model, live, WIDE));
      expect(yield* sessionsOf(running)).toEqual(sessions);
      expect(yield* sessionsOf(earlier)).toEqual(sessions);

      question.submit({ decision: "go" });
      yield* session.join();
    });
  });
});

describe("REPL entries: restoring an answer at a narrow size (#875 R1)", () => {
  beforeAll(() => useTempFileCompiler());

  it("EU1: focus returns to the owning entry, revealed through the catalog's own window", function* () {
    const holder = replExecution();
    yield* scoped(function* (): Operation<void> {
      // One entry that records an answer, then enough trivial entries after it
      // that no narrow window can hold the catalog — so the entry that owns the
      // record is below the window a reader has scrolled to the end of.
      const session = opened(yield* submitReplEntry({ execution: holder, source: ASKS }));
      const question = yield* asking(session);
      expect(question.submit({ decision: "go" }).kind).toBe("answered");
      yield* session.join();
      for (let more = 0; more < 16; more += 1) {
        accepted(yield* session.submit(PLAIN));
        yield* session.join();
      }

      const model = session.model;
      // What the file holds before any of the presentation work below, so the
      // claim at the end compares two different readings of it.
      const journal = yield* holder.stream.readAll();
      expect(journal.length).toBeGreaterThan(0);
      const entry = model.entries[0];
      const answered = entry?.scope.elicitations[0];
      expect(answered).toBeDefined();
      if (entry === undefined || answered === undefined) {
        return;
      }
      const base = initialState(EXECUTION);
      const total = entriesRowCount(model);
      const scrolled = Object.freeze({
        ...base,
        route: Object.freeze({ ...base.route, scopes: Object.freeze([entry.scope.key]) }),
        restore: Object.freeze({
          kind: "answered" as const,
          known: Object.freeze([]),
          answer: answered.answer,
        }),
        viewports: Object.freeze({ ...base.viewports, entries: total }),
      });

      const tree = yield* useReplTree<ReplAction>();
      const view = reading(scrolled, model, NOTHING_LIVE, NARROW);
      // A narrow frame draws no inspection region, so the claim is the entry that
      // owns the record rather than the record's own row.
      expect(focusClaim(view)).toBe(`entry:${entry.key}`);

      const window = (yield* contextOf(view)).admission.windows.get(ENTRIES_WINDOW);
      expect(window).toBeDefined();
      // Pre-assert: the catalog is longer than this window, so the offset above
      // really did put the claimed row outside it.
      expect(total).toBeGreaterThan(window?.count ?? 0);
      // Revealed by moving the existing offset as far as it takes, and no
      // further: the claimed row is the first one the window holds.
      expect(window?.from).toBe(0);

      yield* applied(tree, view);
      expect(nodeOf(tree, `entry:${entry.key}`)).toBeDefined();
      expect(keyedBy(tree)).toBe(`entry:${entry.key}`);

      // The claim is spent by the commit that satisfied it — a restoration is one
      // claim, not a standing one — and the reveal it caused is retained in the
      // offset this process holds.
      const committed = (yield* contextOf(view)).admission;
      const settled = focusSettled(view, `entry:${entry.key}`, committed);
      expect(settled.restore).toBeUndefined();

      // A second committed frame, with no claim left to ask for anything — which
      // is where a reveal that was not kept scrolls the catalog back. The window
      // is where the reveal left it, so the row focus landed on is still there,
      // still mounted and still focused.
      const next = reading(settled, model, NOTHING_LIVE, NARROW, `entry:${entry.key}`);
      expect(focusClaim(next)).toBeUndefined();
      expect((yield* contextOf(next)).admission.windows.get(ENTRIES_WINDOW)?.from).toBe(0);
      yield* applied(tree, next);
      expect(nodeOf(tree, `entry:${entry.key}`)).toBeDefined();
      expect(keyedBy(tree)).toBe(`entry:${entry.key}`);

      // Kept in the offset this process holds, which is what made that frame the
      // frame it was — and nothing else of the reading moved with it.
      expect(settled.viewports.entries).toBe(0);
      expect(settled.route).toEqual(scrolled.route);
      expect(settled.draft).toBe(scrolled.draft);

      // And traversal from there is the person's: Tab moves, and the frame after
      // it leaves focus where they moved it rather than reclaiming the row.
      yield* tree.dispatch({ kind: "key", key: "Tab" });
      const moved = keyedBy(tree);
      expect(moved).not.toBe(`entry:${entry.key}`);
      expect(moved).toBeDefined();
      const third = reading(settled, model, NOTHING_LIVE, NARROW, moved);
      expect(focusClaim(third)).toBeUndefined();
      yield* applied(tree, third);
      expect(keyedBy(tree)).toBe(moved);

      // The Journal is untouched by any of it: this is presentation.
      expect(yield* holder.stream.readAll()).toEqual(journal);
    });
  });
});

describe("REPL entries: the catalog keeps its promise at the narrowest sidebar", () => {
  beforeAll(() => useTempFileCompiler());

  /** The widest sidebar is 32 and the narrowest is 28, so this is the frame to prove. */
  const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };

  /** A root name longer than any sidebar, which is what the promise has to survive. */
  const LONG = "a-root-name-nobody-would-choose-but-nothing-forbids";

  it("EU1: every outcome stays inside the drawn row, whatever the entry is called", function* () {
    // Four entries, one per outcome a reader has to tell apart. The cancelled
    // close is doctored exactly as Slice A doctors it — cancelling a live run
    // is the lifecycle boundary, and what this row is about is the drawing.
    const physical = new InMemoryStream();
    yield* runEntry(physical, saying("one"));
    yield* runEntry(physical, FAILING);
    yield* runEntry(physical, saying("three"));
    yield* runEntry(physical, saying("four"));
    const written = yield* physical.readAll();
    const segments = partitioned(written);
    const third = segments[2];
    if (third === undefined) {
      throw new Error("this journal holds four segments");
    }
    const events = withClose(written, third, cancelled("root"));
    const model = projected(events);
    expect(model.entries.map((entry) => entry.terminal?.status)).toEqual([
      "ok",
      "err",
      "cancelled",
      "ok",
    ]);

    // Every entry renamed to something no column can hold. The name is the
    // model's, so this is done by reading the catalog against a model whose
    // roots really are called that.
    const named: ReplModel = Object.freeze({
      ...model,
      entries: Object.freeze(
        model.entries.map((entry) =>
          Object.freeze({
            ...entry,
            scope: Object.freeze({ ...entry.scope, name: `${LONG}-${entry.order}` }),
          }),
        ),
      ),
    });

    const tree = yield* useReplTree<ReplAction>();
    const view = reading(initialState(EXECUTION), named, NOTHING_LIVE, MEDIUM);
    const frame = yield* drawn(tree, view, MEDIUM);

    // Read from the placed cell, clipped to its own bounds: what a renderer may
    // draw is exactly the text inside the region layout gave the row, so a
    // promise that falls outside it is a promise this frame does not keep.
    for (const [at, outcome] of ["ok", "err", "cancelled", "ok"].entries()) {
      const key = `entry:entry-${at + 1}`;
      const cell = frame.node(key);
      if (cell === undefined) {
        throw new Error(`this frame placed no cell for ${key}`);
      }
      const visible = frame.visible(key) ?? "";
      expect([key, visible.includes(`[${outcome}]`)]).toEqual([key, true]);
      // And the name really was too long to have left room after it.
      expect([key, visible.includes(LONG)]).toEqual([key, false]);
    }

    // The fourth reading, from a prefix where the last entry has not closed.
    const admission = model.entries[3]?.scope.marker;
    if (admission === undefined) {
      throw new Error("an admitted entry has an admission marker");
    }
    const open = projected(events, admission);
    const renamedOpen: ReplModel = Object.freeze({
      ...open,
      entries: Object.freeze(
        open.entries.map((entry) =>
          Object.freeze({
            ...entry,
            scope: Object.freeze({ ...entry.scope, name: `${LONG}-${entry.order}` }),
          }),
        ),
      ),
    });
    const frozen = frozenAt(initialState(EXECUTION), admission);
    const openFrame = yield* drawn(
      tree,
      reading(frozen, renamedOpen, NOTHING_LIVE, MEDIUM),
      MEDIUM,
    );
    const last = openFrame.node("entry:entry-4");
    if (last === undefined) {
      throw new Error("this frame placed no cell for entry:entry-4");
    }
    expect(openFrame.visible("entry:entry-4") ?? "").toContain("[unfinished]");
  });
});

describe("REPL entries: going to Sessions keeps the entry you came from", () => {
  beforeAll(() => useTempFileCompiler());

  it("ER1: the selected entry survives both surfaces, and comes back with you", function* () {
    const { events } = yield* twoEntries();
    const model = projected(events);
    const standing = selecting(drafting(initialState(EXECUTION), "next"), "entry-2");

    // Going to Sessions keeps the entry. It used to be unspellable there, so
    // the location this produced could not be encoded at all.
    const sessions = yield* acted(standing, { kind: "select-surface", surface: "sessions" }, model);
    expect(sessions.route.surface).toBe("sessions");
    expect(sessions.route.scopes).toEqual(["entry-2"]);
    expect(sessions.draft).toBe("next");
    const onSessions = reading(sessions, model, NOTHING_LIVE, WIDE);
    expect(onSessions.location).toContain("/sessions/entry-2");
    expect(onSessions.selection.entry?.key).toBe("entry-2");

    // And coming back lands on the entry that was left, rather than on nothing.
    const back = yield* acted(sessions, { kind: "select-surface", surface: "entries" }, model);
    expect(back.route.surface).toBe("entries");
    expect(back.route.scopes).toEqual(["entry-2"]);
    expect(reading(back, model, NOTHING_LIVE, WIDE).selection.entry?.key).toBe("entry-2");
    expect(back.draft).toBe("next");

    // The round trip is one location either way, and it reads back the same.
    expect(reading(back, model, NOTHING_LIVE, WIDE).location).toBe(
      reading(standing, model, NOTHING_LIVE, WIDE).location,
    );
  });
});

describe("REPL entries: what each prefix of a two-entry history shows", () => {
  beforeAll(() => useTempFileCompiler());

  it("EH1: before an admission, at it, and at the outcome, with the draft throughout", function* () {
    const physical = new InMemoryStream();
    yield* runEntry(physical, saying("ALPHA-ONE"));
    yield* runEntry(physical, saying("BRAVO-TWO"));
    const events = yield* physical.readAll();
    const head = projected(events);
    expect(head.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);

    const admission = head.entries[1]?.scope.marker;
    const terminal = head.entries[1]?.checkpoints[head.entries[1].checkpoints.length - 1]?.marker;
    if (admission === undefined || terminal === undefined) {
      throw new Error("the second entry has an admission and a terminal position");
    }
    // A position strictly before the second entry was admitted: the first
    // entry's own close, which is the last thing that happened before it.
    const before = "close:root";

    /** What one prefix's catalog says, as a reader reads it. */
    const catalogAt = function* (marker: string): Operation<string[]> {
      const state = frozenAt(drafting(initialState(EXECUTION), "still typing"), marker);
      const model = projected(events, marker);
      return (yield* catalogOf(reading(state, model, NOTHING_LIVE, WIDE))).map((one) =>
        one.label.trim(),
      );
    };

    // [1] Before the admission: one entry, settled, and no sign of the next.
    expect(yield* catalogAt(before)).toEqual(["1. [ok] entry-1"]);

    // [2] At the admission: the row exists and says it has settled nothing.
    expect(yield* catalogAt(admission)).toEqual(["1. [ok] entry-1", "2. [unfinished] entry-2"]);

    // [3] At its terminal position: the same row, now carrying its outcome.
    expect(yield* catalogAt(terminal)).toEqual(["1. [ok] entry-1", "2. [ok] entry-2"]);

    // Each prefix shows only what it retained. The second entry's output is in
    // none of the readings before its own close.
    const linesAt = function* (marker: string): Operation<string[]> {
      const state = frozenAt(drafting(initialState(EXECUTION), "still typing"), marker);
      return yield* transcriptOf(reading(state, projected(events, marker), NOTHING_LIVE, WIDE));
    };
    expect(yield* linesAt(before)).toContain("ALPHA-ONE");
    expect(yield* linesAt(before)).not.toContain("BRAVO-TWO");
    expect(yield* linesAt(admission)).not.toContain("BRAVO-TWO");
    expect(yield* linesAt(terminal)).toContain("BRAVO-TWO");

    // The draft is current route state throughout: it is not a thing a prefix
    // retained, so freezing the durable view does not freeze it.
    for (const marker of [before, admission, terminal]) {
      const state = frozenAt(drafting(initialState(EXECUTION), "still typing"), marker);
      const view = reading(state, projected(events, marker), NOTHING_LIVE, WIDE);
      expect([marker, view.state.draft]).toEqual([marker, "still typing"]);
      expect([marker, view.location.includes("draft=still%20typing")]).toEqual([marker, true]);
      // And it is still editable at every one of them.
      const typed = yield* acted(
        state,
        { kind: "type", text: "!" },
        projected(events, marker),
        NOTHING_LIVE,
        WIDE,
      );
      expect([marker, typed.draft]).toEqual([marker, "still typing!"]);
    }

    // Returning live from any of them restores the head catalog and keeps it.
    for (const marker of [before, admission, terminal]) {
      const state = frozenAt(drafting(initialState(EXECUTION), "still typing"), marker);
      const live = yield* acted(
        state,
        { kind: "go-live" },
        projected(events, marker),
        NOTHING_LIVE,
        WIDE,
      );
      expect(live.route.at).toBe(undefined);
      expect(live.draft).toBe("still typing");
      expect(
        (yield* catalogOf(reading(live, head, NOTHING_LIVE, WIDE))).map((one) => one.label.trim()),
      ).toEqual(["1. [ok] entry-1", "2. [ok] entry-2"]);
    }
  });
});

/** One entry that reads the inherited value again, and reports what it got. */
const READS_INHERITED_AGAIN = [
  "```js eval",
  "const third = `${plan.steps.join('/')}/${plan.counts.runs}`;",
  "```",
  "",
  "Three: {third}",
  "",
].join("\n");

describe("REPL entries: a third entry inherits the file, not the run before it", () => {
  beforeAll(() => useTempFileCompiler());

  it("EC1: an edit the entry before it never published reaches no successor", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      // Entry 1 publishes a nested value. Entry 2 inherits it and edits what it
      // inherited — ordinary mutation of an ordinary binding, which publishes
      // nothing, so the two readings of `plan` diverge from here on: the file
      // holds what Entry 1 retained and this process holds what Entry 2 made of
      // it.
      const session = opened(
        yield* submitReplEntry({ execution: holder, source: PUBLISHES_NESTED }),
      );
      yield* session.join();
      accepted(yield* session.submit(EDITS_INHERITED));
      yield* session.join();
      expect(session.model.entries[1]?.terminal?.output).toContain("Two: draft/build/2");
      // Entry 2 published `seen` and no new `plan`, so the last durably
      // published `plan` is still the one Entry 1 wrote.
      expect(session.model.entries[1]?.bindings.map((one) => one.name)).toContain("seen");
      expect(value(session.model.entries[1].bindings, "plan")).toEqual({
        steps: ["draft"],
        counts: { runs: 1 },
      });

      // Entry 3 therefore starts from the file's value, not from the array the
      // run before it was holding when it ended.
      accepted(yield* session.submit(READS_INHERITED_AGAIN));
      yield* session.join();
      expect(session.model.entries[2]?.terminal?.output).toContain("Three: draft/1");
      expect(session.model.entries[2]?.terminal?.output).not.toContain("build");
    });
  });
});

/**
 * Which refusals the screen is allowed to forget (#870 UI11/UI12).
 *
 * Three refusals reach one decision and only one of them goes stale. Readiness
 * refuses a *moment*: the entry it names finishes and it stops being true, and a
 * screen still showing it would contradict the sentence above it. A document that
 * cannot be admitted and a form that does not validate are refusals of the thing
 * itself — they stay true however the execution moves on, and dropping one would
 * take away the only explanation of why somebody's draft is still sitting there.
 *
 * So the classification has to be exact in both directions, and it cannot be the
 * class or the name: `instanceof` silently answers no across loaded copies, and
 * `name` is an ordinary writable property that anything can carry.
 */
describe("REPL entries: which refusal the screen may forget", () => {
  it("UI12: the session's own lifecycle refusal is recognized, and carries its reason", function* () {
    const refusal = new ReplLifecycleError("this execution's entry-1 has not finished.");
    expect(lifecycleRefusal(refusal)).toBe("this execution's entry-1 has not finished.");
  });

  it("UI12: an ordinary error merely named ReplLifecycleError is not one", function* () {
    // The name is writable, so this is what a forgery costs: nothing. If the
    // screen classified by it, any failure at all could claim to be a refusal
    // this session never gave and be dropped the moment readiness moved.
    const forged = new Error("this execution's entry-1 has not finished.");
    forged.name = "ReplLifecycleError";
    expect(lifecycleRefusal(forged)).toBe(undefined);
  });

  it("UI12: a refusal marked by another loaded copy is recognized", function* () {
    // What a separately loaded copy of this module produces: not our class, and
    // not our symbol — the same namespaced own-property, which is the whole
    // reason the mark is a string rather than either of those.
    const elsewhere = new Error("this session is ending, so it starts no further entry.");
    Object.defineProperty(elsewhere, "executablemd.cli.repl.lifecycleRefusal", {
      value: "this session is ending, so it starts no further entry.",
      enumerable: false,
    });
    expect(lifecycleRefusal(elsewhere)).toBe(
      "this session is ending, so it starts no further entry.",
    );
  });

  it("UI12: an inherited mark is not an own mark", function* () {
    // Created *from* something marked. It answers the same for a property read,
    // which is why the parser reads an own descriptor and never the property:
    // inheriting the shape of a refusal is not having been refused.
    const marked = markLifecycleRefusal(new Error("carried"), "carried");
    const inheriting: unknown = Object.create(marked);
    expect(lifecycleRefusal(inheriting)).toBe(undefined);
  });

  it("UI12: an empty or malformed mark is rejected", function* () {
    const empty = new Error("empty");
    Object.defineProperty(empty, "executablemd.cli.repl.lifecycleRefusal", {
      value: "",
      enumerable: false,
    });
    expect(lifecycleRefusal(empty)).toBe(undefined);

    for (const payload of [undefined, null, 0, true, {}, ["a reason"], () => "a reason"]) {
      const malformed = new Error("malformed");
      Object.defineProperty(malformed, "executablemd.cli.repl.lifecycleRefusal", {
        value: payload,
        enumerable: false,
      });
      expect([payload, lifecycleRefusal(malformed)]).toEqual([payload, undefined]);
    }
  });

  it("UI12: an unmarked error, and a value that is not one, are not refusals", function* () {
    expect(lifecycleRefusal(new Error("ordinary"))).toBe(undefined);
    for (const value of [undefined, null, "a string", 7, {}]) {
      expect([value, lifecycleRefusal(value)]).toEqual([value, undefined]);
    }
  });

  it("UI12: the reason is the marked one, and rewriting the message cannot change it", function* () {
    const refusal = new ReplLifecycleError("this execution's entry-1 has not finished.");
    // What the session normalized when it refused, which is what the screen is
    // meant to show.
    expect(lifecycleRefusal(refusal)).toBe("this execution's entry-1 has not finished.");

    // `message` is an ordinary writable property. Anything holding this error can
    // rewrite it, and a screen that displayed `message` while authenticating the
    // mark would show text the session never said.
    refusal.message = "Entry 1 is ready — press Enter to submit";
    expect(refusal.message).toBe("Entry 1 is ready — press Enter to submit");
    expect(lifecycleRefusal(refusal)).toBe("this execution's entry-1 has not finished.");
    expect(lifecycleRefusal(refusal)).not.toBe(refusal.message);
  });

  it("UI12: the mark is non-enumerable, so copying and serializing drop it", function* () {
    const refusal = new ReplLifecycleError("this execution's entry-1 has not finished.");
    // A wrapper that means to pass the classification on marks its own; one that
    // merely copies the fields must not inherit the right to be forgotten.
    const copied: unknown = { ...refusal };
    expect(lifecycleRefusal(copied)).toBe(undefined);
    expect(Object.keys(refusal)).not.toContain("executablemd.cli.repl.lifecycleRefusal");
  });
});

/**
 * Every readiness is a different sentence, at both sizes (#870 UI10).
 *
 * One row per state the contract distinguishes, read off the guidance the
 * application describes rather than off the reducer's shape. The history under
 * each one is a real projected journal and the live half is this process's own
 * fact, because readiness is the pair: a close is recorded while the task that
 * produced it is still unwinding, and a screen reading only the file would offer
 * the next entry into a teardown that has not finished.
 */
describe("REPL entries: what the screen says the execution is doing", () => {
  beforeAll(() => useTempFileCompiler());

  /** The contextual guidance this view describes, at one size. */
  function* stateRow(
    state: ReplState,
    model: ReplModel,
    live: ReplLive,
    size: ReplTerminalSize,
  ): Operation<string> {
    const row = (yield* describedBy(reading(state, model, live, size))).find(
      (one) => one.key === "guidance",
    );
    if (row === undefined) {
      throw new Error("this view described no guidance row");
    }
    return row.label;
  }

  it("UI10: ready, running, waiting, settling, unfinished and complete each read differently", function* () {
    const nothing = projectRepl([]);
    if (!nothing.ok) {
      throw nothing.error;
    }
    const EMPTY_MODEL = nothing.value;
    const holder = replExecution();
    yield* scoped(function* () {
      // Nothing admitted and nothing running.
      const empty = initialState(EXECUTION);
      for (const size of [WIDE, NARROW]) {
        expect([size.columns, yield* stateRow(empty, EMPTY_MODEL, NOTHING_LIVE, size)]).toEqual([
          size.columns,
          `Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move`,
        ]);
      }

      // A real entry, admitted and waiting on a real question.
      const session = opened(yield* submitReplEntry({ execution: holder, source: ASKS }));
      const question = yield* asking(session);
      const waiting = liveReading(session);
      const unsettled = session.model;
      expect(unsettled.settled).toBe(false);
      expect(waiting.running).toBe(true);
      const state = initialState(EXECUTION);

      // Waiting for an answer: the long spelling where there is room, the short
      // one where there is not, and the way to reach it either way.
      expect(yield* stateRow(state, unsettled, waiting, WIDE)).toContain(
        "Entry 1 waiting for an answer · activate answer",
      );
      expect(yield* stateRow(state, unsettled, waiting, NARROW)).toBe(
        "Entry 1 question · activate answer · Type here · Tab/Shift+Tab move",
      );

      // The same history with no question outstanding: running, and Enter is not
      // a submission until it finishes.
      const busy: ReplLive = { ...waiting, question: undefined };
      expect(yield* stateRow(state, unsettled, busy, WIDE)).toContain(
        "Entry 1 running · Enter unavailable until it finishes",
      );
      expect(yield* stateRow(state, unsettled, busy, NARROW)).toBe(
        "Entry 1 running · Enter unavailable · Type here · Tab/Shift+Tab move",
      );

      // Admitted, no outcome, and nothing running it. The file is what decides
      // that an entry never finished, so no successor may start however idle it
      // looks — this is the cold and interrupted case.
      const abandoned: ReplLive = { ...busy, running: false };
      expect(yield* stateRow(state, unsettled, abandoned, WIDE)).toContain(
        "Entry 1 unfinished · no successor can start",
      );
      expect(yield* stateRow(state, unsettled, abandoned, NARROW)).toBe(
        "Entry 1 unfinished · no successor · Type here · Tab/Shift+Tab move",
      );

      // Answered, and joined.
      question.submit({ decision: "go" });
      yield* session.join();
      const settled = session.model;
      expect(settled.settled).toBe(true);
      expect(session.live).toBe(false);

      // The close is recorded and the task is joined: the next entry may start.
      expect(yield* stateRow(state, settled, liveReading(session), WIDE)).toContain(
        "Ready for Entry 2 · Enter submits",
      );

      // The same recorded close while the task that produced it is still
      // unwinding. This is the one distinction the durable side cannot make, and
      // the reason the view carries the live half at all.
      const tearing: ReplLive = { ...liveReading(session), running: true };
      expect(yield* stateRow(state, settled, tearing, WIDE)).toContain(
        "Entry 1 settling · Enter unavailable until teardown finishes",
      );
      expect(yield* stateRow(state, settled, tearing, NARROW)).toBe(
        "Entry 1 settling · Enter unavailable · Type here · Tab/Shift+Tab move",
      );

      // And every one of them is a different sentence.
      const said = new Set([
        yield* stateRow(empty, EMPTY_MODEL, NOTHING_LIVE, NARROW),
        yield* stateRow(state, unsettled, waiting, NARROW),
        yield* stateRow(state, unsettled, busy, NARROW),
        yield* stateRow(state, unsettled, abandoned, NARROW),
        yield* stateRow(state, settled, liveReading(session), NARROW),
        yield* stateRow(state, settled, tearing, NARROW),
      ]);
      expect(said.size).toBe(6);
      for (const row of said) {
        expect([row, row.length <= NARROW.columns]).toEqual([row, true]);
      }
    });
  });
});

/**
 * A frozen position says what is unavailable, and keeps the draft (#870 UI15).
 *
 * The prefix is a reading of the file, not of this process. What the live head is
 * doing is not a fact about the position being inspected, so the sentence is
 * about the position and the live-only controls are absent — while the draft,
 * which belongs to no position, is untouched.
 */
describe("REPL entries: what a frozen position says is unavailable", () => {
  beforeAll(() => useTempFileCompiler());

  it("UI15: History says submission is unavailable, hides live-only controls, and keeps the draft", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: ASKS }));
      const question = yield* asking(session);
      question.submit({ decision: "go" });
      yield* session.join();
      const model = session.model;
      const marker = model.entries[0]?.transcript[0]?.marker;
      if (marker === undefined) {
        throw new Error("the recorded entry has no position to inspect");
      }

      const DRAFT_TEXT = "kept across the position";
      const typed = drafting(initialState(EXECUTION), DRAFT_TEXT);
      const frozen = frozenAt(typed, marker);

      // The live half says an entry is running and a question is waiting. None of
      // it may reach this reading: a prefix that borrowed the head's facts would
      // describe an execution this view is not of.
      const head: ReplLive = {
        output: "live output nobody at this position has seen",
        question: session.overlay.question,
        expansion: "playing",
        pausable: true,
        running: true,
        agent: NO_AGENT,
        lifecycle: NO_LIFECYCLE,
      };

      // Projected *at* the position, because a prefix is a different reading of
      // the same file rather than a filter over the head.
      const prefix = projectRepl(yield* holder.stream.readAll(), marker);
      if (!prefix.ok) {
        throw prefix.error;
      }
      for (const size of [WIDE, NARROW]) {
        const rows = yield* describedBy(reading(frozen, prefix.value, head, size));
        const guidance = rows.find((one) => one.key === "guidance")?.label ?? "";
        // The state is the position, and it says Enter is not a submission here.
        expect([size.columns, guidance.startsWith("History · Enter unavailable")]).toEqual([
          size.columns,
          true,
        ]);
        expect([size.columns, guidance.includes("activate live")]).toEqual([size.columns, true]);
        expect([size.columns, guidance.includes("Enter submits")]).toEqual([size.columns, false]);
        expect([size.columns, guidance.length <= size.columns]).toEqual([size.columns, true]);

        // The way back is a control on the screen, and the live-only ones are not
        // on it at all: there is nothing here to pause and no question to answer.
        const keys = new Set(rows.map((one) => one.key));
        expect([size.columns, keys.has("footer:live")]).toEqual([size.columns, true]);
        for (const absent of ["footer:pause", "footer:continue", "footer:asked"]) {
          expect([size.columns, absent, keys.has(absent)]).toEqual([size.columns, absent, false]);
        }

        // And the draft, which belongs to no position, is exactly what was typed.
        expect([size.columns, rows.find((one) => one.key === "footer:input")?.label]).toEqual([
          size.columns,
          DRAFT_TEXT,
        ]);
      }

      // Returning to the head restores the readiness of the head, with the same
      // draft still in hand.
      const live = yield* describedBy(reading(typed, model, liveReading(session), WIDE));
      expect(live.find((one) => one.key === "guidance")?.label).toContain("Ready for Entry 2");
      expect(live.find((one) => one.key === "footer:input")?.label).toBe(DRAFT_TEXT);
    });
  });
});

/**
 * A recorded close is not a joined task, and the screen says which (#870 UI11).
 *
 * The one state the durable side cannot describe. The root close is in the file —
 * the catalog shows an outcome, `model.settled` is true — while the task that
 * wrote it is still coming down, and a submission taken in that window has
 * nowhere to go. A screen reading only the file would offer the next entry into a
 * teardown that has not finished.
 *
 * Held by a latch rather than by waiting: the entry owns an installation whose
 * `ensure` signals that it has been entered and then parks on a resolver this row
 * opens. Nothing here is produced by elapsed time. The only timing is the bounded
 * wait that keeps a genuine deadlock from reporting as a hang.
 */
describe("REPL entries: a retained close while the task is still coming down", () => {
  beforeAll(() => useTempFileCompiler());

  /** The contextual guidance this view describes. */
  function* guidanceOf(state: ReplState, model: ReplModel, live: ReplLive): Operation<string> {
    const row = (yield* describedBy(reading(state, model, live, WIDE))).find(
      (one) => one.key === "guidance",
    );
    if (row === undefined) {
      throw new Error("this view described no guidance row");
    }
    return row.label;
  }

  it("UI11: settling refuses the next entry, and releasing teardown reads ready with no input", function* () {
    const holder = replExecution();
    const entered = gate();
    const release = gate();
    yield* scoped(function* () {
      // Released from inside this scope as well as outside it: an assertion that
      // throws while the finalizer is parked would otherwise deadlock the
      // teardown it is holding, and a deadlock reports as a timeout rather than
      // as the assertion that failed.
      try {
        const session = opened(
          yield* submitReplEntry({
            execution: holder,
            source: FIRST,
            installations: [holdingTeardown(entered, release)],
          }),
        );
        // Both halves true at once, which is the whole point of the latch: the
        // close is durably projected, and the task that wrote it has not finished.
        yield* awaiting("the entry reaching its own teardown", entered.opened);
        expect(session.model.settled).toBe(true);
        expect(session.model.entries[0]?.terminal?.status).toBe("ok");
        expect(session.live).toBe(true);

        // A draft typed while it comes down, and a form message about something
        // else entirely, so this row can tell the two refusals apart.
        const DRAFT_TEXT = "the next entry, typed while the last one settles";
        const typed = Object.freeze({
          ...drafting(initialState(EXECUTION), DRAFT_TEXT),
          form: Object.freeze({
            ...initialState(EXECUTION).form,
            messages: Object.freeze([{ field: "decision", message: "decision is required" }]),
          }),
        });

        // The screen says settling, and says that Enter is not a submission yet.
        const settling = yield* guidanceOf(typed, session.model, liveReading(session));
        expect(settling).toContain("Entry 1 settling");
        expect(settling).toContain("Enter unavailable until teardown finishes");
        expect(settling).not.toContain("Enter submits");

        // And the session refuses, as a lifecycle refusal and recognisably so.
        const refused = refusedSubmission(yield* session.submit(INHERITING));
        expect(lifecycleRefusal(refused)).toBe(refused.message);
        // Nothing started and nothing was written: one entry, one admission.
        expect(started(yield* holder.stream.readAll())).toBe(1);
        expect(session.model.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
        // The draft is exactly what was typed, and the form message is still the
        // form's own.
        expect(typed.draft).toBe(DRAFT_TEXT);
        expect(typed.form.messages[0]?.message).toBe("decision is required");

        // Released — and nothing is typed. The only thing that changes is that
        // the teardown finishes.
        release.open();
        yield* session.join();
        expect(session.live).toBe(false);

        // The same state, the same draft, the same form message: the screen now
        // reads ready, because the other half of the fact changed.
        const ready = yield* guidanceOf(typed, session.model, liveReading(session));
        expect(ready).toContain("Ready for Entry 2");
        expect(ready).toContain("Enter submits");
        expect(ready).not.toContain("settling");
        expect(typed.form.messages[0]?.message).toBe("decision is required");

        // And the preserved draft is admissible now, which is what the refusal
        // was only ever saying about a moment.
        accepted(yield* session.submit(typed.draft));
        yield* session.join();
        expect(session.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      } finally {
        release.open();
      }
    });
  });
});

/**
 * A failed entry says what it failed with (#870 UI13).
 *
 * The Journal already carries the parsed message; the catalog's `[err]` says only
 * that something went wrong. An outcome without its reason is a reader being
 * shown that their entry failed and being sent to the file to find out what.
 *
 * What it must not become is the record. A real compiler failure runs to hundreds
 * of characters and embeds the whole generated module as a `data:` URI, so the row
 * is flattened to one line and cut — every newline would otherwise become another
 * cell and push the footer and every control off the screen.
 */
describe("REPL entries: what a failed entry says it failed with", () => {
  beforeAll(() => useTempFileCompiler());

  /** The transcript rows this model describes, by label. */
  function* transcript(model: ReplModel): Operation<string[]> {
    return (yield* describedBy(reading(initialState(EXECUTION), model, NOTHING_LIVE, WIDE)))
      .filter((one) => one.key.startsWith("line:"))
      .map((one) => one.label);
  }

  it("UI13: the recorded reason is on the screen, bounded, and a cold reopen says the same", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      // A real failure from a real compile: `await` is not available inside an
      // eval block, which the engine reports with the whole generated module
      // inlined as a `data:` URI.
      const FAILS = ["```ts eval", "await Promise.resolve(1)", "```", ""].join("\n");
      const session = opened(yield* submitReplEntry({ execution: holder, source: FAILS }));
      yield* session.join();

      const terminal = session.model.entries[0]?.terminal;
      expect(terminal?.status).toBe("err");
      const recorded = terminal?.message ?? "";
      expect(recorded.length).toBeGreaterThan(80);

      const live = yield* transcript(session.model);
      const failed = live.find((one) => one.startsWith("failed: "));
      expect(failed).toBeDefined();
      // The compact outcome is still there, beside the reason rather than
      // replaced by it.
      expect(live).toContain("closed err");

      // One line, and bounded by the region it will be drawn in rather than by a
      // constant: the row that carries it is cut to where it lands, and the row
      // below asserts that against the real placement at three sizes.
      expect(failed?.includes("\n")).toBe(false);
      expect((failed ?? "").length).toBeLessThanOrEqual(
        WIDE.columns - (sidebarWidth(WIDE) ?? 0) - (inspectionWidth(WIDE) ?? 0),
      );
      // What is drawn is the *recorded* reason, flattened and cut — compared
      // against the message this run actually produced rather than against a
      // phrase. The phrase is the engine's: Deno compiles an eval block with V8
      // and says "Unexpected reserved word", while Node and Bun reach it through
      // esbuild and say "Transform failed". Asserting either one makes this row a
      // claim about whichever runtime happened to write it.
      const shown = (failed ?? "").slice("failed: ".length).replace(/…$/, "");
      expect(shown.length).toBeGreaterThan(0);
      expect(recorded.replace(/\s+/g, " ").trim().startsWith(shown)).toBe(true);
      // And it is the message, not the serialized record around it.
      expect(failed).not.toContain("stack");
      expect(failed).not.toContain('"name"');

      // Cold: the same file, projected again, with nothing run. `projectRepl` is a
      // pure reading of the events — no compile, no provider, no execution — and
      // it answers with the same reason on the same row.
      const cold = projectRepl(yield* holder.stream.readAll());
      if (!cold.ok) {
        throw cold.error;
      }
      expect(cold.value.entries[0]?.terminal?.message).toBe(recorded);
      expect((yield* transcript(cold.value)).find((one) => one.startsWith("failed: "))).toBe(
        failed,
      );
    });
  });

  it("UI13: the reason is drawn inside its region at every supported size, footer untouched", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const FAILS = ["```ts eval", "await Promise.resolve(1)", "```", ""].join("\n");
      const session = opened(yield* submitReplEntry({ execution: holder, source: FAILS }));
      yield* session.join();
      // With the failed entry selected, so its transcript is the reading on every
      // profile: a narrow frame mounts one routed outlet, and the catalog is what
      // it shows until an entry is chosen.
      const entry = session.model.entries[0]?.key ?? "";
      const state = Object.freeze({
        ...initialState(EXECUTION),
        route: Object.freeze({ ...initialState(EXECUTION).route, entry }),
      });

      // Through the real placement boundary, because the claim is about drawn
      // cells. A described row that is wider than the region it lands in is
      // reflowed into rows the layout never allocated — and the renderer's cut
      // would take the ellipsis with it, so the row would end mid-word with
      // nothing saying it had been shortened.
      for (const size of [WIDE, { columns: 120, rows: 30 }, NARROW]) {
        const tree = yield* useReplTree<ReplAction>();
        const view = reading(state, session.model, NOTHING_LIVE, size);
        const frame = yield* drawn(tree, view, size);

        const cells = frame.keys
          .filter((key) => key.startsWith("line:"))
          .map((key) => ({ key, text: frame.cell(key) ?? "", bounds: frame.bounds(key) }));
        const failed = cells.find((cell) => cell.text.startsWith("failed: "));
        const region = frame.region("transcript");

        if (region === undefined) {
          // The narrow profile mounts one routed outlet, and the transcript is
          // not one of them: `content` carries the navigation and whichever
          // catalog the route chose. No transcript row is placed at this size at
          // all, which is asserted rather than assumed — a reason that cannot be
          // drawn cannot overflow, and a row claiming to measure one here would
          // be measuring nothing.
          expect([size.columns, cells.length]).toEqual([size.columns, 0]);
          expect([size.columns, failed]).toEqual([size.columns, undefined]);
        } else {
          expect([size.columns, failed !== undefined]).toEqual([size.columns, true]);
          const drawn = failed?.bounds;
          // Inside its own region, by its own geometry: it starts where the
          // region starts and ends before the region ends.
          expect([size.columns, (drawn?.x ?? -1) >= region.x]).toEqual([size.columns, true]);
          expect([
            size.columns,
            (drawn?.x ?? 0) + (failed?.text.length ?? 0) <= region.x + region.width,
          ]).toEqual([size.columns, true]);
          // One row, which is what keeps everything below it where it was.
          expect([size.columns, drawn?.height]).toEqual([size.columns, 1]);
          // And it says so wherever it had to be shortened, rather than ending
          // mid-word with the mark cut off by the renderer.
          if ((failed?.text.length ?? 0) === region.width) {
            expect([size.columns, failed?.text.endsWith("…")]).toEqual([size.columns, true]);
          }
        }

        // The footer is exactly where it always is: the reason did not push a
        // single row of it anywhere.
        const footer = frame.region("footer");
        expect([size.columns, footer?.height]).toEqual([size.columns, 7]);
        expect([size.columns, footer?.y]).toEqual([size.columns, size.rows - 7]);
        expect([size.columns, footer?.width]).toEqual([size.columns, size.columns]);
      }
    });
  });

  it("UI13: an entry that did not fail is given no failure text", function* () {
    const holder = replExecution();
    yield* scoped(function* () {
      const session = opened(yield* submitReplEntry({ execution: holder, source: FIRST }));
      yield* session.join();
      expect(session.model.entries[0]?.terminal?.status).toBe("ok");
      // Nothing invented: an `ok` outcome has no reason, and a row saying it
      // failed would describe a failure that did not happen.
      for (const row of yield* transcript(session.model)) {
        expect([row, row.startsWith("failed: ")]).toEqual([row, false]);
      }
    });
  });
});
