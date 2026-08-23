/**
 * Split one runtime's applicable corpus into shards a CI matrix can run at
 * once.
 *
 * The split is a pure function of the applicable paths, the recorded weights,
 * and the requested count: the same inputs give byte-identical lists, on any
 * machine, in any order. That is what lets a matrix job be told only its index
 * and still be certain it runs exactly the files no sibling runs.
 *
 * Assignment is longest-processing-time-first, which minimizes the *longest*
 * shard rather than equalizing file counts — the wall clock a run waits on is
 * the slowest shard, and a corpus with one 90-second file and two hundred
 * one-second files has nothing to gain from equal counts.
 */
export interface Shard {
  /** One-based, so it reads the way the matrix and the check name do. */
  index: number;
  count: number;
  files: string[];
  /** What the recorded weights predict this shard will take, in milliseconds. */
  weight: number;
  /** Assigned files that had no recorded weight and ran at the fallback. */
  unmeasured: string[];
}

export class ShardError extends Error {}

export interface EffectiveWeights {
  weights: Map<string, number>;
  /** The weight an unmeasured file is charged. */
  fallback: number;
  unmeasured: string[];
}

/**
 * What each applicable file is worth for partitioning.
 *
 * A file with no recorded weight is charged the heaviest weight the current
 * corpus recorded, which is conservative in the only direction that matters: a
 * new test lands on the emptiest shard and cannot be treated as free. Weights
 * for files that have since left the corpus are ignored entirely, so a deleted
 * outlier cannot inflate that fallback forever.
 *
 * With nothing recorded at all there is no conservative number to pick — a zero
 * would pack every file onto one shard and a constant would be a timing
 * assumption in disguise — so this refuses instead.
 */
export function effectiveWeights(
  files: string[],
  recorded: Record<string, number>,
): EffectiveWeights {
  const measured = new Map<string, number>();
  for (const file of files) {
    const weight = recorded[file];
    if (typeof weight === "number" && Number.isSafeInteger(weight) && weight > 0) {
      measured.set(file, weight);
    }
  }

  if (measured.size === 0) {
    throw new ShardError("no applicable test file has a recorded weight");
  }

  const fallback = Math.max(...measured.values());
  const unmeasured = files.filter((file) => !measured.has(file));
  const weights = new Map(files.map((file) => [file, measured.get(file) ?? fallback]));

  return { weights, fallback, unmeasured };
}

function requireCount(files: string[], count: number): void {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new ShardError(`shard count ${count} is not a positive integer`);
  }
  if (count > files.length) {
    throw new ShardError(`shard count ${count} exceeds the ${files.length} applicable test files`);
  }
}

/**
 * Every shard of `files`, in index order.
 *
 * Ties are broken twice, and both matter for determinism: equal weights order
 * by ascending path, and equal shard totals take the lowest index.
 */
export function partitionTests(
  files: string[],
  recorded: Record<string, number>,
  count: number,
): Shard[] {
  requireCount(files, count);
  const effective = effectiveWeights(files, recorded);

  const shards: Shard[] = Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    count,
    files: [],
    weight: 0,
    unmeasured: [],
  }));

  const heaviestFirst = [...files].sort((left, right) => {
    const difference = (effective.weights.get(right) ?? 0) - (effective.weights.get(left) ?? 0);
    return difference !== 0 ? difference : left.localeCompare(right);
  });

  for (const file of heaviestFirst) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.weight < lightest.weight) {
        lightest = shard;
      }
    }
    lightest.files.push(file);
    lightest.weight += effective.weights.get(file) ?? 0;
  }

  const unmeasured = new Set(effective.unmeasured);
  for (const shard of shards) {
    shard.files.sort();
    shard.unmeasured = shard.files.filter((file) => unmeasured.has(file));
  }

  return shards;
}

/** The one shard a matrix job runs. */
export function testShard(
  files: string[],
  recorded: Record<string, number>,
  index: number,
  count: number,
): Shard {
  requireCount(files, count);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) {
    throw new ShardError(`shard index ${index} is outside 1..${count}`);
  }
  return partitionTests(files, recorded, count)[index - 1];
}
