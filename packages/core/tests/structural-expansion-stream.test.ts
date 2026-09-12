/**
 * Tier RS — the explicit, backpressured output of one child region (§6.1).
 *
 * A region hands its output to whoever asked for it. Nothing is buffered ahead
 * of the consumer, nothing reaches `DocumentOutput`, and nothing outlives the
 * handler that was consuming it.
 *
 * Backpressure and teardown are proved with latches rather than with elapsed
 * time. Every region here evaluates a recorded expression per segment, so
 * "the producer has not advanced" is a list a row reads back, and a producer
 * that ran ahead or kept running after its consumer stopped puts an extra entry
 * in it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, suspend, useScope, withResolvers } from "effection";
import type { Operation, Subscription } from "effection";

import { DocumentOutput } from "../src/api.ts";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { installedAuthority } from "./support/installed-structural.ts";
import { regionStream } from "../src/expansion-region.ts";
import type { RegionProducer } from "../src/expansion-region.ts";
import type { ExecutionInstallation } from "../host.ts";
import type { ExpansionChunk, ExpansionRegion } from "../src/expansion-request.ts";
import type { StructuralDeclaration } from "../src/execution-declarations.ts";
import type { Segment } from "../src/types.ts";

const ORIGIN = "@test/panels";

function declarations(): readonly StructuralDeclaration[] {
  return [
    {
      kind: "structural",
      name: "Panel",
      origin: ORIGIN,
      forms: ["paired"],
      props: { type: "object", properties: {}, additionalProperties: false },
      syntax: ["<Panel>…</Panel>"],
      description: "Arrange slots.",
      context: "The `<Slot>` children the panel arranges.",
      placement: { kind: "parent", minimumChildren: 1, nested: "allowed" },
    },
    {
      kind: "structural",
      name: "Slot",
      origin: ORIGIN,
      forms: ["self-closing", "paired"],
      props: {
        type: "object",
        properties: { title: { type: "string", minLength: 1 } },
        required: ["title"],
        additionalProperties: false,
      },
      syntax: ['<Slot title="One" />'],
      description: "One slot.",
      context: "Markdown the slot renders.",
      placement: { kind: "child", parent: "Panel" },
    },
  ];
}

/** What the document did while a region was being consumed. */
interface Trace {
  /** Every recorded expression the document evaluated, in order. */
  calls: string[];
  /** Every chunk the handler took, in order. */
  chunks: ExpansionChunk[];
  /** Every text `DocumentOutput` was asked to emit. */
  emitted: string[];
  /** Whether the region's stream closed with `void`. */
  closed: boolean;
  /** What consuming the region raised, if anything. */
  failure: unknown;
}

function trace(): Trace {
  return { calls: [], chunks: [], emitted: [], closed: false, failure: undefined };
}

/**
 * Run one document whose installed parent consumes its regions with `consume`.
 *
 * The environment carries `seen`, which records the label it is given and
 * returns the value, so a region's own expansion leaves a trail.
 */
function expandPanel(
  source: string,
  observed: Trace,
  consume: (regions: readonly ExpansionRegion[], observed: Trace) => Operation<void>,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* Component.around(
      {
        env: () => ({
          values: {
            seen: (label: string, value: unknown) => {
              observed.calls.push(label);
              return value;
            },
            boom: (label: string) => {
              observed.calls.push(label);
              throw new Error("the region failed");
            },
          },
        }),
      },
      { at: "min" },
    );
    yield* DocumentOutput.around({
      *output([text, exact], next) {
        observed.emitted.push(text);
        yield* next(text, exact);
      },
    });
    const installation: ExecutionInstallation = {
      declarations: declarations(),
      *expand(_request, regions): Operation<void> {
        yield* consume(regions, observed);
      },
    };
    const authority = yield* installedAuthority(installation);
    return yield* expandSegments(
      scanSegments(source),
      {},
      {},
      new Set(),
      undefined,
      undefined,
      "",
      0,
      undefined,
      authority,
    );
  });
}

/**
 * Acquire one region's producer and subscribe to it.
 *
 * `expand()` establishes the producer in the calling scope and hands back the
 * stream; subscribing is the second step, and it is what starts production.
 */
function* subscribe(region: ExpansionRegion): Operation<Subscription<ExpansionChunk, void>> {
  return yield* yield* region.expand();
}

