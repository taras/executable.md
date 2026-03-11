/**
 * VM context management for generator eval blocks (spec §5).
 *
 * Provides a shared vm.Context per document run and a block compiler
 * that produces generator functions from transformed source code.
 */

import { createContext as createEffectionContext } from "effection";
import {
  sleep, spawn, call, resource, useScope,
  createChannel, each, suspend, createSignal,
} from "effection";
import { when } from "@effectionx/converge";
import { fetch } from "@effectionx/fetch";
import { findFreePort } from "./find-free-port.ts";
import { Sample } from "./sample-api.ts";
import { callLlamafile } from "./sample/llamafile.ts";
import { createContext as vmCreateContext, runInContext } from "node:vm";

// ---------------------------------------------------------------------------
// EvalContext — shared VM context (spec §5.1)
// ---------------------------------------------------------------------------

/**
 * Holds the shared vm.Context for all eval blocks in a document run.
 *
 * Created once per document run (context creation is expensive ~7–21ms).
 * Handlers access it via `ephemeral(EvalCtxKey.expect())`.
 */
export interface EvalContext {
  vmContext: object;
}

/**
 * Effection context key for the shared VM context.
 */
export const EvalCtxKey = createEffectionContext<EvalContext>("evalContext");

/**
 * Create a shared VM context with Effection APIs and standard globals.
 *
 * The sandbox exposes Effection operations (sleep, spawn, call, resource,
 * useScope) and standard globals (console) so eval blocks can use them
 * without explicit imports.
 */
export function createEvalContext(
  globals: Record<string, unknown> = {},
): EvalContext {
  const sandbox = {
    // Effection APIs available in blocks without import
    sleep,
    spawn,
    call,
    resource,
    useScope,
    createChannel,
    each,
    suspend,
    createSignal,
    // Convergence — poll and wait for conditions to be met
    when,
    // Port allocation — find available TCP port
    findFreePort,
    // HTTP — Effection-compatible fetch
    fetch,
    // Sample Api — middleware for LLM inference routing
    Sample,
    // Llamafile — HTTP utility for local LLM inference
    callLlamafile,
    // Standard globals
    console,
    // Host-provided extras
    ...globals,
  };
  return { vmContext: vmCreateContext(sandbox) };
}

// ---------------------------------------------------------------------------
// Block compiler (spec §5.2)
// ---------------------------------------------------------------------------

/**
 * Compile transformed source code into a generator function.
 *
 * The source code is the transformed body (from eval-transform.ts),
 * which is wrapped in a `(function*(env) { ... })` IIFE. The result
 * is a generator function that accepts an `env` record and yields
 * Effection operations.
 *
 * @param transformedBodyCode - The transformed block body (without the generator wrapper)
 * @param vmContext - The shared vm.Context for this document run
 * @returns A generator function that accepts env and yields operations
 */
export function compileBlock(
  transformedBodyCode: string,
  vmContext: object,
): (env: Record<string, unknown>) => Generator<unknown, void, unknown> {
  // The trailing newline before `})` is critical — the transformed code
  // ends with a //# sourceURL comment, and without the newline the
  // closing `})` would be swallowed by the comment.
  const result = runInContext(
    `(function*(env) {\n${transformedBodyCode}\n})`,
    vmContext,
  );

  // Runtime shape check — vm.runInContext returns any
  if (typeof result !== "function") {
    throw new Error(
      `compileBlock: expected generator function, got ${typeof result}`,
    );
  }

  return result as (
    env: Record<string, unknown>,
  ) => Generator<unknown, void, unknown>;
}
