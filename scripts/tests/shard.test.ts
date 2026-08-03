import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { median, partition, unweighted } from "../lib/shard.ts";
import type { Weights } from "../lib/shard.ts";

const FILES = ["a", "b", "c", "d", "e", "f"];
const WEIGHTS: Weights = { a: 100, b: 90, c: 40, d: 30, e: 20, f: 20 };

function makespan(shards: Array<{ weight: number }>): number {
  return Math.max(...shards.map((shard) => shard.weight));
}

describe("partition", () => {
  it("covers the corpus exactly once", function* () {
    const shards = partition(FILES, WEIGHTS, 3);
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual([...FILES].sort());
  });

  it("keeps shards disjoint", function* () {
    const shards = partition(FILES, WEIGHTS, 3);
    const seen = new Set<string>();
    for (const file of shards.flatMap((shard) => shard.files)) {
      expect(seen.has(file)).toBe(false);
      seen.add(file);
    }
  });

  it("gives the same answer every time, whatever order the files arrive in", function* () {
    const forwards = partition(FILES, WEIGHTS, 3);
    const backwards = partition([...FILES].reverse(), WEIGHTS, 3);
    expect(backwards).toEqual(forwards);
  });

  it("balances by weight rather than by file count", function* () {
    const shards = partition(FILES, WEIGHTS, 3);
    // 100 / 110 / 90 against a perfect 100: the two heaviest files run alone,
    // and the four cheap ones share a shard.
    expect(makespan(shards)).toEqual(110);
    expect(shards.map((shard) => shard.files.length).sort()).not.toEqual([2, 2, 2]);
  });

  it("beats splitting the sorted list into consecutive groups", function* () {
    const sorted = [...FILES].sort();
    const consecutive = [0, 1, 2].map((index) => {
      const group = sorted.slice((sorted.length * index) / 3, (sorted.length * (index + 1)) / 3);
      return { weight: group.reduce((total, file) => total + WEIGHTS[file]!, 0) };
    });
    expect(makespan(partition(FILES, WEIGHTS, 3))).toBeLessThan(makespan(consecutive));
  });

  it("weighs an unmeasured file at the median instead of at nothing", function* () {
    const shards = partition([...FILES, "new"], WEIGHTS, 3);
    const carrying = shards.find((shard) => shard.files.includes("new"))!;
    expect(carrying.weight).toBeGreaterThan(median(Object.values(WEIGHTS)) - 1);
    expect(unweighted([...FILES, "new"], WEIGHTS)).toEqual(["new"]);
  });

  it("still covers the corpus when nothing has been measured", function* () {
    const shards = partition(FILES, {}, 2);
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual([...FILES].sort());
    expect(shards.map((shard) => shard.files.length)).toEqual([3, 3]);
  });

  it("returns the heaviest shard first, so a missing shard is the loudest one", function* () {
    const shards = partition(FILES, WEIGHTS, 3);
    expect(shards[0]!.weight).toBeGreaterThanOrEqual(shards[2]!.weight);
  });

  it("puts every file in the only shard there is", function* () {
    expect(partition(FILES, WEIGHTS, 1)[0]!.files).toEqual([...FILES].sort());
  });

  it("refuses a split into no shards", function* () {
    expect(() => partition(FILES, WEIGHTS, 0)).toThrow();
  });
});

describe("median", () => {
  it("is the middle of an odd count", function* () {
    expect(median([5, 1, 3])).toEqual(3);
  });

  it("averages the middle pair of an even count", function* () {
    expect(median([1, 2, 3, 4])).toEqual(3);
  });

  it("is zero when nothing has been measured", function* () {
    expect(median([])).toEqual(0);
  });
});
