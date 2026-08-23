/**
 * The topology, its order, and what it refuses to call a proof.
 *
 * These stand in for the four processes with a recorder, because what is being
 * checked here is coordination: that the producer does not start before the
 * consumers are cycling, that a participant failing does not cancel the others
 * or skip the comparison, that a mutation restored before the end is still
 * reported, and that a consumer which never overlapped the producer is a hole
 * rather than a pass.
 *
 * Nothing here waits on a clock. A mutation is held until the observer has
 * seen it and the producer settles only then, so a case that would be a timing
 * test elsewhere is a deterministic one here.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep } from "effection";
import type { Operation } from "effection";

import {
  movedOwned,
  movedSensitive,
  OBSERVER,
  PARTICIPANTS,
  PRODUCER,
  PROBE_TIMEOUT_MILLISECONDS,
  REPRODUCE,
  RUNTIMES,
  UNREADABLE,
  verify,
} from "../lib/verify.ts";
import type { OwnedState, Sensitive, Settled, VerifyHost } from "../lib/verify.ts";
import type { CycleReport, Runtime } from "../lib/consumer-cycle.ts";
import type { TrackedEntry, TrackedState } from "../lib/tracked.ts";

const FILE: TrackedEntry = { kind: "file", digest: "abc123def456", executable: false };
const CLEAN: TrackedState = new Map([["a.ts", FILE]]);
const DIRTY: TrackedState = new Map([["a.ts", { ...FILE, digest: "999999999999" }]]);

const MANIFEST = "packages/web/node_modules/@rjsf/validator-ajv8/package.json";
const OTHER_MANIFEST = "node_modules/@rjsf/validator-ajv8/package.json";

function whole(): Sensitive {
  return {
    manifests: { [MANIFEST]: "digest-a ino=1", [OTHER_MANIFEST]: "digest-b ino=2" },
    generated: "whole",
  };
}

function owned(tracked: TrackedState, installed: readonly string[], lock: string): OwnedState {
  return { tracked, installed, lock };
}

const BEFORE = owned(CLEAN, ["node_modules/tsx 100644 file aaa"], "lock-a");

/** A state the producer holds until the observer has read it, then restores. */
interface Mutation {
  /** What `sensitive()` reports while the producer holds it. */
  broken(base: Sensitive): Sensitive;
  /** Readings of the broken state the producer waits for before restoring. */
  readings?: number;
}

interface Behaviour {
  /** Exit codes by participant id; anything unnamed passes. */
  codes?: Record<string, number>;
  /** Participants that throw instead of settling. */
  throws?: string[];
  /** Consumers that never signal readiness and never exit. */
  wedged?: Runtime[];
  /** A producer that never settles, so only the deadline can end it. */
  wedgedProducer?: boolean;
  /** The observer's first loop reading takes several turns to complete. */
  slowObserver?: boolean;
  /** Cycle counts by runtime; a whole overlap when unnamed. */
  cycles?: Partial<Record<Runtime, CycleReport | null>>;
  mutation?: Mutation;
  /** Owned snapshots handed back in order; the last one repeats. */
  ownedStates?: OwnedState[];
  /** The generated module is already broken before the probe begins. */
  bornBroken?: boolean;
}

interface Recorded {
  host: VerifyHost;
  lines: string[];
  emitted: string[];
  order: string[];
}

