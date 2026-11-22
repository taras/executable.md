import { ensureDir, exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { hasBinding, type FunctionComponent } from "@executablemd/core";
import { cwd } from "@executablemd/runtime";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  check,
  layerValues,
  measures,
  namedLayers,
  parseBaseline,
  renderBaseline,
  renderCheck,
  type Baseline,
} from "./lib/baseline.ts";
import { CallCounts } from "./lib/calls.ts";

const UPDATE = "XMD_PROFILE_UPDATE";
const baselineProps = z.object({
  path: z.string().min(1),
  title: z.string().min(1).optional(),
  tolerance: z.number().positive().default(1),
  captures: z
    .array(z.object({ calls: z.string().min(1), units: z.number().positive().optional() }))
    .min(1)
    .max(2),
});
const Versions = z.object({
  deno: z.string().optional(),
  bun: z.string().optional(),
  node: z.string().optional(),
});

const string = { type: "string" };
const number = { type: "number" };
export const baselineProperties = {
  path: string,
  title: string,
  tolerance: number,
  captures: {
    type: "array",
    items: {
      type: "object",
      properties: { calls: string, units: number },
      required: ["calls"],
      additionalProperties: false,
    },
  },
};

// Runtime internals are counted too, and they differ by engine and platform, so
// a baseline is compared only where it was recorded.
function runtime(): string {
  const versions = Versions.parse(process.versions);
  let engine = `node ${versions.node ?? "unknown"}`;
  if (versions.deno !== undefined) {
    engine = `deno ${versions.deno}`;
  } else if (versions.bun !== undefined) {
    engine = `bun ${versions.bun}`;
  }
  return `${engine} on ${process.platform} ${process.arch}`;
}

export const ProfileBaseline: FunctionComponent = function* (props) {
  const wanted = baselineProps.parse(props);
  const directory = yield* cwd();
  const file = resolve(directory, wanted.path);
  const counted = [];
  for (const capture of wanted.captures) {
    const source = yield* readTextFile(resolve(directory, capture.calls));
    counted.push({ counts: CallCounts.parse(JSON.parse(source)), units: capture.units });
  }
  const values = layerValues(counted);
  if (process.env[UPDATE] === "1") {
    const baseline: Baseline = {
      version: 1,
      title: wanted.title ?? wanted.path,
      runtime: runtime(),
      tolerance: wanted.tolerance,
      units: [...values.units],
      measures: measures(values),
    };
    yield* ensureDir(dirname(file));
    yield* writeTextFile(file, renderBaseline(baseline));
    if (yield* hasBinding()) {
      return { updated: true, path: wanted.path, measures: baseline.measures };
    }
    return `Updated baseline \`${wanted.path}\` with ${baseline.measures.length} measures.`;
  }
  if (!(yield* exists(file))) {
    throw new Error(
      `There is no baseline at ${wanted.path}. Run this with ${UPDATE}=1 to record one.`,
    );
  }
  const baseline = parseBaseline(yield* readTextFile(file));
  if (JSON.stringify(baseline.units) !== JSON.stringify(values.units)) {
    throw new Error(
      `The baseline at ${wanted.path} was recorded from different capture sizes. ` +
        `Run this with ${UPDATE}=1 to record it again.`,
    );
  }
  const result = check(baseline, measures(values, namedLayers(baseline)), runtime());
  if (result.shifted) {
    throw new Error(
      `${renderCheck(wanted.path, result)}\nRun this with ${UPDATE}=1 to accept an intended change.`,
    );
  }
  return (yield* hasBinding()) ? result : renderCheck(wanted.path, result);
};
