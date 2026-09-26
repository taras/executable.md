/**
 * The topology #841's first slice asks for, and nothing else.
 *
 *     session owner
 *     ├── controller sibling        the scope that acquires the gate
 *     ├── unrelated live sibling    same mediated loop, no middleware over it
 *     └── target execution scope    the one scope the middleware decorates
 *         ├── nested child A
 *         └── nested child B
 *
 * The unrelated sibling runs the *identical* mediated loop as the target's
 * children. It is not a different kind of work that happens to keep going — it
 * is the same work with the decoration absent, which is what makes "the
 * middleware is what stopped the target" separable from "that loop was going to
 * stop anyway".
 *
 * Child B is where the negative control lives. Mediated, it advances through the
 * Api like its sibling. Raw, it makes the same progress with ordinary Effection
 * and never invokes the Api at all — the case that must fail.
 *
 * Two things keep the evidence off the clock. Every execution announces each
 * advance on `advances`, so a test waits for an advance that happened instead of
 * assuming an interval was long enough for one; and every step is numbered, so a
 * continuation released twice would leave a duplicate in the history rather than
 * being invisible among identical labels.
 */

import { createScope, createSignal, sleep, spawn, useScope } from "effection";
import type { Operation, Scope, Signal, Subscription, Task } from "effection";

import { ExecutionJournal, ExecutionOwner, external, fork, step } from "./execution.ts";
import { useGate } from "./gate.ts";
import type { Gate } from "./gate.ts";
import { createJournal } from "./journal.ts";
import type { Journal } from "./journal.ts";

/** Long enough that a loop yields to its siblings, short enough to stay quick. */
const TICK = 1;

export interface Advance {
  readonly owner: string;
  readonly count: number;
}

export interface FixtureOptions {
  /** How child B advances: through the Api, or in raw Effection. */
  readonly childB: "mediated" | "raw";
  /**
   * An external operation child A performs through the Api. The promise is
   * already in flight when the fixture starts, so whatever it represents keeps
   * running no matter what the gate does.
   */
  readonly pending?: Promise<string>;
}

export interface Fixture {
  readonly gate: Gate;
  readonly journal: Journal;
  readonly targetScope: Scope;
  readonly entry: Task<void>;
  /** One value per completed loop, from every execution in the topology. */
  readonly advances: Signal<Advance, never>;
  /** How many times child A's continuation ran past its external operation. */
  readonly pastExternal: () => number;
  /**
   * Destroy the scope that owns the target subtree.
   *
   * Used by the lifecycle matrix for the two rows that need the `paused` state,
   * which only this synthetic gate reaches.
   */
  shutdown(): Operation<void>;
}

export function* startFixture(options: FixtureOptions): Operation<Fixture> {
  const session = yield* useScope();
  const journal = createJournal();
  session.set(ExecutionJournal, journal);

  const advances = createSignal<Advance, never>();
  const counts = { pastExternal: 0 };

  function announce(owner: string, count: number) {
    advances.send({ owner, count });
  }

  // Destructured so the matrix can tear the owner down explicitly. Reading the
  // tuple creates no scope, so the live set is the same as before.
  const [targetScope, disposeTarget] = createScope(session);
  targetScope.set(ExecutionOwner, "entry");

  const gate = yield* useGate({
    target: targetScope,
    journal,
    rootOwner: "entry",
  });

  yield* spawn(function* unrelatedSibling() {
    yield* ExecutionOwner.set("sibling");
    for (let count = 1; ; count += 1) {
      yield* sleep(TICK);
      yield* step(`sibling#${count}`);
      announce("sibling", count);
    }
  });

  const entry = targetScope.run(function* targetExecution() {
    yield* fork("childA", function* childA() {
      if (options.pending) {
        yield* external("await", options.pending);
        counts.pastExternal += 1;
      }
      for (let count = 1; ; count += 1) {
        yield* sleep(TICK);
        yield* step(`childA#${count}`);
        announce("childA", count);
      }
    });

    yield* fork("childB", function* childB() {
      if (options.childB === "raw") {
        for (let count = 1; ; count += 1) {
          yield* sleep(TICK);
          announce("childB", count);
        }
      }
      for (let count = 1; ; count += 1) {
        yield* sleep(TICK);
        yield* step(`childB#${count}`);
        announce("childB", count);
      }
    });

    for (let count = 1; ; count += 1) {
      yield* sleep(TICK);
      yield* step(`entry#${count}`);
      announce("entry", count);
    }
  });

  return {
    gate,
    journal,
    targetScope,
    entry,
    advances,
    pastExternal: () => counts.pastExternal,
    *shutdown() {
      yield* disposeTarget();
    },
  };
}

/**
 * Wait until `owner` announces its next advance.
 *
 * The subscription must already exist, so an advance that happens while a test
 * is deciding what to assert is queued rather than missed.
 */
export function* advanceOf(
  advancing: Subscription<Advance, never>,
  owner: string,
): Operation<Advance> {
  while (true) {
    const next = yield* advancing.next();
    if (!next.done && next.value.owner === owner) {
      return next.value;
    }
  }
}
