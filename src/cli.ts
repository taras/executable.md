#!/usr/bin/env node --experimental-strip-types
/**
 * CLI — run an executable markdown document.
 *
 * Usage:
 *   ema run <document.md> [options]
 *   ema <document.md> [options]        (run is the default command)
 *
 * Examples:
 *   ema run examples/hello-world.md
 *   ema examples/hello-world.md --verbose
 *   ema run examples/hello-world.md --journal events.jsonl
 */

import { main, exit, spawn, each, createSignal, type Operation } from "effection";
import { InMemoryStream, type DurableEvent, type DurableStream } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";
import { inspect } from "node:util";
import { program, object, field, cli, commands, type Mods } from "@frontside/configliere";
import { z } from "zod";
import { runDocument } from "./run-document.ts";
import { FileStream } from "./file-stream.ts";
import { loadJournal } from "./load-journal.ts";

// ---------------------------------------------------------------------------
// Workaround: field.default exists at runtime but is missing from the .d.ts
// ---------------------------------------------------------------------------

const defaults = <T>(value: T) => (mods: Mods): Mods => ({ ...mods, default: value });

// ---------------------------------------------------------------------------
// Program schema
// ---------------------------------------------------------------------------

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
    description: "log journal events to stderr",
    aliases: ["-V"],
    ...field(z.boolean(), defaults(false)),
  },
  journal: {
    description: "JSONL journal file (creates if missing, replays if exists, retries on failure)",
    aliases: ["-j"],
    ...field(z.string().optional()),
  },
});

const ema = program({
  name: "ema",
  version: "0.1.0",
  config: commands({ run: runConfig }, { default: "run" }),
});

// ---------------------------------------------------------------------------
// Journal event formatting
// ---------------------------------------------------------------------------

const pretty = (value: unknown): string =>
  inspect(value, { colors: true, compact: true, breakLength: Infinity, depth: 2, maxStringLength: 60 });

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
    const detail = status === "err" && "error" in event.result
      ? ` (${event.result.error.message})`
      : formatYieldResult(event);
    return `[yield] ${desc.type}:${desc.name} → ${status}${detail}`;
  }
  const status = event.result.status;
  const detail = status === "err" && "error" in event.result
    ? ` (${event.result.error.message})`
    : "";
  return `[close] ${event.coroutineId} → ${status}${detail}`;
}

// ---------------------------------------------------------------------------
// Document runner
// ---------------------------------------------------------------------------

function* run(config: {
  docPath: string;
  componentDir: string[];
  verbose: boolean;
  journal: string | undefined;
}): Operation<void> {
  const { docPath, componentDir, verbose, journal } = config;

  // Build the durable stream:
  // - With --journal: file-backed stream that persists events as JSONL.
  //   If the file exists, events are loaded for replay. If the previous
  //   run failed, the Close(err) is stripped so we retry from the last
  //   successful point.
  // - Without --journal: ephemeral in-memory stream (no persistence).
  let stream: DurableStream;

  if (journal) {
    const events = yield* loadJournal(journal);
    stream = new FileStream(journal, events);
  } else {
    stream = new InMemoryStream();
  }

  // Wire --verbose observability via Signal.
  // FileStream.onAppend fires after each persist; the signal fans out
  // to the stderr writer below. Persistence is handled by FileStream
  // itself — the signal is purely for observability.
  const signal = verbose
    ? createSignal<DurableEvent, void>()
    : undefined;

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
    : spawn(function *() {});

  try {
    const output = yield* runDocument({
      docPath,
      stream,
      runtime: nodeRuntime(),
      componentDirs: componentDir,
      freshness: false,
    });

    console.log(output);
  } finally {
    // Close the signal so the writer drains remaining events and exits.
    if (signal) {
      signal.close();
      yield* writer;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

await main(function* (args) {
  const parser = ema.createParser({ args });

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
          yield* run(parsed.value.config);
          break;
      }
    }
  }
});
