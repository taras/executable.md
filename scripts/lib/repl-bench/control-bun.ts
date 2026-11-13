import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import {
  createQueue,
  ensure,
  type Operation,
  race,
  sleep,
  spawn,
  until,
  useScope,
  withResolvers,
} from "effection";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { useTempDirectory } from "../temp-directory.ts";
import { command, response, type Command, type Launch } from "./protocol.ts";

declare const Bun: {
  stdin: { stream(): ReadableStream<Uint8Array> };
  file(path: string): Blob;
  spawn(
    args: string[],
    options: { stdout: Blob; stderr: Blob; stdin: "ignore" },
  ): {
    exited: Promise<number>;
    kill(): void;
    unref(): void;
  };
  serve(options: { unix: string; fetch(request: Request): Promise<Response> }): {
    stop(close: boolean): Promise<void>;
  };
};

type Execute = (value: Command) => Operation<unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function* reply(execute: Execute, input: unknown) {
  try {
    return { value: (yield* execute(command.parse(input))) ?? null };
  } catch (error) {
    return { error: message(error) };
  }
}

function* pipe(execute: Execute): Operation<void> {
  const reader = Bun.stdin.stream().pipeThrough(new TextDecoderStream()).getReader();
  yield* ensure(() => until(reader.cancel()));
  const inputs = createQueue<Command, void>();
  const readDone = yield* spawn(function* () {
    let pending = "";
    while (true) {
      const chunk = yield* until(reader.read());
      if (chunk.done) {
        return;
      }
      const lines = (pending + chunk.value).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const input = command.parse(JSON.parse(line));
        if (input.action === "stop") {
          return;
        }
        inputs.add(input);
      }
    }
  });
  yield* race([
    (function* () {
      while (true) {
        const input = yield* inputs.next();
        if (input.done) {
          return;
        }
        const result = yield* reply(execute, input.value);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    })(),
    // The reader settling cancels a pending wait before the driver tears down.
    readDone,
  ]);
}

function* socket(directory: string, execute: Execute): Operation<void> {
  // A Unix socket's path limit is independent of the worktree path length.
  const scratch = yield* useTempDirectory("xmd-bench-", { dir: "/tmp" });
  const path = join(scratch, "control");
  const endpoint = join(directory, "endpoint");
  const scope = yield* useScope();
  const done = withResolvers<void>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let active = false;
  let closing = false;
  yield* ensure(function* () {
    if (server !== undefined) {
      yield* until(server.stop(!closing));
    }
    yield* rm(endpoint, { force: true });
  });
  server = Bun.serve({
    unix: path,
    fetch(incoming) {
      const task = scope.run(function* () {
        if (active) {
          return Response.json({ error: "Another bench command is in progress" }, { status: 409 });
        }
        active = true;
        try {
          const input = command.parse(yield* until(incoming.json()));
          const result = yield* reply(execute, input);
          if (input.action === "stop" || input.action === "exit" || "error" in result) {
            try {
              yield* execute({ action: "stop" });
            } finally {
              // Stop admitting requests while this response drains.
              closing = true;
            }
          }
          return Response.json(
            { ...result, closed: closing },
            { status: "error" in result ? 422 : 200 },
          );
        } catch (error) {
          return Response.json({ error: message(error), closed: closing });
        } finally {
          active = false;
        }
      });
      return task.then((value) => {
        if (closing) {
          done.resolve();
        }
        return value;
      });
    },
  });
  yield* writeTextFile(endpoint, path);
  yield* done.operation;
}

export function serve(directory: string, detached: boolean, execute: Execute): Operation<void> {
  return detached ? socket(directory, execute) : pipe(execute);
}

export function* request(directory: string, operation: Command): Operation<unknown> {
  const endpoint = join(directory, "endpoint");
  const unix = yield* readTextFile(endpoint);
  const options = {
    unix,
    method: "POST",
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(25_000),
  };
  const result = yield* until(fetch("http://localhost/", options));
  const raw: unknown = yield* until(result.json());
  const payload = response.parse(raw);
  if (typeof raw === "object" && raw !== null && "closed" in raw && raw.closed === true) {
    const deadline = Date.now() + 5_000;
    while (yield* exists(endpoint)) {
      if (Date.now() >= deadline) {
        throw new Error(`Control endpoint did not close. Evidence: ${directory}`);
      }
      yield* sleep(20);
    }
  }
  if ("error" in payload) {
    throw new Error(payload.error);
  }
  return payload.value;
}

export function* start(options: Launch): Operation<void> {
  const executable = fileURLToPath(new URL("../../repl-bench-bun.ts", import.meta.url));
  const output = join(options.directory, "driver.log");
  const endpoint = join(options.directory, "endpoint");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let attached = true;
  yield* ensure(function* () {
    if (attached && child !== undefined) {
      child.kill();
      yield* until(child.exited);
    }
  });
  child = Bun.spawn(
    [process.execPath, "--no-install", executable, "driver", JSON.stringify(options), "socket"],
    {
      stdout: Bun.file(output),
      stderr: Bun.file(output),
      stdin: "ignore",
    },
  );
  const result = yield* race([
    (function* () {
      while (!(yield* exists(endpoint))) {
        yield* sleep(25);
      }
      return "ready";
    })(),
    until(child.exited),
    (function* () {
      yield* sleep(20_000);
      return "timed out";
    })(),
  ]);
  if (result !== "ready") {
    const log = yield* readTextFile(output);
    throw new Error(`Driver startup failed (${result}). Evidence: ${options.directory}\n${log}`);
  }
  attached = false;
  child.unref();
}
