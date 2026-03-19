/**
 * Entry point — runDocument (spec §7).
 *
 * Wires together the boundary scanner, component import, expansion engine,
 * modifier system, and durable execution infrastructure.
 *
 * This is the only module that imports from @executablemd/durable-streams
 * and @executablemd/durable-effects — all other modules are dependency-free.
 * See DEC-005 in specs/decisions.md.
 */

import { useScope, spawn, createChannel, withResolvers } from "effection";
import type { Operation, Stream } from "effection";
import {
  durableRun,
  createDurableOperation,
  ephemeral,
  type DurableStream,
  ReplayGuard,
  StaleInputError,
} from "@executablemd/durable-streams";
import {
  computeSHA256,
} from "@executablemd/durable-effects";
import { exec, readTextFile, stat } from "@executablemd/runtime";
import type { Workflow, Json } from "@executablemd/durable-streams";
import { call } from "effection";
import process from "node:process";
import type {
  ComponentDefinition,
  FunctionComponent,
  FunctionComponentDefinition,
  InputDefinition,
  ImportResult,
  Modifier,
  CodeBlockContext,
} from "./types.ts";
import { scanSegments } from "./scanner.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { expandSegments, createBlockCounter } from "./expand.ts";
import type { ExpansionContext } from "./expand.ts";
import { renderSegment } from "./render.ts";
import { EMA } from "./api.ts";
import {
  composeModifierChain,
  buildCommand,
  createModifierRegistry,
  useCodeBlock,
} from "./modifiers.ts";
import type { ModifierFactory, ModifierRegistry } from "./modifiers.ts";
import { evalFactory } from "./eval-handler.ts";
import { persistFactory } from "./modifiers/persist.ts";
import { timeoutFactory } from "./modifiers/timeout.ts";
import { daemonFactory } from "./modifiers/daemon.ts";
import { EvalEnvCtx, EvalScopeCtx } from "./eval-env.ts";
import type { EvalEnv } from "./eval-env.ts";
import { useEvalScope } from "@effectionx/scope-eval";

// Re-export gray-matter — we use it for YAML frontmatter extraction
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// runDocument options (spec §7.1)
// ---------------------------------------------------------------------------

export interface RunDocumentOptions {
  /** Path to the root markdown document (workspace-relative). */
  docPath: string;

  /** Durable stream for journaling. */
  stream: DurableStream;

  /** Component search directories (default: ["./components", "./"]) */
  componentDirs?: string[];

  /** Install file content guard (default: true) */
  freshness?: boolean;

  /** Custom modifier factories to register */
  modifiers?: Record<string, ModifierFactory>;
}

// ---------------------------------------------------------------------------
// durableImportComponent (spec §4.3)
//
// This is a Workflow<ComponentDefinition | FunctionComponentDefinition> —
// it yields durable import effects and returns either markdown or function
// component definitions.
// The execute body inside createDurableOperation is an Operation<Json> —
// it uses yield* for Effection operations (runtime.readTextFile, computeSHA256).
// See DEC-001, DEC-004 in specs/decisions.md.
// ---------------------------------------------------------------------------

