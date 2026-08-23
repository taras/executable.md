/**
 * A shard job is told an index and a count and nothing else. Everything it runs
 * follows from those two numbers and the committed weights, so the partition
 * has to be a pure function of them: two jobs computing it on two runners, in
 * two processes, must agree exactly or a file runs twice or not at all.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { effectiveWeights, partitionTests, ShardError, testShard } from "../lib/test-shards.ts";

const ONE = "packages/alpha/tests/one.test.ts";
const TWO = "packages/alpha/tests/two.test.ts";
const THREE = "packages/beta/tests/three.test.ts";
const FOUR = "packages/beta/tests/four.test.ts";
const FIVE = "scripts/tests/five.test.ts";
const SIX = "packages/beta/tests/six.test.ts";

const CORPUS = [ONE, TWO, THREE, FOUR, FIVE];

/** `TWO` and `THREE` tie on weight, and the two shards tie on total. */
const WEIGHTS: Record<string, number> = {
  [ONE]: 500,
  [TWO]: 300,
  [THREE]: 300,
  [FOUR]: 200,
  [FIVE]: 100,
};

/** A file that left the corpus, weighing more than anything still in it. */
const STALE = "packages/gone/tests/gone.test.ts";

function files(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `packages/gen/tests/${index}.test.ts`);
}

function refuses(partition: () => unknown): boolean {
  try {
    partition();
    return false;
  } catch (error) {
    return error instanceof ShardError;
  }
}

describe("longest-processing-time assignment", () => {
  it("assigns the exact shards the weights and the tie rules dictate", function* () {
    expect(partitionTests(CORPUS, WEIGHTS, 2)).toEqual([
      { index: 1, count: 2, files: [ONE, FOUR], weight: 700, unmeasured: [] },
      { index: 2, count: 2, files: [TWO, THREE, FIVE], weight: 700, unmeasured: [] },
    ]);
  });

  /**
   * Two files of equal weight and two empty shards: the only thing deciding
   * which shard each lands on is the path order, so a tie broken the other way
   * produces different shards rather than the same ones rearranged.
   */
  it("breaks an equal weight by ascending path", function* () {
    expect(partitionTests([THREE, ONE], { [ONE]: 300, [THREE]: 300 }, 2)).toEqual([
      { index: 1, count: 2, files: [ONE], weight: 300, unmeasured: [] },
      { index: 2, count: 2, files: [THREE], weight: 300, unmeasured: [] },
    ]);
  });

  /** Two shards of equal total take the file in index order, not the reverse. */
  it("breaks an equal shard total by lowest index", function* () {
    expect(partitionTests([ONE, THREE], { [ONE]: 500, [THREE]: 100 }, 2)[0].files).toEqual([ONE]);
  });

  it("returns the same lists on repeated calls and in any input order", function* () {
    const once = partitionTests(CORPUS, WEIGHTS, 3);

    expect(partitionTests(CORPUS, WEIGHTS, 3)).toEqual(once);
    expect(partitionTests([...CORPUS].reverse(), WEIGHTS, 3)).toEqual(once);
    expect(partitionTests([FIVE, ONE, THREE, TWO, FOUR], WEIGHTS, 3)).toEqual(once);
  });

  it("keeps each shard's own files sorted and its index", function* () {
    const shards = partitionTests(CORPUS, WEIGHTS, 2);

    for (const shard of shards) {
      expect(shard.files).toEqual([...shard.files].sort());
      expect(shard.count).toEqual(2);
    }
    expect(shards.map((shard) => shard.index)).toEqual([1, 2]);
  });

  it("minimizes the longest shard rather than equalizing counts", function* () {
    const heavy = { [ONE]: 1000, [TWO]: 10, [THREE]: 10, [FOUR]: 10, [FIVE]: 10 };
    const shards = partitionTests(CORPUS, heavy, 2);

    expect(shards[0].files).toEqual([ONE]);
    expect(shards[1].files).toEqual([FOUR, THREE, TWO, FIVE].sort());
  });

  it("covers the corpus exactly once, at every count", function* () {
    const corpus = files(37);
    const weights = Object.fromEntries(corpus.map((file, index) => [file, (index % 7) + 1]));

    for (let count = 1; count <= corpus.length; count += 1) {
      const shards = partitionTests(corpus, weights, count);
      const assigned = shards.flatMap((shard) => shard.files);

      expect(shards.length).toEqual(count);
      expect(assigned.length).toEqual(corpus.length);
      expect([...assigned].sort()).toEqual([...corpus].sort());
      expect(new Set(assigned).size).toEqual(corpus.length);
      expect(shards.map((shard) => shard.index)).toEqual(
        Array.from({ length: count }, (_, offset) => offset + 1),
      );
    }
  });

  it("hands a matrix job its own shard and no other", function* () {
    const shards = partitionTests(CORPUS, WEIGHTS, 2);

    expect(testShard(CORPUS, WEIGHTS, 1, 2)).toEqual(shards[0]);
    expect(testShard(CORPUS, WEIGHTS, 2, 2)).toEqual(shards[1]);
  });
});

