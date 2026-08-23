/**
 * The interference proof's place in the clean chain, which is the whole of what
 * this harness adds.
 *
 * Two things are worth recording. The snapshot has to be taken before the probe
 * — after it, anything the probe moved is already in the baseline and compares
 * equal. And the comparison has to happen whether the probe passed or not: a
 * failing probe is exactly when a moved `node_modules` or lockfile would go
 * unreported, because the run is already exiting non-zero for another reason.
 *
 * The previous version of this harness got the second one wrong — it returned
 * at a failed battery and never compared — which is why the failing case here
 * is not a variation on the passing one.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { interferenceProof, phases } from "../verify-clean.ts";
import type { OwnedState } from "../lib/verify.ts";
import type { TrackedEntry, TrackedState } from "../lib/tracked.ts";

const SOURCE: TrackedEntry = { kind: "file", digest: "abc123def456", executable: false };
const LINK: TrackedEntry = { kind: "symlink", target: "../mod.ts" };
const CLEAN: TrackedState = new Map<string, TrackedEntry>([
  ["mod.ts", SOURCE],
  ["bin/xmd", LINK],
]);

function owned(overrides: Partial<OwnedState> = {}): OwnedState {
  return {
    tracked: CLEAN,
    installed: ["node_modules/tsx 100644 file aaa"],
    lock: "0",
    ...overrides,
  };
}

const EMPTY = owned();
const MOVED = owned({ lock: "changed" });

interface Recorded {
  order: string[];
  states: OwnedState[];
  passes: boolean;
}

function proof({ order, states, passes }: Recorded) {
  let taken = 0;
  return {
    *baseline(): Operation<OwnedState> {
      order.push("baseline");
      return states[Math.min(taken++, states.length - 1)] ?? EMPTY;
    },
    *probe(): Operation<boolean> {
      order.push("probe");
      return passes;
    },
    *after(): Operation<OwnedState> {
      order.push("after");
      return states[Math.min(taken++, states.length - 1)] ?? EMPTY;
    },
  };
}

describe("CP11 — the interference proof runs between two snapshots", () => {
  it("takes the baseline before the probe, and compares after it", function* () {
    const order: string[] = [];
    yield* interferenceProof(proof({ order, states: [EMPTY], passes: true }));

    expect(order).toEqual(["baseline", "probe", "after"]);
  });

  it("reports nothing moved when the probe preserved what the repository owns", function* () {
    const order: string[] = [];
    const result = yield* interferenceProof(proof({ order, states: [EMPTY], passes: true }));

    expect(result).toEqual({ passed: true, moved: [] });
  });

  it("names what moved when the probe changed it", function* () {
    const order: string[] = [];
    const result = yield* interferenceProof(proof({ order, states: [EMPTY, MOVED], passes: true }));

    expect(result.passed).toBe(true);
    expect(result.moved.join("\n")).toContain("deno.lock changed");
  });

  /** The regression: a failed probe used to return before the comparison ran. */
  it("still compares after a failing probe, and reports both", function* () {
    const order: string[] = [];
    const result = yield* interferenceProof(
      proof({ order, states: [EMPTY, MOVED], passes: false }),
    );

    expect(order).toEqual(["baseline", "probe", "after"]);
    expect(result.passed).toBe(false);
    expect(result.moved.join("\n")).toContain("deno.lock changed");
  });

  it("reports a clean tree after a failing probe as a failure with nothing moved", function* () {
    const order: string[] = [];
    const result = yield* interferenceProof(proof({ order, states: [EMPTY], passes: false }));

    expect(result).toEqual({ passed: false, moved: [] });
    expect(order).toContain("after");
  });
});

/**
 * CP11 — what the outer comparison can see.
 *
 * `hostState()` alone covers `node_modules` and the lockfile, and a probe
 * process that failed is exactly the case where its own comparison never got to
 * run. So the snapshots this harness takes have to describe tracked content,
 * executable modes, symlink targets and presence as well — and have to do it on
 * the failing path, not only the passing one.
 */
describe("CP11 — the outer comparison covers tracked paths after a failed probe", () => {
  const moved: [string, OwnedState][] = [
    [
      "rewritten content",
      owned({
        tracked: new Map([...CLEAN, ["mod.ts", { ...SOURCE, digest: "999999999999" }]]),
      }),
    ],
    [
      "a flipped executable bit",
      owned({
        tracked: new Map([...CLEAN, ["mod.ts", { ...SOURCE, executable: true }]]),
      }),
    ],
    [
      "a repointed symlink",
      owned({
        tracked: new Map<string, TrackedEntry>([
          ...CLEAN,
          ["bin/xmd", { kind: "symlink", target: "../other.ts" }],
        ]),
      }),
    ],
    [
      "a deleted tracked file",
      owned({
        tracked: new Map<string, TrackedEntry>([...CLEAN, ["mod.ts", { kind: "absent" }]]),
      }),
    ],
    ["node_modules", owned({ installed: [] })],
    ["the lockfile", owned({ lock: "changed" })],
  ];

  for (const [what, after] of moved) {
    it(`reports ${what} even though the probe itself failed`, function* () {
      const order: string[] = [];
      const result = yield* interferenceProof(
        proof({ order, states: [EMPTY, after], passes: false }),
      );

      expect(result.passed).toBe(false);
      expect(result.moved.length).toBeGreaterThan(0);
      expect(order).toEqual(["baseline", "probe", "after"]);
    });

    it(`reports ${what} when the probe passed`, function* () {
      const order: string[] = [];
      const result = yield* interferenceProof(
        proof({ order, states: [EMPTY, after], passes: true }),
      );

      expect(result.passed).toBe(true);
      expect(result.moved.length).toBeGreaterThan(0);
    });
  }

  it("names the tracked path it found moved", function* () {
    const order: string[] = [];
    const after = owned({
      tracked: new Map([...CLEAN, ["mod.ts", { ...SOURCE, executable: true }]]),
    });
    const result = yield* interferenceProof(
      proof({ order, states: [EMPTY, after], passes: false }),
    );

    expect(result.moved.join("\n")).toContain("mod.ts");
  });
});

describe("CP11 — the offline build phases are unchanged", () => {
  it("still runs build:web, build and the release compile, in that order", function* () {
    expect(phases("xmd-release").map((phase) => phase.label)).toEqual([
      "build:web",
      "build",
      "release compile",
    ]);
  });

  /** The site pair belongs to the dedicated site job; nothing here may run it. */
  it("names no site phase", function* () {
    const everything = JSON.stringify(phases("xmd-release"));
    expect(everything).not.toContain("site");
  });
});
