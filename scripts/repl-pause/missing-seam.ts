/**
 * The smallest proof of the seam Effection 4.1.0 does not publish.
 *
 * `scripts/tests/repl-pause-gate.test.ts` shows what middleware around an
 * XMD-owned Api *can* do: hold every descendant whose progress is an invocation
 * of that Api. This script is about the gap that leaves — a descendant advancing
 * in ordinary Effection — and about what it would take to close it.
 *
 * Read the printed report, not this comment, for the result. Run it with:
 *
 *     deno task repl:pause:seam
 *
 * Nothing here is a proposal. The one mechanism that does gate every
 * continuation is reached by writing a context Effection neither exports nor
 * documents, and the last section demonstrates the specific reason that is
 * unsafe rather than merely unsupported: the write fails *open*. A gate built on
 * it would report `paused` for a subtree that is still running the moment the
 * internal name changed, because writing an unknown context name is not an
 * error.
 */

import { createContext, createScope, Err, main, Ok, sleep, spawn, until } from "effection";
import type { Operation, Result, Scope } from "effection";
import { api } from "effection/experimental";

function say(line: string) {
  console.log(line);
}

function heading(line: string) {
  console.log(`\n${line}\n${"-".repeat(line.length)}`);
}

/**
 * The runtime's own contexts, addressed by the names it gives them.
 *
 * `createContext` is public; these three names are not. A scope resolves a
 * context by `context.name` against a prototype chain of plain records, so a
 * context rebuilt under an internal name reads and writes the internal slot.
 */
const ReducerByName = createContext<unknown>("@effection/reducer");
const PriorityByName = createContext<number>("@effection/scope.generation", 0);
const SettleByName = createContext<Settleware>("@effection/coroutine.settle");

interface Coroutine {
  scope: Scope;
  data: { enqueued: boolean };
  step(): IteratorResult<unknown, unknown>;
  perform(effect: unknown): void;
  settle(outcome: unknown): void;
}

type Settleware = (outcome: unknown, next: (o: unknown) => void) => void;

/**
 * Effection's own reducer loop, with one difference: who decides when it runs.
 *
 * Every continuation in Effection advances through exactly one funnel —
 * `Coroutine.resume()` calls `reducer.schedule(routine)` on the reducer its
 * scope resolved when the coroutine was *created*. A subtree whose scope
 * resolves this object instead therefore cannot take a step that this object
 * does not take for it, whatever the operation was and whoever wrote it.
 */
class Gate {
  reducing = false;
  paused = false;
  private tiers: Coroutine[][] = [];

  schedule = (routine: Coroutine) => {
    if (!routine.data.enqueued) {
      routine.data.enqueued = true;
      (this.tiers[routine.scope.expect(PriorityByName)] ??= []).push(routine);
    }
    this.drain();
  };

  drain() {
    if (this.reducing) {
      return;
    }
    try {
      this.reducing = true;
      for (let routine = this.dequeue(); routine; routine = this.dequeue()) {
        const settle = routine.scope.expect(SettleByName);
        try {
          const next = routine.step();
          if (next.done) {
            settle({ exists: true, value: { ok: true, value: next.value } }, (outcome) =>
              routine.settle(outcome),
            );
          } else {
            routine.perform(next.value);
          }
        } catch (error) {
          settle({ exists: true, value: { ok: false, error } }, (outcome) =>
            routine.settle(outcome),
          );
        }
      }
    } finally {
      this.reducing = false;
    }
  }

  private dequeue(): Coroutine | undefined {
    if (this.paused) {
      return undefined;
    }
    for (let priority = 0; priority < this.tiers.length; priority++) {
      const tier = this.tiers[priority];
      if (tier && tier.length > 0) {
        const routine = tier.shift();
        if (routine) {
          routine.data.enqueued = false;
          return routine;
        }
      }
    }
    return undefined;
  }

  get queued(): number {
    return this.tiers.reduce((sum, tier) => sum + (tier?.length ?? 0), 0);
  }
}

