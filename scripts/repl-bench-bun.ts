import { exists, readTextFile } from "@effectionx/fs";
import { exit, main, race, scoped, sleep, type Operation } from "effection";
import { join } from "node:path";
import process from "node:process";
import { useDriver } from "./lib/repl-bench/driver-bun.ts";
import {
  command,
  defaultSize,
  exitResult,
  launch as launchSchema,
  size,
  type Command,
} from "./lib/repl-bench/protocol.ts";
import { evidence, prepareRun, root } from "./lib/repl-bench/run.ts";
import { serve, request, start } from "./lib/repl-bench/control-bun.ts";

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function dimensions(text: string) {
  const match = /^(\d+)x(\d+)$/.exec(text);
  return size.parse({ columns: Number(match?.[1]), rows: Number(match?.[2]) });
}

function* preflight(cwd: string, requested: ReturnType<typeof dimensions>) {
  const { id, revision, launch } = yield* prepareRun(cwd, requested, ["--deny-all"]);
  const driver = yield* useDriver(launch);
  const marker = "repl-bench check;";
  const region = "sidekick-composer";
  yield* driver.execute({ action: "ready" });
  yield* driver.execute({ action: "focus" });
  yield* driver.execute({ action: "type", text: marker });
  yield* driver.execute({ action: "wait", region, text: marker });
  yield* driver.execute({ action: "look" });
  yield* driver.execute({ action: "key", key: "Ctrl+C" });
  yield* driver.execute({ action: "wait", region, text: marker, present: false });
  yield* driver.execute({ action: "key", key: "Ctrl+C" });
  const result = yield* race([
    driver.execute({ action: "exit" }),
    (function* () {
      yield* sleep(5_000);
      throw new Error(`Timed out waiting for REPL exit. Evidence: ${launch.directory}`);
    })(),
  ]);
  const { exitCode, location } = exitResult.parse(result);
  if (exitCode !== 0 || location === null) {
    throw new Error(
      `REPL exit failed: status ${exitCode}, reopen location ${location}. Evidence: ${launch.directory}`,
    );
  }
  print(
    `Worktree ${root}\nRevision ${revision}\nRun ${id}\nTerminal ${requested.columns}x${requested.rows}\nExit ${exitCode}\nReopen ${location}\nEvidence ${launch.directory}`,
  );
}

function* followup(action: string, directory: string, args: string[]): Operation<void> {
  if (action === "status") {
    print(yield* readTextFile(join(directory, "run.json")));
    if (yield* exists(join(directory, "closed.json"))) {
      print("closed");
    } else {
      print("open");
    }
    return;
  }
  if (action === "look" && (yield* exists(join(directory, "closed.json")))) {
    print(yield* readTextFile(join(directory, "screen.txt")));
    return;
  }
  const operations: Command[] =
    action === "send"
      ? args.map((key) => ({ action: "key", key }))
      : [
          command.parse({
            action,
            text: args[0],
            name: args[0],
            ...(action === "resize" ? dimensions(args[0] ?? "") : {}),
          }),
        ];
  if (operations.length === 0) {
    throw new Error("send needs at least one key");
  }
  for (const operation of operations) {
    const result = yield* request(directory, operation);
    if (typeof result === "string") {
      print(result);
    } else if (operation.action === "exit") {
      print(JSON.stringify(exitResult.parse(result)));
    }
  }
}

main(function* ([action, ...args]) {
  if (action === "driver") {
    const options = launchSchema.parse(JSON.parse(args[0] ?? ""));
    const driver = yield* useDriver(options);
    if (args[1] === "socket") {
      yield* driver.execute({ action: "ready" });
    }
    yield* serve(options.directory, args[1] === "socket", driver.execute);
    return;
  }
  if (action === "preflight" || action === "start") {
    let requested = defaultSize;
    if (args[0] === "--size") {
      requested = dimensions(args[1] ?? "");
      args = args.slice(2);
    }
    if ((action === "preflight" && args.length > 0) || (args.length > 0 && args[0] !== "--")) {
      throw new Error(
        `Usage: repl-bench ${action} [--size WxH]${action === "start" ? " [-- <repl args>]" : ""}`,
      );
    }
    if (action === "preflight") {
      yield* preflight(process.cwd(), requested);
    } else {
      const replArgs = args.slice(1);
      const run = yield* prepareRun(
        process.cwd(),
        requested,
        replArgs.length === 0 ? ["--deny-all"] : replArgs,
      );
      yield* start(run.launch);
      print(run.id);
    }
    return;
  }
  const id = args.shift() ?? "";
  if (action === undefined || !/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error("Specify a command and run ID. See repl-bench --help.");
  }
  try {
    yield* scoped(() => followup(action, join(evidence, id), args));
  } catch (error) {
    yield* exit(1, error instanceof Error ? error.message : String(error));
  }
});
