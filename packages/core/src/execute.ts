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
import { exec, readTextFile, cwd } from "@executablemd/runtime";
import { cwd as processCwd } from "@effectionx/fs";
import type { Workflow, Json } from "@executablemd/durable-streams";
import { createReplayStream } from "./replay-stream.ts";
import { createContext } from "effection";
import type { Context } from "effection";
import type {
  ComponentDefinition,
  ComponentRegistry,
  FunctionComponent,
  FunctionComponentDefinition,
  JsonObject,
  PropsSchema,
  ReturnsSchema,
  Segment,
} from "./types.ts";
import { parseJson, parseJsonObject } from "./json.ts";
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
import { DocumentationError, documentationFailure, durabilityFailure } from "./errors.ts";
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
import {
  DEFAULT_COMPONENT_DIRS,
  effectiveRegistry,
  selectComponent,
  unresolvedMessage,
} from "./components/select.ts";
import type { EvalEnv } from "./types.ts";
import { readRootSource, rootSourcePath } from "./root-source.ts";
import type { RootDocumentSource } from "./root-source.ts";
import { useEvalScope } from "@effectionx/scope-eval";
import { Stdio } from "@effectionx/process";

export interface ExecuteSettings {
  /** Durable stream for journaling. */
  stream: DurableStream;

  /** JSON values supplied to the root document (default: `{}`). */
  props?: Record<string, Json>;

  /** Component search directories (default: ["./components", "./"]) */
  componentDirs?: string[];

  /** Custom modifier factories to register */
  modifiers?: Record<string, ModifierFactory>;
}

/**
 * What to execute and how: the root document — a path, or text supplied with
 * its `<eval>` identity — together with the run's settings.
 */
export type ExecuteOptions = RootDocumentSource & ExecuteSettings;

/**
 * What resolving a name decided, in a form the journal can hold.
 *
 * Selection is an observation of the environment — which files exist, what is
 * registered — so it belongs inside the durable operation with the read it
 * leads to. A registration is recorded by origin rather than by value: a
 * function cannot be serialized, so replay restores the origin and looks the
 * implementation up again in the scope that is running now.
 */
type DurableSelection =
  | { kind: "repository"; path: string; content: string }
  | { kind: "registered"; origin: string; reserved: boolean };

