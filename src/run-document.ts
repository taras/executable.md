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

import { useScope } from "effection";
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
import type { Workflow, Json, DurableEffect } from "@effectionx/durable-streams";
import type {
  Segment,
  ComponentDefinition,
  ImportResult,
  Modifier,
  CodeBlockContext,
  CodeBlockResult,
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
} from "./modifiers.ts";
import type { ModifierHandler, ModifierRegistry } from "./modifiers.ts";

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

  /** Custom modifier handlers to register */
  modifiers?: Record<string, ModifierHandler>;

  /** Sample handler — if not provided, sample modifier will error */
  sampleHandler?: ModifierHandler;
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

function createExecHandler(runtime: DurableRuntime): ModifierHandler {
  return function* execHandler(context, _params, _next) {
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
  };
}

const silentHandler: ModifierHandler = function* (_context, _params, next) {
  yield* next(); // inner chain runs — exec journals its result
  return { output: "", exitCode: 0, stderr: "" };
};

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

  // Expand all segments — this generator yields durable effects
  // through the import and modifier chain functions. The cast is
  // safe because expandSegments only forwards DurableEffect yields
  // from durableImportComponent and the modifier chain. The expansion
  // engine itself does not yield any non-durable values.
  const expandGen = expandSegments(
    root.bodySegments,
    root.meta,
    {},
    new Set(),
    ctx,
  );
  const expanded: Segment[] = yield* (expandGen as unknown as Workflow<Segment[]>);

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

  // Install replay guard
  if (freshness) {
    yield* useImportComponentGuard(runtime);
  }

  // Build modifier registry with built-in + custom handlers
  const registry = createModifierRegistry();
  registry.set("exec", createExecHandler(runtime));
  registry.set("silent", silentHandler);
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
