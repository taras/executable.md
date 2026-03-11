#!/usr/bin/env node --experimental-strip-types
/**
 * CLI — run an executable markdown document.
 *
 * Usage:
 *   npm run run -- <document.md> [options]
 *
 * Example:
 *   npm run run -- examples/hello-world.md
 *   npm run run -- examples/hello-world.md --verbose
 *   npm run run -- examples/hello-world.md --journal events.jsonl
 */

import { main } from "effection";
import { InMemoryStream, type DurableEvent } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";
import { appendFileSync, writeFileSync } from "node:fs";
import { runDocument } from "./run-document.ts";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run run -- <document.md> [options]

Run an executable markdown document.

Options:
  --component-dir <dir>   Add a component search directory (default: components, .)
  --verbose               Log each journal event to stderr as it happens
  --journal <file>        Write journal events as JSONL to a file
  --help, -h              Show this help message

Examples:
  npm run run -- examples/hello-world.md
  npm run run -- examples/hello-world.md --verbose
  npm run run -- examples/hello-world.md --journal events.jsonl`);
  process.exit(0);
}

let docPath: string | undefined;
const componentDirs: string[] = [];
let verbose = false;
let journalFile: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string;
  if (arg === "--component-dir" && i + 1 < args.length) {
    componentDirs.push(args[i + 1] as string);
    i++;
  } else if (arg === "--verbose") {
    verbose = true;
  } else if (arg === "--journal" && i + 1 < args.length) {
    journalFile = args[i + 1] as string;
    i++;
  } else if (!arg.startsWith("--")) {
    docPath = arg;
  }
}

if (!docPath) {
  console.error("Error: no document path provided");
  process.exit(1);
}

if (componentDirs.length === 0) {
  componentDirs.push("components", ".");
}

// ---------------------------------------------------------------------------
// Journal event formatting
// ---------------------------------------------------------------------------

function summarizeEvent(event: DurableEvent): string {
  if (event.type === "yield") {
    const desc = event.description;
    const status = event.result.status;
    const detail = status === "err" && "error" in event.result
      ? ` (${event.result.error.message})`
      : "";
    return `[yield] ${desc.type}:${desc.name} → ${status}${detail}`;
  }
  const status = event.result.status;
  const detail = status === "err" && "error" in event.result
    ? ` (${event.result.error.message})`
    : "";
  return `[close] ${event.coroutineId} → ${status}${detail}`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Truncate journal file if specified
if (journalFile) {
  writeFileSync(journalFile, "");
}

await main(function* () {
  const stream = new InMemoryStream();

  // Hook into journal events for observability
  if (verbose || journalFile) {
    stream.onAppend = (event: DurableEvent) => {
      if (verbose) {
        console.error(summarizeEvent(event));
      }
      if (journalFile) {
        appendFileSync(journalFile, JSON.stringify(event) + "\n");
      }
    };
  }

  const output = yield* runDocument({
    docPath,
    stream,
    runtime: nodeRuntime(),
    componentDirs,
    freshness: false,
  });

  console.log(output);
});
