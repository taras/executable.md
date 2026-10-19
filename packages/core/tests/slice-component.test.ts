/**
 * Tier SL1 — `<Slice>` (spec §6.21).
 *
 * The contract is an exact string, so the assertions are exact strings. Every
 * window case compares a whole rendering or a whole captured value, never a
 * substring and never a trimmed one: the note's own wording, the interval it
 * reports and the payload beside it are one result, and asserting on pieces of
 * it would let a wrong total or a trimmed payload read as correct. Nothing here
 * installs the `DocumentOutput` middleware, so what is compared is what the
 * component returned.
 *
 * The cases drive core's registered component through `execute()`, because what
 * is being proved is the component an author reaches — its ordinary prop
 * validation, its one `content()` call and the capture boundary around it.
 * Expanding segments directly would prove none of those.
 *
 * Four fixtures travel with the documents. `<Value>` puts an arbitrary string
 * in scope without an eval block, because a document cannot author a four
 * thousand point log as a literal. `<Probe>` reads a binding back out at the
 * ordinary prop boundary, which is the boundary a repository override receives.
 * `<Tripwire>` is written inside content a refused invocation must not expand,
 * so a body that ran anyway is counted rather than inferred. `<Held>` is the
 * controlled producer: it announces that it started, registers its own cleanup,
 * waits to be released, and only then returns a structured value — which is how
 * completion, cleanup and cancellation are observed without sleeping on
 * anything.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { useStubFs } from "@executablemd/runtime/test";
import { InMemoryStream } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { ComponentRegistration } from "../src/components/registration.ts";
import type { Json } from "../src/types.ts";

interface Run {
  /** Everything the document emitted, before any output middleware. */
  output: string;
  /** The run's own outcome: a failure nothing printed settles here. */
  failure: string;
  /** Every `value` a `<Probe>` was handed, in invocation order. */
  probed: Json[];
  /** How many times the refused-form tripwire expanded. */
  tripped: number;
}

/** Everything a run reported, printed or settled. */
function reported(result: Run): string {
  return `${result.output}\n${result.failure}`;
}

/** What one `<Held>` producer did, counted rather than timed. */
interface Producer {
  starts: number;
  completions: number;
  cleanups: number;
}

/** The two signals a row drives one `<Held>` producer by, and what it recorded. */
interface Harness {
  /** Resolves once the producer has started and is parked. */
  entered: Operation<void>;
  /** Announces that it has started, from inside the producer. */
  enter: () => void;
  /** What the producer waits on before it may return. */
  gate: Operation<void>;
  /** Releases that wait. */
  release: () => void;
  producer: Producer;
}

/** The registrations every document here resolves. */
function fixtures(
  values: Record<string, string>,
  probed: Json[],
  trip: () => void,
  harness: Harness | undefined,
): ComponentRegistration[] {
  const registrations: ComponentRegistration[] = [
    {
      name: "Value",
      origin: "tier-sl1",
      props: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<unknown> {
        return values[String(props.key)];
      },
    },
    {
      name: "Probe",
      origin: "tier-sl1",
      props: {
        type: "object",
        properties: { value: {} },
        required: ["value"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        probed.push(props.value);
        return "";
      },
    },
    {
      name: "Tripwire",
      origin: "tier-sl1",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        trip();
        return "TRIPPED";
      },
    },
  ];
  if (harness === undefined) {
    return registrations;
  }
  const held: ComponentRegistration = {
    name: "Held",
    origin: "tier-sl1",
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<Json> {
      harness.producer.starts += 1;
      // Registered before the wait it covers, so a producer halted while it is
      // parked still unwinds through its own cleanup.
      yield* ensure(() => {
        harness.producer.cleanups += 1;
      });
      harness.enter();
      yield* harness.gate;
      harness.producer.completions += 1;
      return { held: true, size: 3 };
    },
  };
  return [...registrations, held];
}

/** A producer nobody has released yet. */
function controlled(): Harness {
  const started = withResolvers<void>();
  const gate = withResolvers<void>();
  const producer: Producer = { starts: 0, completions: 0, cleanups: 0 };
  return {
    entered: started.operation,
    enter: () => started.resolve(),
    gate: gate.operation,
    release: () => gate.resolve(),
    producer,
  };
}

