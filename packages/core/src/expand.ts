/**
 * Expansion engine (spec §5).
 *
 * Term-rewriting process: each component invocation is replaced by the
 * component's body, with <Content /> (and <Content slot="name" />)
 * substituted by the invocation's children and {meta.key}/{props.key}
 * resolved.
 *
 * Top-down expansion with raw child substitution: children are
 * substituted into the component body as raw (unexpanded) segments,
 * then the entire substituted body is expanded in document order.
 * This ensures code blocks before <Content /> (e.g., provider
 * middleware installation) execute before children's code blocks.
 */

import { ensure, Err, Ok, scoped, useScope, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { parse } from "acorn";
import type {
  Segment,
  TextSegment,
  ErrorSegment,
  ComponentElement,
  ComponentHandling,
  ComponentDefinition,
  ComponentFailure,
  ComponentInvocationMetadata,
  EvalEnv,
  FunctionComponentDefinition,
  Json,
  CodeBlockContext,
  ReturnsSchema,
  SourcePosition,
} from "./types.ts";
import { interpolate } from "./interpolate.ts";
import { interpolateEvalBindings } from "./eval-interpolate.ts";
import {
  Component,
  ExpansionFrame,
  applyModifiers,
  env,
  evalScope,
  handleFailure,
  importComponent,
  raise,
} from "./component-api.ts";
import {
  AmbientErrorPolicy,
  attributeCause,
  ContentError,
  DocumentationError,
  durabilityFailure,
  fatalCause,
  settle,
} from "./errors.ts";
import { collectsFailures, useFailureCollection } from "./component-failures.ts";
import type { ErrorPolicy } from "./errors.ts";
import { withInvocation } from "./invocation.ts";
import type { Invocation } from "./invocation.ts";
import { ActiveProjection } from "./projection.ts";
import type { ProjectionHandle, ProjectionRequest } from "./projection.ts";
import { ActiveLoop, recordIteration, recordOutcome } from "./loop.ts";
import type { LoopFrame, LoopIdentity, LoopOutcome } from "./loop.ts";
import { unbox, useEvalScope } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";
import { SchemaValidationError, validateProps, validateReturnValue } from "./validate.ts";
import { parseJson } from "./json.ts";
import { healSegment } from "./heal.ts";
import { scanSegments } from "./scanner.ts";
import { expandAnswers, strayAnswerError } from "./answers.ts";
import { RESERVED_STRUCTURAL } from "./structural.ts";
import { renderSegments } from "./render.ts";
import { remark } from "remark";
import { select as cssSelect } from "unist-util-select";
import { toString as mdastToString } from "mdast-util-to-string";

/**
 * Mutable counter for generating unique, deterministic blockId values.
 * Threaded through the expansion context to ensure stable IDs across
 * per-segment expansion calls.
 */
export interface BlockCounter {
  next(): number;
}

export function createBlockCounter(): BlockCounter {
  let id = 0;
  return { next: () => id++ };
}

// Providers install at "min" inside scoped() so nested components override
// ancestors (innermost min runs first) without leaking into siblings.
function provideEnv(value: EvalEnv): Operation<void> {
  return Component.around({ env: () => value }, { at: "min" });
}

function provideEvalScope(value: EvalScope): Operation<void> {
  return Component.around({ evalScope: () => value }, { at: "min" });
}

/**
 * Let the component body create resources that outlive it (spec §4.4).
 *
 * `site` is the eval scope ambient at the invocation site, read before the
 * invocation installs its own. Each `retain()` opens a child scope *of* the
 * site and runs the factory there, so the resource lives as long as the site
 * does while everything else the factory touches stays inside the child.
 *
 * The isolation is the point, not an accident of nesting. A factory is
 * arbitrary code: run directly on the site's loop task it could set a context
 * value or install middleware that every later sibling would then observe —
 * the same mechanism that lets a `persist` block install a provider for the
 * rest of its invocation. Retention is a lifetime, not authority over the
 * caller, so only the provided value crosses back.
 *
 * Every invocation installs a provider, including one with no site to retain
 * into. Leaving that case uninstalled would let whatever `retain` provider
 * happens to be inherited answer for this invocation, and a resource would be
 * created in a scope with no relationship to the call site.
 */
function provideRetain(site: EvalScope | undefined): Operation<void> {
  if (!site) {
    return Component.around({ retain: rejectRetain }, { at: "min" });
  }
  return Component.around(
    {
      *retain([resource], _next) {
        // Created *through* the site, so the child's loop task is spawned in
        // the site's and dies with it — the resource's lifetime — while the
        // factory runs one level down, where its own scope writes land.
        const child = unbox(yield* site.eval(useEvalScope));
        return unbox(yield* child.eval(resource));
      },
    },
    { at: "min" },
  );
}

// deno-lint-ignore require-yield
function* rejectRetain(): Operation<never> {
  throw new Error(
    "retain() has no invocation-site eval scope to own the resource. Expansion driven " +
      "without one — no document scope and no enclosing invocation — can only create " +
      "resources with invocation lifetime.",
  );
}

/**
 * Offer an element to extensions, with this expansion's recursion — its
 * interpolation inputs, hide set, and block counter — bound for exactly the
 * length of the offer. A claiming handler reaches it through
 * `Component.expandSegments`; a nested claim replaces the binding for its own
 * offer and restores this one. Nothing else in expansion sees a frame, so a
 * code block or modifier running between elements finds none active.
 */

/**
 * Run `body` with the frame the Api form of `expandSegments` needs.
 *
 * A structural construct that renders segments of its own reaches them through
 * that operation rather than through this module's function, so the frame has
 * to name where those segments belong.
 */
/**
 * Offer an element to installed component support before built-in expansion.
 *
 * The frame it publishes is what `Component.expandSegments` binds to, so a
 * handler's recursion carries this element's interpolation inputs and cycle
 * detection; a nested claim replaces the binding for its own subtree.
 */
function* offerElement(
  element: ComponentElement,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<ComponentHandling | undefined> {
  return yield* withExpansionFrame(parentMeta, parentProps, hideSet, counter, () =>
    Component.operations.expand(element),
  );
}

function* withExpansionFrame<T>(
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  body: () => Operation<T>,
): Operation<T> {
  const scope = yield* useScope();
  const enclosing = scope.get(ExpansionFrame);
  scope.set(ExpansionFrame, (inner: Segment[]) =>
    expandSegments(inner, parentMeta, parentProps, hideSet, counter),
  );
  try {
    return yield* body();
  } finally {
    scope.set(ExpansionFrame, enclosing);
  }
}

/**
 * Expand segments in a fresh scope whose eval env is the caller's values
 * plus an optional per-render override. The override is a shallow layer —
 * spread into a new object, never assigned onto the caller's env — so it is
 * discarded when the scope exits and cannot leak to the caller, siblings, or
 * later renders. Returns the expanded segments; callers decide whether to
 * render them to a string. Shared by `renderChildren`/`render` and `<Each>`.
 */
function expandChildrenScoped(
  segments: Segment[],
  callerEnv: EvalEnv | undefined,
  override: Record<string, unknown> | undefined,
  scope: EvalScope | undefined,
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* provideEnv({ values: { ...(callerEnv?.values ?? {}), ...(override ?? {}) } });
    if (scope) {
      yield* provideEvalScope(scope);
    }
    return yield* expandSegments(segments, meta, props, hideSet, counter);
  });
}

interface ProjectionState {
  invocation: Invocation;
  enclosing: ProjectionHandle | undefined;
  children: Segment[];
  /**
   * The environment projected content expands in. Undefined leaves the ambient
   * one in place, which is how a function component publishes bindings to its
   * own content: it installs an env and `content()` inherits it.
   */
  callerEnv: EvalEnv | undefined;
  meta: Record<string, unknown>;
  props: Record<string, Json>;
  hideSet: Set<string>;
  counter: BlockCounter;
  /**
   * The loop active where the caller wrote the content it projects, read at
   * the invocation site before the invocation cleared it for its own body.
   * Projected content is the caller's text, so a `<Break>` in it means the
   * loop the author could see.
   */
  callerLoop: LoopFrame | undefined;
  /**
   * Where a string projection records the errors it renders away. A handle that
   * only projects structured segments needs none — its caller sees the errors.
   */
  collect?: Segment[];
}

/**
 * Build the handle one invocation publishes (spec §6.3).
 *
 * Every projection expands in a task the invocation's content scope owns, so
 * nested invocations and persistent work created by projected content descend
 * from it and stop with the invocation. The environment is the caller's, the
 * resource scope is the callee's.
 */
