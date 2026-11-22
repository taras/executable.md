import { z } from "zod";
import { place } from "./report.ts";

export const Coverage = z.object({
  result: z.array(
    z.object({
      url: z.string(),
      functions: z.array(
        z.object({
          functionName: z.string(),
          ranges: z.array(z.object({ startOffset: z.number().int(), count: z.number().int() })),
        }),
      ),
    }),
  ),
});
export type Coverage = z.infer<typeof Coverage>;

const CallRow = z.object({
  name: z.string(),
  source: z.string(),
  layer: z.string(),
  calls: z.number().int().nonnegative(),
});
export type CallRow = z.infer<typeof CallRow>;

export const CallCounts = z.object({
  total: z.number().int().nonnegative(),
  functions: z.array(CallRow),
});
export type CallCounts = z.infer<typeof CallCounts>;

export interface LayerCalls {
  readonly layer: string;
  readonly calls: number;
}

// An anonymous function has only a position, which moves between revisions, so
// anonymous functions are totalled per source file.
export function countCalls(coverage: Coverage): CallCounts {
  const rows = new Map<string, CallRow>();
  let total = 0;
  for (const script of coverage.result) {
    if (script.url === "") {
      continue;
    }
    const { layer, source } = place({ functionName: "", url: script.url, lineNumber: 0 });
    for (const entry of script.functions) {
      const [range] = entry.ranges;
      if (range === undefined || range.count === 0) {
        continue;
      }
      if (entry.functionName === "" && range.startOffset === 0) {
        continue;
      }
      const name = entry.functionName === "" ? "(anonymous)" : entry.functionName;
      const key = `${name} ${source}`;
      const held = rows.get(key);
      rows.set(key, { name, source, layer, calls: (held?.calls ?? 0) + range.count });
      total += range.count;
    }
  }
  const functions = [...rows.values()].toSorted(
    (a, b) => b.calls - a.calls || a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
  return { total, functions };
}

export function callsByLayer(counts: CallCounts): LayerCalls[] {
  const totals = new Map<string, number>();
  for (const row of counts.functions) {
    totals.set(row.layer, (totals.get(row.layer) ?? 0) + row.calls);
  }
  const layers: LayerCalls[] = [];
  for (const [layer, calls] of totals) {
    layers.push({ layer, calls });
  }
  return layers.toSorted((a, b) => b.calls - a.calls || a.layer.localeCompare(b.layer));
}

function share(calls: number, total: number): string {
  return total > 0 ? `${((calls / total) * 100).toFixed(1)}%` : "n/a";
}

function count(calls: number): string {
  return calls.toLocaleString("en-US");
}

export function renderCalls(path: string, counts: CallCounts, top: number): string {
  return [
    `Calls \`${path}\`: ${count(counts.total)} function calls across ${counts.functions.length} functions. A count shows how much work was asked for, not how long it took.`,
    "",
    "### Calls by layer",
    "",
    "| Layer | Calls | Share |",
    "| --- | ---: | ---: |",
    ...callsByLayer(counts).map(
      (row) => `| \`${row.layer}\` | ${count(row.calls)} | ${share(row.calls, counts.total)} |`,
    ),
    "",
    "### Most-called functions",
    "",
    "| Function | Calls | Share |",
    "| --- | ---: | ---: |",
    ...counts.functions
      .slice(0, top)
      .map(
        (row) =>
          `| \`${row.name} ${row.source}\` | ${count(row.calls)} | ${share(row.calls, counts.total)} |`,
      ),
    "",
  ].join("\n");
}
