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
import {
  callers,
  compare,
  CpuProfile,
  renderCallers,
  renderComparison,
  renderSummary,
  summarize,
} from "./lib/report.ts";

const top = z.number().int().positive().default(12);
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const captureProps = z.object({
  label,
  dir: z.string().min(1).default(".bench/profile"),
  interval: z.number().int().min(50).default(200),
});
type Wanted = z.infer<typeof captureProps>;
const stopProps = z.object({ label });
const reportProps = z.object({ path: z.string().min(1), top, focus: z.string().min(1).optional() });
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
  readonly loadAverage: number | null;
}

const Captures = createContext<Map<string, Open>>("xmd.profile.captures");

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

function* begin(session: Session, wanted: Wanted): Operation<Open> {
  const directory = resolve(yield* cwd(), wanted.dir);
  session.connect();
  yield* post(session, "Profiler.enable");
  yield* post(session, "Profiler.setSamplingInterval", { interval: wanted.interval });
  const startedAt = new Date().toISOString();
  const [loadAverage = null] = loadavg();
  yield* post(session, "Profiler.start");
  return { session, wanted, directory, startedAt, loadAverage };
}

function* finish(open: Open) {
  const { wanted, directory } = open;
  const { profile } = Stopped.parse(yield* post(open.session, "Profiler.stop"));
  const text = JSON.stringify(profile);
  const receipt = {
    label: wanted.label,
    profile: join(wanted.dir, `${wanted.label}.cpuprofile`),
    startedAt: open.startedAt,
    durationMs: Math.round((profile.endTime - profile.startTime) / 1000),
    intervalUs: wanted.interval,
    samples: profile.samples?.length ?? 0,
    nodes: profile.nodes.length,
    bytes: text.length,
    loadAverage: open.loadAverage,
  };
  yield* ensureDir(directory);
  yield* writeTextFile(join(directory, `${wanted.label}.cpuprofile`), text);
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
  const session = new Session();
  yield* ensure(() => {
    session.disconnect();
  });
  const open = yield* begin(session, wanted);
  let finished = false;
  const stop = function* () {
    finished = true;
    return yield* finish(open);
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
  const captures = yield* Captures.expect();
  if (captures.has(wanted.label)) {
    throw new Error(`A capture named ${wanted.label} is already open.`);
  }
  const session = new Session();
  try {
    captures.set(wanted.label, yield* begin(session, wanted));
  } catch (error) {
    session.disconnect();
    throw error;
  }
};

const Stop: FunctionComponent = function* (props) {
  const wanted = stopProps.parse(props);
  const captures = yield* Captures.expect();
  const open = captures.get(wanted.label);
  if (open === undefined) {
    throw new Error(`There is no open capture named ${wanted.label}.`);
  }
  captures.delete(wanted.label);
  try {
    const receipt = yield* finish(open);
    return (yield* hasBinding()) ? receipt : undefined;
  } finally {
    open.session.disconnect();
  }
};

function* load(path: string) {
  const text = yield* readTextFile(resolve(yield* cwd(), path));
  return CpuProfile.parse(JSON.parse(text));
}

function* read(path: string) {
  return summarize(yield* load(path));
}

const Report: FunctionComponent = function* (props) {
  const wanted = reportProps.parse(props);
  const profile = yield* load(wanted.path);
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
const capture = { label: string, dir: string, interval: integer };
const COMMANDS: ReadonlySet<string> = new Set(["run", "test", "repl"]);

export default Plugin({
  name: "xmd-profile",
  *install({ command }): Operation<undefined> {
    if (COMMANDS.has(command)) {
      const captures = new Map<string, Open>();
      yield* ensure(() => {
        for (const open of captures.values()) {
          open.session.disconnect();
        }
      });
      yield* Captures.set(captures);
      yield* registerComponents([
        registration("Profile", Profile, capture, ["label"]),
        registration("Profile.Start", Start, capture, ["label"]),
        registration("Profile.Stop", Stop, { label: string }, ["label"]),
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
