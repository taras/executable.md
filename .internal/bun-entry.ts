/**
 * Bun entrypoint for running EMA documents.
 *
 * Exports emaRun() which calls Effection run() directly — no subprocess,
 * no Deno, no cold start. Uses nodeRuntime() which works in Bun because
 * all its dependencies (@effectionx/process, @effectionx/fetch, @effectionx/fs)
 * are npm packages.
 *
 * Workspace packages (@executablemd/core, durable-streams, durable-effects)
 * are resolved via file: links in .internal/package.json and per-package
 * package.json files with name + exports.
 */

import { run } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { nodeRuntime } from "@executablemd/durable-effects/node-runtime";
import { runDocument, collect } from "@executablemd/core";

export async function emaRun(
  docPath: string,
  options?: { env?: Record<string, string> },
): Promise<string> {
  if (options?.env) {
    for (const [k, v] of Object.entries(options.env)) {
      process.env[k] = v;
    }
  }

  return await run(function* () {
    const execution = yield* runDocument({
      docPath,
      stream: new InMemoryStream(),
      runtime: nodeRuntime(),
      componentDirs: [".internal/components"],
      freshness: false,
    });
    return yield* collect(execution);
  });
}