/** Run `source` as the document, with `values` reachable through `<Value>`. */
function run(
  source: string,
  values: Record<string, string> = {},
  harness?: Harness,
): Operation<Run> {
  return scoped(function* () {
    const probed: Json[] = [];
    let tripped = 0;

    yield* useStubFs({ "doc.md": source });
    yield* registerComponents(
      fixtures(
        values,
        probed,
        () => {
          tripped += 1;
        },
        harness,
      ),
    );

    const execution = yield* execute({ path: "doc.md", stream: new InMemoryStream() });
    const output = yield* forEach(function* () {}, execution.output);
    const outcome = yield* execution;
    return {
      output,
      failure: outcome.ok ? "" : outcome.error.message,
      probed,
      tripped,
    };
  });
}

/** The note a partial window carries, spelled once for every row that reads it. */
function note(start: number, end: number, total: number): string {
  return `Text excerpt: code points [${start}, ${end}) of ${total} (zero-based, end exclusive).`;
}

/** A partial result: the note, one line feed, and the selected payload. */
function excerpt(start: number, end: number, total: number, payload: string): string {
  return `${note(start, end, total)}\n${payload}`;
}

/** One `<Slice>` over a `<Value>`, with nothing else in the document. */
function* over(value: string, attributes = ""): Operation<Run> {
  return yield* run(`<Slice${attributes}><Value key="v" /></Slice>`, { v: value });
}

/** The exact string `as` bound, at the capture boundary. */
function* captured(value: string, attributes = ""): Operation<Json> {
  const result = yield* run(
    `<Slice${attributes} as="window"><Value key="v" /></Slice><Probe value={window} />`,
    { v: value },
  );
  expect(result.failure).toBe("");
  expect(result.probed.length).toBe(1);
  return result.probed[0] ?? "";
}

/** `A😀BCDEF` — seven code points, eight UTF-16 units, the astral one second. */
const SEVEN = "A\u{1F600}BCDEF";

/**
 * A log whose 4096th code point is astral.
 *
 * Four thousand and ninety-seven points in four thousand and ninety-eight
 * UTF-16 units, with the emoji at index 4095 — so the default window ends
 * exactly on it. A selection taken in UTF-16 units would cut it in half and
 * emit a lone surrogate.
 */
const BOUNDARY = `${"a".repeat(4095)}\u{1F600}z`;

describe("Tier SL1 — S1: windows, defaults, clamping and the exact note", () => {
  it("S1: the omitted window is [0, 4096) and counts code points, not UTF-16 units", function* () {
    expect(Array.from(BOUNDARY).length).toBe(4097);
    expect(BOUNDARY.length).toBe(4098);

    const result = yield* over(BOUNDARY);
    const expected = excerpt(0, 4096, 4097, `${"a".repeat(4095)}\u{1F600}`);

    expect(result.failure).toBe("");
    expect(result.output).toBe(expected);
    expect(yield* captured(BOUNDARY)).toBe(expected);
    // Stated separately: the window holds the emoji whole, so no half of a
    // surrogate pair reached the document.
    expect(Array.from(result.output.slice(note(0, 4096, 4097).length + 1)).length).toBe(4096);
    expect(result.output.endsWith("\u{1F600}")).toBe(true);
  });

  it("S1: a middle window, an end window, and a start before the beginning", function* () {
    expect(yield* over(SEVEN, " offset={1} length={3}")).toMatchObject({
      failure: "",
      output: excerpt(1, 4, 7, "\u{1F600}BC"),
    });
    expect(yield* captured(SEVEN, " offset={1} length={3}")).toBe(excerpt(1, 4, 7, "\u{1F600}BC"));

    expect((yield* over(SEVEN, " offset={-3} length={4096}")).output).toBe(excerpt(4, 7, 7, "DEF"));

    // Clamped to zero rather than wrapping or refusing, and the whole input is
    // then covered — so the body comes back with no note at all.
    expect((yield* over(SEVEN, " offset={-99} length={4096}")).output).toBe(SEVEN);
    expect((yield* over(SEVEN, " offset={-99} length={2}")).output).toBe(
      excerpt(0, 2, 7, "A\u{1F600}"),
    );
  });

  it("S1: a start at or beyond the end is an empty window that still says so", function* () {
    for (const offset of [7, 8, 400]) {
      const result = yield* over(SEVEN, ` offset={${offset}} length={4}`);

      expect(result.failure).toBe("");
      expect(result.output).toBe(`${note(7, 7, 7)}\n`);
    }
  });

  it("S1: empty content is the empty string, in both authored spellings", function* () {
    expect(yield* run("<Slice></Slice>")).toMatchObject({ failure: "", output: "" });
    expect(yield* run("<Slice />")).toMatchObject({ failure: "", output: "" });
    expect(yield* captured("", " length={4}")).toBe("");
  });

  it("S1: a positive integer length has no maximum, so 10000 is not capped at 4096", function* () {
    const long = "b".repeat(5000);
    const result = yield* over(long, " length={10000}");

    expect(result.failure).toBe("");
    // The complete original, with no note: a 4096 cap would have reported
    // `[0, 4096) of 5000` here.
    expect(result.output).toBe(long);
    expect(result.output).not.toContain("Text excerpt");
    expect(yield* captured(long, " length={10000}")).toBe(long);
  });

  it("S1: authored whitespace counts, and is neither trimmed nor normalized", function* () {
    const padded = yield* run("<Slice length={4096}>  padded  body  </Slice>");
    expect(padded.failure).toBe("");
    expect(padded.output).toBe("  padded  body  ");

    // The same authored content, partially: the total counts every space, and
    // the payload keeps the two it begins with.
    const cut = yield* run("<Slice length={9}>  padded  body  </Slice>");
    expect(cut.output).toBe(excerpt(0, 9, 16, "  padded "));
  });
});