function createProjectionHandle(state: ProjectionState): ProjectionHandle {
  const slots = partitionBySlot(state.children);
  const project = makeProjectFn(state.callerEnv);
  let slotErrorsEmitted = false;

  function select(request: ProjectionRequest): Segment[] {
    if (request.kind === "markdown") {
      return request.segments;
    }
    if (request.kind === "children") {
      return state.children;
    }
    if (request.name !== undefined) {
      return (slots.named.get(request.name) ?? []).map(stripSlotProp);
    }
    return slots.default;
  }

  function environmentFor(request: ProjectionRequest): EvalEnv | undefined {
    if (request.kind === "children" && request.override) {
      return { values: { ...(state.callerEnv?.values ?? {}), ...request.override } };
    }
    return state.callerEnv;
  }

  const claimed = new WeakSet<ComponentElement>();

  /**
   * Run already-selected segments inside the content scope. Shared by every
   * projection so none of them depends on eval-scope acquisition order.
   */
  function* runInContentScope(options: {
    segments: Segment[];
    policy: ErrorPolicy;
    env: EvalEnv | undefined;
    meta: Record<string, unknown>;
    props: Record<string, Json>;
    hideSet: Set<string>;
    inner: ProjectionHandle | undefined;
    loop: LoopFrame | undefined;
    errors: Segment[];
  }): Operation<Segment[]> {
    return yield* scoped(function* () {
      const contentScope = yield* state.invocation.useContentScope();
      // The projection's failure travels back to the caller rather than into
      // the content scope. Raising it there would poison the scope, and the
      // invocation's teardown would then re-report it as a teardown error,
      // replacing the documentation failure the caller is meant to see.
      const outcome = withResolvers<{ segments: Segment[]; failure?: unknown }>();
      // Shared with the expansion below, so a failure still leaves behind what it
      // rendered before stopping.
      const rendered: Segment[] = [];
      const task = contentScope.scope.run(function* () {
        try {
          yield* AmbientErrorPolicy.set(options.policy);
          if (options.segments.length === 0) {
            outcome.resolve({ segments: [] });
            return;
          }
          yield* provideEvalScope(contentScope);
          if (options.env) {
            yield* provideEnv(options.env);
          }
          yield* ActiveProjection.set(options.inner);
          yield* ActiveLoop.set(options.loop);
          yield* expandSegments(
            options.segments,
            options.meta,
            options.props,
            options.hideSet,
            state.counter,
            rendered,
          );
          outcome.resolve({ segments: rendered });
        } catch (error) {
          outcome.resolve({ segments: rendered, failure: error });
        }
      });
      yield* ensure(() => task.halt());
      const result = yield* outcome.operation;
      if (result.failure !== undefined) {
        throw result.failure;
      }
      return [...options.errors, ...result.segments];
    });
  }

  function* runProjection(request: ProjectionRequest): Operation<Segment[]> {
    const outcome = yield* runProjectionOutcome(request);
    if (outcome.failure !== undefined) {
      throw outcome.failure;
    }
    return outcome.segments;
  }

  /**
   * Project, and report what happened rather than deciding it.
   *
   * `segments` holds everything rendered, which for a failure is everything
   * rendered *before* it — expansion accumulates into the array as it goes, so
   * a body that stops partway still surrenders what it produced.
   */
  function* runProjectionOutcome(
    request: ProjectionRequest,
  ): Operation<{ segments: Segment[]; failure?: unknown }> {
    const segments = select(request);
    const policy = request.policy ?? (yield* AmbientErrorPolicy.get()) ?? "collect";
    const contentScope = yield* state.invocation.useContentScope();
    // The enclosing handle answers <Content /> written inside projected
    // content: it belongs to the caller's invocation, not to this one.
    // Dynamic markdown is the component's own, so it keeps this handle.
    const inner = request.kind === "markdown" ? handle : state.enclosing;

    return yield* scoped(function* () {
      // The projection's failure travels back to the caller rather than into
      // the content scope (see runInContentScope): a throw-bound failure the
      // caller catches is explicit recovery, and the invocation must not
      // re-report it as a teardown error.
      const outcome = withResolvers<{ segments: Segment[]; failure?: unknown }>();
      // Shared with the expansion below, so a failure still leaves behind what it
      // rendered before stopping.
      const rendered: Segment[] = [];
      // Slot errors are reported inside the policy-bound task, so an empty
      // selection cannot settle them under the invocation's baseline. Held out
      // here so a failure still reports them alongside what rendered.
      const errors: Segment[] = [];
      const task = contentScope.scope.run(function* () {
        try {
          yield* AmbientErrorPolicy.set(policy);
          if (!slotErrorsEmitted && slots.errors.length > 0) {
            slotErrorsEmitted = true;
            for (const slotError of slots.errors) {
              errors.push(yield* raise(slotError));
            }
          }
          if (segments.length === 0) {
            outcome.resolve({ segments: errors });
            return;
          }
          yield* provideEvalScope(contentScope);
          const projectionEnv = environmentFor(request);
          if (projectionEnv) {
            yield* provideEnv(projectionEnv);
          }
          yield* ActiveProjection.set(inner);
          // Dynamic markdown is the component's own text, so it is not written
          // where the caller's loop is and cannot break it.
          yield* ActiveLoop.set(request.kind === "markdown" ? undefined : state.callerLoop);
          yield* expandSegments(
            project(segments),
            state.meta,
            state.props,
            state.hideSet,
            state.counter,
            rendered,
          );
          outcome.resolve({ segments: [...errors, ...rendered] });
        } catch (error) {
          outcome.resolve({ segments: [...errors, ...rendered], failure: error });
        }
      });
      yield* ensure(() => task.halt());
      return yield* outcome.operation;
    });
  }

  const handle: ProjectionHandle = {
    claim(element: ComponentElement): ComponentElement {
      claimed.add(element);
      return element;
    },
    claims(element: ComponentElement): boolean {
      return claimed.has(element);
    },
    *expandClaimed(
      element: ComponentElement,
      meta: Record<string, unknown>,
      props: Record<string, Json>,
      hideSet: Set<string>,
    ): Operation<Segment[]> {
      // Slots were resolved during substitution, so the environment, meta,
      // props and hide set are the body's own — only the resource scope moves.
      // The policy has to travel with them: the content task does not inherit
      // the documentation or <Output> frame this `<Content />` sits in.
      const policy = (yield* AmbientErrorPolicy.get()) ?? "collect";
      return yield* runInContentScope({
        segments: element.children,
        policy,
        env: undefined,
        meta,
        props,
        hideSet,
        inner: state.enclosing,
        loop: state.callerLoop,
        errors: [],
      });
    },
    project: runProjection,
    tryProject: runProjectionOutcome,
    *projectToString(request: ProjectionRequest): Operation<string> {
      const collect = state.collect;
      if (collect === undefined) {
        throw new Error(
          "projectToString() requires an error collector; this handle only supports project().",
        );
      }
      const segments = yield* runProjection(request);
      // A string result must not hide a failure: record the structured errors
      // where the invocation can refuse an `as=` capture.
      for (const segment of segments) {
        if (segment.type === "error") {
          collect.push(segment);
        }
      }
      return renderSegments(segments);
    },
  };
  return handle;
}

function validateRenderOverride(override: unknown): Record<string, unknown> | undefined {
  if (override === undefined) {
    return undefined;
  }
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new Error("renderChildren(override) requires a plain object.");
  }
  // Reject Date/Map/class instances: only Object.prototype and null-prototype
  // records are plain objects whose keys layer cleanly over the caller env.
  const proto = Object.getPrototypeOf(override);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error("renderChildren(override) requires a plain object.");
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(override)) {
    result[key] = value;
  }
  return result;
}

const MAX_EXPANSION_DEPTH = 64;
const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Expand an array of segments, resolving components and executing code blocks.
 *
 * Component import, modifier execution, bindings, and error policy are all
 * delivered contextually through the Component Api — install providers with
 * `Component.around(..., { at: "min" })` before expanding.
 *
 * @param counter - Optional block ID counter. If omitted, a local counter
 *   is created. For per-segment emission (§9), pass a shared counter so
 *   IDs are stable across calls.
 */
export function* expandSegments(
  segments: Segment[],
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter = createBlockCounter(),
  /**
   * Where to accumulate, when the caller wants what was rendered even if this
   * does not finish. Expansion appends as it goes, so a caller holding the same
   * array still has everything produced before a failure — which is how a
   * `<Test>` keeps its output when its body stops partway.
   */
  collect?: Segment[],
): Operation<Segment[]> {
  const result: Segment[] = collect ?? [];
  // Read once: `<Loop>` publishes its frame for the nested call that expands
  // its body, so the frame ambient here cannot change while this list runs.
  const loop = yield* ActiveLoop.get();

  for (const segment of segments) {
    switch (segment.type) {
      case "text": {
        // Heal incomplete markdown constructs at segment boundaries (spec §2.3)
        // Runs synchronously — no yield, no journal entry
        const healed = healSegment(segment.content);
        // Interpolate {meta.key} and {props.key} — runtime, no journal
        const interpolated = interpolate(healed, parentMeta, parentProps);
        // Interpolate bare {name} refs from eval bindings (spec §6.4/§6.6).
        // Runs after meta/props interpolation so component contract takes
        // precedence. Only runs when a binding environment is in scope.
        const textEvalEnv = yield* env;
        const final = textEvalEnv
          ? interpolateEvalBindings(interpolated, textEvalEnv.values)
          : interpolated;
        result.push({ type: "text", content: final });
        break;
      }

      case "component": {
        // Extension hook: installed component support may claim this element
        // before built-in expansion. A handler reports the errors it creates
        // (§6.9), so returned segments are settled here rather than reported
        // again: a collecting policy keeps them, a throwing one aborts.
        //
        // Nothing in this repository claims a name any more — every component
        // family resolves through registration or a repository file. The hook
        // itself is retired separately.
        const handling = yield* offerElement(segment, parentMeta, parentProps, hideSet, counter);
        if (handling) {
          for (const handled of handling.segments) {
            if (handled.type === "error") {
              result.push(yield* settle(handled));
            } else {
              result.push(handled);
            }
          }
          break;
        }

        if (segment.name === "Content") {
          // A `<Content />` the invocation claimed carries its resolved
          // projection; expanding it here runs that content in the
          // invocation's content scope, which stops before the invocation
          // releases anything of its own. Its segments already went through
          // the ambient policy, so they are appended as they are.
          const projection = yield* ActiveProjection.get();
          if (projection && projection.claims(segment)) {
            result.push(
              ...(yield* projection.expandClaimed(segment, parentMeta, parentProps, hideSet)),
            );
            break;
          }
        }

        if (segment.name === "Output") {
          // Definition-owned <Output> is consumed by buildBody before it
          // reaches here. Reaching this branch means a misplaced or
          // dynamically scanned <Output> (e.g. render(markdown) content) —
          // diagnose it defensively per the ambient policy.
          result.push(yield* raise(misplacedOutputError()));
          break;
        }

        if (segment.name === "Return") {
          // Definition-owned <Return> is consumed by value-body expansion
          // before it reaches here. Reaching this branch means a projected,
          // dynamically scanned, or misplaced <Return> — diagnose it rather
          // than resolving a component named Return.
          result.push(yield* raise(misplacedReturnError(segment)));
          break;
        }

        if (segment.name === "Capture") {
          // No raise() here: expandCapture reports the errors it creates, and
          // its body settled its own (§6.9).
          result.push(
            ...(yield* expandCapture(segment, parentMeta, parentProps, hideSet, counter)),
          );
          break;
        }

        if (segment.name === "Each") {
          // Same as <Capture>: expandEach reports its own errors and hands the
          // body's back untouched (§6.9).
          result.push(...(yield* expandEach(segment, parentMeta, parentProps, hideSet, counter)));
          break;
        }

        if (segment.name === "If") {
          // No raise() here, like the branches above: expandIf reports the
          // errors it creates, and the selected branch settled its own (§6.9).
          result.push(...(yield* expandIf(segment, parentMeta, parentProps, hideSet, counter)));
          break;
        }

        if (segment.name === "Else") {
          // A well-placed <Else> is consumed by its <If> and never expanded on
          // its own. Reaching this branch means the element sits outside any
          // <If>, so it names no component and is diagnosed rather than
          // resolved from the filesystem.
          result.push(yield* raise(strayElseError(segment)));
          break;
        }

        if (segment.name === "Loop") {
          // No raise() here, for the same reason as <If>: expandLoop reports
          // the errors it creates, and the body settled its own (§6.9).
          result.push(...(yield* expandLoop(segment, parentMeta, parentProps, hideSet, counter)));
          break;
        }

        if (segment.name === "CollectFailures") {
          // No raise() here, like the branches above: expandCollectFailures
          // reports the errors it creates, and the body settled its own (§6.9).
          result.push(
            ...(yield* expandCollectFailures(segment, parentMeta, parentProps, hideSet, counter)),
          );
          break;
        }

        if (segment.name === "Answers") {
          // No raise() here, like the branches above: expandAnswers reports the
          // errors it creates, and the selected answer settled its own (§6.9).
          // It renders the answer it chose through the Api form of
          // `expandSegments`, so it needs this frame — the same one the
          // retired claim hook used to publish for a handler.
          result.push(
            ...(yield* withExpansionFrame(parentMeta, parentProps, hideSet, counter, () =>
              expandAnswers(segment),
            )),
          );
          break;
        }

        if (segment.name === "Answer") {
          // A well-placed <Answer> is partitioned out by its <Answers> and never
          // expanded on its own. Reaching here means it sits outside one, so it
          // names no component — the same shape as a stray <Else>.
          result.push(yield* raise(strayAnswerError(segment)));
          break;
        }

        if (segment.name === "Break") {
          result.push(...(yield* expandBreak(segment, loop)));
          break;
        }

        if (RESERVED_STRUCTURAL.has(segment.name)) {
          // Every other structural name is consumed above; reaching here means
          // one was written where the construct that gives it meaning is not.
          // It is reserved, so resolution stops rather than looking for a file
          // that could stand in for the syntax.
          result.push(yield* raise(strayStructuralError(segment)));
          break;
        }

        const expanded = yield* expandComponent(
          segment.name,
          segment.props,
          segment.expressions,
          segment.children,
          segment.selfClosing,
          hideSet,
          counter,
          segment.projectedEnv,
          segment.position,
          parentMeta,
          parentProps,
        );
        // Consumer boundary: the callee reported these where they were created,
        // under whatever policy its body ran — an `<Output>` region collects,
        // documentation throws. Settling them here applies this caller's policy
        // without reporting them a second time (spec §6.9).
        for (const expandedSegment of expanded) {
          if (expandedSegment.type === "error") {
            result.push(yield* settle(expandedSegment));
          } else {
            result.push(expandedSegment);
          }
        }
        break;
      }

      case "codeBlock": {
        // Interpolate eval bindings into content before the modifier chain.
        // A binding environment may not be in scope (e.g., blocks outside
        // component expansion) — fall back to the original content.
        //
        // Skip interpolation for eval blocks — they access bindings directly
        // via the env preamble (const { name } = env;). Interpolating would
        // mangle JS template literals like `${name}` into `$<value>`.
        const evalEnv = yield* env;
        const lastModifier = segment.modifiers[segment.modifiers.length - 1];
        const isEvalTerminal = lastModifier !== undefined && lastModifier.name === "eval";
        const interpolatedContent =
          evalEnv && !isEvalTerminal
            ? interpolateEvalBindings(segment.content, evalEnv.values)
            : segment.content;

        // Compose modifier chain from info string and run it.
        // blockId uses counter.next() for deterministic IDs that
        // survive per-segment expansion (see spec §6.1 Block ID counter).
        const context: CodeBlockContext = {
          language: segment.language,
          content: interpolatedContent,
          blockId: `eval:${parentMeta["componentName"] ?? "root"}:${counter.next()}`,
          componentName: parentMeta["componentName"] as string | undefined,
        };

        try {
          const codeResult = yield* applyModifiers(segment.modifiers, context);

          if (codeResult.exitCode !== 0 && codeResult.output === "") {
            result.push(
              yield* raise({
                type: "error",
                message: `Command failed (exit ${codeResult.exitCode}): ${codeResult.stderr}`,
                source: segment.content,
              }),
            );
          } else if (codeResult.output !== "") {
            result.push({
              type: "execOutput",
              command: segment.content,
              result: {
                exitCode: codeResult.exitCode,
                stdout: codeResult.output,
                stderr: codeResult.stderr,
              },
            });
          }
          // If output is empty and exit code is 0, nothing added (e.g., silent)
        } catch (error) {
          const fatal = fatalCause(error);
          if (fatal !== undefined) {
            throw fatal;
          }
          result.push(
            yield* raise({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
              source: segment.content,
            }),
          );
        }
        break;
      }

      default: {
        if (segment.type === "error") {
          // Pre-existing error segments (e.g. slot/substitution errors) follow
          // the ambient policy.
          result.push(yield* raise(segment));
        } else {
          result.push(segment);
        }
      }
    }

    // A `<Break>` anywhere below this segment ends the iteration here: what the
    // list already produced stands, and nothing after it expands.
    if (loop?.broken) {
      break;
    }
  }

  return result;
}

