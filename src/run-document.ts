/**
 * Entry point — runDocument (spec §7).
 *
 * Wires together the boundary scanner, component import, expansion engine,
 * modifier system, and durable execution infrastructure.
 *
 * This is the only module that imports from @effectionx/durable-streams
 * and @effectionx/durable-effects — all other modules are dependency-free.
 * See DEC-005 in specs/decisions.md.
 */

import { useScope, resource } from "effection";
import type { Operation } from "effection";
import {
  DurableRuntimeCtx,
  durableRun,
  createDurableOperation,
  ephemeral,
  type DurableStream,
  type DurableRuntime,
  ReplayGuard,
  StaleInputError,
} from "@effectionx/durable-streams";
import {
  computeSHA256,
} from "@effectionx/durable-effects";
import type { Workflow, Json } from "@effectionx/durable-streams";
import type {
  Segment,
  ComponentDefinition,
  ImportResult,
  Modifier,
  CodeBlockContext,
} from "./types.ts";
import { scanSegments } from "./scanner.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { expandSegments } from "./expand.ts";
import type { ExpansionContext } from "./expand.ts";
import { renderSegments } from "./render.ts";
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
import { createEvalContext, EvalCtxKey } from "./eval-context.ts";
import { EvalEnvCtx, EvalScopeCtx } from "./eval-env.ts";
import type { EvalEnv } from "./eval-env.ts";
import { useEvalScope } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";

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

  /** Runtime for I/O operations. */
  runtime: DurableRuntime;

  /** Component search directories (default: ["./components", "./"]) */
  componentDirs?: string[];

  /** Install file content guard (default: true) */
  freshness?: boolean;

  /** Custom modifier factories to register */
  modifiers?: Record<string, ModifierFactory>;

  /** Sample factory — if not provided, sample modifier will error */
  sampleHandler?: ModifierFactory;
}

// ---------------------------------------------------------------------------
// durableImportComponent (spec §4.3)
//
// This is a Workflow<ComponentDefinition> — it yields a single DurableEffect.
// The execute body inside createDurableOperation is an Operation<Json> —
// it uses yield* for Effection operations (runtime.readTextFile, computeSHA256).
// See DEC-001, DEC-004 in specs/decisions.md.
// ---------------------------------------------------------------------------