describe("Tier SL1 — S2: an invalid window runs no body", () => {
  it("S2: every refused argument is ordinary prop validation, and nothing expands", function* () {
    const refused = [
      " offset={1.5}",
      ' offset="x"',
      " offset={true}",
      " length={0}",
      " length={-1}",
      " length={2.5}",
      ' length="x"',
      " window={1}",
    ];

    for (const attributes of refused) {
      const result = yield* run(`<Slice${attributes}><Tripwire /></Slice>`);

      expect(reported(result)).toContain("Prop validation failed for <Slice />");
      // Decided before the body: the content never expanded, so there is no
      // completed work for a window to have been taken from.
      expect(result.tripped).toBe(0);
      expect(result.output).not.toContain("TRIPPED");
      expect(result.output).not.toContain("Text excerpt");
    }
  });
});

describe("Tier SL1 — S3: one completion, and captures that stay complete", () => {
  it("S3: the window waits for the producer, and cuts nothing it captured", function* () {
    const harness = controlled();
    const source =
      '<Slice length={1} as="window">X<Held as="payload" /><Probe value={payload} />' +
      '<Json value={payload} /></Slice><Probe value={window} /><Value key="after" />';

    const result = yield* scoped(function* (): Operation<Run> {
      try {
        const running = yield* spawn(() => run(source, { after: "AFTER" }, harness));
        yield* harness.entered;

        // Held: the producer has started and has not returned, so the window
        // cannot have been taken yet. Nothing after the Slice has run either.
        expect(harness.producer.starts).toBe(1);
        expect(harness.producer.completions).toBe(0);
        expect(harness.producer.cleanups).toBe(0);

        harness.release();
        return yield* running;
      } finally {
        // Released unconditionally: a failed expectation above would otherwise
        // leave the producer parked and the join would read as a hang.
        harness.release();
      }
    });

    expect(result.failure).toBe("");
    // Once each, and the sibling after the Slice ran once.
    expect(harness.producer).toEqual({ starts: 1, completions: 1, cleanups: 1 });

    // The child's captured value, probed in its own environment: the complete
    // structured value, not a window of it.
    expect(result.probed[0]).toEqual({ held: true, size: 3 });

    // And the Slice's own capture. The total is the proof the child's rendering
    // was complete: one authored point, plus the whole of the JSON that
    // captured value serializes to.
    const serialized = JSON.stringify({ held: true, size: 3 }, null, 2);
    const total = 1 + Array.from(serialized).length;
    expect(result.probed[1]).toBe(excerpt(0, 1, total, "X"));

    // Captured, so the invocation site contributed nothing; the sibling after
    // it is the only thing that rendered.
    expect(result.output).toBe("AFTER");
  });
});