describe("the conservative fallback", () => {
  it("charges an unmeasured file the heaviest recorded weight", function* () {
    const effective = effectiveWeights([...CORPUS, SIX], WEIGHTS);

    expect(effective.fallback).toEqual(500);
    expect(effective.weights.get(SIX)).toEqual(500);
    expect(effective.unmeasured).toEqual([SIX]);
  });

  it("ignores a weight for a file that left the corpus", function* () {
    const stale = { ...WEIGHTS, [STALE]: 900_000 };
    const effective = effectiveWeights([...CORPUS, SIX], stale);

    expect(effective.fallback).toEqual(500);
    expect(effective.weights.get(SIX)).toEqual(500);
    expect(effective.weights.has(STALE)).toBe(false);
  });

  it("runs an unmeasured file exactly once and names it", function* () {
    const corpus = [...CORPUS, SIX];
    const shards = partitionTests(corpus, { ...WEIGHTS, [STALE]: 900_000 }, 2);
    const assigned = shards.flatMap((shard) => shard.files);

    expect([...assigned].sort()).toEqual([...corpus].sort());
    expect(assigned.filter((file) => file === SIX).length).toEqual(1);
    expect(assigned).not.toContain(STALE);
    expect(shards.flatMap((shard) => shard.unmeasured)).toEqual([SIX]);
  });

  it("refuses to invent a weight when nothing applicable is recorded", function* () {
    expect(refuses(() => effectiveWeights(CORPUS, {}))).toBe(true);
    expect(refuses(() => effectiveWeights(CORPUS, { [STALE]: 900_000 }))).toBe(true);
    expect(refuses(() => partitionTests(CORPUS, {}, 2))).toBe(true);
    // A recorded zero is not a weight either.
    expect(refuses(() => effectiveWeights(CORPUS, { [ONE]: 0 }))).toBe(true);
  });
});

describe("refusals", () => {
  it("rejects a count outside one through the corpus size", function* () {
    for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, CORPUS.length + 1]) {
      expect({ count, refused: refuses(() => partitionTests(CORPUS, WEIGHTS, count)) }).toEqual({
        count,
        refused: true,
      });
    }
    expect(partitionTests(CORPUS, WEIGHTS, CORPUS.length).length).toEqual(CORPUS.length);
  });

  it("rejects an index outside one through the count", function* () {
    for (const index of [0, -1, 1.5, Number.NaN, 3, Number.POSITIVE_INFINITY]) {
      expect({ index, refused: refuses(() => testShard(CORPUS, WEIGHTS, index, 2)) }).toEqual({
        index,
        refused: true,
      });
    }
  });

  it("rejects a bad count before it looks at the index", function* () {
    expect(refuses(() => testShard(CORPUS, WEIGHTS, 1, 0))).toBe(true);
    expect(refuses(() => testShard(CORPUS, WEIGHTS, 1, CORPUS.length + 1))).toBe(true);
  });
});
