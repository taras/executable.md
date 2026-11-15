import { z } from "zod";

export const EDITS = 40;
export const WARMUP = 10;
export const VIEWPORT = { columns: 200, rows: 52 };
export const WORKLOADS = [
  { name: "small", rounds: 2, linesPerRound: 32 },
  { name: "wrapping", rounds: 52, linesPerRound: 368 },
];

const TypingSampleSchema = z.object({
  edit: z.number().int().positive(),
  milliseconds: z.number().finite().positive(),
  writes: z.number().int().positive(),
});
export type TypingSample = z.infer<typeof TypingSampleSchema>;

const Run = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  runtime: z.object({ deno: z.string(), v8: z.string(), typescript: z.string() }),
  host: z.object({ os: z.string(), arch: z.string() }),
  viewport: z.object({ columns: z.literal(VIEWPORT.columns), rows: z.literal(VIEWPORT.rows) }),
  workload: z.object({
    name: z.string(),
    rounds: z.number().int().positive(),
    linesPerRound: z.number().int().positive(),
  }),
  warmup: z.literal(WARMUP),
  samples: z.array(TypingSampleSchema).length(EDITS),
});
type Run = z.infer<typeof Run>;
const PREFIX = "XMD_TYPING_SAMPLE ";

function readRuns(stdout: string, revision: string): Map<string, Run> {
  const runs = new Map<string, Run>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith(PREFIX)) {
      const run = Run.parse(JSON.parse(line.slice(PREFIX.length)));
      if (run.revision !== revision || runs.has(run.workload.name)) {
        throw new Error(
          `Unexpected or repeated result for ${run.workload.name} at ${run.revision}.`,
        );
      }
      if (run.samples.some((sample, at) => sample.edit !== at + 1)) {
        throw new Error(`Unexpected edit order for ${run.workload.name}.`);
      }
      runs.set(run.workload.name, run);
    }
  }
  if (runs.size !== WORKLOADS.length) {
    throw new Error(`Expected ${WORKLOADS.length} timing workloads, received ${runs.size}.`);
  }
  return runs;
}

function stats(run: Run) {
  const times = run.samples
    .slice(WARMUP)
    .map((sample) => sample.milliseconds)
    .toSorted((a, b) => a - b);
  const middle = times.length / 2;
  return {
    count: times.length,
    medianMs: (times[middle - 1] + times[middle]) / 2,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
  };
}

export function compareTypingRuns(
  baseline: { readonly revision: string; readonly stdout: string },
  candidate: { readonly revision: string; readonly stdout: string },
) {
  const beforeRuns = readRuns(baseline.stdout, baseline.revision);
  const afterRuns = readRuns(candidate.stdout, candidate.revision);
  const workloads = WORKLOADS.map((workload) => {
    const before = beforeRuns.get(workload.name);
    const after = afterRuns.get(workload.name);
    if (
      before === undefined ||
      after === undefined ||
      [before, after].some(
        (run) =>
          run.workload.rounds !== workload.rounds ||
          run.workload.linesPerRound !== workload.linesPerRound,
      )
    ) {
      throw new Error(`Both runs must use the ${workload.name} fixture.`);
    }
    if (
      JSON.stringify(before.runtime) !== JSON.stringify(after.runtime) ||
      JSON.stringify(before.host) !== JSON.stringify(after.host)
    ) {
      throw new Error(`The ${workload.name} runs used different runtimes or hosts.`);
    }
    const baseline = stats(before);
    const candidate = stats(after);
    return {
      workload,
      baseline: { ...before, ...baseline },
      candidate: { ...after, ...candidate },
      deltaMs: {
        median: candidate.medianMs - baseline.medianMs,
        p95: candidate.p95Ms - baseline.p95Ms,
      },
    };
  });
  return {
    measurement:
      "character dispatch through the completed mounted emulator write containing the changed Message value",
    viewport: VIEWPORT,
    warmup: WARMUP,
    workloads,
  };
}
