/**
 * Entry point — execute (spec §7).
 *
 * Wires together the boundary scanner, component import, expansion engine,
 * modifier system, and journal infrastructure. `execute` is delivered
 * through the Execution Api so extensions can decorate the execution
 * lifecycle as middleware.
 *
 * Journal runtime integration is concentrated at execution boundaries.
 * See DEC-005 in specs/decisions.md.
 */

import { Err, Ok, scoped, spawn, withResolvers, until } from "effection";
import type { Operation, Result, Stream } from "effection";
import { type Api, createApi, type Operations } from "@effectionx/context-api";
import {
  durableRun,
  createDurableOperation,
  ephemeral,
  type DurableStream,
} from "@executablemd/durable-streams";
import { exec, readTextFile, stat, cwd } from "@executablemd/runtime";
import type { Workflow, Json } from "@executablemd/durable-streams";
import { createReplayStream } from "./replay-stream.ts";
import type {
  ComponentDefinition,
  FunctionComponent,
  FunctionComponentDefinition,
  JsonObject,
  PropsSchema,
  ReturnsSchema,
  ImportResult,
} from "./types.ts";
import { parseJsonObject } from "./json.ts";
import { compilePropsSchema, compileReturnsSchema, validateProps } from "./validate.ts";
import { isFunctionComponentPath, parseMarkdownDefinition } from "./definition.ts";
import { parseReturnsDeclaration } from "./frontmatter.ts";
import {
  expandSegments,
  expandBody,
  bodyHasOutput,
  isTopLevelReturn,
  resolveReturnValue,
  validateBodyStructure,
  createBlockCounter,
} from "./expand.ts";
import type { BlockCounter } from "./expand.ts";
import { DocumentationError } from "./errors.ts";
import { Component, importComponent } from "./component-api.ts";
import { renderSegment } from "./render.ts";
import { DocumentOutput } from "./api.ts";
import {
  composeModifierChain,
  buildCommand,
  createModifierRegistry,
  useCodeBlock,
} from "./modifiers.ts";
import type { ModifierFactory } from "./modifiers.ts";
import { evalFactory } from "./eval-handler.ts";
import { persistFactory } from "./modifiers/persist.ts";
import { timeoutFactory } from "./modifiers/timeout.ts";
import { daemonFactory } from "./modifiers/daemon.ts";
import type { EvalEnv } from "./types.ts";
import { useEvalScope } from "@effectionx/scope-eval";
import { Stdio } from "@effectionx/process";

export interface ExecuteOptions {
  /** Path to the root markdown document (workspace-relative). */
  path: string;

  /** Durable stream for journaling. */
  stream: DurableStream;

  /** JSON values supplied to the root document (default: `{}`). */
  props?: Record<string, Json>;

  /** Component search directories (default: ["./components", "./"]) */
  componentDirs?: string[];

  /** Custom modifier factories to register */
  modifiers?: Record<string, ModifierFactory>;
}

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
  if (isFunctionComponentPath(result.path)) {
    // Resolve to absolute path for dynamic import
    const currentDir = yield* ephemeral(cwd());
    const absolutePath = result.path.startsWith("/") ? result.path : `${currentDir}/${result.path}`;
    const mod = yield* ephemeral(until(import(`file://${absolutePath}`)));
    if (typeof mod !== "object" || mod === null) {
      throw new Error(`Function component "${name}" at ${result.path} did not load a module`);
    }

    const defaultExport = "default" in mod ? mod.default : undefined;
    if (!isFunctionComponent(defaultExport)) {
      throw new Error(
        `Function component "${name}" at ${result.path} must have a default export that is a generator function`,
      );
    }

    const propsExport = "props" in mod ? mod.props : undefined;
    const props: PropsSchema =
      propsExport === undefined
        ? { type: "object", properties: {}, additionalProperties: false }
        : parseJsonObject(propsExport);
    compilePropsSchema(props);

    const definition: FunctionComponentDefinition = {
      kind: "function",
      name,
      path: result.path,
      props,
      fn: defaultExport,
    };

    if ("returns" in mod && mod.returns !== undefined) {
      const returns = parseReturnsDeclaration(mod.returns);
      compileReturnsSchema(returns);
      definition.returns = returns;
    }

    return definition;
  }

  // Markdown component: parse at runtime — deterministic from content
  return parseMarkdownDefinition(name, result.path, result.content);
}

function isFunctionComponent(value: unknown): value is FunctionComponent {
  return typeof value === "function";
}

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
          cwd: yield* cwd(),
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