/** What the published surface offers for scheduling. Nothing. */
function reportPublishedSurface(): void {
  heading("1. what Effection 4.1.0 publishes");

  const members = Object.keys(api).toSorted();
  say(`effection/experimental exports api with: ${members.join(", ")}`);
  say(
    `api.Main (the Inspector's 4.1.0-alpha.7 gate around the program body) is ${
      "Main" in api ? "present" : "ABSENT"
    }`,
  );
  say(
    "api.Scope's members are create/destroy/set/delete. `create` returns a tuple, not an Operation,",
  );
  say("so middleware over it cannot suspend — it can observe a scope appearing, and nothing more.");
}

/** Whether the internals can be imported at all. */
function* reportDeepImport(): Operation<void> {
  heading("2. can the scheduler be imported directly?");

  for (const specifier of [
    "effection/esm/lib/reducer.js",
    "npm:effection@4.1.0/esm/lib/reducer.js",
  ]) {
    const outcome: Result<unknown> = yield* until(
      import(specifier).then(
        (value: unknown) => Ok(value),
        (error: unknown) => Err<unknown>(error),
      ),
    );
    say(`import("${specifier}") => ${outcome.ok ? "RESOLVED" : `refused: ${outcome.error.name}`}`);
  }
  say("The package's `exports` map publishes `.` and `./experimental` only, so the reducer,");
  say("ReducerContext, SettleContext, Priority, Children, callcc and trap are all unreachable.");
}

/** The one mechanism that gates every continuation, and what it costs. */
function* reportSubstitution(): Operation<void> {
  heading("3. substituting the scheduler for one subtree");

  const gate = new Gate();
  const progress = { entry: 0, childA: 0, childB: 0, sibling: 0 };

  const target = createScope();
  target.set(ReducerByName, gate);

  target.run(function* () {
    yield* spawn(function* () {
      while (true) {
        yield* sleep(1);
        progress.childA += 1;
      }
    });
    yield* spawn(function* () {
      while (true) {
        yield* sleep(1);
        progress.childB += 1;
      }
    });
    while (true) {
      yield* sleep(1);
      progress.entry += 1;
    }
  });

  yield* spawn(function* () {
    while (true) {
      yield* sleep(1);
      progress.sibling += 1;
    }
  });

  yield* sleep(30);
  const before = { ...progress };
  gate.paused = true;
  yield* sleep(30);
  const during = { ...progress };
  // Read before draining: this is the count of continuations being *held*, and
  // after a release there is nothing left to count.
  const retained = gate.queued;
  gate.paused = false;
  gate.drain();
  yield* sleep(30);
  const after = { ...progress };

  say(`before pause: ${JSON.stringify(before)}`);
  say(`while paused: ${JSON.stringify(during)} (retained: ${retained})`);
  say(`after release: ${JSON.stringify(after)}`);

  const frozen =
    during.entry === before.entry &&
    during.childA === before.childA &&
    during.childB === before.childB;
  say("");
  say(`Every descendant froze without invoking any Api: ${frozen}. The loops here are raw`);
  say(
    `Effection — no checkpoint, no cooperation — and the sibling advanced ${
      during.sibling - before.sibling
    } times`,
  );
  say("across the same interval. This is the capability the middleware seam cannot reach.");
}

/** Why the above is a named gap and not a design. */
function* reportFailsOpen(): Operation<void> {
  heading("4. why that substitution is not a proposal");

  const target = createScope();
  const MisspelledByName = createContext<unknown>("@effection/reducer-v2");
  const gate = new Gate();
  gate.paused = true;
  target.set(MisspelledByName, gate);

  const progress = { work: 0 };
  target.run(function* () {
    while (true) {
      yield* sleep(1);
      progress.work += 1;
    }
  });

  yield* sleep(20);

  say(`Writing a context name the runtime does not read threw nothing, enqueued nothing`);
  say(`(gate.queued = ${gate.queued}), and the subtree advanced ${progress.work} times while the`);
  say("gate believed it was holding everything. A pause built this way reports `paused` for a");
  say("live subtree the moment the internal name moves, because there is no binding to fail.");
  say("");
  say("The missing seam, stated as a request: a *public*, per-scope way to mediate continuation");
  say("scheduling — an `api.Reducer`/`api.Coroutine` that `Scope.around()` can decorate, or an");
  say("exported ReducerContext — so that a gate can be installed by ownership and *proven* bound.");
}

await main(function* () {
  reportPublishedSurface();
  yield* reportDeepImport();
  yield* reportSubstitution();
  yield* reportFailsOpen();
  say("");
});
