/**
 * The actual StarFX store, and what it is allowed to be.
 *
 * Slice 2 of #842. Slice 1 proved that records and a URL determine one
 * semantic model; this proves that putting that model in a real immutable
 * store adds nothing to it. The store is `starfx` — `createSchema`,
 * `createStore`, `slice` — and every case here is about a difference that
 * must *not* appear: between a session that accumulated records one at a time
 * and one built from all of them at once, between a store whose cache is warm
 * and one whose cache has been thrown away, and between the same state drawn
 * for two different terminals.
 *
 * The journey is the one #842 names: empty, a first entry, nested scopes, a
 * binding, the expansion pause marker, a background append while expansion is
 * held, historical inspection, the live head, and back to the pause marker.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { EXECUTION, JOURNAL, LIVE_HEAD, PAUSE_MARKER } from "../repl-hydration/fixture.ts";
import { layout, topology } from "../repl-hydration/layout.ts";
import type { Viewport } from "../repl-hydration/layout.ts";
import type { SemanticModel } from "../repl-hydration/model.ts";
import * as overlay from "../repl-hydration/overlay.ts";
import { foreignValues } from "../repl-hydration/purity.ts";
import { hydrate } from "../repl-hydration/store.ts";
import type { ReplSession, SemanticState } from "../repl-hydration/store.ts";

/** The journey, as the locations it visits and the records it has by then. */
const EMPTY = "xmd://repl/e1/transcript";
const FIRST_ENTRY = "xmd://repl/e1/transcript/entry-1";
const NESTED = "xmd://repl/e1/transcript/entry-1/document/plan";
const BINDINGS = "xmd://repl/e1/bindings";
const AT_PAUSE = `xmd://repl/e1/transcript/entry-3/document/publish/+source/+confirm?at=${PAUSE_MARKER}&inspect`;
const HISTORICAL = "xmd://repl/e1/transcript/entry-1/document?at=r-03";
const AT_HEAD = "xmd://repl/e1/transcript/entry-3/document/write";

const WIDE: Viewport = { columns: 120, rows: 40 };
const NARROW: Viewport = { columns: 28, rows: 40 };

function* open(url: string, records: readonly unknown[]): Operation<ReplSession> {
  const session = yield* hydrate(EXECUTION, url, records);
  if (!session.ok) {
    throw session.error;
  }
  return session.value;
}

function* advance(session: ReplSession, to: number): Operation<void> {
  const seen = session.state().records.length;
  for (const record of JOURNAL.slice(seen, to)) {
    const applied = yield* session.append(record);
    if (!applied.ok) {
      throw applied.error;
    }
  }
}

function* go(session: ReplSession, url: string): Operation<void> {
  const moved = yield* session.navigate(url);
  if (!moved.ok) {
    throw moved.error;
  }
}

/** One step of the journey: where the URL points and how much has arrived. */
interface Step {
  readonly name: string;
  readonly url: string;
  readonly records: number;
}

const JOURNEY: readonly Step[] = [
  { name: "empty", url: EMPTY, records: 0 },
  { name: "the first entry", url: FIRST_ENTRY, records: 1 },
  { name: "nested scopes", url: NESTED, records: 3 },
  { name: "a published binding", url: BINDINGS, records: 7 },
  { name: "the expansion pause marker", url: AT_PAUSE, records: 22 },
  { name: "a background append while expansion is held", url: AT_PAUSE, records: 23 },
  { name: "historical inspection", url: HISTORICAL, records: 23 },
  { name: "the live head", url: AT_HEAD, records: 23 },
  { name: "back to the expansion pause marker", url: AT_PAUSE, records: 23 },
];