describe("Tier SL1 — S4: one window over the combined rendering", () => {
  it("S4: enclosed renderings share one window, and siblings outside are untouched", function* () {
    const result = yield* run('HEAD<Slice length={3}>AB<Value key="piece" />EF</Slice>TAIL', {
      piece: "CD",
    });

    expect(result.failure).toBe("");
    // One window over `ABCDEF`, not one per child and not one over the whole
    // document: HEAD and TAIL are outside the element and are unaffected.
    expect(result.output).toBe(`HEAD${excerpt(0, 3, 6, "ABC")}TAIL`);
    // Exactly once in that order, so nothing was rescanned or re-rendered.
    expect(result.output.split("HEAD").length - 1).toBe(1);
    expect(result.output.split("TAIL").length - 1).toBe(1);
    expect(result.output.split("Text excerpt").length - 1).toBe(1);
  });
});

describe("Tier SL1 — S5: nesting is ordinary inside-out text", () => {
  it("S5: the outer window counts the inner note and may cut it", function* () {
    const inner = excerpt(1, 4, 7, "\u{1F600}BC");
    // The inner rendering is seventy code points: a sixty-six point note, its
    // line feed, and the three points it selected.
    expect(Array.from(inner).length).toBe(70);

    const result = yield* run(
      `<Slice offset={0} length={4}><Slice offset={1} length={3}><Value key="v" /></Slice></Slice>`,
      { v: SEVEN },
    );

    expect(result.failure).toBe("");
    // The outer note describes the outer input, and the payload is the first
    // four points of the inner note — so a note is ordinary text to whatever
    // encloses it, and each note is outside its own selected payload.
    expect(result.output).toBe(excerpt(0, 4, 70, "Text"));
  });
});

describe("Tier SL1 — S6: failed work is not an empty successful excerpt", () => {
  it("S6: a content failure settles the root and publishes no window", function* () {
    const result = yield* run(
      '<Slice length={2} as="window">PREFIX<Fail message="the producer gave up" /></Slice>' +
        '<Probe value={window} /><Value key="after" />',
      { after: "AFTER" },
    );

    // The root failed on the authored sentence.
    expect(result.failure).toContain("the producer gave up");
    // No window was published, so nothing read one back.
    expect(result.probed).toEqual([]);
    // And no range note anywhere: an empty or truncated excerpt would have
    // reported a successful window over work that never finished.
    expect(reported(result)).not.toContain("Text excerpt");
    // Nothing after the element ran.
    expect(result.output).not.toContain("AFTER");
  });
});

describe("Tier SL1 — S7: cancellation owns the teardown", () => {
  it("S7: halting the owner joins the producer's cleanup and publishes nothing", function* () {
    const harness = controlled();
    const source =
      '<Slice length={1} as="window">X<Held as="payload" /></Slice>' +
      '<Probe value={window} /><Value key="after" />';

    yield* scoped(function* () {
      try {
        const running = yield* spawn(() => run(source, { after: "AFTER" }, harness));
        yield* harness.entered;
        expect(harness.producer.starts).toBe(1);

        // Halted while the producer is parked, and joined: `halt()` returns a
        // Future, so observing it is what proves the teardown finished rather
        // than merely having been asked for.
        yield* running.halt();

        expect(harness.producer.completions).toBe(0);
        // Exactly one cleanup, through the producer's own `ensure`.
        expect(harness.producer.cleanups).toBe(1);
      } finally {
        harness.release();
      }
    });
  });

  it("S7: the component owns no task, resource or recovery of its own", function* () {
    const source = yield* readTextFile(
      fileURLToPath(new URL("../src/components/Slice.ts", import.meta.url)),
    );
    // Read rather than reasoned about: the lifetime belongs to the invocation,
    // so a spawn, a resource, a finalizer or a catch here would be a second
    // owner the window does not need.
    for (const owned of ["spawn(", "resource(", "ensure(", "useScope(", "catch", "finally"]) {
      expect(source).not.toContain(owned);
    }
    // One content call, and it is the only operation this component yields.
    expect(source.split("yield*").length - 1).toBe(1);
    expect(source).toContain("yield* content()");
  });
});