function captureError(message: string): ErrorSegment {
  return { type: "error", message, source: "Capture" };
}

/**
 * Capture the rendered body into an `as` binding (spec §6.5 `<Capture>`).
 *
 * Like `<If>`, it is not an observation boundary. Errors it creates itself — a
 * missing or invalid `as`, an unknown prop, an empty body — are reported here,
 * exactly once. Body segments come back from `expandSegments` already reported
 * where they were produced, and are handed on untouched: a failing element
 * inside a capture settles once, exactly as it would inline.
 *
 * A capture never swallows an error. When the body produced one, `as` creates no
 * binding and the error segments stand in place of the capture, so the reader
 * sees the failure instead of a binding holding a diagnostic as its text.
 */
function* expandCapture(
  segment: Extract<Segment, { type: "component" }>,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<ErrorSegment[]> {
  if (segment.selfClosing || segment.children.length === 0) {
    return [
      yield* raise(captureError('<Capture> must have content. Use <Capture as="x">...</Capture>.')),
    ];
  }

  const propNames = Object.keys(segment.props);
  if (propNames.some((name) => name !== "as" && name !== "select")) {
    return [yield* raise(captureError('<Capture> only accepts "as" and "select" props.'))];
  }

  const expressionNames = Object.keys(segment.expressions);
  if (expressionNames.length > 0) {
    if (expressionNames.includes("as")) {
      return [
        yield* raise(captureError('<Capture as={...}> is invalid: "as" must be a string literal.')),
      ];
    }
    if (!expressionNames.every((n) => n === "select")) {
      return [yield* raise(captureError('<Capture> only accepts "as" and "select" props.'))];
    }
  }

  if (segment.props.as === undefined) {
    return [yield* raise(captureError('<Capture> requires an "as" prop (non-empty string).'))];
  }

  const asBinding = validateBindingName(segment.props.as);
  if (!asBinding.ok) {
    return [yield* raise(captureError(asBinding.error.message))];
  }
  const bindingName = asBinding.value;
  if (bindingName === undefined) {
    return [yield* raise(captureError('<Capture> requires an "as" prop (non-empty string).'))];
  }

  const expandedChildren = yield* expandSegments(
    segment.children,
    parentMeta,
    parentProps,
    hideSet,
    counter,
  );

  // The body reported these where they were created (§6.9). They are returned
  // before rendering or `select` folds them into text, so the binding stays
  // unset and the diagnostics reach the document unchanged.
  const errors: ErrorSegment[] = [];
  for (const child of expandedChildren) {
    if (child.type === "error") {
      errors.push(child);
    }
  }
  if (errors.length > 0) {
    return errors;
  }

  const rendered = renderSegments(expandedChildren).replace(/\s+$/, "");

  // Apply CSS selector if select prop is present (spec §6.5)
  let captured = rendered;
  const selectProp = segment.props.select as string | undefined;
  if (typeof selectProp === "string" && selectProp.length > 0) {
    const tree = remark().parse(captured);
    // deno-lint-ignore no-explicit-any
    const node = cssSelect(selectProp, tree as any);
    if (node) {
      captured = "value" in node ? String(node.value) : mdastToString(node);
    }
  }

  const bindingEnv = yield* env;
  if (!bindingEnv) {
    return [yield* raise(captureError("<Capture> requires an evaluation environment."))];
  }
  bindingEnv.values[bindingName] = captured;
  return [];
}

function eachError(message: string): ErrorSegment {
  return { type: "error", message, source: "Each" };
}

const EACH_PROPS = new Set(["in", "let", "as"]);

/**
 * Expand the body once per item, binding `let` to the item (spec §6.5 `<Each>`).
 *
 * Like `<If>` and `<Loop>`, it is not an observation boundary: errors it creates
 * itself — an unknown prop, a `let`/`as`/`in` that does not hold up — are
 * reported here, exactly once, and every iteration's segments come back already
 * reported and are handed on untouched.
 *
 * With `as`, a capture never swallows an error: when any iteration produced one,
 * no binding is created and the error segments stand in place of the capture.
 */
function* expandEach(
  segment: Extract<Segment, { type: "component" }>,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  const unknownProp = [...Object.keys(segment.props), ...Object.keys(segment.expressions)].find(
    (n) => !EACH_PROPS.has(n),
  );
  if (unknownProp !== undefined) {
    return [
      yield* raise(
        eachError(`<Each> only accepts "in", "let", and "as" props. Got: "${unknownProp}".`),
      ),
    ];
  }

  if ("let" in segment.expressions) {
    return [yield* raise(eachError('Prop "let" on <Each /> must be a string literal.'))];
  }
  if (segment.props.let === undefined) {
    return [yield* raise(eachError('<Each> requires a "let" prop (the item binding name).'))];
  }
  const letBinding = validateBindingName(segment.props.let);
  if (!letBinding.ok) {
    return [yield* raise(eachError(`Prop "let" on <Each /> ${letBinding.error.message}`))];
  }
  const name = letBinding.value;
  if (name === undefined) {
    return [yield* raise(eachError('<Each> requires a "let" prop (the item binding name).'))];
  }

  if ("as" in segment.expressions) {
    return [yield* raise(eachError('Prop "as" on <Each /> must be a string literal.'))];
  }
  const asResult = validateBindingName(segment.props.as);
  if (!asResult.ok) {
    return [yield* raise(eachError(`Prop "as" on <Each /> ${asResult.error.message}`))];
  }
  const asBinding = asResult.value;

  let items: Json | undefined;
  if ("in" in segment.props) {
    items = segment.props.in;
  } else if ("in" in segment.expressions) {
    try {
      const resolved = yield* resolveExpressionProps(
        {},
        { in: segment.expressions.in },
        "Each",
        segment.projectedEnv,
      );
      items = resolved.in;
    } catch (error) {
      return [yield* raise(eachError(error instanceof Error ? error.message : String(error)))];
    }
  } else {
    return [yield* raise(eachError('<Each> requires an "in" prop (the array to iterate).'))];
  }
  if (!Array.isArray(items)) {
    return [yield* raise(eachError('Prop "in" on <Each /> must resolve to an array.'))];
  }

  // Effective caller env honors projection through <Content />, mirroring
  // expandComponent, so a projected <Each> resolves both lexical caller
  // bindings and the current component's bindings.
  const contextEnv = yield* env;
  const callerEnv = segment.projectedEnv
    ? { values: { ...segment.projectedEnv.values, ...(contextEnv?.values ?? {}) } }
    : contextEnv;
  const parentEvalScope = yield* evalScope;

  const enclosingLoop = yield* ActiveLoop.get();
  const out: Segment[] = [];
  for (const item of items) {
    const expanded = yield* expandChildrenScoped(
      segment.children,
      callerEnv ?? undefined,
      { [name]: item },
      parentEvalScope ?? undefined,
      parentMeta,
      parentProps,
      hideSet,
      counter,
    );
    out.push(...expanded);
    // A `<Break>` in the body exits the enclosing `<Loop>`, so the remaining
    // items are part of the work that iteration no longer does.
    if (enclosingLoop?.broken) {
      break;
    }
  }

  if (asBinding === undefined) {
    return out;
  }

  // A capture never swallows an error. The body reported these where they were
  // created (§6.9), so they are returned as they are: the diagnostics reach the
  // document unchanged and the binding stays unset.
  const errors = out.filter((outSegment) => outSegment.type === "error");
  if (errors.length > 0) {
    return errors;
  }

  const captureEnv = yield* env;
  if (!captureEnv) {
    return [
      yield* raise(eachError('Prop "as" on <Each /> requires a parent evaluation environment.')),
    ];
  }
  captureEnv.values[asBinding] = renderSegments(out);
  return [];
}

/**
 * Anchor a diagnostic to the source location of the element that caused it.
 * Segments built without scanning a document carry no position; there the
 * message stands on its own.
 */
function positioned(message: string, segment: ComponentElement): string {
  const { position } = segment;
  if (!position) {
    return message;
  }
  const file = position.path === undefined ? "" : `${position.path}:`;
  return `${message} (${file}${position.line}:${position.column})`;
}

function ifError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "If" };
}

function elseError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "Else" };
}

/**
 * A structural name written where its construct gives it no meaning.
 *
 * `<Content />` is the one that reaches here in practice: outside an invocation
 * there is nothing to project. Naming it reserved is the point — a repository
 * file called `Content.md` does not stand in for the syntax.
 */
function strayStructuralError(segment: ComponentElement): ErrorSegment {
  const name = segment.name;
  const detail =
    name === "Content"
      ? `<${name} /> renders the content its invocation was given, so it means something ` +
        "only inside a component's body."
      : `<${name} /> is part of a construct that is not open here.`;
  return {
    type: "error",
    message: positioned(
      `${detail} <${name}> is reserved: it never resolves a component, so a repository ` +
        `file named ${name} cannot supply it.`,
      segment,
    ),
    source: name,
  };
}

function strayElseError(segment: ComponentElement): ErrorSegment {
  return elseError(
    segment,
    "<Else> must be a direct child of <If>. <Else> is reserved: it never resolves a " +
      "component, and only the <If> it belongs to can select it.",
  );
}

function isElse(segment: Segment): segment is ComponentElement {
  return segment.type === "component" && segment.name === "Else";
}

/** Markdown puts newlines between block elements; they are not a third branch. */
function isBlankText(segment: Segment): boolean {
  return segment.type === "text" && segment.content.trim() === "";
}

function describeSegment(segment: Segment): string {
  if (segment.type === "component") {
    return `<${segment.name}>`;
  }
  if (segment.type === "codeBlock") {
    return `a \`${segment.language}\` code block`;
  }
  if (segment.type === "execOutput") {
    return "command output";
  }
  if (segment.type === "error") {
    return "an error";
  }
  const text = segment.content.trim().replace(/\s+/g, " ");
  return `text "${text.length > 30 ? `${text.slice(0, 30)}…` : text}"`;
}

function trailingContentError(segment: Segment, elseElement: ComponentElement): ErrorSegment {
  // A component carries its own position; anything else is anchored to the
  // `<Else>` it follows, which is the boundary the author crossed.
  const anchor = segment.type === "component" ? segment : elseElement;
  return elseError(
    anchor,
    `<Else> must be the final substantive child of <If>. Found ${describeSegment(segment)} ` +
      "after </Else>.",
  );
}