function recorder(behaviour: Behaviour): Recorded {
  const lines: string[] = [];
  const emitted: string[] = [];
  const order: string[] = [];
  const states = behaviour.ownedStates ?? [BEFORE];
  const ready = new Set<Runtime>();
  let taken = 0;
  let observations = 0;
  let producing = false;
  let restored = false;
  let abandoned = false;
  let seenBroken = 0;

  function* settle(id: string, code: number): Operation<Settled> {
    if (behaviour.throws?.includes(id)) {
      throw new Error(`${id} never started`);
    }
    return { code, milliseconds: 1000 };
  }

  const host: VerifyHost = {
    *produce(): Operation<Settled> {
      order.push("produce");
      if (behaviour.wedgedProducer) {
        yield* sleep(PROBE_TIMEOUT_MILLISECONDS);
      }
      // Held until the observer has actually read the broken state, so the
      // restoration below can never win a race the report depends on.
      const wanted = behaviour.mutation?.readings ?? 1;
      while (behaviour.mutation !== undefined && seenBroken < wanted) {
        yield* sleep(0);
      }
      restored = true;
      return yield* settle(PRODUCER, behaviour.codes?.[PRODUCER] ?? 0);
    },

    *consume(runtime: Runtime): Operation<Settled> {
      order.push(`consume:${runtime}`);
      if (behaviour.wedged?.includes(runtime)) {
        yield* sleep(PROBE_TIMEOUT_MILLISECONDS);
      }
      ready.add(runtime);
      while (!restored && !abandoned) {
        yield* sleep(0);
      }
      return yield* settle(runtime, behaviour.codes?.[runtime] ?? 0);
    },

    *spool(id: string): Operation<Uint8Array> {
      return new TextEncoder().encode(`<output of ${id}>`);
    },

    // deno-lint-ignore require-yield
    *isReady(runtime: Runtime): Operation<boolean> {
      return ready.has(runtime);
    },

    // deno-lint-ignore require-yield
    *cycles(runtime: Runtime): Operation<CycleReport | undefined> {
      const named = behaviour.cycles?.[runtime];
      if (named === null) {
        return undefined;
      }
      return named ?? { runtime, before: 2, during: 5, after: 1 };
    },

    // deno-lint-ignore require-yield
    *signal(name: string): Operation<void> {
      order.push(`signal:${name}`);
      if (name === "producing") {
        producing = true;
      }
      if (name === "settled") {
        abandoned = true;
      }
    },

    *sensitive(): Operation<Sensitive> {
      const first = observations === 0;
      observations++;
      if (behaviour.slowObserver && !first) {
        // Long enough that a coordinator which did not wait would have
        // signalled `producing` by now.
        for (let turn = 0; turn < 8; turn++) {
          yield* sleep(0);
        }
      }
      order.push(first ? "baseline" : "observe");
      const base = whole();
      if (behaviour.bornBroken) {
        return { ...base, generated: `${UNREADABLE}nothing has built it yet` };
      }
      if (behaviour.mutation && producing && !restored) {
        seenBroken++;
        return behaviour.mutation.broken(base);
      }
      return base;
    },

    // deno-lint-ignore require-yield
    *owned(): Operation<OwnedState> {
      const state = states[Math.min(taken, states.length - 1)]!;
      taken += 1;
      return state;
    },

    pause: (milliseconds) => sleep(Math.min(milliseconds, 0)),

    log(message) {
      lines.push(message);
    },
    emit(bytes) {
      emitted.push(new TextDecoder().decode(bytes));
    },
  };

  return { host, lines, emitted, order };
}

/** The report's verdict lines, as `<state> <id>`. */
function results(lines: string[]): string[] {
  return lines
    .filter((entry) => entry.startsWith("  ok") || entry.startsWith("  FAILED"))
    .map((entry) => entry.trim().split(/\s+/).slice(0, 2).join(" "));
}

describe("CP1 — the topology is the producer, three consumers and an observer", () => {
  it("names them in one fixed order and runs nothing else", function* () {
    expect([...PARTICIPANTS]).toEqual(["build:web", "deno", "node", "bun", "observer"]);
    expect([...RUNTIMES]).toEqual(["deno", "node", "bun"]);
  });

  it("reports every participant, in that order, whatever finished first", function* () {
    const { host, lines } = recorder({});

    expect(yield* verify(host)).toEqual(0);
    expect(results(lines)).toEqual(["ok build:web", "ok deno", "ok node", "ok bun", "ok observer"]);
  });

  it("reproduces as the whole topology rather than as one command", function* () {
    const { host, lines } = recorder({ codes: { deno: 1 } });

    yield* verify(host);
    expect(lines.join("\n")).toContain(REPRODUCE);
    expect(REPRODUCE).toEqual("deno task verify");
  });

  /** The battery that used to live here is what this issue removed. */
  it("states the one deadline it has, and has no per-suite deadlines", function* () {
    const { host, lines } = recorder({});

    yield* verify(host);
    expect(lines[0]).toContain("20m deadline");
    expect(PROBE_TIMEOUT_MILLISECONDS).toEqual(20 * 60 * 1000);
  });

  /** A wedged producer is settled once and reported, never attempted again. */
  it("settles a wedged producer at the deadline and starts nothing twice", function* () {
    const { host, lines, order } = recorder({ wedgedProducer: true });

    expect(yield* verify(host, { deadline: 30 })).toEqual(1);
    expect(lines.join("\n")).toContain("timed out after");
    expect(order.filter((entry) => entry === "produce")).toHaveLength(1);
  });

  it("starts each consumer once, even when it fails", function* () {
    const { host, order } = recorder({ codes: { deno: 1, node: 1, bun: 1 } });

    yield* verify(host);
    for (const runtime of RUNTIMES) {
      expect(order.filter((entry) => entry === `consume:${runtime}`)).toHaveLength(1);
    }
  });

  /** The producer never starts against a topology that never assembled. */
  it("reports a consumer that never reached a cycle instead of producing", function* () {
    const { host, lines, order } = recorder({ wedged: ["bun"] });

    expect(yield* verify(host, { deadline: 30 })).toEqual(1);
    expect(order).not.toContain("produce");
    expect(lines.join("\n")).toContain("did not all reach a reading");
    expect(lines.join("\n")).toContain("never started");
  });
});