function* durableImportComponent(
  name: string,
  rootDocPath: string | undefined,
  searchPaths: string[],
  runtime: DurableRuntime,
): Workflow<ComponentDefinition> {
  // Single durable effect: resolve + read + hash
  const result = (yield createDurableOperation<Json>(
    { type: "import_component", name },
    function* (): Operation<Json> {
      // Resolve the path — runs inside Operation context
      let path: string;

      if (name === "__root__" && rootDocPath) {
        path = rootDocPath;
      } else {
        path = yield* resolveComponentPath(name, searchPaths, runtime);
      }

      // Read file and hash
      const content = yield* runtime.readTextFile(path);
      const contentHash = yield* computeSHA256(content);

      return { path, content, contentHash } as unknown as Json;
    },
  )) as unknown as ImportResult;

  // Parse at runtime — deterministic from content, not journaled
  const parsed = matter(result.content);
  const { meta, inputs } = parseFrontmatter(
    parsed.data as Record<string, unknown>,
  );
  const bodySegments = scanSegments(parsed.content);

  return {
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
  runtime: DurableRuntime,
): Operation<string> {
  const fileName = name.replace(/\./g, "/") + ".md";

  for (const dir of searchPaths) {
    // Try {dir}/{Name}.md
    const candidate = normalizePath(
      dir === "." ? fileName : `${dir}/${fileName}`,
    );
    const stat = yield* runtime.stat(candidate);
    if (stat.exists && stat.isFile) {
      return candidate;
    }

    // Try {dir}/{Name}/index.md
    const indexName = name.replace(/\./g, "/") + "/index.md";
    const indexCandidate = normalizePath(
      dir === "." ? indexName : `${dir}/${indexName}`,
    );
    const indexStat = yield* runtime.stat(indexCandidate);
    if (indexStat.exists && indexStat.isFile) {
      return indexCandidate;
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

function* useImportComponentGuard(
  runtime: DurableRuntime,
): Operation<void> {
  const scope = yield* useScope();
  const cache = new Map<string, string>();

  scope.around(ReplayGuard, {
    *check([event], next) {
      if (
        event.description["type"] === "import_component" &&
        event.result.status === "ok"
      ) {
        const result = event.result.value as unknown as ImportResult | undefined;
        const storedPath = result?.path;
        if (storedPath && !cache.has(storedPath)) {
          try {
            const content = yield* runtime.readTextFile(storedPath);
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

function createExecFactory(runtime: DurableRuntime): ModifierFactory {
  return (_params) => (_args, _next) => function* () {
    const context = yield* useCodeBlock();
    const command = buildCommand(context.language, context.content);
    const result = (yield createDurableOperation<Json>(
      {
        type: "exec",
        name: `exec:${context.content.slice(0, 40).replace(/\n/g, " ")}`,
        command: command as unknown as Json,
      },
      function* (): Operation<Json> {
        const execResult = yield* runtime.exec({
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
}

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
  runtime: DurableRuntime,
  modifierRegistry: ModifierRegistry,
): Workflow<string> {
  // Import root — same pipeline as any component
  const root = yield* durableImportComponent(
    "__root__",
    docPath,
    searchPaths,
    runtime,
  );

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
        runtime,
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

  // Expand all segments within the eval env context.
  // EvalScopeCtx is already set on the scope by runDocument.
  // EvalEnvCtx is scoped to the document expansion lifetime via
  // Context.with() (spec §3.1). Resources spawned by `persist` blocks
  // are retained in the eval scope until expansion completes, then
  // torn down.
  const scopedExpansion: Operation<Segment[]> = EvalEnvCtx.with(
    env,
    function* () {
      const expandGen = expandSegments(
        root.bodySegments,
        root.meta,
        {},
        new Set(),
        ctx,
      );
      return yield* expandGen;
    },
  );
  const expanded = yield* ephemeral(scopedExpansion);

  // Render to output string
  return renderSegments(expanded);
}

// ---------------------------------------------------------------------------
// runDocument (spec §7.1)
// ---------------------------------------------------------------------------

/**
 * Execute a markdown document as a durable workflow.
 */
export function* runDocument(options: RunDocumentOptions): Operation<string> {
  const {
    docPath,
    stream,
    runtime,
    componentDirs = ["components", "."],
    freshness = true,
    modifiers: customModifiers = {},
    sampleHandler,
  } = options;

  // Install runtime context
  const scope = yield* useScope();
  scope.set(DurableRuntimeCtx, runtime);

  // Install replay guards
  if (freshness) {
    yield* useImportComponentGuard(runtime);
  }

  // Create shared EvalContext (one VM context per document run — spec §5.1)
  const evalContext = createEvalContext();
  scope.set(EvalCtxKey, evalContext);

  // Create per-document eval scope (spec §3.1).
  // Must be created BEFORE durableRun so the channel processor task lives
  // in the outer Operation scope, not inside the durable execution scope.
  // evalScope.eval() from within durableEval sends to a channel whose
  // processor must be reachable by the Effection scheduler — this only
  // works when both sender and processor share an ancestor scope outside
  // the durable execution boundary.
  const evalScope: EvalScope = yield* resource<EvalScope>(function* (provide) {
    const es = yield* useEvalScope();
    yield* provide(es);
  });
  scope.set(EvalScopeCtx, evalScope);

  // Build modifier registry with built-in + custom handlers
  const registry = createModifierRegistry();
  registry.set("exec", createExecFactory(runtime));
  registry.set("silent", silentFactory);
  registry.set("eval", evalFactory);
  registry.set("persist", persistFactory);
  registry.set("timeout", timeoutFactory);
  registry.set("daemon", daemonFactory);
  if (sampleHandler) {
    registry.set("sample", sampleHandler);
  }
  for (const [name, handler] of Object.entries(customModifiers)) {
    registry.set(name, handler);
  }

  // Run the durable workflow
  return yield* durableRun(
    () => documentWorkflow(docPath, componentDirs, runtime, registry),
    { stream },
  );
}
