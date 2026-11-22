import { z } from "zod";
import { callsByLayer, type CallCounts } from "./calls.ts";

const Measure = z.object({ name: z.string().min(1), value: z.number() });
export type Measure = z.infer<typeof Measure>;

export const Baseline = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  runtime: z.string().min(1),
  tolerance: z.number().positive(),
  units: z.array(z.number().positive()),
  measures: z.array(Measure).min(1),
});
export type Baseline = z.infer<typeof Baseline>;

export interface Counted {
  readonly counts: CallCounts;
  readonly units?: number;
}

export interface LayerValues {
  readonly kind: string;
  readonly units: readonly number[];
  readonly total: number;
  readonly fixed: number | null;
  readonly layers: ReadonlyMap<string, number>;
}

export interface Checked {
  readonly name: string;
  readonly baseline: number | null;
  readonly measured: number | null;
  readonly shiftPercent: number | null;
  readonly shifted: boolean;
}

export interface CheckResult {
  readonly comparable: boolean;
  readonly reason: string | null;
  readonly shifted: boolean;
  readonly rows: readonly Checked[];
}

const OTHER = "other layers";
const FIXED = "fixed calls: total";
const NAMED_SHARE = 0.001;
const FENCE = "`".repeat(3);

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function totals(counts: CallCounts): Map<string, number> {
  const layers = new Map<string, number>();
  for (const row of callsByLayer(counts)) {
    layers.set(row.layer, row.calls);
  }
  return layers;
}

export function layerValues(captures: readonly Counted[]): LayerValues {
  const [first, second, ...rest] = captures;
  if (first === undefined || rest.length > 0) {
    throw new Error(
      "A baseline takes one capture, or two captures of the same work at different sizes.",
    );
  }
  if (second === undefined) {
    return {
      kind: "calls",
      units: [],
      total: first.counts.total,
      fixed: null,
      layers: totals(first.counts),
    };
  }
  if (first.units === undefined || second.units === undefined || second.units <= first.units) {
    throw new Error("Two captures each need units, and the second needs more than the first.");
  }
  const span = second.units - first.units;
  const small = totals(first.counts);
  const large = totals(second.counts);
  const layers = new Map<string, number>();
  for (const layer of new Set([...small.keys(), ...large.keys()])) {
    layers.set(layer, round(((large.get(layer) ?? 0) - (small.get(layer) ?? 0)) / span));
  }
  const perUnit = (second.counts.total - first.counts.total) / span;
  return {
    kind: "calls per unit",
    units: [first.units, second.units],
    total: round(perUnit),
    fixed: round(first.counts.total - perUnit * first.units),
    layers,
  };
}

// A check passes the baseline's own layer names, so a layer near the naming
// threshold cannot move between a named row and the remainder from run to run.
export function measures(values: LayerValues, named?: readonly string[]): Measure[] {
  const keep = new Set(named);
  if (named === undefined) {
    for (const [layer, value] of values.layers) {
      if (value > values.total * NAMED_SHARE) {
        keep.add(layer);
      }
    }
  }
  const rows: Measure[] = [];
  let other = 0;
  for (const [layer, value] of values.layers) {
    if (keep.has(layer)) {
      rows.push({ name: `${values.kind}: ${layer}`, value });
    } else {
      other += value;
    }
  }
  for (const layer of keep) {
    if (!values.layers.has(layer)) {
      rows.push({ name: `${values.kind}: ${layer}`, value: 0 });
    }
  }
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const all = [
    { name: `${values.kind}: total`, value: values.total },
    ...rows,
    { name: `${values.kind}: ${OTHER}`, value: round(other) },
  ];
  return values.fixed === null ? all : [...all, { name: FIXED, value: values.fixed }];
}

export function namedLayers(baseline: Baseline): string[] {
  const layers: string[] = [];
  for (const { name } of baseline.measures) {
    const layer = name.slice(name.indexOf(": ") + 2);
    if (name !== FIXED && layer !== "total" && layer !== OTHER) {
      layers.push(layer);
    }
  }
  return layers;
}

export function check(
  baseline: Baseline,
  measured: readonly Measure[],
  runtime: string,
): CheckResult {
  if (baseline.runtime !== runtime) {
    return {
      comparable: false,
      reason: `the baseline was recorded on ${baseline.runtime} and this run is on ${runtime}`,
      shifted: false,
      rows: [],
    };
  }
  const before = new Map(baseline.measures.map((one) => [one.name, one.value] as const));
  const after = new Map(measured.map((one) => [one.name, one.value] as const));
  const rows: Checked[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name);
    const now = after.get(name);
    if (was === undefined || now === undefined) {
      rows.push({
        name,
        baseline: was ?? null,
        measured: now ?? null,
        shiftPercent: null,
        shifted: true,
      });
    } else if (was === 0) {
      rows.push({
        name,
        baseline: was,
        measured: now,
        shiftPercent: now === 0 ? 0 : null,
        shifted: now !== 0,
      });
    } else {
      const shiftPercent = ((now - was) / was) * 100;
      rows.push({
        name,
        baseline: was,
        measured: now,
        shiftPercent,
        shifted: Math.abs(shiftPercent) > baseline.tolerance,
      });
    }
  }
  return { comparable: true, reason: null, shifted: rows.some((row) => row.shifted), rows };
}

function number(value: number | null): string {
  return value === null ? "absent" : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function renderBaseline(baseline: Baseline): string {
  const [small, large] = baseline.units;
  const captures =
    small === undefined || large === undefined
      ? "one capture"
      : `two captures, at ${number(small)} and ${number(large)} units`;
  return [
    `# Performance baseline: ${baseline.title}`,
    "",
    "`Profile.Baseline` wrote this document and checks later runs against it. A measure",
    "that moves by more than the tolerance fails the check. Run the same journey with",
    "`XMD_PROFILE_UPDATE=1` to accept an intended change, and review the difference.",
    "",
    `- Runtime: ${baseline.runtime}`,
    `- Measured from: ${captures}`,
    `- Tolerance: ${number(baseline.tolerance)}%`,
    "",
    "| Measure | Value |",
    "| --- | ---: |",
    ...baseline.measures.map((one) => `| ${one.name} | ${number(one.value)} |`),
    "",
    `${FENCE}json`,
    JSON.stringify(baseline, null, 2),
    FENCE,
    "",
  ].join("\n");
}

export function parseBaseline(document: string): Baseline {
  const from = document.indexOf(`${FENCE}json\n`);
  const to = document.lastIndexOf(`\n${FENCE}`);
  if (from < 0 || to <= from) {
    throw new Error("This baseline document has no json data block.");
  }
  return Baseline.parse(JSON.parse(document.slice(from + FENCE.length + 5, to)));
}

export function renderCheck(path: string, result: CheckResult): string {
  if (!result.comparable) {
    return `Baseline \`${path}\` was not compared: ${result.reason}.`;
  }
  const shifted = result.rows.filter((row) => row.shifted);
  if (shifted.length === 0) {
    return `Baseline \`${path}\`: ${result.rows.length} measures within tolerance.`;
  }
  return [
    `Baseline \`${path}\`: ${shifted.length} of ${result.rows.length} measures shifted.`,
    "",
    "| Measure | Baseline | Measured | Shift |",
    "| --- | ---: | ---: | ---: |",
    ...shifted.map(
      (row) =>
        `| ${row.name} | ${number(row.baseline)} | ${number(row.measured)} | ${percent(row.shiftPercent)} |`,
    ),
    "",
  ].join("\n");
}