function* durableImportComponent(
  name: string,
  root: RootDocumentSource | undefined,
  searchPaths: string[],
  registry: ComponentRegistry,
): Workflow<ComponentDefinition | FunctionComponentDefinition> {
  const selection = (yield createDurableOperation<DurableSelection>(
    { type: "import_component", name },
    function* (): Operation<DurableSelection> {
      if (name === "__root__" && root) {
        // Inside the durable operation, so the journal holds the root's identity
        // and its text: a replay restores both without reading anything, whether
        // the source was a file or supplied.
        return {
          kind: "repository",
          path: rootSourcePath(root),
          content: yield* readRootSource(root),
        };
      }

      const selected = yield* selectComponent(name, { componentDirs: searchPaths, registry });

      switch (selected.kind) {
        case "repository":
          return {
            kind: "repository",
            path: selected.path,
            content: yield* readTextFile(selected.path),
          };
        case "registered":
          return {
            kind: "registered",
            origin: selected.origin.kind === "registered" ? selected.origin.origin : "",
            reserved: selected.origin.kind === "registered" && selected.origin.reserved,
          };
        case "structural":
          throw new Error(
            `${name} is structural syntax the engine owns, so it never resolves a component`,
          );
        case "unresolved":
          throw new Error(unresolvedMessage(name, selected.searched));
      }
    },
  )) as DurableSelection;

  if (selection.kind === "registered") {
    // The function was never journaled. Find the implementation the recorded
    // origin names in the registry this run has; refusing when it is gone is
    // what keeps a replay from quietly invoking somebody else's component.
    const entry = effectiveRegistry(registry).get(name);
    const found = selection.reserved ? entry?.reserved : entry?.default;
    if (!found || found.origin !== selection.origin) {
      const kind = selection.reserved ? "reserved registration" : "registration";
      throw new Error(
        `Component ${name} was recorded as the ${kind} "${selection.origin}", which is not ` +
          `registered in this run${found ? ` — "${found.origin}" is registered instead` : ""}.`,
      );
    }
    return found.definition;
  }

  const { path, content } = selection;

  // Function component: .ts file — import() the module
  if (isFunctionComponentPath(path)) {
    // Against the process's directory, not the contextual `Env.cwd`: the search
    // that chose this path stats there too, so a component that rebinds `cwd`
    // for its content — `<TempDir>` — does not change which components that
    // content can resolve, or leave a selected path unloadable.
    const currentDir = yield* ephemeral(processCwd());
    const absolutePath = path.startsWith("/") ? path : `${currentDir}/${path}`;
    const mod = yield* ephemeral(until(import(`file://${absolutePath}`)));
    if (typeof mod !== "object" || mod === null) {
      throw new Error(`Function component "${name}" at ${path} did not load a module`);
    }

    const defaultExport = "default" in mod ? mod.default : undefined;
    if (!isFunctionComponent(defaultExport)) {
      throw new Error(
        `Function component "${name}" at ${path} must have a default export that is a generator function`,
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
  return parseMarkdownDefinition(name, path, content);
}

function isFunctionComponent(value: unknown): value is FunctionComponent {
  return typeof value === "function";
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

// `silent` suppresses output; it does not convert failure into success (#307).
// The outcome it hands back is the inner chain's, so a silenced command that
// failed is still a failure — carrying the exit code and the stderr that say
// so, with only the channel the author asked to hide removed.
const silentFactory: ModifierFactory = (_params) => (_args, next) =>
  (function* () {
    const result = yield* next(); // inner chain runs — exec journals its result
    return { ...result, output: "" };
  })();

/**
 * What a document run produces. `output` is rendered body text — the
 * observability channel — and a completed run adds its return value: the same
 * rendered text for a text root, the validated JSON for a value root. The pair
 * is journaled together so replay restores both; only `value` is public.
 */
type DocumentResult = DocumentSuccess | DocumentFailureResult;

type DocumentSuccess = {
  status: "ok";
  output: string;
  value: Json;
};

/**
 * A document that decided it failed. This is an outcome, not an accident: the
 * run is over, what it rendered first is part of the record, and the journal
 * closes `ok` around it so a replay restores both without re-executing
 * anything. A durability failure is the opposite case and never arrives here
 * (§6.11) — it says the journal no longer describes this run, so recording it
 * as the run's own result would write onto a journal already known to be wrong.
 */
type DocumentFailureResult = {
  status: "err";
  output: string;
  error: DocumentFailure;
};

/**
 * What crosses the journal about a failure. Everything here is JSON: object
 * identity, stacks, and the cause graph stay behind, which is why the live path
 * resolves the original error instead of this description (`LiveFailure`).
 *
 * A field is absent when the failure had nothing to say there, and present when
 * it did. The distinction is load-bearing for `cause`: an absent key says the
 * failure had no own cause, while `"undefined"` says it had one whose value was
 * `undefined` — a component may throw exactly that.
 */
type DocumentFailure = {
  name: string;
  message: string;
  segment: { message: string; source?: string };
  cause?: string;
  errors?: { name: string; message: string }[];
};

/**
 * Where one execution leaves the failure it caught, for its own completion.
 *
 * The handoff is short and entirely inside a run: the workflow's catch fills
 * this, and the completion takes it. A live run therefore reports the failure it
 * actually caught — same object, same type, same `cause`, same aggregate
 * members — while a replayed run never enters the workflow, leaves the slot
 * empty, and reports the account the journal kept. The empty slot is the signal;
 * nothing asks whether it is replaying.
 *
 * The slot belongs to the run's scope, so it is gone when the run is.
 */
interface LiveFailureSlot {
  failure?: unknown;
}

const LiveFailure: Context<LiveFailureSlot | undefined> = createContext<
  LiveFailureSlot | undefined
>("execution.liveFailure", undefined);

function* rememberLiveFailure(error: unknown): Operation<void> {
  const slot = yield* LiveFailure.get();
  if (slot) {
    slot.failure = error;
  }
}

/** The live failure this run recorded, taken so it answers exactly once. */
function* takeLiveFailure(slot: LiveFailureSlot): Operation<unknown> {
  const live = slot.failure;
  slot.failure = undefined;
  return live;
}

function describeFailure(caught: unknown, documentation: DocumentationError): DocumentFailure {
  const wrapper = caught instanceof Error ? caught : new Error(String(caught));
  return {
    name: wrapper.name,
    message: wrapper.message,
    segment: {
      message: documentation.segment.message,
      ...(documentation.segment.source === undefined
        ? {}
        : { source: documentation.segment.source }),
    },
    // An own property, not an inherited one: every Error inherits `cause` from
    // nowhere useful, and what this records is what this failure was given.
    ...(Object.hasOwn(wrapper, "cause") ? { cause: describeCause(wrapper.cause) } : {}),
    ...(wrapper instanceof AggregateError
      ? {
          errors: wrapper.errors.map((member: unknown) => ({
            name: member instanceof Error ? member.name : "Error",
            message: member instanceof Error ? member.message : String(member),
          })),
        }
      : {}),
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The error a completion reports for a failed document: the original one on a
 * live run, and otherwise the documented reconstruction of it.
 */
function failureError(failure: DocumentFailure, live: unknown): unknown {
  if (live !== undefined) {
    return live;
  }
  const members = failure.errors;
  const replayed = members
    ? new AggregateError(
        members.map((member) => withName(new Error(member.message), member.name)),
        failure.message,
      )
    : new Error(failure.message);
  if (failure.cause !== undefined) {
    replayed.cause = failure.cause;
  }
  return withName(replayed, failure.name);
}

function withName(error: Error, name: string): Error {
  error.name = name;
  return error;
}

/**
 * Narrow what the journal or the workflow handed back, field by field.
 *
 * The result is parsed rather than trusted: a journal is data, and a replayed
 * run must fail on a shape it cannot read instead of carrying it further. The
 * live failure is looked up from the value `durableRun` returned, before this
 * runs, so parsing is free to build its own object.
 */
function parseDocumentResult(value: unknown): DocumentResult {
  const candidate = parseJsonObject(value);
  const output = candidate["output"];
  if (typeof output !== "string") {
    throw new Error("A document result must carry its rendered output as a string.");
  }
  const status = candidate["status"];
  if (status === "ok") {
    return { status: "ok", output, value: parseJson(candidate["value"]) };
  }
  if (status === "err") {
    return { status: "err", output, error: parseFailure(candidate["error"]) };
  }
  throw new Error(
    `A document result records its outcome as "ok" or "err", and this one records ` +
      `${JSON.stringify(status)}. A journal written before the outcome contract ` +
      `(#318) has no status at all and cannot be replayed by this version.`,
  );
}

function parseFailure(value: unknown): DocumentFailure {
  const candidate = parseJsonObject(value);
  const name = candidate["name"];
  const message = candidate["message"];
  if (typeof name !== "string" || typeof message !== "string") {
    throw new Error("A failure description carries a name and a message.");
  }
  const segment = parseJsonObject(candidate["segment"]);
  const segmentMessage = segment["message"];
  if (typeof segmentMessage !== "string") {
    throw new Error("A failure description carries the message of the segment that failed.");
  }
  // An optional field is absent or well-formed. Anything else is a journal this
  // run cannot read, and coercing it to "absent" would report a failure that
  // quietly disagrees with the one recorded.
  const source = optionalString(segment, "source", "The source of a failed segment");
  const cause = optionalString(candidate, "cause", "The cause of a failure");
  const errors = candidate["errors"];
  if (errors !== undefined && !Array.isArray(errors)) {
    throw new Error("The aggregate members of a failure are a list.");
  }
  return {
    name,
    message,
    segment: { message: segmentMessage, ...(source === undefined ? {} : { source }) },
    ...(cause === undefined ? {} : { cause }),
    ...(errors === undefined ? {} : { errors: errors.map(parseFailureMember) }),
  };
}

function optionalString(holder: JsonObject, key: string, subject: string): string | undefined {
  const value = holder[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${subject} is text when it is recorded at all.`);
  }
  return value;
}

function parseFailureMember(value: Json): { name: string; message: string } {
  const member = parseJsonObject(value);
  const name = member["name"];
  const message = member["message"];
  if (typeof name !== "string" || typeof message !== "string") {
    throw new Error("An aggregate member carries a name and a message.");
  }
  return { name, message };
}

/**
 * Run a value root (spec §5.4). Its body executes completely under fail-fast,
 * so no printed error can pass for a result, while rendered text still reaches the
 * output stream as observability. `<Return>` selects the value at its position
 * and the body continues past it.
 */
function* runValueRoot(
  root: ComponentDefinition,
  returns: ReturnsSchema,
  validatedProps: Record<string, Json>,
  counter: BlockCounter,
  /** What this root emitted, held by the caller so a failure still finds it. */
  chunks: string[],
): Operation<DocumentResult> {
  let produced: { value: Json } | undefined;

  yield* scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *raise([error], _next) {
          throw new DocumentationError(error, "throw");
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
  return { status: "ok", output: chunks.join(""), value: produced.value };
}

function* documentWorkflow(props: Record<string, Json>): Workflow<DocumentResult> {
  // Import root — same pipeline as any component. The provider middleware
  // installed by execute maps "__root__" to the run's root document source.
  // The ephemeral() wrapper bridges typing only — the import inside remains a
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

  // What the document rendered before it stopped, held outside the expansion
  // scope so a failure still leaves it here (§6.9 Partial output). The buffered
  // root fills `selected`; every streaming root has already emitted `streamed`.
  const selected: Segment[] = [];
  const streamed: string[] = [];
  const produced: Segment[] = [];
  let emittedThrough = 0;

  // The root binding environment is installed as scope-local middleware
  // around the entire loop so all segments share it. Resources spawned by
  // `persist` blocks are retained in the eval scope until expansion
  // completes, then torn down.
  const scopedExpansion: Operation<DocumentResult> = scoped(function* () {
    yield* Component.around({ env: () => rootEnv }, { at: "min" });
    // Structural preflight (spec §6.9, §6.10): a structurally invalid root
    // executes no body side effects. A text root renders the aggregate
    // printed error as a comment (root error mode is "print"); a value root has no
    // rendered result to fall back on, so the printed error fails the execution.
    const structureError = validateBodyStructure(root.bodySegments, root.returns);
    if (structureError) {
      if (root.returns !== undefined) {
        throw new Error(structureError.message);
      }
      const text = renderSegment(structureError);
      yield* ephemeral(DocumentOutput.operations.output(text));
      streamed.push(text);
      return { status: "ok", output: text, value: text };
    }

    if (root.returns !== undefined) {
      return yield* runValueRoot(root, root.returns, validatedProps, counter, streamed);
    }

    // A root declaring top-level <Output> buffers completely (spec §5.4):
    // execute the whole body, then emit the selected regions once. The owner is
    // allocated outside this expansion so that a failure partway still leaves
    // this frame holding what the regions rendered before it.
    if (bodyHasOutput(root.bodySegments)) {
      yield* expandBody(
        root.bodySegments,
        [],
        root.meta,
        validatedProps,
        new Set(),
        counter,
        undefined,
        undefined,
        selected,
      );
      const text = selected.map(renderSegment).join("");
      // An empty buffered root emits no output event.
      if (text) {
        yield* ephemeral(DocumentOutput.operations.output(text));
      }
      return { status: "ok", output: text, value: text };
    }

    // Per-root-segment emission loop for roots without <Output> (spec §5.4).
    // The loop owns the segments, so a component whose own region fails partway
    // has still handed over what it rendered — the root emits that before the
    // failure is reported, exactly as a buffered root does.
    for (const segment of root.bodySegments) {
      yield* expandSegments([segment], root.meta, validatedProps, new Set(), counter, produced);

      while (emittedThrough < produced.length) {
        const resolved = produced[emittedThrough];
        emittedThrough += 1;
        const text = resolved === undefined ? "" : renderSegment(resolved);
        if (text) {
          // Emit through the Document Output Api (spec §9).
          // ephemeral() bridges from Workflow (durable) to Operation
          // (non-durable) — output emission is a derived side effect,
          // not journaled.
          yield* ephemeral(DocumentOutput.operations.output(text));
          streamed.push(text);
        }
      }
    }

    const text = streamed.join("");
    return { status: "ok", output: text, value: text };
  });

  // The catch is outside the `yield*`, not inside the scope: the expansion's
  // teardown — the invocation being dismantled, retained work, and whatever
  // aggregate the platform builds from a body failure and a teardown failure
  // together — finishes as this returns. Describing the failure any earlier
  // would describe an error whose account of itself is not complete yet.
  try {
    return yield* ephemeral(scopedExpansion);
  } catch (error) {
    // What the failing segment handed over but never reached the emission step.
    // Emitted here whatever the failure turns out to be: a consumer reading
    // chunks is who the preservation is for, and the completion path only emits
    // for a run that streamed nothing at all — which stops being true as soon
    // as an earlier segment went out.
    const tail = produced.slice(emittedThrough).map(renderSegment).join("");
    if (tail) {
      yield* ephemeral(DocumentOutput.operations.output(tail));
    }
    // A durability failure is not something the document did, so it never
    // becomes the document's own outcome (§6.11).
    if (durabilityFailure(error) !== undefined) {
      throw error;
    }
    const documentation = documentationFailure(error);
    if (documentation === undefined) {
      throw error;
    }
    // Everything the document rendered: the buffered selection, or what the
    // streaming loop emitted together with that tail.
    const rendered =
      selected.length > 0 ? selected.map(renderSegment).join("") : streamed.join("") + tail;
    yield* ephemeral(rememberLiveFailure(error));
    return { status: "err", output: rendered, error: describeFailure(error, documentation) };
  }
}

/**
 * A running document execution.
 *
 * `yield* execution` waits for completion and returns a `Result<Json>`:
 * `Ok(value)` on success, `Err(error)` on document, infrastructure, or
 * middleware failure. Completion never throws once the handle exists. The
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
 * later failure — document, infrastructure, or middleware — closes
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
    stream,
    props = {},
    componentDirs = [...DEFAULT_COMPONENT_DIRS],
    modifiers: customModifiers = {},
  } = options;

  // Carried through exactly as supplied. Rewriting an identity here would let
  // the same value inspect and execute under different ones.
  const root: RootDocumentSource = options;

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

      // The slot this run's completion reads its failure from. Created here and
      // reclaimed with this task, so nothing a run decided outlives it.
      const liveFailure: LiveFailureSlot = {};
      yield* LiveFailure.set(liveFailure);

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
            // Read per import, in the invoking scope, so a component registered
            // by a nested scope is visible to what that scope expands.
            const registered = yield* Component.operations.registry;
            return yield* durableImportComponent(
              name,
              name === "__root__" ? root : undefined,
              componentDirs,
              registered,
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

      const returned = yield* durableRun(() => Execution.operations.document(props), { stream });
      // Taken rather than read, so the handoff belongs to the run that made it.
      const live = yield* takeLiveFailure(liveFailure);
      const result = parseDocumentResult(returned);

      // Preserve output for any completion path that did not emit through the
      // streaming API — a replayed run restores its body text from the journal
      // instead of re-executing, and callback consumers only ever see chunks,
      // never the close value. A failed document takes the same path, so what
      // it rendered first reaches consumers before its failure does.
      if (!emitted && result.output) {
        yield* DocumentOutput.operations.output(result.output);
      }

      yield* channel.close(result.output);
      if (result.status === "err") {
        const failure = failureError(result.error, live);
        resolve(Err(failure instanceof Error ? failure : new Error(String(failure))));
        return;
      }
      resolve(Ok(result.value));
    } catch (error) {
      // Close with everything already emitted — printed errors produced before
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
  /**
   * The document's expansion, as `durableRun` runs it.
   *
   * A layer here wraps the whole document while the durable stream is still
   * live and before the root Close is written — the only place work that has to
   * outlast every element but still be journaled can go.
   */
  document(props: Record<string, Json>): Operation<DocumentResult>;
}

export const Execution: Api<ExecutionApi> = createApi<ExecutionApi>("Execution", {
  *execute(options: ExecuteOptions): Operation<DocumentExecution> {
    return yield* executeDocument(options);
  },
  *document(props: Record<string, Json>): Operation<DocumentResult> {
    return yield* documentWorkflow(props);
  },
});

export const execute: Operations<ExecutionApi>["execute"] = Execution.operations.execute;
