import { exec, Stdio } from "@effectionx/process";
import {
  capture,
  content,
  hasCapture,
  hasBinding,
  registerComponents,
  type ComponentRegistration,
  type FunctionComponent,
  type PropsSchema,
} from "@executablemd/core";
import { Plugin } from "@executablemd/core/api";
import { cwd, parseDuration } from "@executablemd/runtime";
import { Test } from "@executablemd/testing";
import { createContext, ensure, type Operation, race, spawn, withResolvers } from "effection";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { useTempDirectory } from "./lib/temp-directory.ts";
import {
  defaultSize,
  exitResult,
  point,
  region,
  response,
  size,
  type Command,
  type Launch,
  type Region,
  type Size,
} from "./lib/repl-bench/protocol.ts";
import { prepareRun, root } from "./lib/repl-bench/run.ts";

type Execute = (command: Command) => Operation<unknown>;
const Active = createContext<Execute>("xmd.repl-bench.active");
const RegionContext = createContext<Region | undefined>("xmd.repl-bench.region", undefined);
const Homes = createContext<Set<object>>("xmd.repl-bench.homes");
const closed = { exitCode: null, location: null, resume: null };
const wait = z.object({
  text: z.string().min(1),
  timeout: z.string().optional(),
  at: point.optional(),
  present: z.boolean().optional(),
});
const bench = size.partial().extend({ expectExit: z.boolean().default(false) });
const resumeReference = z.object({ location: z.string(), home: z.string(), ...size.shape });

function* connect(options: Launch): Operation<Execute> {
  const script = fileURLToPath(new URL("./repl-bench-bun.ts", import.meta.url));
  const child = yield* exec("bun", {
    cwd: root,
    arguments: ["--no-install", script, "driver", JSON.stringify(options)],
  });
  const decoder = new TextDecoder();
  let pending = "";
  let pendingReply = withResolvers<z.infer<typeof response>>();
  let busy = false;
  let driverEnded = false;
  yield* spawn(function* () {
    const stream = yield* child.stdout;
    while (true) {
      const part = yield* stream.next();
      if (part.done) {
        return;
      }
      pending += decoder.decode(part.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        pendingReply.resolve(response.parse(JSON.parse(line)));
      }
    }
  });
  const ended = yield* spawn(function* () {
    const { code, signal } = yield* child.join();
    driverEnded = true;
    return { error: `Driver exited (${code ?? signal}). Evidence: ${options.directory}` };
  });
  yield* ensure(function* () {
    if (!driverEnded) {
      child.stdin.send(`${JSON.stringify({ action: "stop" })}\n`);
      yield* child.join();
    }
  });
  return function* (command) {
    if (busy) {
      throw new Error("ReplBench actions run one at a time");
    }
    busy = true;
    try {
      pendingReply = withResolvers<z.infer<typeof response>>();
      child.stdin.send(`${JSON.stringify(command)}\n`);
      const result = yield* race([pendingReply.operation, ended]);
      if ("error" in result) {
        throw new Error(result.error);
      }
      return result.value;
    } finally {
      busy = false;
    }
  };
}