describe("the StarFX store, hydrated from Journal plus URL", () => {
  it("accumulates to the same semantic state a rebuild produces at every step", function* () {
    const live = yield* open(EMPTY, []);
    for (const step of JOURNEY) {
      yield* advance(live, step.records);
      yield* go(live, step.url);

      // The whole store is discarded and another one is built from the same
      // two inputs. Nothing carries over — not the cache, not the scope.
      const cold = yield* open(step.url, JOURNAL.slice(0, step.records));

      expect(live.semantic()).toEqual(cold.semantic());
      expect(cold.cached().length).toBeLessThanOrEqual(1);
    }
  });

  it("holds the expansion pause point still while the durable head advances", function* () {
    const session = yield* open(AT_PAUSE, JOURNAL.slice(0, 22));
    const held = session.semantic();

    expect(held.model.marker).toBe(PAUSE_MARKER);
    expect(held.model.records).toBe(22);
    expect(held.model.outcomes).toEqual([]);
    expect(held.history.filter((one) => one.position === "future")).toEqual([]);

    yield* advance(session, 23);
    const after = session.semantic();

    // The selected prefix did not move; the Execution History grew.
    expect(after.model).toEqual(held.model);
    expect(after.url).toBe(held.url);
    expect(after.history.length).toBe(held.history.length + 1);
    expect(after.history.filter((one) => one.position === "future").map((one) => one.id)).toEqual([
      LIVE_HEAD,
    ]);

    // A future marker is navigation context and never a fact.
    expect(JSON.stringify(after.model)).not.toContain("remote tags fetched");
    expect(JSON.stringify(after.history)).not.toContain("remote tags fetched");
  });

  it("answers navigation the same way with a warm cache and with none", function* () {
    const session = yield* open(EMPTY, JOURNAL);
    const tour = [AT_PAUSE, HISTORICAL, AT_HEAD, AT_PAUSE];

    const warm: SemanticState[] = [];
    for (const url of tour) {
      yield* go(session, url);
      warm.push(session.semantic());
    }
    expect(session.cached()).toEqual(["r-03", PAUSE_MARKER]);

    yield* session.discardSnapshots();
    expect(session.cached()).toEqual([]);

    const cold: SemanticState[] = [];
    for (const url of tour) {
      yield* go(session, url);
      cold.push(session.semantic());
    }
    expect(cold).toEqual(warm);
  });

  it("never memoizes the live head, because that is the prefix that grows", function* () {
    const session = yield* open(AT_HEAD, JOURNAL.slice(0, 22));
    expect(session.cached()).toEqual([]);

    const before = session.semantic().model;
    yield* advance(session, 23);
    const after = session.semantic().model;

    expect(before.records).toBe(22);
    expect(after.records).toBe(23);
    expect(after.outcomes.map((outcome) => outcome.label)).toEqual(["remote tags fetched"]);
    expect(session.cached()).toEqual([]);
  });

  it("reflows for another terminal without moving the semantics", function* () {
    const session = yield* open(AT_HEAD, JOURNAL);
    const state = session.semantic();

    const wide = layout(state, WIDE);
    const narrow = layout(state, NARROW);

    expect(wide).not.toEqual(narrow);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(Math.max(...narrow.map((line) => line.length))).toBeLessThanOrEqual(NARROW.columns);

    // The store did not notice, and neither did the structure.
    expect(session.semantic()).toEqual(state);
    expect(topology(state.model)).toEqual(topology(session.semantic().model));
  });

  it("holds no terminal cell, escape byte or animation frame", function* () {
    const session = yield* open(AT_PAUSE, JOURNAL);
    const state = session.state();
    const serialized = JSON.stringify(state);

    expect(serialized).not.toContain("\\u001b");
    expect(serialized).not.toContain("\u001b");
    for (const word of ["columns", "rows", "viewport", "frame", "cells", "ansi"]) {
      expect(serialized).not.toContain(word);
    }
    // StarFX's own slices are required by the schema and stay empty.
    expect(state.cache).toEqual({});
    expect(state.loaders).toEqual({});

    // Everything in the store, and everything it hands out, is frozen plain
    // data: no function, no class instance, no typed array, no live handle.
    expect(foreignValues(state, "state")).toEqual([]);
    expect(foreignValues(session.semantic(), "semantic")).toEqual([]);
  });

  it("offers Continue only from the process that still holds the continuation", function* () {
    const session = yield* open(AT_PAUSE, JOURNAL);
    const held = overlay.live(PAUSE_MARKER);
    const paused = session.semantic();

    expect(overlay.canContinueAt(held, paused.model.marker)).toBe(true);

    yield* go(session, AT_HEAD);
    expect(overlay.canContinueAt(held, session.semantic().model.marker)).toBe(false);

    yield* go(session, AT_PAUSE);
    expect(overlay.canContinueAt(held, session.semantic().model.marker)).toBe(true);

    // Discarding the continuation, and then the whole process, removes the
    // capability and changes nothing that was reconstructed.
    expect(overlay.canContinueAt(overlay.released(held), PAUSE_MARKER)).toBe(false);
    expect(overlay.canContinueAt(overlay.cold(), PAUSE_MARKER)).toBe(false);
    expect(session.semantic()).toEqual(paused);

    const restarted = yield* open(AT_PAUSE, JOURNAL);
    expect(restarted.semantic()).toEqual(paused);
    expect(JSON.stringify(restarted.state())).not.toContain("pauseMarker");
  });

  it("refuses a malformed record, an unspellable URL and an unresolved one", function* () {
    const broken = yield* hydrate(EXECUTION, AT_HEAD, [...JOURNAL, { id: "r-24" }]);
    expect(broken.ok).toBe(false);

    const unspellable = yield* hydrate(EXECUTION, "xmd://repl/e1/nowhere", JOURNAL);
    expect(unspellable.ok).toBe(false);

    const unresolved = yield* hydrate(EXECUTION, "xmd://repl/e1/transcript/entry-9", JOURNAL);
    expect(unresolved.ok).toBe(false);

    // A refusal leaves nothing half-built: there is no session to observe.
    const session = yield* open(AT_HEAD, JOURNAL);
    const before = session.semantic();
    const rejected = yield* session.navigate("xmd://repl/e1/transcript/entry-9");
    expect(rejected.ok).toBe(false);
    expect(session.semantic()).toEqual(before);
  });

  describe("negative controls", () => {
    it("persisted-snapshots: a cache that outlived its records answers the wrong moment", function* () {
      const session = yield* open(AT_PAUSE, JOURNAL);
      const truthful = session.semantic().model;

      // What a durable snapshot would look like: the model of another prefix,
      // stored under this marker's name. Resolution reads the cache first, so
      // it would be believed.
      const early = yield* open(HISTORICAL, JOURNAL);
      const stale: SemanticModel = early.semantic().model;

      expect(stale).not.toEqual(truthful);
      expect(stale.records).toBe(3);
      expect(truthful.records).toBe(22);

      // A rebuild cannot be handed one, so the stale model has no way in.
      const rebuilt = yield* open(AT_PAUSE, JOURNAL);
      expect(rebuilt.cached()).toEqual([PAUSE_MARKER]);
      expect(rebuilt.semantic().model).toEqual(truthful);
    });

    it("head-memoized: caching the live head freezes an answer that keeps changing", function* () {
      const session = yield* open(AT_HEAD, JOURNAL.slice(0, 22));
      const frozen = session.semantic().model;

      yield* advance(session, 23);
      const now = session.semantic().model;

      // A cache keyed on "the head" would have returned `frozen` here.
      expect(frozen.records).toBe(22);
      expect(now.records).toBe(23);
      expect(frozen).not.toEqual(now);
      expect(session.cached()).toEqual([]);
    });

    it("layout-in-the-store: a viewport written into the state makes two terminals two executions", function* () {
      const session = yield* open(AT_HEAD, JOURNAL);
      const state = session.semantic();

      const wide = { ...state, viewport: WIDE, lines: layout(state, WIDE) };
      const narrow = { ...state, viewport: NARROW, lines: layout(state, NARROW) };

      expect(wide).not.toEqual(narrow);
      expect(session.semantic()).toEqual(state);
      expect(JSON.stringify(session.state())).not.toContain("columns");
    });

    it("overlay-in-the-store: a pause flag in the state survives a restart that cannot know it", function* () {
      const session = yield* open(AT_PAUSE, JOURNAL);
      const held = overlay.live(PAUSE_MARKER);
      const smuggled = { ...session.semantic(), ...held };

      expect(smuggled.pauseMarker).toBe(PAUSE_MARKER);
      expect(smuggled.canContinue).toBe(true);

      const restarted = yield* open(AT_PAUSE, JOURNAL);
      expect(Object.keys(restarted.semantic())).not.toContain("pauseMarker");
      expect(Object.keys(restarted.semantic())).not.toContain("canContinue");
      expect(restarted.semantic()).toEqual(session.semantic());
    });
  });
});
