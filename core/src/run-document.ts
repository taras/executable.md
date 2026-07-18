/**
 * Entry point — runDocument (spec §7).
 *
 * Wires together the boundary scanner, component import, expansion engine,
 * modifier system, and journal infrastructure.
 *
 * Journal runtime integration is concentrated at execution boundaries.
 * See DEC-005 in specs/decisions.md.
 */

import { useScope, spawn, createChannel, withResolvers, until } from "effection";
import type { Operation, Stream } from "effection";
import {
  durableRun,
  createDurableOperation,
  ephemeral,
  type DurableStream,
} from "@executablemd/durable-streams";
import { exec, readTextFile, stat, cwd } from "@executablemd/runtime";
import type { Workflow, Json } from "@executablemd/durable-streams";
import { useDenoCompiler } from "./deno-compiler.ts";
import { useTempFileCompiler } from "./temp-file-compiler.ts";
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
import {
  expandSegments,
  expandBody,
  bodyHasOutput,
  validateOutputPlacement,
  createBlockCounter,
} from "./expand.ts";
import type { ExpansionContext } from "./expand.ts";
import { renderSegment } from "./render.ts";
import { DocumentOutput } from "./api.ts";
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
import { Stdio } from "@effectionx/process";

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

  /** Custom modifier factories to register */
  modifiers?: Record<string, ModifierFactory>;
}

// ---------------------------------------------------------------------------
// durableImportComponent (spec §4.3)
//
// This is a Workflow<ComponentDefinition | FunctionComponentDefinition> —
// it yields durable import effects and returns either markdown or function
// component definitions.
// See DEC-001, DEC-004 in specs/decisions.md.
// ---------------------------------------------------------------------------

function* durableImportComponent(
  name: string,
  rootDocPath: string | undefined,
  searchPaths: string[],
): Workflow<ComponentDefinition | FunctionComponentDefinition> {
  const result = (yield createDurableOperation<ImportResult>(
    { type: "import_component", name },
    function* (): Operation<ImportResult> {
      // Resolve the path — runs inside Operation context
      let path: string;

      if (name === "__root__" && rootDocPath) {
        path = rootDocPath;
      } else {
        path = yield* resolveComponentPath(name, searchPaths);
      }

      const content = yield* readTextFile(path);

      return { path, content };
    },
  )) as ImportResult;

  // Function component: .ts file — import() the module
  if (result.path.endsWith(".ts")) {
    // Resolve to absolute path for dynamic import
    const currentDir = yield* ephemeral(cwd());
    const absolutePath = result.path.startsWith("/") ? result.path : `${currentDir}/${result.path}`;
    const mod = (yield* ephemeral(until(import(`file://${absolutePath}`)))) as {
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
    };
  }

  // Markdown component: parse at runtime — deterministic from content
  const parsed = matter(result.content);
  const { meta, inputs } = parseFrontmatter(parsed.data as Record<string, unknown>);
  const bodySegments = scanSegments(parsed.content);

  return {
    kind: "markdown" as const,
    name,
    path: result.path,
    meta,
    inputs,
    bodySegments,
  };
}

// ---------------------------------------------------------------------------
// Component path resolution — runs inside Operation context (not Workflow)
// ---------------------------------------------------------------------------

