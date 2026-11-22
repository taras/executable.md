import { z } from "zod";

const CallFrame = z.looseObject({
  functionName: z.string(),
  url: z.string(),
  lineNumber: z.number().int(),
});
type CallFrame = z.infer<typeof CallFrame>;

const ProfileNode = z.looseObject({
  id: z.number().int(),
  callFrame: CallFrame,
  children: z.array(z.number().int()).optional(),
});

export const CpuProfile = z.looseObject({
  nodes: z.array(ProfileNode).min(1),
  startTime: z.number(),
  endTime: z.number(),
  samples: z.array(z.number().int()).optional(),
  timeDeltas: z.array(z.number()).optional(),
});
export type CpuProfile = z.infer<typeof CpuProfile>;

export interface Placement {
  readonly layer: string;
  readonly source: string;
}

export interface Row {
  readonly key: string;
  readonly us: number;
}

export interface Summary {
  readonly sampledUs: number;
  readonly idleUs: number;
  readonly profilerUs: number;
  readonly activeUs: number;
  readonly samples: number;
  readonly layers: readonly Row[];
  readonly functions: readonly Row[];
  readonly inclusive: readonly Row[];
  readonly sources: readonly Row[];
}

export interface Callers {
  readonly name: string;
  readonly selfUs: number;
  readonly totalUs: number;
  readonly immediate: readonly Row[];
  readonly above: readonly Row[];
}

export interface Delta {
  readonly key: string;
  readonly baselineUs: number;
  readonly candidateUs: number;
  readonly deltaUs: number;
}

export interface Comparison {
  readonly active: Delta;
  readonly layers: readonly Delta[];
  readonly functions: readonly Delta[];
}

const UNATTRIBUTED = new Map<string, Placement>([
  ["(idle)", { layer: "idle", source: "(idle)" }],
  ["(garbage collector)", { layer: "garbage collector", source: "(gc)" }],
  ["(program)", { layer: "program", source: "(program)" }],
  ["(root)", { layer: "root", source: "(root)" }],
]);

// A compiled binary and the Deno npm cache both store NAME/VERSION/path.
const VERSIONED =
  /\/(?:\.deno_compile_node_modules\/[^/]+|npm\/registry\.npmjs\.org)\/((?:@[^/]+\/)?[^/]+)\/[^/]+\/(.*)$/;
const NODE_MODULES = /^.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/;
const WORKSPACE = /\/packages\/([^/]+)\/(.*)$/;
const TRANSPILED = /\.[cm]?tsx?$/;
const PASS_THROUGH = 0.98;

function dependency(name: string, inside: string): Placement {
  let layer = `npm ${name}`;
  if (name === "effection") {
    layer = "effection";
  } else if (name.startsWith("@effectionx/")) {
    layer = "effectionx";
  }
  return { layer, source: `npm:${name}/${inside}` };
}

export function place(frame: CallFrame): Placement {
  const { url, functionName } = frame;
  if (url === "") {
    return UNATTRIBUTED.get(functionName) ?? { layer: "native", source: "(native)" };
  }
  if (url === "ext:deno_node/inspector.js" || url === "node:inspector") {
    return { layer: "profiler", source: url };
  }
  if (url.startsWith("data:")) {
    return { layer: "eval block", source: "(eval block)" };
  }
  if (url.startsWith("wasm:")) {
    return { layer: "wasm", source: `wasm:${url.split("/").at(-1) ?? ""}` };
  }
  if (url.startsWith("ext:")) {
    return { layer: "deno runtime", source: url };
  }
  if (url.startsWith("node:")) {
    return { layer: "node builtin", source: url };
  }
  const packaged = VERSIONED.exec(url) ?? NODE_MODULES.exec(url);
  if (packaged !== null) {
    const [, name = "", inside = ""] = packaged;
    return dependency(name, inside);
  }
  const workspace = WORKSPACE.exec(url);
  if (workspace !== null) {
    const [, name = "", inside = ""] = workspace;
    return { layer: `xmd ${name}`, source: `xmd:${name}/${inside}` };
  }
  return { layer: "other", source: url.split("/").slice(-3).join("/") };
}

// The profiler sees the transpiled script and no source map, so a position in a
// TypeScript file is a script line and must not read as a source line.
function keyOf(frame: CallFrame, placement: Placement): string {
  const name = frame.functionName === "" ? "(anonymous)" : frame.functionName;
  if (frame.url === "") {
    return UNATTRIBUTED.has(frame.functionName) ? name : `${name} (native)`;
  }
  const line = frame.lineNumber + 1;
  return TRANSPILED.test(placement.source)
    ? `${name} ${placement.source} (script line ${line})`
    : `${name} ${placement.source}:${line}`;
}

function add<Key>(totals: Map<Key, number>, key: Key, us: number): void {
  totals.set(key, (totals.get(key) ?? 0) + us);
}

function ranked(totals: Map<string, number>): Row[] {
  const rows: Row[] = [];
  for (const [key, us] of totals) {
    rows.push({ key, us });
  }
  return rows.toSorted((a, b) => b.us - a.us || a.key.localeCompare(b.key));
}