describe("CP3 — the producer starts only once every consumer is cycling", () => {
  it("consumes, signals producing, produces, then signals settlement", function* () {
    const { host, order } = recorder({});

    yield* verify(host);

    const started = order.indexOf("signal:producing");
    const produced = order.indexOf("produce");
    for (const runtime of RUNTIMES) {
      expect(order.indexOf(`consume:${runtime}`)).toBeLessThan(started);
    }
    expect(started).toBeLessThan(produced);
    expect(produced).toBeLessThan(order.indexOf("signal:settled"));
  });

  /**
   * The observer is a participant, and a producer that beat its first reading
   * would open the window it is meant to be watched through. `slowObserver`
   * makes the first loop reading take several turns, so a coordinator that did
   * not wait would visibly signal `producing` first.
   */
  it("waits for the observer's first reading before signalling producing", function* () {
    const { host, order } = recorder({ slowObserver: true });

    yield* verify(host);

    expect(order.indexOf("observe")).toBeGreaterThan(-1);
    expect(order.indexOf("observe")).toBeLessThan(order.indexOf("signal:producing"));
  });

  it("takes its baseline reading before anything starts", function* () {
    const { host, order } = recorder({});

    yield* verify(host);

    expect(order[0]).toEqual("baseline");
    expect(order.indexOf("baseline")).toBeLessThan(order.indexOf("consume:deno"));
  });

  it("names the observer when the topology never assembled without one", function* () {
    const { host, lines } = recorder({ slowObserver: true, wedged: ["bun"] });

    expect(yield* verify(host, { deadline: 30 })).toEqual(1);
    expect(lines.join("\n")).toContain("did not all reach a reading");
  });

  it("still settles the consumers when one of them dies before it is ready", function* () {
    const { host, lines } = recorder({ throws: ["node"] });

    expect(yield* verify(host)).toEqual(1);
    expect(results(lines)).toContain("FAILED node");
    expect(results(lines)).toContain("ok build:web");
  });
});

describe("CP5/CP6 — a mutation restored before the end is still a failure", () => {
  it("fails on a manifest rewritten and put back", function* () {
    const { host, lines } = recorder({
      mutation: {
        broken: (base) => ({
          ...base,
          manifests: { ...base.manifests, [MANIFEST]: "digest-a ino=77" },
        }),
      },
    });

    expect(yield* verify(host)).toEqual(1);
    expect(results(lines)).toContain("FAILED observer");
    expect(lines.join("\n")).toContain(`${MANIFEST} changed while the producer ran`);
  });

  it("fails on a generated module that was briefly not whole", function* () {
    const { host, lines } = recorder({
      mutation: { broken: (base) => ({ ...base, generated: `${UNREADABLE}it is partial` }) },
    });

    expect(yield* verify(host)).toEqual(1);
    expect(lines.join("\n")).toContain("the generated module was not whole: it is partial");
  });

  /** The whole reason the observer exists rather than one comparison at the end. */
  it("passes the same run when the state never moves", function* () {
    const { host } = recorder({});

    expect(yield* verify(host)).toEqual(0);
  });

  it("refuses to start against a generated module that is already broken", function* () {
    const { host, lines, order } = recorder({ bornBroken: true });

    expect(yield* verify(host)).toEqual(1);
    // The baseline reading is what discovered it; nothing else was started.
    expect(order).toEqual(["baseline"]);
    expect(lines.join("\n")).toContain("nothing has built it yet");
  });

  it("holds manifests to identity and the generated module to wholeness", function* () {
    const base = whole();
    const rewritten = { ...base, manifests: { ...base.manifests, [MANIFEST]: "digest-a ino=9" } };
    expect(movedSensitive(base, rewritten)).toHaveLength(1);

    // The producer replaces this file; a different whole module is not a fault.
    expect(movedSensitive(base, { ...base, generated: "whole again, larger" })).toEqual([]);
    expect(movedSensitive(base, { ...base, generated: `${UNREADABLE}gone` })).toHaveLength(1);

    // A manifest that disappears, and one that appears, are both movement.
    expect(movedSensitive(base, { ...base, manifests: {} })).toHaveLength(2);
  });
});

