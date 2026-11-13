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
import { cwd, parseDuration, realpath } from "@executablemd/runtime";
import { Test } from "@executablemd/testing";
import {
  createContext,
  ensure,
  type Operation,
  race,
  spawn,
  withResolvers,
  type Yielded,
} from "effection";
import { join, resolve } from "node:path";
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
import { attachSidekick } from "./lib/repl-bench/sidekick.ts";

type Execute = (command: Command) => Operation<unknown>;
const Active = createContext<Execute>("xmd.repl-bench.active");
const RegionContext = createContext<Region | undefined>("xmd.repl-bench.region", undefined);
const WaitTimeout = createContext<number | undefined>("xmd.repl-bench.wait-timeout", undefined);
const Sidekick = createContext<Yielded<ReturnType<typeof attachSidekick>> | undefined>(
  "xmd.repl-bench.sidekick",
  undefined,
);
const Homes = createContext<Set<object>>("xmd.repl-bench.homes");
const closed = { exitCode: null, location: null, resume: null };
const wait = z.object({
  text: z.string().min(1),
  timeout: z.string().optional(),
  at: point.optional(),
  row: z.int().nonnegative().optional(),
  count: z.int().nonnegative().optional(),
  present: z.boolean().optional(),
  bold: z.boolean().optional(),
});
const bench = size.partial().extend({
  expectExit: z.boolean().default(false),
  waitTimeout: z.string().optional(),
  scenario: z.string().min(1).optional(),
  entryPermissionFixture: z.boolean().default(false),
  include: z.array(z.string().min(1)).default([]),
  mount: z.array(z.string().min(1)).default([]),
  allowAbsolute: z.boolean().default(false),
});
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
  const waitTimeout =
    wanted.waitTimeout === undefined
      ? undefined
      : parseDuration(wanted.waitTimeout, "<ReplBench waitTimeout>");
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
  const args = wanted.entryPermissionFixture
    ? [
        "--approve-reads",
        "--plugin",
        fileURLToPath(new URL("./lib/repl-bench/wheel-permission.ts", import.meta.url)),
      ]
    : ["--deny-all"];
  if (resume !== undefined) {
    args.push(resume.location);
  }
  for (const path of wanted.include) {
    args.push(`--include=${path}`);
  }
  for (const pair of wanted.mount) {
    args.push(`--mount=${pair}`);
  }
  if (wanted.allowAbsolute) {
    args.push("--allow-absolute");
  }
  const scenario = wanted.scenario === undefined ? undefined : resolve(directory, wanted.scenario);
  let attachment: string | undefined;
  if (scenario !== undefined) {
    if (resume !== undefined || home === undefined) {
      throw new Error("A scripted Sidekick scenario requires a fresh REPL.");
    }
    const canonicalHome = yield* realpath(home);
    if (canonicalHome === undefined) {
      throw new Error("The scripted Sidekick test home is missing.");
    }
    attachment = join(canonicalHome, "sidekick.json");
    args.push(
      "--plugin",
      fileURLToPath(new URL("./lib/repl-bench/scripted-sidekick.ts", import.meta.url)),
      "--sidekick-agent",
      "scripted",
      "--sidekick-acp",
      attachment,
    );
  }
  const { launch } = yield* prepareRun(directory, initial, args, {
    home: resume?.home ?? home,
    scenario,
  });
  yield* Stdio.around({
    // deno-lint-ignore require-yield
    *stdout() {
      return;
    },
  });
  const dispatch = yield* connect(launch);
  let dimensions: Size = initial;
  function* execute(command: Command) {
    const value = yield* dispatch(command);
    if (command.action === "resize") {
      dimensions = { columns: command.columns, rows: command.rows };
    }
    return value;
  }
  yield* execute({ action: "ready" });
  let sidekick: Yielded<ReturnType<typeof attachSidekick>> | undefined;
  if (attachment !== undefined) {
    yield* execute({ action: "attachment-ready", path: attachment });
    sidekick = yield* attachSidekick(attachment, launch.directory);
  }
  yield* Sidekick.set(sidekick);
  yield* Active.set(execute);
  yield* RegionContext.set(undefined);
  yield* WaitTimeout.set(waitTimeout);
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

function* scriptedSidekick() {
  const sidekick = yield* Sidekick.get();
  if (sidekick === undefined) {
    throw new Error("This action needs a <ReplBench> with a scenario.");
  }
  return sidekick;
}

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
const strings = { type: "array", items: string };
const cell = {
  type: "object",
  properties: { row: integer, column: integer },
  required: ["row", "column"],
  additionalProperties: false,
};
const dimensions = { columns: integer, rows: integer };
const registrations = [
  {
    ...registration("", ReplBench, {
      ...dimensions,
      expectExit: boolean,
      waitTimeout: string,
      scenario: string,
      entryPermissionFixture: boolean,
      include: strings,
      mount: strings,
      allowAbsolute: boolean,
    }),
    captures: ["resume"],
  },
  registration(
    ".SidekickPrompt",
    function* (props) {
      return yield* (yield* scriptedSidekick()).prompt(z.string().min(1).parse(props.text));
    },
    { text: string },
    ["text"],
  ),
  registration(".SidekickStatus", function* () {
    return yield* (yield* scriptedSidekick()).status();
  }),
  registration(
    ".EntryOutput",
    function* (props) {
      return yield* (yield* scriptedSidekick()).output(z.int().positive().parse(props.entry));
    },
    { entry: integer },
    ["entry"],
  ),
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
    ".Click",
    function* (props) {
      yield* action({ action: "click", at: point.parse(props.at) });
    },
    { at: cell },
    ["at"],
  ),
  registration(
    ".Scroll",
    function* (props) {
      yield* action({
        action: "scroll",
        at: point.optional().parse(props.at),
        region: yield* RegionContext.get(),
        delta: z.int().parse(props.delta),
      });
    },
    { delta: integer, at: cell },
    ["delta"],
  ),
  registration(
    ".WaitForText",
    function* (props) {
      const { timeout, ...options } = wait.parse(props);
      const unique = yield* hasBinding();
      if (options.count !== undefined && (unique || options.present !== undefined)) {
        throw new Error("ReplBench.WaitForText count cannot be combined with as or present");
      }
      const result = yield* action({
        action: "wait",
        ...options,
        unique,
        region: yield* RegionContext.get(),
        timeout:
          timeout === undefined
            ? yield* WaitTimeout.get()
            : parseDuration(timeout, "<ReplBench.WaitForText timeout>"),
      });
      return point.nullable().parse(result);
    },
    {
      text: string,
      timeout: string,
      at: cell,
      row: integer,
      count: integer,
      present: boolean,
      bold: boolean,
    },
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
