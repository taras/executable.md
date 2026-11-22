import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import {
  content,
  hasBinding,
  registerComponents,
  type ComponentRegistration,
  type FunctionComponent,
  type PropsSchema,
} from "@executablemd/core";
import { Plugin } from "@executablemd/core/api";
import { cwd } from "@executablemd/runtime";
import { action, createContext, ensure, type Operation } from "effection";
import { Session } from "node:inspector";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { baselineProperties, ProfileBaseline } from "./baseline.ts";
import { CallCounts, callsByLayer, countCalls, Coverage, renderCalls } from "./lib/calls.ts";
import {
  callers,
  compare,
  CpuProfile,
  renderCallers,
  renderComparison,
  renderSummary,
  summarize,
} from "./lib/report.ts";

const CALLS = ".calls.json";
const top = z.number().int().positive().default(12);
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const captureProps = z.object({
  label,
  dir: z.string().min(1).default(".bench/profile"),
  interval: z.number().int().min(50).default(200),
  mode: z.enum(["time", "calls"]).default("time"),
});
type Wanted = z.infer<typeof captureProps>;
const stopProps = z.object({ label });
const reportProps = z.object({
  path: z.string().min(1),
  top,
  focus: z.string().min(1).optional(),
});
const compareProps = z.object({
  baseline: z.string().min(1),
  candidate: z.string().min(1),
  top,
});
const Stopped = z.object({ profile: CpuProfile });

interface Open {
  readonly session: Session;
  readonly wanted: Wanted;
  readonly directory: string;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly loadAverage: number | null;
}

interface Captures {
  readonly open: Map<string, Open>;
  counting: boolean;
}

const CapturesContext = createContext<Captures>("xmd.profile.captures");

function post(session: Session, method: string, params: object = {}): Operation<unknown> {
  return action<unknown>((settle, fail) => {
    let live = true;
    session.post(method, params, (error, result) => {
      if (!live) {
        return;
      }
      if (error === null || error === undefined) {
        settle(result);
      } else {
        fail(new Error(`${method}: ${error.message}`));
      }
    });
    return () => {
      live = false;
    };
  });
}