/** Take chunks until one contains `marker`, recording each. */
function* pullUntil(
  subscription: Subscription<ExpansionChunk, void>,
  observed: Trace,
  marker: string,
): Operation<boolean> {
  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      observed.closed = true;
      return false;
    }
    observed.chunks.push(next.value);
    if (next.value.text.includes(marker)) {
      return true;
    }
  }
}

/** Drain the rest of a region, recording every chunk and how it closed. */
function* drain(
  subscription: Subscription<ExpansionChunk, void>,
  observed: Trace,
): Operation<void> {
  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      observed.closed = true;
      return;
    }
    observed.chunks.push(next.value);
  }
}

const THREE_STEPS = [
  "<Panel>",
  '<Slot title="One">',
  "<If condition={seen('one', true)}>one</If>",
  "",
  "<If condition={seen('two', true)}>two</If>",
  "",
  "<If condition={seen('three', true)}>three</If>",
  "</Slot>",
  "</Panel>",
  "",
].join("\n");

describe("Tier RS — a region's output is explicit", () => {
  it("RS1: the chunks are the region's rendered text, and the stream closes with void", function* () {
    const observed = trace();

    yield* expandPanel(THREE_STEPS, observed, function* (regions, seen) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      yield* drain(yield* subscribe(region), seen);
    });

    const text = observed.chunks.map((chunk) => chunk.text).join("");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
    expect(observed.closed).toBe(true);
    expect(observed.chunks.every((chunk) => chunk.exact === false)).toBe(true);
  });

  it("RS1: no region chunk travels through DocumentOutput", function* () {
    const observed = trace();

    yield* expandPanel(THREE_STEPS, observed, function* (regions, seen) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      yield* drain(yield* subscribe(region), seen);
    });

    // The region produced text, and the document's output boundary saw none of
    // it: no ambient route carries a region, and no default writer copies one.
    expect(observed.chunks.length).toBeGreaterThan(0);
    expect(observed.emitted.join("")).not.toContain("one");
    expect(observed.emitted.join("")).not.toContain("three");
  });

  it("RS1: a region nobody consumes produces nothing at all", function* () {
    const observed = trace();

    // The stream is acquired and never subscribed. Production is lazy, so the
    // region's first expression is never evaluated.
    yield* expandPanel(THREE_STEPS, observed, function* (regions) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      yield* region.expand();
    });

    expect(observed.calls).toEqual([]);
  });
});

describe("Tier RS — the producer waits for its consumer", () => {
  it("RS2: a region's chunks and its expansion interleave, one segment at a time", function* () {
    const observed = trace();

    yield* expandPanel(THREE_STEPS, observed, function* (regions, seen) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      const subscription = yield* subscribe(region);

      // The region is expanded as it is read rather than rendered whole and
      // handed over: when the chunk carrying the first segment arrives, only
      // that segment has been expanded. What *enforces* that is the transport's
      // rendezvous, which the rows at the bottom of this file latch directly —
      // the ordering here is the observable consequence of it.
      expect(yield* pullUntil(subscription, seen, "one")).toBe(true);
      expect(seen.calls).toEqual(["one"]);

      expect(yield* pullUntil(subscription, seen, "two")).toBe(true);
      expect(seen.calls).toEqual(["one", "two"]);

      expect(yield* pullUntil(subscription, seen, "three")).toBe(true);
      expect(seen.calls).toEqual(["one", "two", "three"]);
    });
  });

  it("RS3: a region stops where its consumer stopped", function* () {
    const observed = trace();

    yield* expandPanel(THREE_STEPS, observed, function* (regions, seen) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      const subscription = yield* subscribe(region);
      yield* pullUntil(subscription, seen, "one");
      // And that is all this handler wants. Leaving its scope is what has to
      // stop the producer.
    });

    // The region expanded exactly as far as it was read. That the producer was
    // *halted and joined* rather than left running is the transport's claim,
    // and the latched rows at the bottom of this file are what prove it — this
    // row shows the consequence through a document.
    expect(observed.calls).toEqual(["one"]);
  });
});