interface Placed extends Placement {
  readonly key: string;
  readonly name: string;
  readonly children: readonly number[];
}

interface Analysis {
  readonly samples: number;
  readonly sampledUs: number;
  readonly root: number;
  readonly selfUs: ReadonlyMap<number, number>;
  readonly totalUs: ReadonlyMap<number, number>;
  readonly placed: ReadonlyMap<number, Placed>;
  readonly parent: ReadonlyMap<number, number>;
}

function analyze(profile: CpuProfile): Analysis {
  const samples = profile.samples ?? [];
  const timeDeltas = profile.timeDeltas ?? [];
  const selfUs = new Map<number, number>();
  let sampledUs = 0;
  samples.forEach((id, at) => {
    const us = timeDeltas[at] ?? 0;
    add(selfUs, id, us);
    sampledUs += us;
  });

  const placed = new Map<number, Placed>();
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    const placement = place(node.callFrame);
    const children = node.children ?? [];
    placed.set(node.id, {
      ...placement,
      key: keyOf(node.callFrame, placement),
      name: node.callFrame.functionName,
      children,
    });
    for (const child of children) {
      parent.set(child, node.id);
    }
  }
  for (const id of selfUs.keys()) {
    if (!placed.has(id)) {
      throw new Error(`A sample names node ${id}, which this profile does not contain.`);
    }
  }

  const [first] = profile.nodes;
  if (first === undefined) {
    throw new Error("This profile has no root node.");
  }
  const order: number[] = [];
  const pending = [first.id];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    order.push(id);
    pending.push(...(placed.get(id)?.children ?? []));
  }
  const totalUs = new Map<number, number>();
  for (const id of order.toReversed()) {
    let total = selfUs.get(id) ?? 0;
    for (const child of placed.get(id)?.children ?? []) {
      total += totalUs.get(child) ?? 0;
    }
    totalUs.set(id, total);
  }
  return { samples: samples.length, sampledUs, root: first.id, selfUs, totalUs, placed, parent };
}

function passesThrough(analysis: Analysis, frame: Placed, total: number): boolean {
  return (
    total === 0 ||
    frame.children.some((child) => (analysis.totalUs.get(child) ?? 0) >= total * PASS_THROUGH)
  );
}

type Step = { readonly enter: number } | { readonly leave: string };

export function summarize(profile: CpuProfile): Summary {
  const analysis = analyze(profile);
  const layers = new Map<string, number>();
  const functions = new Map<string, number>();
  const sources = new Map<string, number>();
  let idleUs = 0;
  let profilerUs = 0;
  for (const [id, us] of analysis.selfUs) {
    const frame = analysis.placed.get(id);
    if (frame === undefined) {
      continue;
    }
    if (frame.layer === "idle") {
      idleUs += us;
    } else if (frame.layer === "profiler") {
      profilerUs += us;
    } else {
      add(layers, frame.layer, us);
      add(functions, frame.key, us);
      add(sources, frame.source, us);
    }
  }

  // A frame already open on the path is recursion, and counting it again would
  // double its time. A frame that hands nearly everything to one callee only
  // repeats that callee's row.
  const inclusive = new Map<string, number>();
  const open = new Set<string>();
  const walk: Step[] = [{ enter: analysis.root }];
  for (let step = walk.pop(); step !== undefined; step = walk.pop()) {
    if ("leave" in step) {
      open.delete(step.leave);
      continue;
    }
    const frame = analysis.placed.get(step.enter);
    if (frame === undefined) {
      continue;
    }
    const total = analysis.totalUs.get(step.enter) ?? 0;
    if (
      frame.layer.startsWith("xmd ") &&
      !open.has(frame.key) &&
      !passesThrough(analysis, frame, total)
    ) {
      add(inclusive, frame.key, total);
      open.add(frame.key);
      walk.push({ leave: frame.key });
    }
    for (const child of frame.children) {
      walk.push({ enter: child });
    }
  }

  return {
    sampledUs: analysis.sampledUs,
    idleUs,
    profilerUs,
    activeUs: analysis.sampledUs - idleUs - profilerUs,
    samples: analysis.samples,
    layers: ranked(layers),
    functions: ranked(functions),
    inclusive: ranked(inclusive),
    sources: ranked(sources),
  };
}

function ancestors(analysis: Analysis, id: number): Placed[] {
  const above: Placed[] = [];
  for (let at = analysis.parent.get(id); at !== undefined; at = analysis.parent.get(at)) {
    const frame = analysis.placed.get(at);
    if (frame !== undefined) {
      above.push(frame);
    }
  }
  return above;
}