describe("CP8 — the comparison covers three things and always runs", () => {
  it("names a tracked file, node_modules and the lockfile separately", function* () {
    expect(movedOwned(BEFORE, owned(DIRTY, BEFORE.installed, BEFORE.lock))).toHaveLength(1);
    expect(movedOwned(BEFORE, owned(CLEAN, BEFORE.installed, "lock-b"))).toEqual([
      "deno.lock changed",
    ]);
    expect(movedOwned(BEFORE, owned(CLEAN, [], BEFORE.lock)).join("\n")).toContain(
      "node_modules: 1 removed, 0 added",
    );
    expect(movedOwned(BEFORE, BEFORE)).toEqual([]);
  });

  for (const [what, after] of [
    ["a tracked file", owned(DIRTY, BEFORE.installed, BEFORE.lock)],
    ["node_modules", owned(CLEAN, ["node_modules/tsx 100644 file bbb"], BEFORE.lock)],
    ["deno.lock", owned(CLEAN, BEFORE.installed, "lock-b")],
  ] as const) {
    it(`fails when the probe moved ${what}`, function* () {
      const { host, lines } = recorder({ ownedStates: [BEFORE, after] });

      expect(yield* verify(host)).toEqual(1);
      expect(lines.join("\n")).toContain("repository-owned state");
    });
  }

  /** A failing participant is exactly when a moved tree would go unnoticed. */
  it("reports both the failure and the movement, never one instead of the other", function* () {
    const { host, lines } = recorder({
      codes: { bun: 3 },
      ownedStates: [BEFORE, owned(CLEAN, BEFORE.installed, "lock-b")],
    });

    expect(yield* verify(host)).toEqual(1);
    const report = lines.join("\n");
    expect(results(lines)).toContain("FAILED bun");
    expect(report).toContain("deno.lock changed");
  });
});

describe("CP9 — the report emits the first failure whole and names the rest", () => {
  it("emits one spool, in participant order, and names later failures", function* () {
    const { host, lines, emitted } = recorder({ codes: { node: 1, bun: 1 } });

    expect(yield* verify(host)).toEqual(1);
    expect(emitted).toEqual(["<output of node>"]);
    expect(lines.join("\n")).toContain("also failed: bun");
  });

  it("prefers the producer's output when the producer is what failed", function* () {
    const { host, emitted } = recorder({ codes: { [PRODUCER]: 1, deno: 1 } });

    yield* verify(host);
    expect(emitted).toEqual([`<output of ${PRODUCER}>`]);
  });

  /** The observer has no process and therefore no spool; its findings are the output. */
  it("prints the observer's violations instead of reading a spool", function* () {
    const { host, lines, emitted } = recorder({
      mutation: { broken: (base) => ({ ...base, generated: `${UNREADABLE}truncated` }) },
    });

    yield* verify(host);
    expect(emitted).toEqual([]);
    expect(lines.join("\n")).toContain("truncated");
  });

  it("reports how many readings the observer took", function* () {
    const { host, lines } = recorder({});

    yield* verify(host);
    const observer = lines.find((entry) => entry.includes(OBSERVER)) ?? "";
    expect(observer).toContain("reading(s)");
  });
});

describe("CP2 — a consumer that never overlapped the producer is not a pass", () => {
  for (const [what, report] of [
    ["never ran while the producer did", { runtime: "deno", before: 3, during: 0, after: 1 }],
    ["only started after the producer", { runtime: "deno", before: 0, during: 4, after: 1 }],
    // The loop runs exactly one cycle once the producer has settled, so a zero
    // here is a consumer that never saw the state the producer left behind.
    ["stopped before the producer settled", { runtime: "deno", before: 2, during: 4, after: 0 }],
  ] as const) {
    it(`fails a consumer that ${what}, even at exit zero`, function* () {
      const { host, lines } = recorder({ cycles: { deno: { ...report, runtime: "deno" } } });

      expect(yield* verify(host)).toEqual(1);
      expect(results(lines)).toContain("FAILED deno");
      expect(lines.join("\n")).toContain("never overlapped the producer");
    });
  }

  it("fails a consumer that recorded nothing at all", function* () {
    const { host, lines } = recorder({ cycles: { bun: null } });

    expect(yield* verify(host)).toEqual(1);
    expect(lines.join("\n")).toContain("recorded no cycles");
  });

  it("reports each runtime's cycles before, during and after", function* () {
    const { host, lines } = recorder({});

    yield* verify(host);
    for (const runtime of RUNTIMES) {
      const entry = lines.find((line) => line.startsWith("  ok") && line.includes(runtime)) ?? "";
      expect(entry).toContain("(2 before, 5 during, 1 after)");
    }
  });
});
