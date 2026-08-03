/**
 * Split a runtime's corpus into shards that finish at the same time.
 *
 * `deno test --shard=i/N` splits the *sorted* file list into consecutive
 * groups, which puts neighbours in the same shard regardless of what they cost.
 * Measured on this corpus, that lands the `packages/test-agent` and `scripts`
 * heavyweights together: at three shards the sorted split models 137 s against
 * 81 s for the weighted one, and 81 s is within a second of a perfect balance.
 *
 * So shards are assigned by longest-processing-time-first over recorded
 * weights: take the most expensive file still unassigned, give it to the shard
 * with the least work so far, repeat. The result is deterministic — ties break
 * on the path, and the shard order never depends on iteration order — because
 * a partition that moved between the workflow and the aggregate would make
 * "every file ran exactly once" unprovable.
 *
 * A file nobody has measured is not an error. It takes the median weight and
 * the caller reports it, because failing the build for an unmeasured test would
 * make adding a test a two-step act, and silently weighting it zero would pile
 * every new test into one shard.
 */

export type Weights = Readonly<Record<string, number>>;

export interface Shard {
  files: string[];
  /** What the recorded weights say this shard costs, in milliseconds. */
  weight: number;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Files the weights do not mention, in the order they were given. */
export function unweighted(files: string[], weights: Weights): string[] {
  return files.filter((file) => weights[file] === undefined);
}

/**
 * `files` in `count` disjoint shards whose union is `files`.
 *
 * Shards are returned heaviest-first so that `--shard=1/N` is the longest one:
 * a workflow that loses a shard then loses the one whose absence is loudest.
 */
export function partition(files: string[], weights: Weights, count: number): Shard[] {
  if (count < 1) {
    throw new Error(`a corpus cannot be split into ${count} shards`);
  }
  const fallback = median(Object.values(weights));
  const cost = (file: string): number => weights[file] ?? fallback;

  const ordered = [...files].sort((left, right) => {
    const difference = cost(right) - cost(left);
    if (difference !== 0) {
      return difference;
    }
    return left.localeCompare(right);
  });

  const shards: Shard[] = Array.from({ length: count }, () => ({ files: [], weight: 0 }));
  for (const file of ordered) {
    const lightest = shards.reduce((left, right) => (lighter(right, left) ? right : left));
    lightest.files.push(file);
    lightest.weight += cost(file);
  }

  return shards
    .map((shard) => ({ files: shard.files.sort(), weight: shard.weight }))
    .sort((left, right) => right.weight - left.weight || compare(left.files, right.files));
}

/**
 * Which shard has less work.
 *
 * Equal weights fall back to file count, and a corpus nobody has measured is
 * entirely equal weights: without that tie-break every file lands in the first
 * shard and the rest run nothing.
 */
function lighter(candidate: Shard, best: Shard): boolean {
  if (candidate.weight !== best.weight) {
    return candidate.weight < best.weight;
  }
  return candidate.files.length < best.files.length;
}

/** Total order for equally weighted shards, so the split never depends on timing. */
function compare(left: string[], right: string[]): number {
  return (left[0] ?? "").localeCompare(right[0] ?? "");
}