function jsonKind(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value}`;
}

function elseElementViolations(segment: ComponentElement): ErrorSegment[] {
  const violations: ErrorSegment[] = [];
  const names = [...Object.keys(segment.props), ...Object.keys(segment.expressions)];
  if (names.length > 0) {
    violations.push(elseError(segment, `<Else> accepts no props. Got: "${names[0]}".`));
  }
  if (segment.selfClosing || segment.children.length === 0) {
    violations.push(elseError(segment, "<Else> must have content. Use <Else>...</Else>."));
  }
  return violations;
}

/**
 * Every `<Else>` below an `<If>` that is not one of its direct children. The
 * walk stops at a nested `<If>`, which owns the `<Else>` elements beneath it.
 */
function misplacedElseViolations(children: Segment[]): ErrorSegment[] {
  const violations: ErrorSegment[] = [];

  const walk = (segments: Segment[], depth: number): void => {
    for (const segment of segments) {
      if (segment.type !== "component" || segment.name === "If") {
        continue;
      }
      if (segment.name === "Else" && depth > 0) {
        violations.push(strayElseError(segment));
      }
      walk(segment.children, depth + 1);
    }
  };

  walk(children, 0);
  return violations;
}

interface IfStructure {
  violations: ErrorSegment[];
  whenTrue: Segment[];
  whenFalse: Segment[];
}

/**
 * Split an `<If>` body at its `<Else>` and validate the split. Structure is
 * read from source, before either branch expands, so a malformed `<Else>` is
 * diagnosed even when it sits in the branch the condition does not select.
 *
 * `<If>` has exactly two branches, so `<Else>` is the final substantive child:
 * content after `</Else>` belongs to neither branch and is rejected rather than
 * silently folded into the true one.
 */
function ifStructure(segment: ComponentElement): IfStructure {
  const violations: ErrorSegment[] = [];
  const whenTrue: Segment[] = [];
  let whenFalse: Segment[] | undefined;
  let elseElement: ComponentElement | undefined;

  for (const child of segment.children) {
    if (isElse(child)) {
      if (elseElement) {
        violations.push(elseError(child, "<If> accepts at most one <Else> branch."));
        continue;
      }
      violations.push(...elseElementViolations(child));
      elseElement = child;
      whenFalse = child.children;
      continue;
    }
    if (!elseElement) {
      whenTrue.push(child);
      continue;
    }
    if (!isBlankText(child)) {
      violations.push(trailingContentError(child, elseElement));
    }
  }

  violations.push(...misplacedElseViolations(segment.children));
  return { violations, whenTrue, whenFalse: whenFalse ?? [] };
}

const IF_PROPS = new Set(["condition"]);

/**
 * Expand the one branch the condition selects (spec §6.5 `<If>`). The other
 * branch is never expanded, so nothing in it imports a component, runs a code
 * block, creates a binding, or reaches a provider.
 *
 * `<If>` opens no binding scope: the selected branch expands in the enclosing
 * environment, so a `<Capture>` it creates behaves like inline content and
 * stays available after `</If>`.
 *
 * It is not an observation boundary either. Errors it creates itself — an
 * invalid condition, an unknown prop, a malformed `<Else>` — are reported here,
 * exactly once. Everything the selected branch returns was already reported
 * where it was produced and is handed back untouched, so a `<Broken />` inside
 * a selected branch settles once, exactly as it would inline.
 */
function* expandIf(
  segment: ComponentElement,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  const unknownProp = [...Object.keys(segment.props), ...Object.keys(segment.expressions)].find(
    (name) => !IF_PROPS.has(name),
  );
  if (unknownProp !== undefined) {
    return [
      yield* raise(
        ifError(segment, `<If> only accepts a "condition" prop. Got: "${unknownProp}".`),
      ),
    ];
  }

  const structure = ifStructure(segment);
  if (structure.violations.length > 0) {
    const reported: Segment[] = [];
    for (const violation of structure.violations) {
      reported.push(yield* raise(violation));
    }
    return reported;
  }

  let condition: Json;
  if ("condition" in segment.props) {
    condition = segment.props.condition;
  } else if ("condition" in segment.expressions) {
    try {
      const resolved = yield* resolveExpressionProps(
        {},
        { condition: segment.expressions.condition },
        "If",
        segment.projectedEnv,
      );
      condition = resolved.condition;
    } catch (error) {
      return [
        yield* raise(ifError(segment, error instanceof Error ? error.message : String(error))),
      ];
    }
  } else {
    return [yield* raise(ifError(segment, '<If> requires a "condition" prop (a boolean).'))];
  }

  if (typeof condition !== "boolean") {
    return [
      yield* raise(
        ifError(
          segment,
          `Prop "condition" on <If /> must be a boolean, not ${jsonKind(condition)}. ` +
            "<If> does not coerce truthy or falsy values.",
        ),
      ),
    ];
  }

  return yield* expandSegments(
    condition ? structure.whenTrue : structure.whenFalse,
    parentMeta,
    parentProps,
    hideSet,
    counter,
  );
}

/** How a `<Loop>` names itself in its own diagnostics. */
function loopTag(segment: ComponentElement): string {
  const name = segment.props.name;
  return typeof name === "string" && name.length > 0 ? `<Loop name="${name}">` : "<Loop>";
}

function loopError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "Loop" };
}

function breakError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "Break" };
}

const LOOP_PROPS = new Set(["max", "name"]);

/**
 * The bound a `<Loop>` runs to, or why the prop rejects it. The caller turns
 * the failure into a positioned diagnostic, because it is the one that raises.
 */
function* loopBound(segment: ComponentElement): Operation<Result<number>> {
  let max: Json;
  if ("max" in segment.props) {
    max = segment.props.max;
  } else if ("max" in segment.expressions) {
    try {
      const resolved = yield* resolveExpressionProps(
        {},
        { max: segment.expressions.max },
        "Loop",
        segment.projectedEnv,
      );
      max = resolved.max;
    } catch (error) {
      return Err(error);
    }
  } else {
    return Err(
      new Error(
        `${loopTag(segment)} requires a "max" prop (a positive integer). Repetition is ` +
          "always bounded — there is no unbounded loop.",
      ),
    );
  }

  if (typeof max !== "number") {
    return Err(
      new Error(
        `Prop "max" on ${loopTag(segment)} must be a positive integer, not ${jsonKind(max)}.`,
      ),
    );
  }
  if (!Number.isInteger(max) || max < 1) {
    return Err(
      new Error(
        `Prop "max" on ${loopTag(segment)} must be a positive integer. Got: ${JSON.stringify(max)}.`,
      ),
    );
  }
  return Ok(max);
}

/**
 * Expand a bounded repetition (spec §6.5 `<Loop>`). The body expands in
 * document order at most `max` times, and reaching `max` completes the loop
 * normally — exhaustion is not a failure. Whether an exhausted loop means
 * success is the surrounding document's policy to state.
 *
 * `<Loop>` opens no binding scope. Every iteration expands in the enclosing
 * environment, so an iteration reads what earlier ones bound and the final
 * values stay readable after `</Loop>`.
 *
 * Like `<If>` it is not an observation boundary: it reports the errors it
 * creates itself and hands the body's segments back untouched. It adds no
 * error policy either — under a throwing policy the first failure ends the
 * loop by propagating out of it, and under a collecting one the diagnostic
 * renders and the next iteration runs.
 *
 * The loop writes its own execution records: one entry per iteration entered,
 * carrying that iteration's zero-based identity, and one terminal entry saying
 * the loop finished and how. They are written by the loop rather than derived
 * from whatever the body happened to journal, so an empty body is on the record
 * exactly like a busy one, and exhaustion, `<Break>` and failure are read from
 * the terminal entry instead of inferred. An interrupted loop has no terminal
 * entry — see `LoopOutcome`.
 */
function* expandLoop(
  segment: ComponentElement,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  const unknownProp = [...Object.keys(segment.props), ...Object.keys(segment.expressions)].find(
    (name) => !LOOP_PROPS.has(name),
  );
  if (unknownProp !== undefined) {
    return [
      yield* raise(
        loopError(segment, `<Loop> only accepts "max" and "name" props. Got: "${unknownProp}".`),
      ),
    ];
  }

  if ("name" in segment.expressions) {
    return [yield* raise(loopError(segment, 'Prop "name" on <Loop /> must be a string literal.'))];
  }
  const name = segment.props.name;
  if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
    return [
      yield* raise(loopError(segment, 'Prop "name" on <Loop /> must be a non-empty string.')),
    ];
  }

  const bound = yield* loopBound(segment);
  if (!bound.ok) {
    return [yield* raise(loopError(segment, bound.error.message))];
  }

  // Taken from the shared block counter, so every `<Loop>` an execution enters
  // — including each entry into a nested one — has a distinct identity that
  // lands the same way on replay.
  const identity: LoopIdentity = { id: counter.next(), ...(name === undefined ? {} : { name }) };

  const frame: LoopFrame = { broken: false };
  const out: Segment[] = [];
  let started = 0;

  try {
    yield* scoped(function* () {
      yield* ActiveLoop.set(frame);
      for (let iteration = 0; iteration < bound.value; iteration++) {
        yield* recordIteration(identity, iteration);
        started = iteration + 1;
        out.push(
          ...(yield* expandSegments(segment.children, parentMeta, parentProps, hideSet, counter)),
        );
        if (frame.broken) {
          break;
        }
      }
    });
  } catch (error) {
    // A durability failure is not an outcome of the loop's work, and recording
    // one would reach the journal twice over: it appends an entry on top of a
    // journal already known not to describe this run, and on replay it consumes
    // a terminal entry an earlier run wrote — which is how a stale journal
    // would quietly hand this loop a different outcome. The durability failure
    // stays the primary error.
    const durability = durabilityFailure(error);
    if (durability !== undefined) {
      // The durability failure itself, not whatever wrapped it. A teardown
      // aggregate or an AggregateError says how the failure travelled, not what
      // went wrong, and the caller has to see which journal entry stopped
      // describing this run.
      throw durability;
    }
    // An ordinary document failure is the loop's own outcome. Recorded from the
    // catch rather than a destructor: this frame is still live here, so the
    // entry lands in the journal before the failure leaves the loop.
    try {
      yield* recordOutcome(identity, { iterations: started, outcome: "error" });
    } catch (recording) {
      // Recording found the journal recording a different outcome. That is the
      // more fundamental failure and becomes the primary one, but the document
      // failure that reached it is what the author has to fix.
      if (recording instanceof Error && recording.cause === undefined) {
        recording.cause = error;
      }
      throw recording;
    }
    throw error;
  }

  const outcome: LoopOutcome = frame.broken ? "break" : "exhausted";
  yield* recordOutcome(identity, { iterations: started, outcome });
  return out;
}

function breakElementViolations(segment: ComponentElement): string[] {
  const violations: string[] = [];
  const names = [...Object.keys(segment.props), ...Object.keys(segment.expressions)];
  if (names.length > 0) {
    violations.push(`<Break> accepts no props. Got: "${names[0]}".`);
  }
  if (!segment.selfClosing || segment.children.length > 0) {
    violations.push("<Break> takes no content. Write it self-closing: <Break />.");
  }
  return violations;
}

/**
 * Exit the nearest enclosing `<Loop>` (spec §6.5 `<Break>`).
 *
 * Marking the frame is the whole effect: `expandSegments` sees the mark after
 * this element and stops, so the rest of the iteration expands no content,
 * imports no component, runs no block, and writes no journal entry. Everything
 * the iteration produced before the mark stands.
 *
 * A malformed `<Break>` performs no control action. Only a well-formed one
 * carries the author's instruction, so the diagnostic settles under the
 * ambient policy — aborting under a throwing one, rendering under a collecting
 * one while the loop runs on — rather than a rejected element also ending the
 * loop.
 */
function* expandBreak(
  segment: ComponentElement,
  loop: LoopFrame | undefined,
): Operation<Segment[]> {
  const violations = breakElementViolations(segment);

  if (loop && violations.length === 0) {
    loop.broken = true;
    return [];
  }

  if (!loop) {
    violations.unshift(
      "<Break> must be written inside a <Loop>. <Break> is reserved: it never resolves a " +
        "component, and a <Break> a component writes in its own body cannot break the loop " +
        "that invoked it.",
    );
  }

  const reported: Segment[] = [];
  for (const violation of violations) {
    reported.push(yield* raise(breakError(segment, violation)));
  }
  return reported;
}

function collectFailuresError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "CollectFailures" };
}

/**
 * Continue past ordinary component failures in this region (spec §6.8.1
 * `<CollectFailures>`).
 *
 * The body expands as structured segments rather than a rendered string: this
 * is a region of the caller's document, expanded in the caller's own frame,
 * that happens to continue after an ordinary component failure.
 *
 * The element names a region and nothing else, so it takes no props at all —
 * including `as` and `slot`, which are ordinary prop entries here rather than
 * fields of their own. An invalid element performs no action: the body is not
 * expanded and a prop expression is never evaluated, because the mistake is the
 * prop being written at all rather than anything its value turns out to be.
 */
function* expandCollectFailures(
  segment: ComponentElement,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  const names = [...Object.keys(segment.props), ...Object.keys(segment.expressions)];
  if (names.length > 0) {
    return [
      yield* raise(
        collectFailuresError(segment, `<CollectFailures> accepts no props. Got: "${names[0]}".`),
      ),
    ];
  }

  return yield* scoped(function* () {
    yield* useFailureCollection();
    return yield* expandSegments(segment.children, parentMeta, parentProps, hideSet, counter);
  });
}

function* expandComponent(
  name: string,
  props: Record<string, Json>,
  expressions: Record<string, string>,
  children: Segment[],
  selfClosing: boolean,
  hideSet: Set<string>,
  counter: BlockCounter,
  projectedEnv?: EvalEnv,
  position?: SourcePosition,
  /** The invoking frame's meta and props, for content this element projects. */
  callerMeta: Record<string, unknown> = {},
  callerProps: Record<string, Json> = {},
): Operation<Segment[]> {
  // Cycle detection — Prosser's algorithm
  if (hideSet.has(name)) {
    return [
      yield* raise({
        type: "error",
        message: `Cycle detected: ${name} is already being expanded (hide set: ${[...hideSet].join(" → ")})`,
        source: name,
      }),
    ];
  }

  if (hideSet.size >= MAX_EXPANSION_DEPTH) {
    return [
      yield* raise({
        type: "error",
        message: `Maximum expansion depth (${MAX_EXPANSION_DEPTH}) exceeded`,
        source: name,
      }),
    ];
  }

  let imported: ComponentDefinition | FunctionComponentDefinition;
  try {
    imported = yield* importComponent(name);
  } catch (error) {
    // Import is a durable effect, so it is the other place a stale journal
    // entry can surface.
    const fatal = fatalCause(error);
    if (fatal !== undefined) {
      throw fatal;
    }
    return [
      yield* raise({
        type: "error",
        message:
          error instanceof Error
            ? `Failed to import component ${name}: ${error.message}`
            : `Failed to import component ${name}: ${String(error)}`,
        source: name,
      }),
    ];
  }

  // Function component: call the generator function directly
  if (imported.kind === "function") {
    return yield* expandFunctionComponent(
      name,
      props,
      expressions,
      children,
      selfClosing,
      imported,
      hideSet,
      counter,
      projectedEnv,
      position,
      callerMeta,
      callerProps,
    );
  }

  const definition = imported;

  const placementError = validateBodyStructure(definition.bodySegments, definition.returns);
  if (placementError) {
    return [yield* raise(placementError)];
  }

  // `as` names a binding, so it is rejected on the expression itself rather
  // than on a resolved value. Evaluating it first would make the outcome
  // depend on the host: a bare identifier that happens to name a global
  // resolves on one runtime and throws ReferenceError on another.
  if ("as" in expressions) {
    return [
      yield* raise({
        type: "error",
        message: `Prop "as" on <${name} /> must be a string literal.`,
        source: name,
      }),
    ];
  }

  // Resolve eval expression props against env.values using the shared
  // VM context. This must happen before validation so that resolved
  // values can be type-checked. See spec §5.1 (expression prop evaluation).
  let resolvedProps: Record<string, Json>;
  try {
    resolvedProps = yield* resolveExpressionProps(props, expressions, name, projectedEnv);
  } catch (error) {
    return [
      yield* raise({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        source: name,
      }),
    ];
  }

  // Validate caller props against the component's declared props schema.
  // Strip the `slot` prop before validation — it is consumed by the
  // expansion engine for slot assignment, not forwarded to the child.
  let validatedProps: Record<string, Json>;
  let asBinding: string | undefined;
  try {
    const binding = validateBindingName(resolvedProps.as);
    if (!binding.ok) {
      throw new Error(`Prop "as" on <${name} /> ${binding.error.message}`);
    }
    asBinding = binding.value;

    const { slot: _slot, as: _as, ...propsForValidation } = resolvedProps;
    validatedProps = validateProps(name, propsForValidation, definition.props);
  } catch (error) {
    return [yield* raise(schemaValidationErrorSegment(error, name))];
  }

  if (definition.returns !== undefined && asBinding === undefined) {
    return [
      yield* raise({
        type: "error",
        message:
          `<${name} /> declares \`returns\`, so it renders nothing and must be invoked ` +
          `with \`as\`: <${name} as="binding" />.`,
        source: name,
      }),
    ];
  }

  // Capture the caller's eval environment before creating the component's
  // own env. Children are caller-provided content — expression props like
  // {pr} should resolve against the scope where the JSX was written, not
  // the component that renders <Content />.
  //
  // For multi-level nesting (Root → Provider → Instruction → ReviewBody),
  // the projectedEnv from the outer caller must be merged with the current
  // context env so that ancestor bindings propagate through all levels.
  // The current context env's bindings take precedence (innermost-wins).
  const contextEnv = yield* env;
  const callerEvalEnv = projectedEnv
    ? { values: { ...projectedEnv.values, ...(contextEnv?.values ?? {}) } }
    : contextEnv;

  // Recurse with augmented hide set.
  // Each component gets its own fresh binding environment so that
  // eval blocks within a component share bindings but don't leak
  // into parent or sibling components. This is critical for the
  // provider pattern where each provider has isolated port/URL bindings.
  //
  // Each component also gets its own EvalScope, created as a child of
  // the parent component's eval scope. This ensures that middleware
  // installed via `persist eval` blocks (e.g., Sample.around()) is
  // scoped to the component. Nested providers produce a scope chain
  // where innermost middleware runs first (innermost-wins), and
  // next() delegates to the parent scope's middleware.
  const newHideSet = new Set([...hideSet, name]);
  const componentEnv: EvalEnv = { values: { ...validatedProps } };

  // Children are caller-provided content, not the component's own body.
  // Use the parent's hide set (without the current component name) so
  // that caller-provided children can reference the same component name
  // without triggering false cycle detection. True cycles in a component's
  // body are still caught because body expansion uses newHideSet.
  //
  // Use the caller's eval env for the same reason: expression props (e.g.
  // {pr}) resolve against the scope where the JSX was written.
  const capturedCallerEnv = callerEvalEnv ?? componentEnv;
  // A body eval block can render errors away through a string projection
  // (renderChildren, render, useContent); the collector records them so an
  // `as=` capture can be refused (§6.5).
  const bodyContentErrors: Segment[] = [];

  // Read before the invocation exists: the eval scope ambient here is the
  // caller's, and it is what `retain()` creates resources in. The loop is read
  // here for the same reason — it is the one the caller's content was written
  // in, and the invocation is about to clear it for the component's own body.
  const siteEvalScope = yield* evalScope;
  const siteLoop = yield* ActiveLoop.get();

  // Both bodies run inside one invocation, so a value component owns its
  // resources exactly like a rendered one.
  let claimProjection: ClaimFn = passthroughClaim;

  function* installInvocation(invocation: Invocation): Operation<void> {
    const enclosing = yield* ActiveProjection.get();
    const handle = createProjectionHandle({
      invocation,
      enclosing,
      children,
      callerEnv: capturedCallerEnv,
      meta: definition.meta,
      props: validatedProps,
      hideSet,
      counter,
      callerLoop: siteLoop,
      collect: bodyContentErrors,
    });
    // Published on the eval scope, which every task the invocation owns
    // descends from — including its persist-eval blocks and its content.
    invocation.evalScope.scope.set(ActiveProjection, handle);
    claimProjection = handle.claim;

    // The component's own body is isolated from the loop that invoked it: a
    // `<Break>` written here belongs to a `<Loop>` written here. Set on the body
    // task, which the content scope descends from — so each projection restores
    // the caller's frame for the caller's own text (createProjectionHandle),
    // and anything the body does outside a projection finds none.
    yield* ActiveLoop.set(undefined);

    // Installed on the invocation's own body task rather than a nested
    // scoped(): anything the body acquires must still be alive when teardown
    // halts the content scope, and it is released by the body's own stage.
    yield* provideEnv(componentEnv);
    yield* provideEvalScope(invocation.evalScope);
    yield* provideRetain(siteEvalScope);

    // Render closures (spec §4.8). Non-serializable, so serializeExports
    // omits them from the journal. The optional policy is supplied by a
    // persistent evaluation's binding snapshot (§4.3), which knows the policy of the
    // block that started the projection; an ordinary block leaves it unset and
    // the projection site's policy applies.
    componentEnv.values.renderChildren = (override?: unknown, policy?: ErrorPolicy) =>
      handle.projectToString({
        kind: "children",
        override: validateRenderOverride(override),
        policy,
      });
    componentEnv.values.render = (markdown: unknown, policy?: ErrorPolicy) =>
      handle.projectToString({
        kind: "markdown",
        segments: scanSegments(String(markdown)),
        policy,
      });
    componentEnv.values.useContent = (slot?: unknown, policy?: ErrorPolicy) =>
      handle.projectToString({
        kind: "slot",
        name: slot === undefined ? undefined : String(slot),
        policy,
      });
  }

  const returns = definition.returns;
  if (returns !== undefined) {
    let value: Json;
    try {
      value = yield* withInvocation(function* (invocation) {
        yield* installInvocation(invocation);
        return yield* expandValueBody(
          name,
          returns,
          definition.bodySegments,
          children,
          definition.meta,
          validatedProps,
          newHideSet,
          counter,
          callerEvalEnv ?? undefined,
          claimProjection,
        );
      });
    } catch (error) {
      // Body fail-fast propagates unchanged; a return-value failure is the
      // component's own diagnostic and follows the caller's policy.
      const fatal = fatalCause(error);
      if (fatal !== undefined) {
        throw fatal;
      }
      return [yield* raise(schemaValidationErrorSegment(error, name))];
    }

    // Bind only after the invocation has torn down, so the value reaches the
    // caller's environment and never the component's own.
    const parentEnv = yield* env;
    if (!parentEnv || asBinding === undefined) {
      return [
        yield* raise({
          type: "error",
          message: `Prop "as" on <${name} /> requires a parent evaluation environment.`,
          source: name,
        }),
      ];
    }
    parentEnv.values[asBinding] = value;
    return [];
  }

  const expanded = yield* withInvocation(function* (invocation) {
    yield* installInvocation(invocation);
    return yield* expandBody(
      definition.bodySegments,
      children,
      definition.meta,
      validatedProps,
      newHideSet,
      counter,
      callerEvalEnv ?? undefined,
      claimProjection,
    );
  });

  if (asBinding) {
    // A capture never swallows an error. The body reported these where they
    // were created (§6.9) — including the ones a string projection rendered
    // away — so they are handed back as they are and the binding stays unset.
    // Recorded errors precede expanded ones regardless of source position;
    // the order across the two lists is deliberately unspecified.
    const errors = [
      ...bodyContentErrors,
      ...expanded.filter((capturedSegment) => capturedSegment.type === "error"),
    ];
    if (errors.length > 0) {
      return errors;
    }

    const parentEnv = yield* env;
    if (!parentEnv) {
      return [
        yield* raise({
          type: "error",
          message: `Prop "as" on <${name} /> requires a parent evaluation environment.`,
          source: name,
        }),
      ];
    }
    parentEnv.values[asBinding] = renderSegments(expanded);
    return [];
  }

  return expanded;
}

