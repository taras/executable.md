/**
 * The site proof's order, which is the whole of what it proves.
 *
 * `verify:clean` changes `site/` in its clone so applicability selects the site
 * pair from a real change. That edit has to land *before* the baseline
 * snapshot: after it, the same edit reads as a tracked file the battery
 * dirtied, and the run fails for the harness's own doing. Nothing about the
 * returned value distinguishes the two orders, so these record the sequence.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { siteEnabledBattery } from "../verify-clean.ts";
import type { HostState } from "../lib/prepared-state.ts";

const EMPTY: HostState = { tree: { entries: [], roots: [] }, lock: "0" };

interface Recorded {
  order: string[];
  states: HostState[];
  passes: boolean;
}

function proof({ order, states, passes }: Recorded) {
  let taken = 0;
  return {
    *changeSite(): Operation<void> {
      order.push("change");
    },
    *baseline(): Operation<HostState> {
      order.push("baseline");
      return states[Math.min(taken++, states.length - 1)] ?? EMPTY;
    },
    *battery(): Operation<boolean> {
      order.push("battery");
      return passes;
    },
    *after(): Operation<HostState> {
      order.push("after");
      return states[Math.min(taken++, states.length - 1)] ?? EMPTY;
    },
  };
}

describe("siteEnabledBattery", () => {
  it("changes site/ before it takes the baseline", function* () {
    const order: string[] = [];
    yield* siteEnabledBattery(proof({ order, states: [EMPTY], passes: true }));

    expect(order).toEqual(["change", "baseline", "battery", "after"]);
    expect(order.indexOf("change")).toBeLessThan(order.indexOf("baseline"));
  });

  it("reports nothing moved when the battery preserved the tree", function* () {
    const order: string[] = [];
    const moved = yield* siteEnabledBattery(proof({ order, states: [EMPTY], passes: true }));

    expect(moved).toEqual([]);
  });

  it("names what moved when the battery changed the tree", function* () {
    const order: string[] = [];
    const after: HostState = { tree: { entries: [], roots: [] }, lock: "changed" };
    const moved = yield* siteEnabledBattery(proof({ order, states: [EMPTY, after], passes: true }));

    if (moved === false) {
      throw new Error("this battery was told to pass, so it must have compared");
    }
    expect(moved.join("\n")).toContain("deno.lock changed");
  });

  /** A failed battery is reported as itself, not as a clean comparison. */
  it("stops at a failing battery and never compares", function* () {
    const order: string[] = [];
    const moved = yield* siteEnabledBattery(proof({ order, states: [EMPTY], passes: false }));

    expect(moved).toEqual(false);
    expect(order).toEqual(["change", "baseline", "battery"]);
  });
});