function* durableImportComponent(
  name: string,
  rootDocPath: string | undefined,
  searchPaths: string[],
): Workflow<ComponentDefinition | FunctionComponentDefinition> {
  // Single durable effect: resolve + read + hash
  const result = (yield createDurableOperation<Json>(
    { type: "import_component", name },
    function* (): Operation<Json> {
      // Resolve the path — runs inside Operation context
      let path: string;

      if (name === "__root__" && rootDocPath) {
        path = rootDocPath;
      } else {
        path = yield* resolveComponentPath(name, searchPaths);
      }

      // Read file and hash
      const content = yield* readTextFile(path);
      const contentHash = yield* computeSHA256(content);

      return { path, content, contentHash } as unknown as Json;
    },
  )) as unknown as ImportResult;

  // Function component: .ts file — import() the module
  if (result.path.endsWith(".ts")) {
    // Resolve to absolute path for dynamic import
    const absolutePath = result.path.startsWith("/")
      ? result.path
      : `${process.cwd()}/${result.path}`;
    const mod = (yield* ephemeral(call(() => import(`file://${absolutePath}`)))) as {
      default?: unknown;
      inputs?: unknown;
    };

    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new Error(
        `Function component "${name}" at ${result.path} must have a default export that is a generator function`,
      );
    }

    const typedFn = fn as FunctionComponent;

    const inputs = (mod.inputs ?? {}) as Record<string, InputDefinition>;

    return {
      kind: "function" as const,
      name,
      path: result.path,
      inputs,
      fn: typedFn,
      contentHash: result.contentHash,
    };
  }

  // Markdown component: parse at runtime — deterministic from content
  const parsed = matter(result.content);
  const { meta, inputs } = parseFrontmatter(
    parsed.data as Record<string, unknown>,
  );
  const bodySegments = scanSegments(parsed.content);

  return {
    kind: "markdown" as const,
    name,
    path: result.path,
    meta,
    inputs,
    bodySegments,
    contentHash: result.contentHash,
  };
}

// ---------------------------------------------------------------------------
// Component path resolution — runs inside Operation context (not Workflow)
// ---------------------------------------------------------------------------

function* resolveComponentPath(
  name: string,
  searchPaths: string[],
): Operation<string> {
  const baseName = name.replace(/\./g, "/");

  for (const dir of searchPaths) {
    // Try {dir}/{Name}.md (backward compat — .md wins over .ts)
    const mdCandidate = normalizePath(
      dir === "." ? `${baseName}.md` : `${dir}/${baseName}.md`,
    );
    const mdStat = yield* stat(mdCandidate);
    if (mdStat.exists && mdStat.isFile) {
      return mdCandidate;
    }

    // Try {dir}/{Name}.ts (function component)
    const tsCandidate = normalizePath(
      dir === "." ? `${baseName}.ts` : `${dir}/${baseName}.ts`,
    );
    const tsStat = yield* stat(tsCandidate);
    if (tsStat.exists && tsStat.isFile) {
      return tsCandidate;
    }

    // Try {dir}/{Name}/index.md
    const indexMdCandidate = normalizePath(
      dir === "." ? `${baseName}/index.md` : `${dir}/${baseName}/index.md`,
    );
    const indexMdStat = yield* stat(indexMdCandidate);
    if (indexMdStat.exists && indexMdStat.isFile) {
      return indexMdCandidate;
    }

    // Try {dir}/{Name}/index.ts
    const indexTsCandidate = normalizePath(
      dir === "." ? `${baseName}/index.ts` : `${dir}/${baseName}/index.ts`,
    );
    const indexTsStat = yield* stat(indexTsCandidate);
    if (indexTsStat.exists && indexTsStat.isFile) {
      return indexTsCandidate;
    }
  }

  throw new Error(
    `Cannot resolve component: ${name} (searched: ${searchPaths.join(", ")})`,
  );
}