// Without `returns`, a function component's rendering is its return value, so
// anything else is a contract violation rather than something to stringify.
function asText(output: Json): string {
  if (typeof output !== "string") {
    throw new Error(
      `returned a non-string (${output === null ? "null" : typeof output}). ` +
        "A component renders text unless it declares `returns`.",
    );
  }
  return output;
}

/**
 * The engine's own content failure — the only one the invocation boundary turns
 * back into transported segments. An author who constructs and throws a
 * `ContentError` is reporting a component error, not moving errors that were
 * already observed, so it cannot inject unobserved segments into the document.
 *
 * Under a throwing policy the original `DocumentationError` travels as the
 * cause, which is how the boundary restores it by identity when the component
 * does not recover.
 */
class ContentExpansionFailure extends ContentError {
  constructor(errors: readonly ErrorSegment[], cause?: DocumentationError) {
    super(errors);
    this.cause = cause;
  }
}

function errorSegments(segments: Segment[]): ErrorSegment[] {
  return segments.filter((segment) => segment.type === "error");
}

/**
 * Carries a non-Error value a function component threw. The invocation
 * boundary transports failures as Errors — `withInvocation` wraps anything
 * else with `asError`, which keeps the string but loses the value — so the
 * value rides across in this carrier and the diagnostic is translated from
 * the exact value the component threw, `undefined` included.
 */
