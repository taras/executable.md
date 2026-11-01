import { execute, inlineSource } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useHostFiles } from "@executablemd/runtime";
import { readTextFile } from "@effectionx/fs";
import { fromReadable } from "@effectionx/node/stream";
import { main, scoped } from "effection";
import process from "node:process";
import { z } from "zod";

const argumentsSchema = z.tuple([
  z.string().min(1),
  z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number),
]);
const renderedSchema = z.object({ text: z.string(), terminal: z.json().nullable() });
const MAX_LINE = 1024 * 1024;

await main(function* (args) {
  const [document, entry] = argumentsSchema.parse(args);
  const source = yield* readTextFile(document);
  yield* useHostFiles();
  const incoming = yield* fromReadable(process.stdin);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let previous: string | undefined;
  let terminalEmitted = false;

  while (true) {
    const next = yield* incoming.next();
    pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      if (newline > MAX_LINE) {
        throw new Error("The progress stream exceeded the progress line limit.");
      }
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > 0) {
        const update = z.json().parse(JSON.parse(line));
        const rendered = yield* scoped(function* () {
          const execution = yield* execute({
            ...inlineSource(source),
            stream: new InMemoryStream(),
            includes: [],
            props: { update, entry },
          });
          const result = yield* execution;
          if (!result.ok) {
            throw result.error;
          }
          return renderedSchema.parse(result.value);
        });
        if (rendered.text !== previous) {
          process.stderr.write(rendered.text + "\n");
          previous = rendered.text;
        }
        if (rendered.terminal !== null && !terminalEmitted) {
          process.stdout.write(JSON.stringify(rendered.terminal) + "\n");
          terminalEmitted = true;
        }
      }
      newline = pending.indexOf("\n");
    }
    if (pending.length > MAX_LINE) {
      throw new Error("The progress stream exceeded the progress line limit.");
    }
    if (next.done) {
      if (pending.trim().length > 0) {
        throw new Error("The progress stream ended with an incomplete frame.");
      }
      break;
    }
  }
});