/** Strip leading ./ from paths for workspace-relative normalization. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// useImportComponentGuard (spec §4.3, §6.1)
// ---------------------------------------------------------------------------

function* useImportComponentGuard(): Operation<void> {
  const cache = new Map<string, string>();

  yield* ReplayGuard.around({
    *check([event], next) {
      if (
        event.description["type"] === "import_component" &&
        event.result.status === "ok"
      ) {
        const result = event.result.value as unknown as ImportResult | undefined;
        const storedPath = result?.path;
        if (storedPath && !cache.has(storedPath)) {
          try {
            const content = yield* readTextFile(storedPath);
            const currentHash = yield* computeSHA256(content);
            cache.set(storedPath, currentHash);
          } catch {
            // File may not exist — leave uncached, decide will handle
          }
        }
      }
      yield* next(event);
    },
    decide([event], next) {
      if (
        event.description["type"] === "import_component" &&
        event.result.status === "ok"
      ) {
        const result = event.result.value as unknown as ImportResult | undefined;
        if (result) {
          const currentHash = cache.get(result.path);
          if (currentHash && currentHash !== result.contentHash) {
            return {
              outcome: "error" as const,
              error: new StaleInputError(
                `Component changed: ${event.description["name"]} at ${result.path}`,
              ),
            };
          }
        }
      }
      return next(event);
    },
  });
}

// ---------------------------------------------------------------------------
// Built-in modifier handlers (spec §3.3)
//
// Modifier handlers return Workflow<CodeBlockResult> since terminal
// handlers (exec) yield DurableEffects. See DEC-003 in specs/decisions.md.
// ---------------------------------------------------------------------------

const execFactory: ModifierFactory = (_params) =>
  (_args, _next) => function* () {
    const context = yield* useCodeBlock();
    const command = buildCommand(context.language, context.content);
    const result = (yield createDurableOperation<Json>(
      {
        type: "exec",
        name: `exec:${context.content.slice(0, 40).replace(/\n/g, " ")}`,
        command: command as unknown as Json,
      },
      function* (): Operation<Json> {
        const execResult = yield* exec({
          command,
          timeout: 30_000,
        });
        return execResult as unknown as Json;
      },
    )) as unknown as { exitCode: number; stdout: string; stderr: string };

    return {
      output: result.stdout,
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  }();

const silentFactory: ModifierFactory = (_params) =>
  (_args, next) => function* () {
    yield* next(); // inner chain runs — exec journals its result
    return { output: "", exitCode: 0, stderr: "" };
  }();

// ---------------------------------------------------------------------------
// Document workflow (spec §7.1)
//
// This is a Workflow<string> — it yields DurableEffects (via
// durableImportComponent, exec handler). Non-journaled work
// (interpolation, validation, parsing) runs as synchronous function
// calls inside the expansion engine. See DEC-002.
// ---------------------------------------------------------------------------

function* documentWorkflow(
  docPath: string,
  searchPaths: string[],
  modifierRegistry: ModifierRegistry,
): Workflow<string> {
  // Import root — same pipeline as any component
  const root = yield* durableImportComponent(
    "__root__",
    docPath,
    searchPaths,
  );

  if (root.kind === "function") {
    throw new Error(
      "Root document must be a markdown file, not a function component",
    );
  }

  // Create per-document binding environment (spec §3.2).
  // The EvalScope was already created in runDocument (before durableRun)
  // and set on the scope via EvalScopeCtx — it's inherited by all child
  // scopes including durableEval bodies.
  const env: EvalEnv = { values: {} };

  // Build the expansion context
  const ctx: ExpansionContext = {
    importComponent: function* (name: string) {
      return yield* durableImportComponent(
        name,
        undefined,
        searchPaths,
      );
    },
    runModifierChain: function* (
      modifiers: Modifier[],
      context: CodeBlockContext,
    ) {
      const chain = composeModifierChain(modifiers, context, modifierRegistry);
      return yield* chain();
    },
  };

  // Per-root-segment emission loop (spec §9).
  // Mutable counter preserves deterministic blockIds across
  // per-segment expansion calls (see spec §6.1).
  const counter = createBlockCounter();

  // EvalScopeCtx is already set on the scope by runDocument.
  // EvalEnvCtx is scoped to the document expansion lifetime via
  // Context.with() (spec §3.1). Resources spawned by `persist` blocks
  // are retained in the eval scope until expansion completes, then
  // torn down.
  //
  // The EvalEnvCtx.with() wraps the entire loop so all segments share
  // the same binding environment.
  const scopedExpansion: Operation<string> = EvalEnvCtx.with(
    env,
    function* () {
      const chunks: string[] = [];

      for (const segment of root.bodySegments) {
        const expanded = yield* expandSegments(
          [segment],
          root.meta,
          {},
          new Set(),
          ctx,
          counter,
        );

        for (const resolved of expanded) {
          const text = renderSegment(resolved);
          if (text) {
            // Emit through the EMA Output Api (spec §9).
            // ephemeral() bridges from Workflow (durable) to Operation
            // (non-durable) — output emission is a derived side effect,
            // not journaled.
            yield* ephemeral(EMA.operations.output(text));
            chunks.push(text);
          }
        }
      }

      return chunks.join("");
    },
  );

  return yield* ephemeral(scopedExpansion);
}

// ---------------------------------------------------------------------------
// runDocument (spec §7.1)
// ---------------------------------------------------------------------------

/**
 * A running document execution.
 *
 * `yield* execution` waits for the workflow to complete and returns
 * the full output string (or throws on error).
 *
 * `execution.output` is a `Stream<string, string>` for consuming
 * chunks as they arrive. The close value is the full output.
 */