class ThrownValue extends Error {
  constructor(readonly value: unknown) {
    super(String(value));
  }
}

/**
 * Report a diagnostic built from a failure, keeping that failure reachable
 * underneath whatever settlement produces.
 *
 * The diagnostic is what the document says, and under a throwing policy the
 * `DocumentationError` carrying it is what the execution fails with. The failure
 * it was built from is the structural account of how the component got there —
 * a component that recovered from failed content and then reported a failure of
 * its own is the only place the original content failure survives.
 *
 * The link is attributed to the segment before it is raised, so settlement
 * constructs a failure that already carries it: middleware that catches what
 * `raise` throws is an observer like any other, and there is no moment in which
 * this diagnostic exists without its account. The observation itself is still the
 * single `raise` of the segment.
 */
function raiseFrom(segment: ErrorSegment, from: unknown): Operation<ErrorSegment> {
  attributeCause(segment, from);
  return raise(segment);
}

/**
 * Expand a function component (.ts file).
 *
 * Function components are generator functions that return a rendered
 * string. They receive validated props, raw child segments, and an
 * `expandChildren` helper that renders children.
 */
function* expandFunctionComponent(
  name: string,
  props: Record<string, Json>,
  expressions: Record<string, string>,
  children: Segment[],
  selfClosing: boolean,
  definition: FunctionComponentDefinition,
  hideSet: Set<string>,
  counter: BlockCounter,
  projectedEnv?: EvalEnv,
  position?: SourcePosition,
  /** The invoking frame's meta and props, for content this component projects. */
  callerMeta: Record<string, unknown> = {},
  callerProps: Record<string, Json> = {},
): Operation<Segment[]> {
  if ("as" in expressions) {
    return [
      yield* raise({
        type: "error",
        message: `Prop "as" on <${name} /> must be a string literal.`,
        source: name,
      }),
    ];
  }

  // Captures are the engine's to hand over unresolved, like `slot` and `as` are
  // the engine's to consume: they never meet the JSON gate below, and never
  // appear in `validatedProps`.
  const captured = new Set(definition.captures ?? []);
  const literalCaptures: Record<string, Json> = {};
  const expressionCaptures: Record<string, string> = {};
  const openProps: Record<string, Json> = {};
  const openExpressions: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (captured.has(key)) {
      literalCaptures[key] = value;
    } else {
      openProps[key] = value;
    }
  }
  for (const [key, value] of Object.entries(expressions)) {
    if (captured.has(key)) {
      expressionCaptures[key] = value;
    } else {
      openExpressions[key] = value;
    }
  }

  // Resolve expression props
  let resolvedProps: Record<string, Json>;
  try {
    resolvedProps = yield* resolveExpressionProps(openProps, openExpressions, name, projectedEnv);
  } catch (error) {
    return [
      yield* raise({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        source: name,
      }),
    ];
  }

  // Strip slot prop before validation
  const asBindingResult = validateBindingName(resolvedProps.as);
  if (!asBindingResult.ok) {
    return [
      yield* raise({
        type: "error",
        message: `Prop "as" on <${name} /> ${asBindingResult.error.message}`,
        source: name,
      }),
    ];
  }
  const asBinding = asBindingResult.value;
  const { slot: _slot, as: _as, ...propsForValidation } = resolvedProps;

  // Validate props
  let validatedProps: Record<string, Json>;
  try {
    validatedProps = validateProps(name, propsForValidation, definition.props);
  } catch (error) {
    return [yield* raise(schemaValidationErrorSegment(error, name))];
  }

  const returns = definition.returns;
  if (returns !== undefined && asBinding === undefined) {
    return [
      yield* raise({
        type: "error",
        message:
          `<${name} /> declares \`returns\`, so it renders nothing and must be invoked ` +
          `with \`as\`: <${name} as="binding" />.`,
        source: name,
      }),
    ];
  }

  // Read before the invocation exists: the eval scope ambient here is the
  // caller's, and it is what `retain()` creates resources in. The loop is read
  // here for the same reason — see expandComponent.
  const siteEvalScope = yield* evalScope;
  const siteLoop = yield* ActiveLoop.get();

  // Resolved once, here: an operand is what the call site meant, not what the
  // component's own body later did to the environment.
  const siteEnv = yield* env;
  const captureEnv: Record<string, unknown> = {
    ...(projectedEnv?.values ?? {}),
    ...(siteEnv?.values ?? {}),
  };

  /** The invocation itself, and what a failure of it means. */
  const invoke = function* (): Operation<Segment[]> {
    // Detached and frozen: what a component reads about its call site is a copy,
    // so nothing it does can reach the element the parser built.
    const metadata: ComponentInvocationMetadata = Object.freeze(
      position === undefined
        ? { name }
        : {
            name,
            position: Object.freeze({
              ...(position.path === undefined ? {} : { path: position.path }),
              offset: position.offset,
              line: position.line,
              column: position.column,
            }),
          },
    );

    // Call the function component inside its invocation, with content middleware
    // in scope so it can render its invocation content through `yield* content()`.
    try {
      const output: unknown = yield* withInvocation(function* (invocation) {
        const enclosing = yield* ActiveProjection.get();
        const handle = createProjectionHandle({
          invocation,
          enclosing,
          children,
          // A function component's content inherits whatever environment the
          // component installed for it — see ProjectionState.callerEnv.
          callerEnv: undefined,
          // ...but the content itself is the CALLER's markdown, so `{meta.x}`
          // and `{props.x}` in it resolve against the frame that wrote it. The
          // Api form of `expandSegments` carries this through ExpansionFrame;
          // projection has to be handed it.
          meta: callerMeta,
          props: callerProps,
          hideSet,
          counter,
          callerLoop: siteLoop,
        });
        invocation.evalScope.scope.set(ActiveProjection, handle);

        yield* ActiveLoop.set(undefined);
        yield* provideEvalScope(invocation.evalScope);
        yield* provideRetain(siteEvalScope);
        yield* Component.around(
          {
            *content([slotName], _next) {
              let segments: Segment[];
              try {
                segments = yield* handle.project({ kind: "slot", name: slotName });
              } catch (error) {
                // A throwing policy already decided this execution fails; the call
                // site still sees the public shape, and the original failure
                // travels as the cause so the boundary can restore it.
                if (error instanceof DocumentationError) {
                  throw new ContentExpansionFailure([error.segment], error);
                }
                throw error;
              }
              const errors = errorSegments(segments);
              if (errors.length > 0) {
                throw new ContentExpansionFailure(errors);
              }
              return renderSegments(segments);
            },
            // The element's shape, not its rendered result: content that renders
            // an empty string is still content.
            // deno-lint-ignore require-yield
            *hasContent(_args, _next) {
              return !selfClosing;
            },
            // deno-lint-ignore require-yield
            *invocation(_args, _next) {
              return metadata;
            },
            // deno-lint-ignore require-yield
            *hasCapture([captureName], _next) {
              return captureName in literalCaptures || captureName in expressionCaptures;
            },
            *capture([captureName], _next) {
              if (captureName in literalCaptures) {
                return literalCaptures[captureName];
              }
              const expression = expressionCaptures[captureName];
              if (expression === undefined) {
                throw new Error(`<${name} /> was not written with a "${captureName}" prop.`);
              }
              // Evaluated here, not during prop resolution: the component asked
              // for it, and owns whatever the expression does. Against the site
              // environment resolved before the invocation began.
              return yield* evaluateExpression(expression, name, captureName, {
                values: captureEnv,
              });
            },
            *tryContent([slotName], _next) {
              const outcome = yield* handle.tryProject({ kind: "slot", name: slotName });
              // A documentation failure is presented in the public shape, as
              // `content()` does, so a component recovering from one sees the
              // same thing either way.
              const failure =
                outcome.failure instanceof DocumentationError
                  ? new ContentExpansionFailure([outcome.failure.segment], outcome.failure)
                  : outcome.failure;
              return failure === undefined
                ? { text: renderSegments(outcome.segments) }
                : { text: renderSegments(outcome.segments), failure };
            },
          },
          { at: "min" },
        );
        // Projection honored the way expandComponent and expandEach honor it:
        // a component written inside content projected through <Content /> sees
        // the lexical caller's bindings under the current component's, so what
        // it reads is what its author wrote beside it.
        if (projectedEnv) {
          const siteEnv = yield* env;
          yield* Component.around(
            {
              env: () => ({
                values: { ...projectedEnv.values, ...(siteEnv?.values ?? {}) },
              }),
            },
            { at: "min" },
          );
        }
        try {
          return yield* definition.fn(validatedProps);
        } catch (error) {
          if (error instanceof Error) {
            throw error;
          }
          throw new ThrownValue(error);
        }
      });
      if (asBinding) {
        const parentEnv = yield* env;
        if (!parentEnv) {
          return [
            yield* raise({
              type: "error",
              message: `Prop "as" on <${name} /> requires a parent evaluation environment.`,
              source: name,
            }),
          ];
        }
        // By reference by default: the binding is the value the component
        // returned. `returns` is the opt-in that says this one is a validated
        // JSON record, and it is checked before binding.
        parentEnv.values[asBinding] =
          returns === undefined ? output : validateReturnValue(name, parseJson(output), returns);
        return [];
      }
      // Without `as` there is nowhere to bind, so only text can be observed:
      // a string renders, and anything else renders nothing rather than being
      // stringified into the document.
      return typeof output === "string" ? [{ type: "text", content: output }] : [];
    } catch (error) {
      // Everything below runs after `withInvocation()` has dismantled the
      // invocation, so what is handled here accounts for the body and its
      // teardown together.

      // Not the document's failure to render: a journal that no longer describes
      // this run, or a policy that has already decided the document fails.
      const fatal = fatalCause(error);
      if (fatal !== undefined) {
        throw fatal;
      }
      // The content the component asked for failed and it did not recover, so the
      // invocation is replaced by what the projection already reported (§6.9) and
      // reporting it again here would double-observe it.
      if (error instanceof ContentExpansionFailure) {
        if (error.cause instanceof DocumentationError) {
          throw error.cause;
        }
        return [...error.errors];
      }
      // A return that failed its schema already names the component and carries
      // its issues; wrapping it would bury both.
      if (error instanceof SchemaValidationError) {
        return [yield* raise(schemaValidationErrorSegment(error, name))];
      }
      // An ordinary failure. Whether the document carries on is the nearest
      // collection boundary's decision, and the default is that it does not.
      const thrown = error instanceof ThrownValue ? error.value : error;
      return [
        yield* handleFailure({
          name,
          ...(metadata.position === undefined ? {} : { position: metadata.position }),
          error: asFailure(thrown),
        }),
      ];
    }
  };

  // The boundary sits outside the whole invocation, so it is still installed
  // while the invocation is being dismantled — middleware a component installs
  // for itself is gone by then. Outside also puts nested components and
  // projected content inside it, since their scopes descend from this one.
  // Scoped, so a component that collects its own failures does not quietly
  // decide the same for its siblings.
  if (collectsFailures(definition.fn)) {
    return yield* scoped(function* () {
      yield* useFailureCollection();
      return yield* invoke();
    });
  }
  return yield* invoke();
}

