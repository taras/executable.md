/**
 * CLI — run an executable markdown document.
 *
 * Usage:
 *   xmd run <document.md> [options]
 *   xmd <document.md> [options]        (run is the default command)
 *
 * Examples:
 *   xmd run core/examples/hello-world.md
 *   xmd core/examples/hello-world.md --verbose
 *   xmd run core/examples/hello-world.md --journal events.jsonl
 */

import { main, exit, spawn, each, createSignal, until, type Operation } from "effection";
import {
  InMemoryStream,
  type DurableEvent,
  type DurableStream,
} from "@executablemd/durable-streams";

import { forEach } from "@effectionx/stream-helpers";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { inspect } from "node:util";
import process from "node:process";
import { program, object, field, cli, commands, type Mods } from "configliere";
import { z } from "zod";
import { execute, useNormalizedOutput, useTerminalOutput } from "@executablemd/core";
import { installTestingVocabulary, TestFailureError, useTesting } from "@executablemd/testing";
import { FileStream } from "./file-stream.ts";
import denoJson from "../deno.json" with { type: "json" };

const defaults =
  <T>(value: T) =>
  (mods: Mods): Mods => ({ ...mods, default: value });

const runConfig = object({
  docPath: {
    description: "markdown document to execute",
    ...field(z.string(), cli.argument()),
  },
  componentDir: {
    description: "component search directory",
    ...field(z.array(z.string()), defaults(["components", "."]), field.array()),
  },
  verbose: {
    description: "log journal entries to stderr",
    aliases: ["-V"],
    ...field(z.boolean(), defaults(false)),
  },
  journal: {
    description: "write a diagnostic JSONL trace (path must not exist)",
    aliases: ["-j"],
    ...field(z.string().optional()),
  },
  raw: {
    description: "output raw markdown without normalization or terminal formatting",
    ...field(z.boolean(), defaults(false)),
  },
});

const testConfig = object({
  docPath: {
    description: "markdown document to test",
    ...field(z.string(), cli.argument()),
  },
  componentDir: {
    description: "component search directory",
    ...field(z.array(z.string()), defaults(["components", "."]), field.array()),
  },
  verbose: {
    description: "log journal entries to stderr",
    aliases: ["-V"],
    ...field(z.boolean(), defaults(false)),
  },
  journal: {
    description: "write a diagnostic JSONL trace (path must not exist)",
    aliases: ["-j"],
    ...field(z.string().optional()),
  },
  raw: {
    description: "output raw markdown without normalization or terminal formatting",
    ...field(z.boolean(), defaults(false)),
  },
});

const xmd = program({
  name: "xmd",
  version: denoJson.version,
  config: commands({ run: runConfig, test: testConfig }, { default: "run" }),
});

const pretty = (value: unknown): string =>
  inspect(value, {
    colors: true,
    compact: true,
    breakLength: Infinity,
    depth: 2,
    maxStringLength: 200,
  });

function formatYieldResult(event: DurableEvent & { type: "yield" }): string {
  const { result, description } = event;
  if (result.status !== "ok" || result.value === undefined) return "";

  const v = result.value as Record<string, unknown>;
  switch (description.type) {
    case "import_component":
      return " " + pretty({ path: v.path });
    case "eval":
      return " " + pretty(v.value ?? {});
    case "exec":
      return " " + pretty({ exitCode: v.exitCode, stdout: v.stdout, stderr: v.stderr });
    default:
      return " " + pretty(v);
  }
}

function summarizeEvent(event: DurableEvent): string {
  if (event.type === "yield") {
    const desc = event.description;
    const status = event.result.status;
    const detail =
      status === "err" && "error" in event.result
        ? ` (${event.result.error.message})`
        : formatYieldResult(event);
    return `[yield] ${desc.type}:${desc.name} → ${status}${detail}`;
  }
  const status = event.result.status;
  const detail =
    status === "err" && "error" in event.result ? ` (${event.result.error.message})` : "";
  return `[close] ${event.coroutineId} → ${status}${detail}`;
}