const ReplBench: FunctionComponent = function* (props, invocation) {
  if (!invocation.hasContent()) {
    throw new Error("Use a paired <ReplBench> inside <Test>");
  }
  const test = yield* Test.operations.testScope;
  if (test === undefined) {
    throw new Error("<ReplBench> needs an enclosing <Test>");
  }
  const directory = yield* cwd();
  const wanted = bench.parse(props);
  const captured = (yield* hasCapture("resume")) ? yield* capture("resume") : undefined;
  const prepared = yield* test.eval(function* () {
    const homes = (yield* Homes.get()) ?? (yield* Homes.set(new Set<object>()));
    if (captured !== undefined) {
      if (typeof captured !== "object" || captured === null || !homes.has(captured)) {
        throw new Error("resume must come from a clean <ReplBench> exit in this test");
      }
      return { homes, resume: resumeReference.parse(captured), home: undefined };
    }
    return { homes, resume: undefined, home: yield* useTempDirectory("xmd-repl-test-") };
  });
  if (!prepared.ok) {
    throw prepared.error;
  }
  const { homes, home, resume } = prepared.value;
  const initial = {
    columns: wanted.columns ?? resume?.columns ?? defaultSize.columns,
    rows: wanted.rows ?? resume?.rows ?? defaultSize.rows,
  };
  const args = resume === undefined ? ["--deny-all"] : ["--deny-all", resume.location];
  const { launch } = yield* prepareRun(directory, initial, args, resume?.home ?? home);
  yield* Stdio.around({
    // deno-lint-ignore require-yield
    *stdout() {
      return;
    },
  });
  const connection = yield* connect(launch);
  let dimensions: Size = initial;
  function* execute(command: Command) {
    const value = yield* connection(command);
    if (command.action === "resize") {
      dimensions = { columns: command.columns, rows: command.rows };
    }
    return value;
  }
  yield* execute({ action: "ready" });
  yield* Active.set(execute);
  yield* RegionContext.set(undefined);
  const rendered = yield* content();
  const bind = yield* hasBinding();
  if (!wanted.expectExit) {
    return bind ? closed : rendered;
  }
  const exit = exitResult.parse(yield* execute({ action: "exit" }));
  const reference =
    exit.exitCode === 0 && exit.location !== null
      ? Object.freeze({ location: exit.location, home: launch.home, ...dimensions })
      : null;
  if (reference !== null) {
    homes.add(reference);
  }
  return bind ? { ...exit, resume: reference } : rendered;
};

function* action(command: Command) {
  const execute = yield* Active.expect();
  return yield* execute(command);
}

function registration(
  name: string,
  fn: FunctionComponent,
  properties: NonNullable<PropsSchema["properties"]> = {},
  required: string[] = [],
): ComponentRegistration {
  return {
    name: `ReplBench${name}`,
    origin: "scripts/repl-bench-plugin.ts",
    props: { type: "object", properties, required, additionalProperties: false },
    fn,
  };
}

const integer = { type: "integer" };
const string = { type: "string" };
const boolean = { type: "boolean" };
const dimensions = { columns: integer, rows: integer };
const registrations = [
  { ...registration("", ReplBench, { ...dimensions, expectExit: boolean }), captures: ["resume"] },
  registration(
    ".Focus",
    function* (props) {
      z.literal("sidekick-composer").parse(props.target);
      yield* action({ action: "focus" });
    },
    { target: string },
    ["target"],
  ),
  registration(
    ".Type",
    function* (props) {
      yield* action({ action: "type", text: z.string().parse(props.text) });
    },
    { text: string },
    ["text"],
  ),
  registration(
    ".Key",
    function* (props) {
      yield* action({ action: "key", key: z.string().min(1).parse(props.key) });
    },
    { key: string },
    ["key"],
  ),
  registration(
    ".Resize",
    function* (props) {
      yield* action({ action: "resize", ...size.parse(props) });
    },
    dimensions,
    ["columns", "rows"],
  ),
  registration(
    ".Region",
    function* (props, invocation) {
      if (!invocation.hasContent()) {
        throw new Error("Use a paired <ReplBench.Region>");
      }
      yield* Active.expect();
      yield* RegionContext.set(region.parse(props.name));
      return yield* content();
    },
    { name: string },
    ["name"],
  ),
  registration(
    ".Scroll",
    function* (props) {
      yield* action({
        action: "scroll",
        region: yield* RegionContext.get(),
        delta: z.int().parse(props.delta),
      });
    },
    { delta: integer },
    ["delta"],
  ),
  registration(
    ".WaitForText",
    function* (props) {
      const { timeout, ...options } = wait.parse(props);
      const result = yield* action({
        action: "wait",
        ...options,
        unique: yield* hasBinding(),
        region: yield* RegionContext.get(),
        timeout:
          timeout === undefined
            ? undefined
            : parseDuration(timeout, "<ReplBench.WaitForText timeout>"),
      });
      return point.nullable().parse(result);
    },
    { text: string, timeout: string, at: { type: "object" }, present: boolean },
    ["text"],
  ),
];

export default Plugin({
  name: "repl-bench",
  *install({ command }) {
    if (command === "test") {
      yield* registerComponents(registrations);
    }
    return undefined;
  },
});
