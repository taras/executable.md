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
import { command as xmdCommand, cwd, parseDuration, realpath } from "@executablemd/runtime";
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
import { randomUUID } from "node:crypto";
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
  screenshotName,
  size,
  type Command,
  type Launch,
  type Region,
  type Size,
} from "./lib/repl-bench/protocol.ts";
import {
  assertPinnedWorktree,
  prepareRun,
  root,
  type PreparedBuild,
} from "./lib/repl-bench/run.ts";
import { attachSidekick } from "./lib/repl-bench/sidekick.ts";

type Execute = (command: Command) => Operation<unknown>;

function createTerminal(initial: Size, entryHome?: string) {
  let dimensions = initial;
  let active: { dispatch?: Execute } | undefined;
  function requireLaunch(): Execute {
    if (active?.dispatch === undefined) {
      throw new Error("This terminal action needs an active <XMD.Repl> launch");
    }
    return active.dispatch;
  }
  return {
    entryHome,
    resumes: new WeakMap<object, Resume & { dimensions: Size }>(),
    get dimensions() {
      return dimensions;
    },
    *claim() {
      if (active !== undefined) {
        throw new Error("This <Terminal> already has an active <XMD.Repl> launch");
      }
      const launch: { dispatch?: Execute } = {};
      active = launch;
      // The launch registers its driver cleanup after this reservation.
      yield* ensure(() => {
        active = undefined;
      });
      return launch;
    },
    requireLaunch,
    *execute(command: Command): Operation<unknown> {
      const result =
        active === undefined && command.action === "resize"
          ? null
          : yield* requireLaunch()(command);
      if (command.action === "resize") {
        dimensions = { columns: command.columns, rows: command.rows };
      }
      return result;
    },
  };
}

const TerminalContext = createContext<ReturnType<typeof createTerminal>>("xmd.repl-bench.terminal");
const LaunchRevision = createContext<string | null>("xmd.repl-bench.launch-revision");
const EntryBench = createContext("xmd.repl-bench.entry", false);
const buildProps = z.object({
  checkout: z.string().min(1),
  expectedRevision: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .optional(),
});
const Build = createContext<PreparedBuild>("xmd.repl-bench.build");
const RegionContext = createContext<Region | undefined>("xmd.repl-bench.region", undefined);
const WaitTimeout = createContext<number | undefined>("xmd.repl-bench.wait-timeout", undefined);
const Sidekick = createContext<Yielded<ReturnType<typeof attachSidekick>> | undefined>(
  "xmd.repl-bench.sidekick",
  undefined,
);
interface Resume {
  location: string;
  home: string;
}
const Resumes =
  createContext<WeakMap<object, Resume & { dimensions: Size }>>("xmd.repl-bench.resumes");
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
  entryBenchFixture: z.boolean().default(false),
  include: z.array(z.string().min(1)).default([]),
  mount: z.array(z.string().min(1)).default([]),
  allowAbsolute: z.boolean().default(false),
});

