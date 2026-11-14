import { createQueue, ensure, main, type Operation, race, spawn, until } from "effection";
import process from "node:process";
import { useDriver } from "./lib/driver-bun.ts";
import { command, type DriverCommand, launch } from "./lib/protocol.ts";

declare const Bun: { stdin: { stream(): ReadableStream<Uint8Array> } };

type Execute = (value: DriverCommand) => Operation<unknown>;

function* reply(execute: Execute, input: DriverCommand) {
  try {
    return { value: (yield* execute(input)) ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function* serve(execute: Execute): Operation<void> {
  const reader = Bun.stdin.stream().pipeThrough(new TextDecoderStream()).getReader();
  yield* ensure(() => until(reader.cancel()));
  const inputs = createQueue<DriverCommand, void>();
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

main(function* ([options]) {
  const driver = yield* useDriver(launch.parse(JSON.parse(options ?? "")));
  yield* serve(driver.execute);
});