function* createJournalFile(filePath: string): Operation<void> {
  let handle: FileHandle;
  try {
    handle = yield* until(open(filePath, "wx"));
  } catch (error) {
    const isExistingFile =
      error instanceof Error &&
      (("code" in error && error.code === "EEXIST") || error.message.startsWith("EEXIST:"));
    if (isExistingFile) {
      throw new Error(
        `Journal trace already exists: ${filePath}. Remove it or choose another path.`,
        { cause: error },
      );
    }
    throw error;
  }

  yield* until(handle.close());
}

function* run(
  config: {
    docPath: string;
    componentDir: string[];
    verbose: boolean;
    journal: string | undefined;
    raw: boolean;
  },
  mode: { testing: boolean },
): Operation<void> {
  const { docPath, componentDir, verbose, journal, raw } = config;

  // Every CLI invocation starts from an empty stream. --journal writes
  // current-run diagnostics only; existing traces are never loaded.
  let stream: DurableStream;

  if (journal) {
    yield* createJournalFile(journal);
    stream = new FileStream(journal);
  } else {
    stream = new InMemoryStream();
  }

  // Wire --verbose observability via Signal.
  // FileStream.onAppend fires after each persist; the signal fans out
  // to the stderr writer below. Persistence is handled by FileStream
  // itself — the signal is purely for observability.
  const signal = verbose ? createSignal<DurableEvent, void>() : undefined;

  if (signal && stream instanceof FileStream) {
    stream.onAppend = (event: DurableEvent) => signal.send(event);
  } else if (signal && stream instanceof InMemoryStream) {
    stream.onAppend = (event: DurableEvent) => signal.send(event);
  }

  // Spawn verbose stderr writer
  const writer = signal
    ? yield* spawn(function* () {
        for (const event of yield* each(signal)) {
          console.error(summarizeEvent(event));
          yield* each.next();
        }
      })
    : spawn(function* () {});

  // ---------------------------------------------------------------------------
  // Output middleware (spec §9).
  //
  // Middleware is installed on the DocumentOutput Api via Api.around() before
  // execute is called. execute owns the output stream internally —
  // the CLI just installs transformations and consumes the returned stream.
  // ---------------------------------------------------------------------------

  if (!raw) {
    yield* useNormalizedOutput();
  }

  if (process.stdout.isTTY && !raw) {
    yield* useTerminalOutput();
  }

  // Compose testing around the single core execution entrypoint: both
  // commands register the vocabulary (assertions work in regular documents,
  // explicit <Testing> boundaries affect the outcome), while `xmd test`
  // additionally activates root testing through a useTesting() session.
  if (mode.testing) {
    yield* useTesting({ verbose });
  } else {
    yield* installTestingVocabulary({ verbose });
  }

  const execution = yield* execute({
    docPath,
    stream,
    componentDirs: componentDir,
  });

  // Consume the output stream with forEach.
  // Interactive TTY: write each chunk as it arrives.
  // Piped: collect and write the full output at the end.
  const fullOutput = yield* forEach(function* (chunk: string) {
    if (process.stdout.isTTY) {
      process.stdout.write(chunk);
    }
  }, execution.output);

  // When piped (not TTY), write the full output at the end.
  if (!process.stdout.isTTY) {
    process.stdout.write(fullOutput);
  }

  // Close the signal so the writer drains remaining events and exits.
  if (signal) {
    signal.close();
    yield* writer;
  }

  // Inspect the completion Result AFTER the report finished streaming:
  // test failures, assertion aborts, and any document abort exit nonzero.
  const result = yield* execution;
  if (!result.ok) {
    if (result.error instanceof TestFailureError) {
      console.error(`\ntests failed: ${result.error.message}`);
    } else {
      console.error(result.error.message);
    }
    yield* exit(1);
  }
}

await main(function* (args) {
  const parser = xmd.createParser({ args });

  switch (parser.type) {
    case "help":
      console.log(parser.print());
      yield* exit(0);
      break;
    case "version":
      console.log(parser.print());
      yield* exit(0);
      break;
    case "main": {
      const parsed = parser.parse();
      if (!parsed.ok) {
        console.error(parsed.error.message);
        yield* exit(1);
        break;
      }
      switch (parsed.value.name) {
        case "run":
          yield* run(parsed.value.config, { testing: false });
          break;
        case "test":
          yield* run(parsed.value.config, { testing: true });
          break;
      }
    }
  }
});