describe("Tier RS — failure and repetition", () => {
  it("RS3: a failure inside a region follows the chunks already delivered", function* () {
    const observed = trace();
    const source = [
      "<Panel>",
      '<Slot title="One">',
      "<If condition={seen('one', true)}>one</If>",
      "",
      "<If condition={boom('two')}>two</If>",
      "</Slot>",
      "</Panel>",
      "",
    ].join("\n");

    yield* expandPanel(source, observed, function* (regions, seen) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      const subscription = yield* subscribe(region);
      yield* pullUntil(subscription, seen, "one");
      // The chunk that was already acknowledged is still the consumer's.
      expect(seen.chunks.some((chunk) => chunk.text.includes("one"))).toBe(true);
      yield* drain(subscription, seen);
    });

    // The region stopped where it failed, and what it produced first arrived
    // first: the failure is reported after the delivered chunk rather than in
    // place of it.
    const text = observed.chunks.map((chunk) => chunk.text).join("");
    expect(text.indexOf("one")).toBeLessThan(text.indexOf("the region failed"));
    expect(observed.calls).toEqual(["one", "two"]);
  });

  it("RS4: expanding a pure region again is ordinary, not a bespoke refusal", function* () {
    const observed = trace();

    yield* expandPanel(THREE_STEPS, observed, function* (regions, seen) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      yield* drain(yield* subscribe(region), seen);
      const before = seen.chunks.length;
      // A second acquisition and a second subscription. Nothing here promises
      // that repeating arbitrary durable work is safe — only that no new
      // "already expanded" or single-consumer rule was invented.
      yield* drain(yield* subscribe(region), seen);
      expect(seen.chunks.length).toBeGreaterThan(before);
    });

    expect(observed.calls.filter((call) => call === "one")).toHaveLength(2);
  });
});

describe("Tier RS — the root's own output is unchanged", () => {
  it("RS1: text beside an installed parent still travels the ordinary path", function* () {
    const observed = trace();
    const source = [
      "Before.",
      "",
      "<Panel>",
      '<Slot title="One">inside</Slot>',
      "</Panel>",
      "",
      "After.",
      "",
    ].join("\n");

    const segments = yield* expandPanel(source, observed, function* (regions, seen) {
      const region = regions[0];
      if (region === undefined) {
        throw new Error("the panel received no region");
      }
      yield* drain(yield* subscribe(region), seen);
    });

    const rendered = renderSegments(segments);
    expect(rendered).toContain("Before.");
    expect(rendered).toContain("After.");
    // The region rendered into the handler's hands, not into the document.
    expect(rendered).not.toContain("inside");
  });
});

/**
 * One producer that records every lifecycle moment a row needs to distinguish.
 *
 * `ensure` is registered before the child is spawned, so the finalizer exists
 * for the whole of the child's life — an `ensure` yielded afterwards would have
 * established nothing for a producer halted while registering.
 */
function latchedProducer(): { events: string[]; produce: RegionProducer } {
  const events: string[] = [];
  const produce: RegionProducer = function* (deliver) {
    yield* ensure(function* () {
      events.push("producer-finalized");
    });
    // The child reports that it is *inside* its try before the producer goes on.
    // `spawn` attaches a turn late, so a child halted before its body ran would
    // never have entered the block its finalizer belongs to — and the latch
    // would read as "no child ran" rather than "the child was halted".
    const childStarted = withResolvers<void>();
    yield* spawn(function* () {
      try {
        childStarted.resolve();
        yield* suspend();
      } finally {
        events.push("child-halted");
      }
    });
    yield* childStarted.operation;
    yield* deliver({ text: "first", exact: false });
    events.push("resumed");
    yield* deliver({ text: "second", exact: false });
    events.push("completed");
  };
  return { events, produce };
}

/** Both finalizers ran, and the work after the delivered chunk never did. */
function expectHaltedAndJoined(events: readonly string[]): void {
  expect(events).toContain("child-halted");
  expect(events).toContain("producer-finalized");
  expect(events).not.toContain("resumed");
  expect(events).not.toContain("completed");
}