export interface DocumentExecution extends Operation<string> {
  /** Stream of output chunks. Close value is the full output. */
  output: Stream<string, string>;
}

/**
 * Execute a markdown document as a durable workflow.
 *
 * Returns a `DocumentExecution` — an operation you can `yield*` to
 * get the full output, with a `.output` stream for chunk-by-chunk
 * consumption.
 *
 * Simple — just get the output:
 *
 * ```ts
 * const execution = yield* runDocument(options);
 * const output = yield* execution;
 * ```
 *
 * Streaming — consume chunks as they arrive:
 *
 * ```ts
 * const execution = yield* runDocument(options);
 * const output = yield* forEach(function* (chunk) {
 *   process.stdout.write(chunk);
 * }, execution.output);
 * ```
 *
 * Error handling:
 *
 * ```ts
 * const execution = yield* runDocument(options);
 * try {
 *   const output = yield* execution;
 * } catch (e) {
 *   // workflow error (e.g., StaleInputError)
 * }
 * ```
 */
export function* runDocument(options: RunDocumentOptions): Operation<DocumentExecution> {
  const {
    docPath,
    stream,
    componentDirs = ["components", "."],
    freshness = true,
    modifiers: customModifiers = {},
  } = options;

  // Build modifier registry — pure data, no scope side effects.
  const registry = createModifierRegistry();
  registry.set("exec", execFactory);
  registry.set("silent", silentFactory);
  registry.set("eval", evalFactory);
  registry.set("persist", persistFactory);
  registry.set("timeout", timeoutFactory);
  registry.set("daemon", daemonFactory);
  for (const [name, handler] of Object.entries(customModifiers)) {
    registry.set(name, handler);
  }

  // ---------------------------------------------------------------------------
  // Document execution.
  //
  // The workflow runs in a spawned child scope that contains all
  // execution state: replay guards, eval context/scope, and the
  // EMA→channel bridge. Nothing leaks onto the caller's scope.
  //
  // withResolvers captures the completion result so `yield* execution`
  // can wait for it without needing to await the spawned Task directly
  // (which would propagate errors through scope teardown).
  // ---------------------------------------------------------------------------

  const channel = createChannel<string, string>();
  const { operation, resolve, reject } = withResolvers<string>();

  yield* spawn(function* () {
    const scope = yield* useScope();
    let emitted = false;

    // Install replay guards
    if (freshness) {
      yield* useImportComponentGuard();
    }

    // EMA → channel bridge (innermost middleware — output flows through
    // caller-installed normalize/terminal middleware first, then here).
    yield* EMA.around({
      *output([text]) {
        emitted = true;
        yield* channel.send(text);
      },
    });

    // Create per-document eval scope (spec §3.1).
    // Created in the same scope as durableRun so that DurableCtx
    // (set by durableRun) is visible to eval code that calls
    // renderChildren → importComponent → createDurableOperation.
    scope.set(EvalScopeCtx, yield* useEvalScope());

    // Run the durable workflow.
    try {
      const storedOutput = yield* durableRun(
        () => documentWorkflow(docPath, componentDirs, registry),
        { stream },
      );

      // On replay, durableRun short-circuits and the workflow body never
      // runs — no output() calls are made. Emit the stored result through
      // the full Output Api pipeline (normalize, terminal format, channel)
      // so replay output is consistent with fresh runs.
      if (!emitted && storedOutput) {
        yield* EMA.operations.output(storedOutput);
      }

      yield* channel.close(storedOutput);
      resolve(storedOutput);
    } catch (error) {
      yield* channel.close("");
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    *[Symbol.iterator]() {
      return yield* operation;
    },
    output: channel,
  };
}