/**
 * The thrown value as an `Error`.
 *
 * An `Error` is kept by identity, so its type and cause survive. Anything else
 * becomes one carrying the original value as its cause, because a component may
 * throw whatever it likes and none of it should be lost.
 */
function asFailure(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown), { cause: thrown });
}

export function validateBindingName(value: Json | undefined): Result<string | undefined> {
  if (value === undefined) {
    return Ok(undefined);
  }
  if (typeof value !== "string") {
    return Err(new Error("must be a non-empty string literal."));
  }
  if (value.length === 0) {
    return Err(new Error("must be non-empty."));
  }
  if (!IDENTIFIER_RE.test(value)) {
    return Err(new Error(`must be a valid JavaScript identifier. Got: "${value}"`));
  }
  // The identifier shape is not sufficient: reserved and contextual words
  // (in, let, await, ...) match the regex but cannot form an ES-module
  // binding, which is where these names end up (eval preamble destructures
  // `const { name } = env;`). Parse the destructuring shape to reject them.
  if (!isModuleBindingName(value)) {
    return Err(new Error(`must be a valid JavaScript binding name. Got: "${value}"`));
  }
  return Ok(value);
}

function isModuleBindingName(name: string): boolean {
  try {
    parse(`const { ${name} } = 0;`, { ecmaVersion: "latest", sourceType: "module" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve eval expression props against env.values using the shared VM
 * context. Merges resolved values into the props record.
 *
 * Expression props are stored as raw expression text in the
 * `expressions` field of `ComponentElement`. At expansion time,
 * they are evaluated as JavaScript using `new Function()` with
 * `env.values` destructured into scope.
 *
 * Errors are thrown (not ErrorSegments), consistent with prop validation.
 *
 * Uses `new Function()` instead of `node:vm` — Deno's permission model
 * provides the security boundary. The expression text comes from the
 * document author (trusted), and results must pass serialization check.
 */
function* resolveExpressionProps(
  props: Record<string, Json>,
  expressions: Record<string, string>,
  componentName: string,
  explicitEnv?: EvalEnv,
): Operation<Record<string, Json>> {
  // Start with already-resolved props
  const resolved = { ...props };

  // Nothing to evaluate
  if (Object.keys(expressions).length === 0) {
    return resolved;
  }

  const evalEnv = yield* expressionEnv(componentName, Object.keys(expressions), explicitEnv);

  for (const [propName, expression] of Object.entries(expressions)) {
    const result = evaluateIn(evalEnv, expression, componentName, propName);

    if (typeof result === "function" || typeof result === "undefined") {
      throw new Error(
        `Expression prop "${propName}" on <${componentName} /> evaluated ` +
          `to a non-serializable value (${typeof result}). Props must be ` +
          `JSON-serializable.`,
      );
    }

    try {
      resolved[propName] = parseJson(JSON.parse(JSON.stringify(result)));
    } catch {
      throw new Error(
        `Expression prop "${propName}" on <${componentName} /> evaluated ` +
          `to a non-serializable value (${typeof result}). Props must be ` +
          `JSON-serializable.`,
      );
    }
  }

  return resolved;
}

/**
 * Evaluate a single expression and return its raw result. Callers that need
 * JSON decide how to cross that boundary: props normalize through
 * `JSON.stringify`, while a `<Return>` value is parsed strictly so a value
 * that could not survive replay is rejected rather than quietly rewritten.
 */
/**
 * Evaluate one expression prop against the binding environment.
 *
 * Exported within the package because a claimed construct resolves its own
 * props: the expansion hook is offered the element before prop resolution runs,
 * so `<Answers>` and `<Answer>` reach their `value` and `delegate` expressions
 * through here rather than receiving them already evaluated.
 */
export function* evaluateExpression(
  expression: string,
  componentName: string,
  propName: string,
  explicitEnv?: EvalEnv,
): Operation<unknown> {
  const evalEnv = yield* expressionEnv(componentName, [propName], explicitEnv);
  return evaluateIn(evalEnv, expression, componentName, propName);
}

function* expressionEnv(
  componentName: string,
  names: string[],
  explicitEnv?: EvalEnv,
): Operation<EvalEnv> {
  const contextEnv = yield* env;

  // For projected children (substituted via <Content />), merge the
  // caller's env (explicitEnv) with the wrapping component's env
  // (contextEnv). The component's env takes priority because its eval
  // blocks run before <Content /> and may define bindings that children
  // reference. The caller's env provides fallback bindings from the
  const evalEnv =
    explicitEnv && contextEnv
      ? { values: { ...explicitEnv.values, ...contextEnv.values } }
      : (contextEnv ?? explicitEnv);

  if (!evalEnv) {
    throw new Error(
      `Expression props (${names.join(", ")}) on <${componentName} /> cannot be ` +
        `resolved: no eval context available. Expression props require ` +
        `a preceding eval block that defines the referenced bindings.`,
    );
  }
  return evalEnv;
}

function evaluateIn(
  evalEnv: EvalEnv,
  expression: string,
  componentName: string,
  propName: string,
): unknown {
  const envKeys = Object.keys(evalEnv.values);
  const envValues = envKeys.map((key) => evalEnv.values[key]);
  try {
    const fn = new Function(...envKeys, `return (${expression})`);
    return fn(...envValues);
  } catch (error) {
    // The wrapper names where evaluation failed; `cause` keeps what actually
    // failed, so an author's own error survives by identity rather than being
    // replaced by a description of it.
    throw new Error(
      `Failed to evaluate expression prop "${propName}={${expression}}" ` +
        `on <${componentName} />: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Slot name validation pattern: must start with a letter, followed by
 * letters, digits, underscores, or hyphens.
 */
const SLOT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function schemaValidationErrorSegment(error: unknown, name: string): ErrorSegment {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SchemaValidationError) {
    return {
      type: "error",
      message,
      source: name,
      cause: parseJson({ componentName: error.componentName, errors: error.issues }),
    };
  }
  return { type: "error", message, source: name };
}

/**
 * Validate a slot name. Returns an ErrorSegment if invalid, undefined if ok.
 */
function validateSlotName(name: string, source: string): ErrorSegment | undefined {
  if (name === "") {
    return {
      type: "error",
      message: "Invalid slot name: slot name must not be empty",
      source,
    };
  }
  if (!SLOT_NAME_RE.test(name)) {
    return {
      type: "error",
      message: `Invalid slot name "${name}": must match [a-zA-Z][a-zA-Z0-9_-]*`,
      source,
    };
  }
  return undefined;
}

/**
 * Slot assignment: returns the slot name if the segment is a component
 * invocation with a `slot` prop, undefined otherwise.
 *
 * Only ComponentElement segments can carry a `slot` prop. Text
 * segments and code blocks are always default-slot content.
 */
function getSlotAssignment(segment: Segment): string | undefined {
  if (segment.type === "component" && segment.props.slot !== undefined) {
    return String(segment.props.slot);
  }
  return undefined;
}

/**
 * Slot map produced by partitionBySlot.
 */
export interface SlotMap {
  /** Children without a `slot` prop. */
  default: Segment[];
  /** Children keyed by slot name. */
  named: Map<string, Segment[]>;
  /** Validation errors from invalid slot names. */
  errors: ErrorSegment[];
}

/**
 * Partition children into slot buckets. Only ComponentElement segments
 * with a `slot` prop are assigned to named slots. Everything else goes
 * to the default slot.
 *
 * Invalid slot names produce ErrorSegments in the `errors` array.
 */
export function partitionBySlot(children: Segment[]): SlotMap {
  const named = new Map<string, Segment[]>();
  const defaultSlot: Segment[] = [];
  const errors: ErrorSegment[] = [];

  for (const child of children) {
    const slotName = getSlotAssignment(child);
    if (slotName !== undefined) {
      const error = validateSlotName(slotName, `slot="${slotName}"`);
      if (error) {
        errors.push(error);
        continue;
      }
      let bucket = named.get(slotName);
      if (!bucket) {
        bucket = [];
        named.set(slotName, bucket);
      }
      bucket.push(child);
    } else {
      defaultSlot.push(child);
    }
  }

  return { default: defaultSlot, named, errors };
}

/**
 * Strip the `slot` prop from a segment. Returns a shallow clone with
 * `slot` removed from props. Non-component segments pass through unchanged.
 */
export function stripSlotProp(segment: Segment): Segment {
  if (segment.type === "component" && "slot" in segment.props) {
    const { slot: _, ...rest } = segment.props;
    return { ...segment, props: rest };
  }
  return segment;
}

type ProjectFn = (segments: Segment[]) => Segment[];

/**
 * Marks a `<Content />` element as carrying a resolved projection. Identity,
 * not a name or a segment type, is what separates it from a `<Content />` an
 * author wrote somewhere the engine does not project.
 */
type ClaimFn = (element: ComponentElement) => ComponentElement;

const passthroughClaim: ClaimFn = (element) => element;

/** Mutable flag so slot validation errors are emitted only once. */
interface SubstitutionState {
  errorsEmitted: boolean;
}

/**
 * Build the projection function that tags substituted children with the
 * caller's eval env so their expression props resolve in the caller's scope.
 */
function makeProjectFn(callerEnv: EvalEnv | undefined): ProjectFn {
  const project: ProjectFn = (segments) => {
    if (!callerEnv) {
      return segments;
    }
    return segments.map((seg) => {
      if (seg.type === "component") {
        return {
          ...seg,
          projectedEnv: callerEnv,
          children: project(seg.children),
        };
      }
      return seg;
    });
  };
  return project;
}

/**
 * Replace `<Content />` / `<Content slot="X" />` in a segment list with the
 * caller's children (partitioned by slot) and interpolate {meta}/{props} in
 * text. Slot validation errors are emitted once, at the first projection
 * point, tracked via the shared `state`.
 */
function substituteSegmentList(
  segments: Segment[],
  slots: SlotMap,
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  project: ProjectFn,
  state: SubstitutionState,
  claim: ClaimFn,
): Segment[] {
  return segments.flatMap((segment): Segment[] => {
    if (segment.type === "component" && segment.name === "Content") {
      const targetSlot = segment.props.slot;
      const pendingErrors = !state.errorsEmitted ? slots.errors : [];
      if (pendingErrors.length > 0) {
        state.errorsEmitted = true;
      }

      // Slot resolution stays here — partitioning, validation and once-only
      // errors are unchanged. What changes is that the resolved segments ride
      // on the element instead of being spliced in, so expansion can run them
      // inside the invocation's content scope rather than its own.
      const projected =
        targetSlot !== undefined
          ? project((slots.named.get(String(targetSlot)) ?? []).map(stripSlotProp))
          : project(slots.default);
      const element: ComponentElement = { ...segment, children: projected, selfClosing: false };
      return [...pendingErrors, claim(element)];
    }
    if (segment.type === "text") {
      return [{ ...segment, content: interpolate(segment.content, meta, props) }];
    }
    return [segment];
  });
}

/**
 * Replace `<Content />` and `<Content slot="X" />` invocations with the
 * caller's children, partitioned by slot assignment.
 * Also interpolates {meta.key} and {props.key} in text segments.
 *
 * When no `slot` props are present anywhere, this behaves identically
 * to the original single-slot substituteContent.
 */
function substituteContent(
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  callerEnv: EvalEnv | undefined,
  claim: ClaimFn,
): Segment[] {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);
  return substituteSegmentList(bodySegments, slots, meta, props, project, state, claim);
}

interface BodyChunk {
  /** true = a rendered `<Output>` region; false = documentation (executed, not rendered). */
  output: boolean;
  segments: Segment[];
}

function isTopLevelOutput(segment: Segment): boolean {
  return segment.type === "component" && segment.name === "Output";
}

export function bodyHasOutput(bodySegments: Segment[]): boolean {
  return bodySegments.some(isTopLevelOutput);
}

function misplacedOutputError(): ErrorSegment {
  return {
    type: "error",
    message:
      "<Output> must be a direct top-level child of the component or document " +
      "that declares it. For conditional rendering, use <If> inside <Output>.",
    source: "Output",
  };
}

function misplacedReturnError(segment: ComponentElement): ErrorSegment {
  return {
    type: "error",
    message:
      `${previewReturn(segment)} must be a direct top-level child of the document or ` +
      "component whose `returns` declaration it satisfies. <Return> is reserved: it " +
      "never resolves a component, and content a caller projects cannot declare one.",
    source: "Return",
  };
}

function previewOutput(segment: ComponentElement): string {
  const text = segment.children
    .filter((child): child is TextSegment => child.type === "text")
    .map((child) => child.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    return "<Output> (empty)";
  }
  const clipped = text.slice(0, 40);
  return `<Output> containing "${clipped}${text.length > 40 ? "…" : ""}"`;
}

/**
 * Structural preflight (spec §6.9). Validates `<Output>` placement against the
 * body's own source AST. Only a direct top-level `<Output>` is a valid
 * declaration; any `<Output>` at depth > 0 — including inside unreachable or
 * discarded children — is a placement violation. All violations are combined
 * into a single aggregate ErrorSegment. Returns undefined when placement is
 * valid.
 */
export function validateOutputPlacement(bodySegments: Segment[]): ErrorSegment | undefined {
  const violations: string[] = [];

  const walk = (segments: Segment[], depth: number): void => {
    for (const segment of segments) {
      if (segment.type !== "component") {
        continue;
      }
      if (segment.name === "Output" && depth > 0) {
        violations.push(previewOutput(segment));
      }
      walk(segment.children, depth + 1);
    }
  };

  walk(bodySegments, 0);

  if (violations.length === 0) {
    return undefined;
  }

  const list = violations.map((entry) => `  - ${entry}`).join("\n");
  return {
    type: "error",
    message:
      "<Output> must be a direct top-level child of the component or document " +
      "that declares it. For conditional rendering, use <If> inside " +
      `<Output>. Misplaced <Output> found:\n${list}`,
    source: "Output",
  };
}

export function isTopLevelReturn(segment: Segment): segment is ComponentElement {
  return segment.type === "component" && segment.name === "Return";
}

function previewReturn(segment: ComponentElement): string {
  if ("value" in segment.expressions) {
    return `<Return value={${segment.expressions.value}} />`;
  }
  if ("value" in segment.props) {
    return `<Return value=${JSON.stringify(segment.props.value)} />`;
  }
  return "<Return />";
}

function structureError(source: string, headline: string, violations: string[]): ErrorSegment {
  const list = violations.map((entry) => `  - ${entry}`).join("\n");
  return { type: "error", message: `${headline}\n${list}`, source };
}

function collectReturns(bodySegments: Segment[]): {
  topLevel: ComponentElement[];
  nested: string[];
} {
  const topLevel: ComponentElement[] = [];
  const nested: string[] = [];

  const walk = (segments: Segment[], depth: number): void => {
    for (const segment of segments) {
      if (segment.type !== "component") {
        continue;
      }
      if (segment.name === "Return") {
        if (depth === 0) {
          topLevel.push(segment);
        } else {
          nested.push(`${previewReturn(segment)} is not a direct top-level child`);
        }
      }
      walk(segment.children, depth + 1);
    }
  };

  walk(bodySegments, 0);
  return { topLevel, nested };
}

function returnElementViolations(segment: ComponentElement): string[] {
  const violations: string[] = [];
  const names = [...Object.keys(segment.props), ...Object.keys(segment.expressions)];
  const extra = names.filter((name) => name !== "value");
  if (extra.length > 0) {
    violations.push(`${previewReturn(segment)} accepts only a "value" prop, got "${extra[0]}"`);
  }
  if (!names.includes("value")) {
    violations.push(`${previewReturn(segment)} requires a "value" prop`);
  }
  if (segment.children.length > 0) {
    violations.push(`${previewReturn(segment)} takes no children`);
  }
  return violations;
}

function textModeReturnError(bodySegments: Segment[]): ErrorSegment | undefined {
  const { topLevel, nested } = collectReturns(bodySegments);
  if (topLevel.length === 0 && nested.length === 0) {
    return undefined;
  }
  const found = [...topLevel.map(previewReturn), ...nested];
  return structureError(
    "Return",
    "<Return> requires a document or component that declares `returns`. Declare a " +
      "return schema, or remove <Return>. Found:",
    found,
  );
}

function valueModeStructureError(bodySegments: Segment[]): ErrorSegment | undefined {
  const violations: string[] = [];

  const walkOutput = (segments: Segment[]): void => {
    for (const segment of segments) {
      if (segment.type !== "component") {
        continue;
      }
      if (segment.name === "Output") {
        violations.push(`${previewOutput(segment)} — <Output> and \`returns\` are exclusive`);
      }
      walkOutput(segment.children);
    }
  };
  walkOutput(bodySegments);

  const { topLevel, nested } = collectReturns(bodySegments);
  violations.push(...nested);

  if (topLevel.length === 0) {
    violations.push("no direct top-level <Return>");
  }
  for (const duplicate of topLevel.slice(1)) {
    violations.push(`${previewReturn(duplicate)} is a duplicate declaration`);
  }
  for (const declaration of topLevel) {
    violations.push(...returnElementViolations(declaration));
  }

  if (violations.length === 0) {
    return undefined;
  }
  return structureError(
    "Return",
    "A component that declares `returns` renders nothing and produces exactly one " +
      "value through a direct top-level <Return>. Problems found:",
    violations,
  );
}

/**
 * Structural preflight for a body's output and return contract (spec §6.9,
 * §6.10). Runs against the body's own source AST, before `<Content />`
 * substitution, so projected content can neither introduce nor satisfy a
 * declaration. Every violation is combined into a single ErrorSegment, and a
 * body whose structure is invalid runs no eval, exec, `<Capture>`, or nested
 * component.
 */
export function validateBodyStructure(
  bodySegments: Segment[],
  returns: ReturnsSchema | undefined,
): ErrorSegment | undefined {
  if (returns !== undefined) {
    return valueModeStructureError(bodySegments);
  }
  const outputError = validateOutputPlacement(bodySegments);
  const returnError = textModeReturnError(bodySegments);
  if (outputError && returnError) {
    return {
      type: "error",
      message: `${outputError.message}\n\n${returnError.message}`,
      source: "Return",
    };
  }
  return outputError ?? returnError;
}

function validateOutputProps(segment: ComponentElement): ErrorSegment | undefined {
  const hasProps = Object.keys(segment.props).length > 0;
  const hasExpressions = Object.keys(segment.expressions).length > 0;
  if (hasProps || hasExpressions) {
    return { type: "error", message: "<Output> accepts no props.", source: "Output" };
  }
  return undefined;
}

/**
 * Partition a definition body into ordered chunks (spec §6.9). Output policy
 * is determined by definition provenance — top-level `<Output>` segments in
 * the source, before `<Content />` substitution — so caller-projected
 * `<Output>` can neither activate nor alter it. `<Content />` inside a
 * top-level `<Output>` is substituted one level in; slot errors are emitted
 * once across the whole body via the shared substitution state.
 */
function buildBody(
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  callerEnv: EvalEnv | undefined,
  claim: ClaimFn,
): BodyChunk[] {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);
  const chunks: BodyChunk[] = [];

  for (const segment of bodySegments) {
    if (segment.type === "component" && segment.name === "Output") {
      const propsError = validateOutputProps(segment);
      if (propsError) {
        chunks.push({ output: true, segments: [propsError] });
        continue;
      }
      const outputSegments = substituteSegmentList(
        segment.children,
        slots,
        meta,
        props,
        project,
        state,
        claim,
      );
      chunks.push({ output: true, segments: outputSegments });
      continue;
    }

    const docSegments = substituteSegmentList([segment], slots, meta, props, project, state, claim);
    chunks.push({ output: false, segments: docSegments });
  }

  return chunks;
}

/**
 * Expand a definition body (spec §6.9). Without a top-level `<Output>`, the
 * whole body renders (backward compatible). With `<Output>`, only the declared
 * regions render; documentation executes for its side effects under a throwing
 * raise policy (fail-fast) and its rendered result is discarded; output
 * regions set a collecting policy of their own, so their errors render as
 * comments; the caller settles them again on the way out.
 * Regions and documentation run in document order, so output can depend on
 * bindings computed by preceding documentation.
 */
export function* expandBody(
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  callerEnv: EvalEnv | undefined,
  claim: ClaimFn = passthroughClaim,
): Operation<Segment[]> {
  if (!bodyHasOutput(bodySegments)) {
    const substituted = substituteContent(bodySegments, children, meta, props, callerEnv, claim);
    return yield* expandSegments(substituted, meta, props, hideSet, counter);
  }

  const chunks = buildBody(bodySegments, children, meta, props, callerEnv, claim);
  const output: Segment[] = [];

  for (const chunk of chunks) {
    if (chunk.output) {
      const expanded = yield* scoped(function* () {
        yield* AmbientErrorPolicy.set("collect");
        return yield* expandSegments(chunk.segments, meta, props, hideSet, counter);
      });
      output.push(...expanded);
    } else {
      // Documentation: execute for side effects, discard rendered output.
      yield* scoped(function* () {
        yield* AmbientErrorPolicy.set("throw");
        return yield* expandSegments(chunk.segments, meta, props, hideSet, counter);
      });
    }
  }

  return output;
}

/**
 * Run documentation for its side effects and discard what it renders. The
 * throwing policy makes the first error stop the body immediately.
 *
 * Set as a policy value, not as raise middleware: a projection launched from
 * here runs in the invocation's content scope, which inherits the value but
 * would never see middleware installed on this frame.
 */
function runDocumentation(
  segments: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* AmbientErrorPolicy.set("throw");
    return yield* expandSegments(segments, meta, props, hideSet, counter);
  });
}