export function callers(profile: CpuProfile, name: string): Callers {
  const analysis = analyze(profile);
  const immediate = new Map<string, number>();
  const through = new Map<string, number>();
  const depth = new Map<string, number>();
  let selfUs = 0;
  let totalUs = 0;
  let found = false;
  for (const [id, frame] of analysis.placed) {
    if (frame.name !== name) {
      continue;
    }
    found = true;
    selfUs += analysis.selfUs.get(id) ?? 0;
    const above = ancestors(analysis, id);
    if (above.some((one) => one.name === name)) {
      continue;
    }
    const total = analysis.totalUs.get(id) ?? 0;
    totalUs += total;
    add(immediate, above[0]?.key ?? "(none)", total);
    const seen = new Set<string>([frame.key]);
    above.forEach((one, at) => {
      if (!one.layer.startsWith("xmd ") || seen.has(one.key)) {
        return;
      }
      seen.add(one.key);
      add(through, one.key, total);
      depth.set(one.key, Math.min(depth.get(one.key) ?? at, at));
    });
  }
  if (!found) {
    throw new Error(`This profile has no frame named ${name}.`);
  }
  const above = ranked(through).toSorted(
    (a, b) => b.us - a.us || (depth.get(a.key) ?? 0) - (depth.get(b.key) ?? 0),
  );
  return { name, selfUs, totalUs, immediate: ranked(immediate), above };
}

function ms(us: number): string {
  return (us / 1000).toFixed(1);
}

function signedMs(us: number): string {
  return `${us >= 0 ? "+" : ""}${ms(us)}`;
}

function share(us: number, activeUs: number): string {
  return activeUs > 0 ? `${((us / activeUs) * 100).toFixed(1)}%` : "n/a";
}

function table(
  title: string,
  head: string,
  measure: string,
  rows: readonly Row[],
  activeUs: number,
): string[] {
  return [
    `### ${title}`,
    "",
    `| ${head} | ${measure} | Share of active |`,
    "| --- | ---: | ---: |",
    ...rows.map((row) => `| \`${row.key}\` | ${ms(row.us)} | ${share(row.us, activeUs)} |`),
    "",
  ];
}

export function renderSummary(path: string, summary: Summary, top: number): string {
  return [
    `Profile \`${path}\`: ${ms(summary.sampledUs)} ms sampled, ${ms(summary.activeUs)} ms active, ` +
      `${ms(summary.idleUs)} ms idle, ${ms(summary.profilerUs)} ms profiler, ${summary.samples} samples.`,
    "",
    ...table("Active time by layer", "Layer", "Self ms", summary.layers, summary.activeUs),
    ...table(
      "Top functions by self time",
      "Function",
      "Self ms",
      summary.functions.slice(0, top),
      summary.activeUs,
    ),
    ...table(
      "Top XMD frames by inclusive time",
      "Frame",
      "Inclusive ms",
      summary.inclusive.slice(0, top),
      summary.activeUs,
    ),
    ...table(
      "Top source files by self time",
      "Source",
      "Self ms",
      summary.sources.slice(0, top),
      summary.activeUs,
    ),
  ].join("\n");
}

export function renderCallers(found: Callers, activeUs: number, top: number): string {
  return [
    `### Callers of \`${found.name}\``,
    "",
    `\`${found.name}\` took ${ms(found.selfUs)} ms itself and ${ms(found.totalUs)} ms with what it calls.`,
    "",
    ...table(
      "Immediate callers",
      "Caller",
      "Inclusive ms",
      found.immediate.slice(0, top),
      activeUs,
    ),
    ...table(
      "XMD frames above it, nearest first",
      "Caller",
      "Inclusive ms",
      found.above.slice(0, top),
      activeUs,
    ),
  ].join("\n");
}

function indexed(rows: readonly Row[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.key, row.us);
  }
  return totals;
}

function delta(key: string, baselineUs: number, candidateUs: number): Delta {
  return { key, baselineUs, candidateUs, deltaUs: candidateUs - baselineUs };
}

function deltas(baseline: readonly Row[], candidate: readonly Row[]): Delta[] {
  const before = indexed(baseline);
  const after = indexed(candidate);
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .map((key) => delta(key, before.get(key) ?? 0, after.get(key) ?? 0))
    .toSorted((a, b) => Math.abs(b.deltaUs) - Math.abs(a.deltaUs) || a.key.localeCompare(b.key));
}

export function compare(baseline: Summary, candidate: Summary): Comparison {
  return {
    active: delta("active", baseline.activeUs, candidate.activeUs),
    layers: deltas(baseline.layers, candidate.layers),
    functions: deltas(baseline.functions, candidate.functions),
  };
}

function deltaTable(title: string, head: string, rows: readonly Delta[]): string[] {
  return [
    `### ${title}`,
    "",
    `| ${head} | Baseline ms | Candidate ms | Delta ms |`,
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      (row) =>
        `| \`${row.key}\` | ${ms(row.baselineUs)} | ${ms(row.candidateUs)} | ${signedMs(row.deltaUs)} |`,
    ),
    "",
  ];
}

export function renderComparison(comparison: Comparison, top: number): string {
  const { active } = comparison;
  return [
    `Active time: baseline ${ms(active.baselineUs)} ms, candidate ${ms(active.candidateUs)} ms, ` +
      `delta ${signedMs(active.deltaUs)} ms.`,
    "",
    ...deltaTable("Change by layer", "Layer", comparison.layers),
    ...deltaTable("Largest changes by function", "Function", comparison.functions.slice(0, top)),
  ].join("\n");
}