describe("Tier RS — the transport itself", () => {
  it("RS3: a producer failure reaches the consumer after every acknowledged chunk", function* () {
    const taken: string[] = [];
    let produced = 0;
    let failure: unknown;

    yield* scoped(function* () {
      const stream = yield* regionStream(function* (deliver) {
        produced++;
        yield* deliver({ text: "first", exact: false });
        produced++;
        yield* deliver({ text: "second", exact: false });
        throw new Error("the producer failed");
      });
      const subscription = yield* stream;
      try {
        while (true) {
          const next = yield* subscription.next();
          if (next.done) {
            return;
          }
          taken.push(next.value.text);
        }
      } catch (error) {
        failure = error;
      }
    });

    expect(taken).toEqual(["first", "second"]);
    expect(failure instanceof Error ? failure.message : "").toBe("the producer failed");
    expect(produced).toBe(2);
  });

  it("RS2: the producer is suspended on the chunk the consumer holds", function* () {
    const reached: string[] = [];

    yield* scoped(function* () {
      const stream = yield* regionStream(function* (deliver) {
        reached.push("before-first");
        yield* deliver({ text: "first", exact: false });
        reached.push("after-first");
        yield* deliver({ text: "second", exact: false });
        reached.push("after-second");
      });
      const subscription = yield* stream;

      const first = yield* subscription.next();
      expect(first.done).toBe(false);
      // Delivery has happened and acknowledgement has not: the producer is
      // parked between the two, so nothing after the first delivery has run.
      expect(reached).toEqual(["before-first"]);

      const second = yield* subscription.next();
      expect(second.done).toBe(false);
      expect(reached).toEqual(["before-first", "after-first"]);
    });
  });

  it("RS3: stopping early halts and joins the producer and its child", function* () {
    const { events, produce } = latchedProducer();

    yield* scoped(function* () {
      const subscription = yield* yield* regionStream(produce);
      yield* subscription.next();
      // The consumer wants no more. It stays in scope and does other work, and
      // the producer must not use that window to run ahead.
      expect(events).not.toContain("resumed");
    });

    expectHaltedAndJoined(events);
  });

  it("RS3: leaving the handler's scope halts and joins the producer and its child", function* () {
    const { events, produce } = latchedProducer();

    yield* scoped(function* () {
      const subscription = yield* yield* regionStream(produce);
      yield* subscription.next();
    });

    // Read *after* the scope returned: both finalizers had to complete before
    // it did, which is the join half of the claim.
    expectHaltedAndJoined(events);
  });

  it("RS3: a handler that fails halts and joins the producer and its child", function* () {
    const { events, produce } = latchedProducer();
    let raised: unknown;

    try {
      yield* scoped(function* () {
        const subscription = yield* yield* regionStream(produce);
        yield* subscription.next();
        throw new Error("the handler failed");
      });
    } catch (error) {
      raised = error;
    }

    expect(raised instanceof Error ? raised.message : "").toBe("the handler failed");
    expectHaltedAndJoined(events);
  });

  it("RS3: cancelling the handler halts and joins the producer and its child", function* () {
    const { events, produce } = latchedProducer();
    const holding = withResolvers<void>();

    yield* scoped(function* () {
      const handler = yield* spawn(function* () {
        const subscription = yield* yield* regionStream(produce);
        yield* subscription.next();
        holding.resolve();
        yield* suspend();
      });
      // Deterministic: the handler says when it is holding a chunk, rather than
      // this row guessing with a delay.
      yield* holding.operation;
      yield* handler.halt();
      expect(events).not.toContain("resumed");
    });

    expectHaltedAndJoined(events);
  });

  it("RS3: the control — work the region does not own is not stopped by leaving", function* () {
    // Without this row, every `not.toContain("resumed")` above could be passing
    // because nothing was ever going to run, rather than because leaving the
    // scope stopped it. Here the same shape of work is owned by an *outer*
    // scope, and leaving the inner one does not stop it.
    const events: string[] = [];
    const outer = yield* useScope();
    const finished = withResolvers<void>();

    yield* scoped(function* () {
      outer.run(function* () {
        yield* sleep(0);
        events.push("resumed");
        finished.resolve();
      });
    });

    yield* finished.operation;
    expect(events).toContain("resumed");
  });

  it("RS4: a second acquisition and a second subscription are ordinary", function* () {
    const taken: string[] = [];

    yield* scoped(function* () {
      const produce: RegionProducer = function* (deliver) {
        yield* deliver({ text: "one", exact: false });
        yield* deliver({ text: "two", exact: false });
      };

      // A second acquisition establishes a second producer, and it runs.
      const first = yield* yield* regionStream(produce);
      const firstChunk = yield* first.next();
      expect(firstChunk.done).toBe(false);
      const second = yield* yield* regionStream(produce);
      const secondChunk = yield* second.next();
      expect(secondChunk.done).toBe(false);

      // And a second subscription to one stream is taken without any bespoke
      // refusal: this asserts no new "already expanded" or single-consumer rule
      // was invented, not that repeating durable work is safe.
      const stream = yield* regionStream(produce);
      const a = yield* stream;
      const b = yield* stream;
      const fromA = yield* a.next();
      const fromB = yield* b.next();
      taken.push(String(fromA.value?.text), String(fromB.value?.text));
    });

    expect(taken).toEqual(["one", "two"]);
  });
});
