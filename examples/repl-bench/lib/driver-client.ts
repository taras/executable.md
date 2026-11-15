import { exec } from "@effectionx/process";
import { ensure, race, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { response } from "./protocol.ts";
import type { Command, Launch } from "./protocol.ts";
import { root } from "./run.ts";

export function* connectDriver(options: Launch) {
  const script = fileURLToPath(new URL("../driver.ts", import.meta.url));
  const child = yield* exec("bun", {
    cwd: root,
    arguments: ["--no-install", script, JSON.stringify(options)],
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
  function* dispatch(command: Command): Operation<unknown> {
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
  }
  return { dispatch, close };
}