/**
 * Produce the value a `<Return>` selects. A literal `value` is already JSON; an
 * expression is evaluated raw, at this position in the body, and crosses the
 * JSON boundary during validation.
 */
export function* resolveReturnValue(
  componentName: string,
  returns: ReturnsSchema,
  segment: ComponentElement,
): Operation<Json> {
  const raw =
    "value" in segment.expressions
      ? yield* evaluateExpression(
          segment.expressions.value,
          componentName,
          "value",
          segment.projectedEnv,
        )
      : segment.props.value;
  return validateReturnValue(componentName, raw, returns);
}

/**
 * Expand the body of a value component (spec §6.10) and return its validated
 * value. Everything except the definition-owned `<Return>` is documentation:
 * it executes in document order under fail-fast, and what it renders is
 * discarded. `<Return>` selects the value at its own position — it does not end
 * the body, so documentation after it still runs.
 *
 * The value is returned rather than bound, so the caller owns the binding
 * boundary and the value never enters the component's own environment.
 */
function* expandValueBody(
  componentName: string,
  returns: ReturnsSchema,
  bodySegments: Segment[],
  children: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  callerEnv: EvalEnv | undefined,
  claim: ClaimFn = passthroughClaim,
): Operation<Json> {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);
  let produced: { value: Json } | undefined;

  for (const segment of bodySegments) {
    if (isTopLevelReturn(segment)) {
      produced = { value: yield* resolveReturnValue(componentName, returns, segment) };
      continue;
    }
    const docSegments = substituteSegmentList([segment], slots, meta, props, project, state, claim);
    yield* runDocumentation(docSegments, meta, props, hideSet, counter);
  }

  if (!produced) {
    throw new Error(`<${componentName} /> declares \`returns\` but produced no <Return> value.`);
  }
  return produced.value;
}