function* connect(options: Launch) {
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
  let stopRequested = false;
  function* close() {
    if (!driverEnded && !stopRequested) {
      stopRequested = true;
      child.stdin.send(`${JSON.stringify({ action: "stop" })}\n`);
    }
    return yield* child.join();
  }
  yield* ensure(function* () {
    yield* close();
  });
  const dispatch: Execute = function* (command) {
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
  return { dispatch, close };
}

const Terminal: FunctionComponent = function* (props, invocation) {
  if (!invocation.hasContent()) {
    throw new Error("Use a paired <Terminal>");
  }
  const test = yield* Test.operations.testScope;
  if (test === undefined && !(yield* EntryBench.expect())) {
    throw new Error("<Terminal> needs an enclosing <Test> or a development REPL entry");
  }
  const initial = size.parse(props);
  const home = test === undefined ? yield* useTempDirectory("xmd-repl-terminal-") : undefined;
  yield* TerminalContext.set(createTerminal(initial, home));
  yield* Sidekick.set(undefined);
  yield* RegionContext.set(undefined);
  yield* WaitTimeout.set(undefined);
  return yield* content();
};

const XmdBuild: FunctionComponent = function* (props, invocation) {
  if (!invocation.hasContent()) {
    throw new Error("Use a paired <XMD.Build>");
  }
  const { checkout, expectedRevision } = buildProps.parse(props);
  yield* Build.set({ checkout: resolve(yield* cwd(), checkout), expectedRevision });
  return yield* content();
};

const XmdRepl: FunctionComponent = function* (props, invocation) {
  if (!invocation.hasContent()) {
    throw new Error("Use a paired <XMD.Repl>");
  }
  const test = yield* Test.operations.testScope;
  if (test === undefined && !(yield* EntryBench.expect())) {
    throw new Error("<XMD.Repl> needs an enclosing <Test> or a development REPL entry");
  }
  const directory = yield* cwd();
  const wanted = bench.parse(props);
  const build = yield* Build.get();
  if (
    test === undefined &&
    (wanted.entryBenchFixture ||
      wanted.entryPermissionFixture ||
      wanted.scenario !== undefined ||
      wanted.include.length > 0 ||
      wanted.mount.length > 0 ||
      wanted.allowAbsolute)
  ) {
    throw new Error("Use scripted REPL fixtures and launch overrides inside <Test>");
  }
  const enclosing = yield* TerminalContext.get();
  if (enclosing !== undefined && (wanted.columns !== undefined || wanted.rows !== undefined)) {
    throw new Error("Set viewport dimensions on the enclosing <Terminal>");
  }
  const reservation = enclosing === undefined ? undefined : yield* enclosing.claim();
  const waitTimeout =
    wanted.waitTimeout === undefined
      ? undefined
      : parseDuration(wanted.waitTimeout, "<XMD.Repl waitTimeout>");
  const captured = (yield* hasCapture("resume")) ? yield* capture("resume") : undefined;
  const allocateTestHome = function* () {
    const resumes = (yield* Resumes.get()) ?? (yield* Resumes.set(new WeakMap()));
    return {
      resumes,
      home: captured === undefined ? yield* useTempDirectory("xmd-repl-test-") : undefined,
    };
  };
  const allocation = test === undefined ? undefined : yield* test.eval(allocateTestHome);
  if (allocation !== undefined && !allocation.ok) {
    throw allocation.error;
  }
  const resumes = allocation?.value.resumes ?? enclosing?.resumes;
  const resume =
    typeof captured === "object" && captured !== null ? resumes?.get(captured) : undefined;
  if (captured !== undefined && resume === undefined) {
    throw new Error("resume must come from a clean <XMD.Repl> exit in this test or <Terminal>");
  }
  let home = allocation?.value.home;
  if (test === undefined && resume === undefined) {
    home =
      enclosing?.entryHome === undefined
        ? yield* useTempDirectory("xmd-repl-entry-")
        : join(enclosing.entryHome, randomUUID());
  }
  const terminal =
    enclosing ??
    createTerminal({
      columns: wanted.columns ?? resume?.dimensions.columns ?? defaultSize.columns,
      rows: wanted.rows ?? resume?.dimensions.rows ?? defaultSize.rows,
    });
  const active = reservation ?? (yield* terminal.claim());
  const args = wanted.entryPermissionFixture
    ? [
        "--approve-reads",
        "--plugin",
        fileURLToPath(new URL("./lib/repl-bench/wheel-permission.ts", import.meta.url)),
      ]
    : ["--deny-all"];
  if (wanted.entryBenchFixture) {
    if (test === undefined || wanted.scenario === undefined) {
      throw new Error("The ReplBench entry fixture needs a scripted <Test>");
    }
    args.push("--plugin", fileURLToPath(import.meta.url));
  }
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
  const command = build === undefined ? yield* xmdCommand(["repl", ...args]) : undefined;
  const { launch, revision } = yield* prepareRun(directory, terminal.dimensions, args, {
    home: resume?.home ?? home,
    scenario,
    build,
    command,
  });
  yield* Stdio.around(
    {
      // deno-lint-ignore require-yield
      *stdout() {
        return;
      },
    },
    { at: "min" },
  );
  const { dispatch, close } = yield* connect(launch);
  yield* dispatch({ action: "ready" });
  let sidekick: Yielded<ReturnType<typeof attachSidekick>> | undefined;
  if (attachment !== undefined) {
    yield* dispatch({ action: "attachment-ready", path: attachment });
    sidekick = yield* attachSidekick(attachment, launch.directory);
  }
  active.dispatch = dispatch;
  yield* ensure(() => {
    delete active.dispatch;
  });
  yield* Sidekick.set(sidekick);
  yield* TerminalContext.set(terminal);
  yield* LaunchRevision.set(revision);
  yield* RegionContext.set(undefined);
  yield* WaitTimeout.set(waitTimeout);
  const rendered = yield* content();
  const bind = yield* hasBinding();
  const exit = wanted.expectExit
    ? exitResult.parse(yield* dispatch({ action: "exit" }))
    : undefined;
  if (build?.expectedRevision !== undefined && launch.worktree !== undefined) {
    const { code, signal } = yield* close();
    if (code !== 0) {
      throw new Error(`Driver exited (${code ?? signal}). Evidence: ${launch.directory}`);
    }
    yield* assertPinnedWorktree(launch.worktree, build.expectedRevision);
  }
  if (exit === undefined) {
    return bind ? closed : rendered;
  }
  const reference =
    resumes !== undefined && exit.exitCode === 0 && exit.location !== null
      ? Object.freeze({ location: exit.location, home: launch.home })
      : null;
  if (reference !== null) {
    resumes?.set(reference, { ...reference, dimensions: terminal.dimensions });
  }
  return bind ? { ...exit, resume: reference } : rendered;
};

function* scriptedSidekick() {
  const sidekick = yield* Sidekick.get();
  if (sidekick === undefined) {
    throw new Error("This action needs an <XMD.Repl> with a scenario.");
  }
  return sidekick;
}

function* action(command: Command) {
  const terminal = yield* TerminalContext.get();
  if (terminal === undefined) {
    throw new Error("Use terminal actions inside <Terminal> or <XMD.Repl>");
  }
  return yield* terminal.execute(command);
}

function registration(
  name: string,
  fn: FunctionComponent,
  properties: NonNullable<PropsSchema["properties"]> = {},
  required: string[] = [],
): ComponentRegistration {
  return {
    name,
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
const replLaunch = {
  ...registration("XMD.Repl", XmdRepl, {
    ...dimensions,
    expectExit: boolean,
    waitTimeout: string,
    scenario: string,
    entryPermissionFixture: boolean,
    entryBenchFixture: boolean,
    include: strings,
    mount: strings,
    allowAbsolute: boolean,
  }),
  captures: ["resume"],
};
const launchActions = [
  registration("XMD.Repl.Revision", function* () {
    (yield* TerminalContext.expect()).requireLaunch();
    return (yield* LaunchRevision.get()) ?? null;
  }),
  registration(
    "XMD.Repl.SidekickPrompt",
    function* (props) {
      return yield* (yield* scriptedSidekick()).prompt(z.string().min(1).parse(props.text));
    },
    { text: string },
    ["text"],
  ),
  registration("XMD.Repl.SidekickStatus", function* () {
    return yield* (yield* scriptedSidekick()).status();
  }),
  registration(
    "XMD.Repl.EntryOutput",
    function* (props) {
      return yield* (yield* scriptedSidekick()).output(z.int().positive().parse(props.entry));
    },
    { entry: integer },
    ["entry"],
  ),
];

const terminalActions = [
  registration(
    "Terminal.Screenshot",
    function* (props) {
      const name = screenshotName.parse(props.name);
      const format = z.enum(["png", "svg"]).optional().parse(props.format);
      return z.string().parse(yield* action({ action: "screenshot", name, format }));
    },
    { name: string, format: { type: "string", enum: ["png", "svg"] } },
    ["name"],
  ),
  registration(
    "Terminal.Focus",
    function* (props) {
      z.literal("sidekick-composer").parse(props.target);
      yield* action({ action: "focus" });
    },
    { target: string },
    ["target"],
  ),
  registration(
    "Terminal.Type",
    function* (props) {
      yield* action({ action: "type", text: z.string().parse(props.text) });
    },
    { text: string },
    ["text"],
  ),
  registration(
    "Terminal.Key",
    function* (props) {
      yield* action({ action: "key", key: z.string().min(1).parse(props.key) });
    },
    { key: string },
    ["key"],
  ),
  registration(
    "Terminal.Resize",
    function* (props) {
      yield* action({ action: "resize", ...size.parse(props) });
    },
    dimensions,
    ["columns", "rows"],
  ),
  registration(
    "Terminal.Region",
    function* (props, invocation) {
      if (!invocation.hasContent()) {
        throw new Error("Use a paired <Terminal.Region>");
      }
      (yield* TerminalContext.expect()).requireLaunch();
      yield* RegionContext.set(region.parse(props.name));
      return yield* content();
    },
    { name: string },
    ["name"],
  ),
  registration(
    "Terminal.Click",
    function* (props) {
      yield* action({ action: "click", at: point.parse(props.at) });
    },
    { at: cell },
    ["at"],
  ),
  registration(
    "Terminal.Scroll",
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
    "Terminal.WaitForText",
    function* (props) {
      const { timeout, ...options } = wait.parse(props);
      const unique = yield* hasBinding();
      if (options.count !== undefined && (unique || options.present !== undefined)) {
        throw new Error("WaitForText count cannot be combined with as or present");
      }
      const result = yield* action({
        action: "wait",
        ...options,
        unique,
        region: yield* RegionContext.get(),
        timeout:
          timeout === undefined
            ? yield* WaitTimeout.get()
            : parseDuration(timeout, "<Terminal.WaitForText timeout>"),
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
  *install({ command }): Operation<undefined> {
    if (command === "repl") {
      yield* EntryBench.set(true);
    }
    if (command === "test" || command === "repl") {
      yield* registerComponents([
        registration("Terminal", Terminal, dimensions, ["columns", "rows"]),
        registration("XMD.Build", XmdBuild, { checkout: string, expectedRevision: string }, [
          "checkout",
        ]),
        replLaunch,
        { ...replLaunch, name: "ReplBench" },
        ...launchActions,
        ...launchActions.map((entry) => ({
          ...entry,
          name: entry.name.replace("XMD.Repl.", "ReplBench."),
        })),
        ...terminalActions,
        ...terminalActions.map((entry) => ({
          ...entry,
          name: entry.name.replace("Terminal.", "ReplBench."),
        })),
      ]);
    }
    return undefined;
  },
});