function* resolveComponentPath(name: string, searchPaths: string[]): Operation<string> {
  const baseName = name.replace(/\./g, "/");

  for (const dir of searchPaths) {
    // Try {dir}/{Name}.md (backward compat — .md wins over .ts)
    const mdCandidate = normalizePath(dir === "." ? `${baseName}.md` : `${dir}/${baseName}.md`);
    const mdStat = yield* stat(mdCandidate);
    if (mdStat.exists && mdStat.isFile) {
      return mdCandidate;
    }

    // Try {dir}/{Name}.ts (function component)
    const tsCandidate = normalizePath(dir === "." ? `${baseName}.ts` : `${dir}/${baseName}.ts`);
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

  throw new Error(`Cannot resolve component: ${name} (searched: ${searchPaths.join(", ")})`);
}

/** Strip leading ./ from paths for workspace-relative normalization. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// Built-in modifier handlers (spec §3.3)
//
// Modifier handlers return Workflow<CodeBlockResult> since terminal
// handlers (exec) yield DurableEffects. See DEC-003 in specs/decisions.md.
// ---------------------------------------------------------------------------

const execFactory: ModifierFactory = (_params) => (_args, _next) =>
  (function* () {
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
  })();

const silentFactory: ModifierFactory = (_params) => (_args, next) =>
  (function* () {
    yield* next(); // inner chain runs — exec journals its result
    return { output: "", exitCode: 0, stderr: "" };
  })();

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
  const root = yield* durableImportComponent("__root__", docPath, searchPaths);

  if (root.kind === "function") {
    throw new Error("Root document must be a markdown file, not a function component");
  }

  const env: EvalEnv = { values: {} };

  // Build the expansion context
  const ctx: ExpansionContext = {
    importComponent: function* (name: string) {
      return yield* durableImportComponent(name, undefined, searchPaths);
    },
    runModifierChain: function* (modifiers: Modifier[], context: CodeBlockContext) {
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
  const scopedExpansion: Operation<string> = EvalEnvCtx.with(env, function* () {
    // Structural preflight (spec §6.9): a root with misplaced <Output>
    // executes no body side effects; the aggregate diagnostic renders as a
    // comment (root policy is "collect").
    const placementError = validateOutputPlacement(root.bodySegments);
    if (placementError) {
      const text = renderSegment(placementError);
      yield* ephemeral(DocumentOutput.operations.output(text));
      return text;
    }

    // A root declaring top-level <Output> buffers completely (spec §5.4):
    // execute the whole body, then emit the selected regions only after
    // successful completion. A documentation failure throws before any emit,
    // so no partial output is produced.
    if (bodyHasOutput(root.bodySegments)) {
      const expanded = yield* expandBody(
        root.bodySegments,
        [],
        root.meta,
        {},
        new Set(),
        ctx,
        counter,
        undefined,
      );
      const text = expanded.map(renderSegment).join("");
      // An empty buffered root emits no output event.
      if (text) {
        yield* ephemeral(DocumentOutput.operations.output(text));
      }
      return text;
    }

    // Per-root-segment emission loop for roots without <Output> (spec §5.4).
    const chunks: string[] = [];

    for (const segment of root.bodySegments) {
      const expanded = yield* expandSegments([segment], root.meta, {}, new Set(), ctx, counter);

      for (const resolved of expanded) {
        const text = renderSegment(resolved);
        if (text) {
          // Emit through the Document Output Api (spec §9).
          // ephemeral() bridges from Workflow (durable) to Operation
          // (non-durable) — output emission is a derived side effect,
          // not journaled.
          yield* ephemeral(DocumentOutput.operations.output(text));
          chunks.push(text);
        }
      }
    }

    return chunks.join("");
  });

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
 *   // workflow error
 * }
 * ```
 */
export function* runDocument(options: RunDocumentOptions): Operation<DocumentExecution> {
  const {
    docPath,
    stream,
    componentDirs = ["components", "."],
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
  // execution state: eval context/scope and the
  // DocumentOutput→channel bridge. Nothing leaks onto the caller's scope.
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

    // Install platform-appropriate compiler middleware
    // deno-lint-ignore no-explicit-any
    if (typeof (globalThis as any).Deno !== "undefined") {
      yield* useDenoCompiler();
    } else {
      yield* useTempFileCompiler();
    }

    // DocumentOutput → channel bridge (innermost middleware — output flows
    // through caller-installed normalize/terminal middleware first, then here).
    yield* DocumentOutput.around({
      *output([text]) {
        emitted = true;
        yield* channel.send(text);
      },
    });

    yield* Stdio.around({
      *stdout() {},
      *stderr() {},
    });

    // Create per-document eval scope (spec §3.1).
    // Created in the same scope as durableRun so that DurableCtx
    // (set by durableRun) is visible to eval code that calls
    // renderChildren → importComponent → createDurableOperation.
    scope.set(EvalScopeCtx, yield* useEvalScope());

    // Run the durable workflow.
    try {
      const output = yield* durableRun(() => documentWorkflow(docPath, componentDirs, registry), {
        stream,
      });

      // Preserve output for any synchronous completion path that did not emit
      // through the streaming API.
      if (!emitted && output) {
        yield* DocumentOutput.operations.output(output);
      }

      yield* channel.close(output);
      resolve(output);
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
