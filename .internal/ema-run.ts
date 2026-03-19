/**
 * Reusable EMA document runner for OpenCode tools.
 *
 * Provides `emaRun` — an Effection Operation that runs an EMA document
 * and returns the output string. Handles:
 * - Compiler middleware (auto-detected by runDocument)
 * - AbortSignal bridging into Effection structured concurrency
 * - Environment variable injection
 *
 * Usage from an OpenCode tool:
 *
 * ```ts
 * import { run } from "effection";
 * import { emaRun } from "../.internal/ema-run.ts";
 *
 * const output = await run(() =>
 *   emaRun({
 *     docPath: ".internal/MyDoc.md",
 *     signal: context.abort,
 *   })
 * );
 * ```
 */

import { spawn, action } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { runDocument, collect } from "@executablemd/core";

export interface EmaRunOptions {
  /** Path to the EMA document to run. */
  docPath: string;

  /** Component search directories (default: [".internal/components"]). */
  componentDirs?: string[];

  /** Environment variables to inject before running. */
  env?: Record<string, string>;

  /** AbortSignal to bridge into Effection scope teardown. */
  signal?: AbortSignal;
}

/**
 * Bridge an AbortSignal into the current Effection scope.
 *
 * Spawns a child task that rejects when the signal fires,
 * tearing down the parent scope via structured concurrency.
 * The event listener is cleaned up when the scope exits.
 */
function* useSignal(signal: AbortSignal): Operation<void> {
  yield* spawn(function* () {
    yield* action<void>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return () => {};
      }
      const onAbort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      return () => signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Run an EMA document and return the output.
 *
 * This is an Effection Operation — call it inside `run()`:
 *
 * ```ts
 * const output = await run(() => emaRun({ docPath: "doc.md" }));
 * ```
 */
export function* emaRun(options: EmaRunOptions): Operation<string> {
  const { docPath, componentDirs = [".internal/components"], env, signal } = options;

  if (env) {
    for (const [k, v] of Object.entries(env)) {
      process.env[k] = v;
    }
  }

  if (signal) {
    yield* useSignal(signal);
  }

  const execution = yield* runDocument({
    docPath,
    stream: new InMemoryStream(),
    componentDirs,
    freshness: false,
  });

  return yield* collect(execution);
}