/**
 * What a document run produces. `output` is rendered body text — the
 * observability channel — and `value` is the document's return value: the same
 * rendered text for a text root, the validated JSON for a value root. The pair
 * is journaled together so replay restores both; only `value` is public.
 */
interface DocumentResult extends JsonObject {
  output: string;
  value: Json;
}

/**
 * Run a value root (spec §5.4). Its body executes completely under fail-fast,
 * so no diagnostic can pass for a result, while rendered text still reaches the
 * output stream as observability. `<Return>` selects the value at its position
 * and the body continues past it.
 */
function* runValueRoot(
  root: ComponentDefinition,
  returns: ReturnsSchema,
  validatedProps: Record<string, Json>,
  counter: BlockCounter,
): Operation<DocumentResult> {
  const chunks: string[] = [];
  let produced: { value: Json } | undefined;

  yield* scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *raise([error], _next) {
          throw new DocumentationError(error);
        },
      },
      { at: "min" },
    );

    for (const segment of root.bodySegments) {
      if (isTopLevelReturn(segment)) {
        produced = { value: yield* resolveReturnValue("__root__", returns, segment) };
        continue;
      }
      const expanded = yield* expandSegments(
        [segment],
        root.meta,
        validatedProps,
        new Set(),
        counter,
      );
      for (const resolved of expanded) {
        const text = renderSegment(resolved);
        if (text) {
          yield* ephemeral(DocumentOutput.operations.output(text));
          chunks.push(text);
        }
      }
    }
  });

  if (!produced) {
    throw new Error("The root document declares `returns` but produced no <Return> value.");
  }
  return { output: chunks.join(""), value: produced.value };
}

function* documentWorkflow(props: Record<string, Json>): Workflow<DocumentResult> {
  // Import root — same pipeline as any component. The provider middleware
  // installed by execute maps "__root__" to the document path. The
  // ephemeral() wrapper bridges typing only — the import inside remains a
  // durable, journaled operation.
  const root = yield* ephemeral(importComponent("__root__"));

  if (root.kind === "function") {
    throw new Error("Root document must be a markdown file, not a function component");
  }

  const validatedProps = validateProps("__root__", props, root.props);

  const rootEnv: EvalEnv = { values: { ...validatedProps } };

  // Per-root-segment emission loop (spec §9).
  // Mutable counter preserves deterministic blockIds across
  // per-segment expansion calls (see spec §6.1).
  const counter = createBlockCounter();

  // The root binding environment is installed as scope-local middleware
  // around the entire loop so all segments share it. Resources spawned by
  // `persist` blocks are retained in the eval scope until expansion
  // completes, then torn down.
  const scopedExpansion: Operation<DocumentResult> = scoped(function* () {
    yield* Component.around({ env: () => rootEnv }, { at: "min" });
    // Structural preflight (spec §6.9, §6.10): a structurally invalid root
    // executes no body side effects. A text root renders the aggregate
    // diagnostic as a comment (root policy is "collect"); a value root has no
    // rendered result to fall back on, so the diagnostic fails the execution.
    const structureError = validateBodyStructure(root.bodySegments, root.returns);
    if (structureError) {
      if (root.returns !== undefined) {
        throw new Error(structureError.message);
      }
      const text = renderSegment(structureError);
      yield* ephemeral(DocumentOutput.operations.output(text));
      return { output: text, value: text };
    }

    if (root.returns !== undefined) {
      return yield* runValueRoot(root, root.returns, validatedProps, counter);
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
        validatedProps,
        new Set(),
        counter,
        undefined,
      );
      const text = expanded.map(renderSegment).join("");
      // An empty buffered root emits no output event.
      if (text) {
        yield* ephemeral(DocumentOutput.operations.output(text));
      }
      return { output: text, value: text };
    }

    // Per-root-segment emission loop for roots without <Output> (spec §5.4).
    const chunks: string[] = [];

    for (const segment of root.bodySegments) {
      const expanded = yield* expandSegments(
        [segment],
        root.meta,
        validatedProps,
        new Set(),
        counter,
      );

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

    const text = chunks.join("");
    return { output: text, value: text };
  });

  return yield* ephemeral(scopedExpansion);
}

/**
 * A running document execution.
 *
 * `yield* execution` waits for completion and returns a `Result<Json>`:
 * `Ok(value)` on success, `Err(error)` on document, infrastructure, or
 * policy failure. Completion never throws once the handle exists. The
 * successful value is the document's return value — its rendered Markdown for
 * a text root, the validated JSON for a root declaring `returns` (§5.4).
 *
 * `execution.output` is a `Stream<string, string>` for consuming chunks as
 * they arrive. It carries rendered body text for both kinds of root — for a
 * value root it is observability, never the result. The close value is the
 * complete rendered output, or the partial output rendered before a failure.
 */