function* begin(session: Session, wanted: Wanted, captures: Captures): Operation<Open> {
  if (wanted.mode === "calls" && captures.counting) {
    throw new Error(
      "A call-count capture is already open; the runtime keeps one set of call counters.",
    );
  }
  const directory = resolve(yield* cwd(), wanted.dir);
  session.connect();
  yield* post(session, "Profiler.enable");
  const [loadAverage = null] = loadavg();
  const startedAt = new Date().toISOString();
  if (wanted.mode === "calls") {
    captures.counting = true;
    try {
      yield* post(session, "Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    } catch (error) {
      captures.counting = false;
      throw error;
    }
  } else {
    yield* post(session, "Profiler.setSamplingInterval", { interval: wanted.interval });
    yield* post(session, "Profiler.start");
  }
  return { session, wanted, directory, startedAt, startedMs: performance.now(), loadAverage };
}

function* counted(open: Open, captures: Captures) {
  try {
    const taken = Coverage.parse(yield* post(open.session, "Profiler.takePreciseCoverage"));
    yield* post(open.session, "Profiler.stopPreciseCoverage");
    return countCalls(taken);
  } finally {
    captures.counting = false;
  }
}

function* finish(open: Open, captures: Captures) {
  const { wanted, directory } = open;
  const shared = {
    label: wanted.label,
    mode: wanted.mode,
    startedAt: open.startedAt,
    loadAverage: open.loadAverage,
  };
  let text;
  let receipt;
  let file;
  if (wanted.mode === "calls") {
    const counts = yield* counted(open, captures);
    file = `${wanted.label}${CALLS}`;
    text = JSON.stringify(counts);
    receipt = {
      ...shared,
      calls: join(wanted.dir, file),
      durationMs: Math.round(performance.now() - open.startedMs),
      totalCalls: counts.total,
      functions: counts.functions.length,
    };
  } else {
    const { profile } = Stopped.parse(yield* post(open.session, "Profiler.stop"));
    file = `${wanted.label}.cpuprofile`;
    text = JSON.stringify(profile);
    receipt = {
      ...shared,
      profile: join(wanted.dir, file),
      durationMs: Math.round((profile.endTime - profile.startTime) / 1000),
      intervalUs: wanted.interval,
      samples: profile.samples?.length ?? 0,
      nodes: profile.nodes.length,
      bytes: text.length,
    };
  }
  yield* ensureDir(directory);
  yield* writeTextFile(join(directory, file), text);
  yield* writeTextFile(
    join(directory, `${wanted.label}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

const Profile: FunctionComponent = function* (props, invocation) {
  if (!invocation.hasContent()) {
    throw new Error("Use a paired <Profile>");
  }
  const wanted = captureProps.parse(props);
  const captures = yield* CapturesContext.expect();
  const session = new Session();
  yield* ensure(() => {
    session.disconnect();
  });
  const open = yield* begin(session, wanted, captures);
  let finished = false;
  const stop = function* () {
    finished = true;
    return yield* finish(open, captures);
  };
  yield* ensure(function* () {
    if (!finished) {
      yield* stop();
    }
  });
  const rendered = yield* content();
  const receipt = yield* stop();
  return (yield* hasBinding()) ? receipt : rendered;
};

const Start: FunctionComponent = function* (props) {
  const wanted = captureProps.parse(props);
  const captures = yield* CapturesContext.expect();
  if (captures.open.has(wanted.label)) {
    throw new Error(`A capture named ${wanted.label} is already open.`);
  }
  const session = new Session();
  try {
    captures.open.set(wanted.label, yield* begin(session, wanted, captures));
  } catch (error) {
    session.disconnect();
    throw error;
  }
};

const Stop: FunctionComponent = function* (props) {
  const wanted = stopProps.parse(props);
  const captures = yield* CapturesContext.expect();
  const open = captures.open.get(wanted.label);
  if (open === undefined) {
    throw new Error(`There is no open capture named ${wanted.label}.`);
  }
  captures.open.delete(wanted.label);
  try {
    const receipt = yield* finish(open, captures);
    return (yield* hasBinding()) ? receipt : undefined;
  } finally {
    open.session.disconnect();
  }
};

function* readSource(path: string) {
  return yield* readTextFile(resolve(yield* cwd(), path));
}

function* read(path: string) {
  return summarize(CpuProfile.parse(JSON.parse(yield* readSource(path))));
}

const Report: FunctionComponent = function* (props) {
  const wanted = reportProps.parse(props);
  const source = JSON.parse(yield* readSource(wanted.path));
  if (wanted.path.endsWith(CALLS)) {
    if (wanted.focus !== undefined) {
      throw new Error("focus needs a CPU profile; a call-count capture records no stacks.");
    }
    const counts = CallCounts.parse(source);
    if (yield* hasBinding()) {
      return {
        total: counts.total,
        layers: callsByLayer(counts),
        functions: counts.functions.slice(0, wanted.top),
      };
    }
    return renderCalls(wanted.path, counts, wanted.top);
  }
  const profile = CpuProfile.parse(source);
  const summary = summarize(profile);
  const focused = wanted.focus === undefined ? undefined : callers(profile, wanted.focus);
  if (yield* hasBinding()) {
    return {
      ...summary,
      functions: summary.functions.slice(0, wanted.top),
      inclusive: summary.inclusive.slice(0, wanted.top),
      sources: summary.sources.slice(0, wanted.top),
      focus: focused ?? null,
    };
  }
  const report = renderSummary(wanted.path, summary, wanted.top);
  if (focused === undefined) {
    return report;
  }
  return [report, "", renderCallers(focused, summary.activeUs, wanted.top)].join("\n");
};

const Compare: FunctionComponent = function* (props) {
  const wanted = compareProps.parse(props);
  const result = compare(yield* read(wanted.baseline), yield* read(wanted.candidate));
  if (yield* hasBinding()) {
    return { ...result, functions: result.functions.slice(0, wanted.top) };
  }
  return renderComparison(result, wanted.top);
};

function registration(
  name: string,
  fn: FunctionComponent,
  properties: NonNullable<PropsSchema["properties"]>,
  required: string[],
): ComponentRegistration {
  return {
    name,
    origin: "examples/xmd-profile/plugin.ts",
    props: { type: "object", properties, required, additionalProperties: false },
    fn,
  };
}

const integer = { type: "integer" };
const string = { type: "string" };
const capture = {
  label: string,
  dir: string,
  interval: integer,
  mode: { type: "string", enum: ["time", "calls"] },
};
const COMMANDS: ReadonlySet<string> = new Set(["run", "test", "repl"]);

export default Plugin({
  name: "xmd-profile",
  *install({ command }): Operation<undefined> {
    if (COMMANDS.has(command)) {
      const captures: Captures = { open: new Map(), counting: false };
      yield* ensure(() => {
        for (const open of captures.open.values()) {
          open.session.disconnect();
        }
      });
      yield* CapturesContext.set(captures);
      yield* registerComponents([
        registration("Profile", Profile, capture, ["label"]),
        registration("Profile.Start", Start, capture, ["label"]),
        registration("Profile.Stop", Stop, { label: string }, ["label"]),
        registration("Profile.Baseline", ProfileBaseline, baselineProperties, ["path", "captures"]),
        registration("Profile.Report", Report, { path: string, top: integer, focus: string }, [
          "path",
        ]),
        registration(
          "Profile.Compare",
          Compare,
          { baseline: string, candidate: string, top: integer },
          ["baseline", "candidate"],
        ),
      ]);
    }
    return undefined;
  },
});
