/**
 * Thin programmatic entry point for running EMA documents.
 *
 * Usage:
 *   deno run --allow-all .internal/exec.ts <document.md>
 *
 * Bootstraps Effection, creates an in-memory stream (no journal),
 * runs the document, and writes the raw output to stdout.
 *
 * Component resolution searches .internal/components/ only.
 */

import { main } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { nodeRuntime } from "@executablemd/durable-effects";
import { runDocument, collect } from "@executablemd/core";

await main(function* () {
  const docPath = Deno.args[0];

  if (!docPath) {
    console.error("Usage: deno run --allow-all .internal/exec.ts <document.md>");
    Deno.exit(1);
  }

  const execution = yield* runDocument({
    docPath,
    stream: new InMemoryStream(),
    runtime: nodeRuntime(),
    componentDirs: [".internal/components"],
    freshness: false,
  });

  const output = yield* collect(execution);
  Deno.stdout.writeSync(new TextEncoder().encode(output));
});