export interface DocumentExecution extends Operation<Result<Json>> {
  /** Stream of output chunks. Close value is the full (or partial) output. */
  output: Stream<string, string>;
}

/**
 * Execute a markdown document as a durable workflow.
 *
 * Returns a `DocumentExecution` — an operation you can `yield*` for the
 * completion `Result<Json>`, with a `.output` stream for chunk-by-chunk
 * consumption. Once the handle exists, completion never throws: every
 * later failure — document, infrastructure, or policy middleware — closes
 * `output` (with the complete or partial rendered text) and resolves
 * `Err(error)`.
 *
 * Simple — get the outcome:
 *
 * ```ts
 * const execution = yield* execute(options);
 * const result = yield* execution;
 * if (result.ok) {
 *   console.log(result.value);
 * }
 * ```
 *
 * Streaming — consume chunks as they arrive:
 *
 * ```ts
 * const execution = yield* execute(options);
 * const output = yield* forEach(function* (chunk) {
 *   process.stdout.write(chunk);
 * }, execution.output);
 * ```
 */
function* executeDocument(options: ExecuteOptions): Operation<DocumentExecution> {
  const {
    path: rootPath,
    stream,
    props = {},
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

  // Replay-safe transport: late subscribers receive every chunk and the
  // close value, so subscription readiness before first emission is never
  // required (spec §9; see replay-stream.ts).
  const channel = createReplayStream<string, string>();
  const { operation, resolve } = withResolvers<Result<Json>>();

  yield* spawn(function* () {
    let emitted = false;
    let emittedText = "";

    // The ENTIRE setup and workflow sit inside one error boundary: once the
    // handle exists, any failure closes output (with whatever rendered so
    // far) and resolves Err — completion never throws.
    try {
      // No compiler is installed here. Which one suits the host is the
      // entrypoint's decision, and installing one from inside this task would
      // shadow whatever the caller installed outside it. A document with no
      // eval blocks never reaches API.Env.compile at all.

      // DocumentOutput → channel bridge (innermost middleware — output flows
      // through caller-installed normalize/terminal middleware first, then here).
      yield* DocumentOutput.around({
        *output([text]) {
          emitted = true;
          emittedText += text;
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
      const rootEvalScope = yield* useEvalScope();

      // Install the document's runtime Component providers before durableRun
      // so the workflow inherits them: component import, modifier execution,
      // and the root eval scope.
      yield* Component.around(
        {
          *importComponent([name], _next) {
            return yield* durableImportComponent(
              name,
              name === "__root__" ? rootPath : undefined,
              componentDirs,
            );
          },
          *applyModifiers([modifiers, context], _next) {
            const chain = composeModifierChain(modifiers, context, registry);
            return yield* chain();
          },
          evalScope: () => rootEvalScope,
        },
        { at: "min" },
      );

      const { output, value } = yield* durableRun(() => documentWorkflow(props), {
        stream,
      });

      // Preserve output for any synchronous completion path that did not emit
      // through the streaming API — a replayed run restores its body text from
      // the journal instead of re-executing, and callback consumers only ever
      // see chunks, never the close value.
      if (!emitted && output) {
        yield* DocumentOutput.operations.output(output);
      }

      yield* channel.close(output);
      resolve(Ok(value));
    } catch (error) {
      // Close with everything already emitted — diagnostics produced before
      // an abort stay visible to consumers of the close value.
      yield* channel.close(emittedText);
      resolve(Err(error instanceof Error ? error : new Error(String(error))));
    }
  });

  return {
    *[Symbol.iterator]() {
      return yield* operation;
    },
    output: channel,
  };
}

/**
 * Execution Api — a test-agnostic middleware surface around document
 * execution. The default provider runs the document; extensions decorate the
 * execution lifecycle with `Execution.around({ execute })` — observing
 * options, wrapping the returned handle, or mapping its completion Result —
 * without introducing another execution function.
 */
export interface ExecutionApi {
  execute(options: ExecuteOptions): Operation<DocumentExecution>;
}

export const Execution: Api<ExecutionApi> = createApi<ExecutionApi>("Execution", {
  *execute(options: ExecuteOptions): Operation<DocumentExecution> {
    return yield* executeDocument(options);
  },
});

export const execute: Operations<ExecutionApi>["execute"] = Execution.operations.execute;
