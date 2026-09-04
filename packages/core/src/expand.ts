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

import { ensure, Err, scoped, useScope, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import type {
  FunctionComponent,
  Segment,
  ErrorSegment,
  ComponentElement,
  ComponentDefinition,
  ComponentFailure,
  EvalEnv,
  ExecutableCodeBlock,
  FunctionComponentDefinition,
  Json,
  CodeBlockContext,
  ProgramBody,
  ProgramOutcome,
  ReturnsSchema,
  SourcePosition,
} from "./types.ts";
import {
  bodyHasOutput,
  misplacedOutputMessage,
  misplacedReturnMessage,
  outputPropsViolation,
  validateBodyStructure,
  validateOutputPlacement,
} from "./body-structure.ts";
import {
  breakElementViolations,
  eachCaptureBinding,
  eachItemBinding,
  eachItemsViolation,
  eachViolations,
  ifConditionViolation,
  ifPropsViolation,
  ifStructure,
  letBindingName,
  letViolations,
  loopBound,
  loopMissingBoundMessage,
  loopPropsViolation,
  printErrorsViolations,
  strayBreakMessage,
  strayCaseMessage,
  strayElseMessage,
  strayStructuralMessage,
  switchStructure,
} from "./structural-rules.ts";
import type { StructuralViolation, SwitchCase } from "./structural-rules.ts";
import {
  asBindingViolation,
  asExpressionViolation,
  capturedBinding,
  returnCaptureViolation,
} from "./invocation-rules.ts";
import { interpolate } from "./interpolate.ts";
import { interpolateEvalBindings } from "./eval-interpolate.ts";
import {
  Component,
  applyBoundModifiers,
  applyModifiers,
  env,
  evalScope,
  handleFailure,
  importComponent,
  raise,
} from "./component-api.ts";
import {
  attributeCause,
  ContentError,
  decidedByOutput,
  DocumentationError,
  durabilityFailure,
  ErrorMode,
  fatalCause,
  filesFatalFailure,
  projectedContentFailure,
  SegmentCauses,
  useSegmentCauses,
} from "./errors.ts";
import { printsErrors, usePrintErrors } from "./component-failures.ts";
import { containedLedger, recoveringLedger } from "./component-failures.ts";
import type { CheckedFailures } from "./component-failures.ts";
import type { ExpansionAuthority, ImportedDefinition } from "./components/import-authority.ts";
import {
  INCOMPATIBLE,
  ProgramEvaluationError,
  sameComponents,
  UNIDENTIFIED,
  UNRESOLVED,
} from "./program-identity.ts";
import type { ProgramComponentRef, ResolvedProgramComponent } from "./program-identity.ts";
import { ProgramImports } from "./program-imports.ts";
import { DeclaredMarkdownError } from "./components/declared-markdown.ts";
import type { PrivateImport } from "./components/declared-markdown.ts";
import CoreTest from "./components/Test.ts";
import { carriesTestActivationDecision } from "./test-activation.ts";
import { declaredRouting, withRouting } from "./foreground.ts";
import { issueBoundExec } from "./bound-exec.ts";
import { elementFrame, elementSite, extendPath, publishExpansion, snapshot } from "./expansion.ts";
import type { ExpansionFrame } from "./expansion.ts";
import { isPrivateImplementation, issueInvocation } from "./invocation-identity.ts";
import type { IdentityDomain } from "./invocation-identity.ts";
import { withInvocation } from "./invocation.ts";
import type { Invocation } from "./invocation.ts";
import { ActiveProjection } from "./projection.ts";
import type { ProjectionHandle, ProjectionRequest } from "./projection.ts";
import { ActiveLoop, recordIteration, recordOutcome } from "./loop.ts";
import type { LoopFrame, LoopIdentity, LoopOutcome } from "./loop.ts";
import { createReturnBody, missingReturnMessage } from "./return-flow.ts";
import type { ReturnBody } from "./return-flow.ts";
import { unbox, useEvalScope } from "@effectionx/scope-eval";
import type { EvalScope } from "@effectionx/scope-eval";
import { SchemaValidationError, validateProps, validateReturnValue } from "./validate.ts";
import { parseJson } from "./json.ts";
import { healSegment } from "./heal.ts";
import { scanSegments } from "./scanner.ts";
import { declareChildAnswers, expandAnswers, strayAnswerError } from "./answers.ts";
import { DeclarationScan } from "./declaration-scan.ts";
import { RESERVED_STRUCTURAL } from "./structural.ts";
import { renderSegments } from "./render.ts";
import { markExactSource } from "./output/exact-source.ts";
import {
  layerEnvironments,
  layerProjectedContentEnvironment,
  propsEnvironment,
} from "./eval-env.ts";
import { remark } from "remark";
import { select as cssSelect } from "unist-util-select";
import { toString as mdastToString } from "mdast-util-to-string";
import { liveEnvironment } from "./live-env.ts";
import { TestHarnessComponentDefinition } from "./test-harness.ts";
import type { TestHarnessBinding } from "./test-harness.ts";

export { validateBindingName } from "./live-env.ts";

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
  /** Where this expansion accumulates — its caller's region, or a private buffer. */
  owner: Segment[],
  path: string,
  /** Whether the region that caused this expansion grants recovery (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<Segment[]> {
  return scoped(function* () {
    const overrideEnv = override === undefined ? undefined : { values: override };
    yield* provideEnv(
      layerEnvironments(callerEnv, overrideEnv, false) ?? {
        values: {},
      },
    );
    if (scope) {
      yield* provideEvalScope(scope);
    }
    return yield* expandSegmentsWithin(
      segments,
      meta,
      props,
      hideSet,
      counter,
      owner,
      path,
      0,
      checkedFailures,
      authority,
      returnBody,
    );
  });
}

interface ProjectionState {
  invocation: Invocation;
  /**
   * Raised for the whole of one projection of this invocation's own content.
   *
   * Everything nested is reached through here, so this is where an invocation
   * stops naming itself: a durable identity claimed while it is raised is being
   * claimed by something inside the content, not by the invocation that owns it
   * (`component-invocation.ts`). A Markdown body has no issuance to raise.
   */
  projecting?: () => () => void;
  enclosing: ProjectionHandle | undefined;
  children: Segment[];
  caller: ProjectionFrame;
  authored: ProjectionFrame;
  counter: BlockCounter;
  /**
   * The loop active where the caller wrote the content it projects, read at
   * the invocation site before the invocation cleared it for its own body.
   * Projected content is the caller's text, so a `<Break>` in it means the
   * loop the author could see.
   */
  callerLoop: LoopFrame | undefined;
  /**
   * The value body active where the caller wrote the content it projects, read
   * at the invocation site before the invocation cleared it for its own body.
   * Projected content is the caller's text, so a `<Return>` in it satisfies the
   * declaration the author could see.
   */
  callerReturn: ReturnBody | undefined;
  /**
   * This invocation's own structural path (§5.6). A projection is identified by
   * the invocation that performed it, so the same authored content projected
   * through two different components is two expansions. What the content is
   * made of still comes from where the caller wrote it: every element inside
   * carries its own source position.
   */
  ownPath: string;
  /**
   * Where a string projection records the errors it renders away. A handle that
   * only projects structured segments needs none — its caller sees the errors.
   */
  printedErrors?: Segment[];
  /**
   * Whether the element that performed this invocation sits inside a
   * `<PrintErrors>` region. Content projected through it is the caller's own
   * text, written where the invocation was written, so it is covered exactly as
   * the invocation is (§3.6).
   */
  checkedFailures: CheckedFailures | undefined;
  authority: ExpansionAuthority | undefined;
}

interface ProjectionFrame {
  env: EvalEnv | undefined;
  meta: Record<string, unknown>;
  props: Record<string, Json>;
  hideSet: Set<string>;
}

/**
 * Build the handle one invocation publishes (spec §6.3).
 *
 * Every projection expands in a task the invocation's content scope owns, so
 * nested invocations and persistent work created by projected content descend
 * from it and stop with the invocation. Projected and authored requests carry
 * their own lexical frame; the resource scope is the callee's.
 */
function createProjectionHandle(state: ProjectionState): ProjectionHandle {
  const slots = partitionBySlot(state.children);
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
    const frame = request.kind === "markdown" ? state.authored : state.caller;
    if (request.kind === "children" && request.override !== undefined) {
      return layerEnvironments(frame.env, { values: request.override }, false);
    }
    return frame.env;
  }

  function frameFor(request: ProjectionRequest): ProjectionFrame {
    return request.kind === "markdown" ? state.authored : state.caller;
  }

  const claimed = new WeakSet<ComponentElement>();

  /**
   * How many times this invocation has already projected the same request.
   *
   * An authored `<Content />` is told apart by where it was written; a
   * programmatic projection has no source of its own, so repeated calls are told
   * apart by the order the component made them in. Read when the projection
   * operation is interpreted and before it suspends, so it follows the
   * component's own program order rather than the order projections finish in.
   * Owned by this invocation and gone with it.
   */
  const repeats = new Map<string, number>();

  function projectionPath(request: ProjectionRequest): string {
    const req =
      request.kind === "slot"
        ? `slot:${request.name ?? ""}`
        : request.kind === "children"
          ? "children"
          : "markdown";
    const n = repeats.get(req) ?? 0;
    repeats.set(req, n + 1);
    return extendPath(state.ownPath, { f: "proj", req, n });
  }

  /**
   * Run already-selected segments inside the content scope. Shared by every
   * projection so none of them depends on eval-scope acquisition order.
   */
  function* runInContentScope(options: {
    segments: Segment[];
    mode: ErrorMode;
    env: EvalEnv | undefined;
    meta: Record<string, unknown>;
    props: Record<string, Json>;
    hideSet: Set<string>;
    inner: ProjectionHandle | undefined;
    loop: LoopFrame | undefined;
    returnFrame: ReturnBody | undefined;
    errors: Segment[];
    /**
     * The caller's region, when this projection renders into one. Structural
     * `<Content />` passes it, so a failure partway leaves the projected prefix
     * with the document. A string projection passes none: it produces a value,
     * and a value is not output until it is complete.
     */
    owner?: Segment[];
    path: string;
  }): Operation<Segment[]> {
    return yield* scoped(function* () {
      // Every projection this invocation performs funnels through here —
      // `content()`, `tryContent()`, an authored `<Content />`, a `render()`
      // closure — so this is the whole of what "expanding its own content"
      // means, and there is one place to raise it.
      const projected = state.projecting?.();
      try {
        return yield* project();
      } finally {
        projected?.();
      }
    });

    function* project(): Operation<Segment[]> {
      const contentScope = yield* state.invocation.useContentScope();
      // The projection's failure travels back to the caller rather than into
      // the content scope. Raising it there would poison the scope, and the
      // invocation's teardown would then re-report it as a teardown error,
      // replacing the documentation failure the caller is meant to see.
      const outcome = withResolvers<{ segments: Segment[]; failure?: unknown }>();
      // Shared with the expansion below, so a failure still leaves behind what it
      // rendered before stopping. When the caller owns a region, that array is
      // the region itself and the prefix is already where the document needs it.
      const rendered: Segment[] = options.owner ?? [];
      const task = contentScope.scope.run(function* () {
        try {
          yield* ErrorMode.set(options.mode);
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
          yield* expandSegmentsWithin(
            options.segments,
            options.meta,
            options.props,
            options.hideSet,
            state.counter,
            rendered,
            options.path,
            0,
            state.checkedFailures,
            state.authority,
            options.returnFrame,
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
      // A projection that wrote into the caller's region has nothing left to
      // hand back; one that kept its own returns what it rendered.
      return options.owner === undefined ? [...options.errors, ...result.segments] : options.errors;
    }
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
    // First statement of the body, so the ordinal is taken when this operation
    // is interpreted and before anything it does can suspend. An operation that
    // is constructed and never yielded takes none.
    const path = projectionPath(request);
    const segments = select(request);
    const mode = request.mode ?? (yield* ErrorMode.get()) ?? "print";
    const contentScope = yield* state.invocation.useContentScope();
    const frame = frameFor(request);
    const project = makeProjectFn(frame.env);
    // The enclosing handle answers <Content /> written inside projected
    // content: it belongs to the caller's invocation, not to this one.
    // Dynamic markdown is the component's own, so it keeps this handle.
    const inner = request.kind === "markdown" ? handle : state.enclosing;

    // Raised for the whole projection, as in `runInContentScope`: everything
    // expanded below belongs to the content, so the invocation that owns it
    // names nothing until this returns.
    const projected = state.projecting?.();
    try {
      return yield* runOutcome();
    } finally {
      projected?.();
    }

    function* runOutcome(): Operation<{ segments: Segment[]; failure?: unknown }> {
      return yield* scoped(function* () {
        // The projection's failure travels back to the caller rather than into
        // the content scope (see runInContentScope): a throw-bound failure the
        // caller catches is explicit recovery, and the invocation must not
        // re-report it as a teardown error.
        const outcome = withResolvers<{ segments: Segment[]; failure?: unknown }>();
        // Shared with the expansion below, so a failure still leaves behind what it
        // rendered before stopping.
        const rendered: Segment[] = [];
        // Slot errors are reported inside the mode-bound task, so an empty
        // selection cannot settle them under the invocation's baseline. Held out
        // here so a failure still reports them alongside what rendered.
        const errors: Segment[] = [];
        const task = contentScope.scope.run(function* () {
          try {
            yield* ErrorMode.set(mode);
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
            // Dynamic markdown is the component's own text for the same reason,
            // so a <Return> scanned out of it satisfies no caller declaration.
            yield* expandSegmentsWithin(
              project(segments),
              frame.meta,
              frame.props,
              frame.hideSet,
              state.counter,
              rendered,
              path,
              0,
              state.checkedFailures,
              state.authority,
              request.kind === "markdown" ? undefined : state.callerReturn,
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
      owner: Segment[],
      elementPath: string,
    ): Operation<Segment[]> {
      // Slots were resolved during substitution. The projected content keeps
      // the caller frame; only the resource scope moves.
      // The error mode has to travel with them: the content task does not inherit
      // the documentation or <Output> frame this `<Content />` sits in.
      const mode = (yield* ErrorMode.get()) ?? "print";
      return yield* runInContentScope({
        segments: element.children,
        mode,
        env: layerProjectedContentEnvironment(state.caller.env, state.authored.env),
        meta: state.caller.meta,
        props: state.caller.props,
        hideSet: state.caller.hideSet,
        inner: state.enclosing,
        loop: state.callerLoop,
        returnFrame: state.callerReturn,
        errors: [],
        owner,
        path: extendPath(elementPath, { f: "proj" }),
      });
    },
    project: runProjection,
    tryProject: runProjectionOutcome,
    *projectToString(request: ProjectionRequest): Operation<string> {
      const printedErrors = state.printedErrors;
      if (printedErrors === undefined) {
        throw new Error(
          "projectToString() requires somewhere to record printed errors; this handle only supports project().",
        );
      }
      const segments = yield* runProjection(request);
      // A string result must not hide a failure: record the structured errors
      // where the invocation can refuse an `as=` capture.
      for (const segment of segments) {
        if (segment.type === "error") {
          printedErrors.push(segment);
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

/**
 * Refuse an answer that carries a private implementation to an import no
 * closure authorized.
 *
 * Asked of every import that was not itself an authorized private one, so it
 * holds where there is no declaration to consult: a second execution that
 * declares no Markdown still refuses the implementation a first one built. What
 * is recognized is the function, which is what a copy of the definition cannot
 * change and a handler cannot forge — a component a handler wrote itself carries
 * a different one and stays the open import it always was.
 */
function refuseEscapedPrivate(name: string, imported: ImportedDefinition): void {
  if (imported.kind !== "function" || !isPrivateImplementation(imported.fn)) {
    return;
  }
  throw new DeclaredMarkdownError(
    `${name} was answered with a component only exact declared Markdown may write. A private ` +
      "implementation runs for the element the declaration that carries it authored, and for " +
      "no other name, copy, later site or run.",
  );
}

/**
 * The definition one private import may invoke.
 *
 * An offer that was never made, or one canonical resolution never took,
 * authorizes nothing — a handler that answered such an import answered with
 * something core did not produce for it.
 */
function requirePrivate(
  offered: PrivateImport | undefined,
  name: string,
  answered: ImportedDefinition,
): ImportedDefinition {
  if (offered === undefined) {
    throw new Error(
      `${name} is declared privately by exact Markdown, and this is not an element it authored`,
    );
  }
  return offered.authorize(answered);
}

/**
 * The authority a definition's own body expands under.
 *
 * Only one member changes: the private closure. A declaration's body carries
 * its own, so the names only those bytes may write resolve while they are being
 * expanded and nowhere else. Everything else — a repository component, a
 * bundled one, a registration — carries the caller's, which clears a closure
 * rather than passing it down.
 *
 * Content the caller projected is not this body. It expands through the
 * invocation's projection handle, which restores the frame and the authority
 * read at the invocation site, so a `<Content />` inside a declaration reaches
 * no private name.
 */
function authorityForBody(
  authority: ExpansionAuthority | undefined,
  name: string,
  definition: ComponentDefinition,
): ExpansionAuthority | undefined {
  if (authority === undefined) {
    return undefined;
  }
  const privates = authority.declared?.closureFor(name, definition);
  if (privates === authority.privates) {
    return authority;
  }
  const { privates: _cleared, ...rest } = authority;
  return privates === undefined ? rest : { ...rest, privates };
}

const MAX_EXPANSION_DEPTH = 64;
const ESCAPED_BRACE_PLACEHOLDER = "\uE000";

/**
 * Expand an array of segments, resolving components and executing code blocks.
 *
 * Component import, modifier execution, bindings, and error mode are all
 * delivered contextually through the Component Api — install providers with
 * `Component.around(..., { at: "min" })` before expanding.
 *
 * This is the one entry for expansion driven directly — a test, a tool
 * describing a document — and the one place an expansion legitimately starts
 * without an `ExpansionAuthority`. A form-sensitive component under such an
 * expansion refuses rather than running unselected. Everything an execution
 * causes recurses through `expandSegmentsWithin`, where the authority is not
 * optional.
 *
 * @param counter - Optional block ID counter. If omitted, a local counter
 *   is created. For per-segment emission (§9), pass a shared counter so
 *   IDs are stable across calls.
 */
export function expandSegments(
  segments: Segment[],
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter = createBlockCounter(),
  owner?: Segment[],
  path: string = "",
  indexBase: number = 0,
  checkedFailures?: CheckedFailures,
  authority?: ExpansionAuthority,
): Operation<Segment[]> {
  return expandSegmentsWithin(
    segments,
    parentMeta,
    parentProps,
    hideSet,
    counter,
    owner,
    path,
    indexBase,
    checkedFailures,
    authority,
    undefined,
  );
}

/**
 * The recursion inside an expansion already under way.
 *
 * Every parameter travels by hand and none is optional, so an internal caller
 * that drops the authority — or the ledger, or the path — fails to compile
 * rather than silently expanding without it. What `execute()` causes must
 * carry the same `ExpansionAuthority` through every recursion that can invoke
 * a component: regions, branches, iterations, captures, answers, component
 * bodies, and projected content alike.
 */
export function* expandSegmentsWithin(
  ...expansion: Parameters<typeof expandListSegments>
): Operation<Segment[]> {
  // Placement, for a harness that reads a construct's children in two passes.
  // A declaration written beside the others and one a construct expanded on its
  // own are told apart by how many lists are open, and only expansion knows
  // that. Bracketed once here rather than at each construct, so a construct
  // that recurses cannot be the one this forgets.
  const scanner = yield* DeclarationScan.get();
  if (scanner === undefined) {
    return yield* expandListSegments(...expansion);
  }
  scanner.enterList();
  try {
    return yield* expandListSegments(...expansion);
  } finally {
    scanner.exitList();
  }
}

function* expandListSegments(
  segments: Segment[],
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  /**
   * The output owner: the accumulator belonging to the region whose text
   * renders into the document. Expansion appends as it goes, so a caller
   * holding the same array still has everything produced before a failure —
   * which is how a failing `<Output>` region keeps what it rendered first, and
   * how a `<Test>` keeps its output when its body stops partway.
   *
   * A call site that produces a binding, a value, or a string passes none.
   * Its buffer is private and never merges into an owner, so a failure cannot
   * promote content the document was not going to render (§6.9).
   */
  owner: Segment[] | undefined,
  /**
   * The structural path that reached these segments (§5.6). Expansion driven
   * directly — a test, a tool describing a document — starts from the empty
   * path, so identity works with no execution and no journal around it.
   */
  path: string,
  /**
   * Where `segments` starts in the list it was taken from. A caller that
   * expands one segment at a time — body chunking — would otherwise hand every
   * one of them index 0, and the positionless fallback would stop telling them
   * apart (§5.6).
   */
  indexBase: number,
  /**
   * Whether these segments are work the region of a `<PrintErrors>` element
   * caused, that element being the one construct that may keep a checked
   * command failure from ending the run (§3.6).
   *
   * It travels as an argument from the element that grants it, and reaches
   * everything the region causes: its own children, the branches, iterations,
   * captures and answers written inside it, the bodies of components its
   * elements invoke, and the content those invocations project back. It reaches
   * nothing else — a sibling after `</PrintErrors>`, a later invocation, or a
   * root, all of which start from the default here and are outside it.
   */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<Segment[]> {
  // An execution opens the table its printed errors record their causes in.
  // Expansion driven directly — a test, a tool describing a document — has no
  // execution around it, so the outermost call opens one for exactly its own
  // lifetime rather than reaching for a table that outlives it.
  if ((yield* SegmentCauses.get()) === undefined) {
    return yield* scoped(function* () {
      yield* useSegmentCauses();
      // The list, not the wrapper: this is the same list continuing under a
      // table of its own, and counting it twice would make its children look
      // one construct deeper than they are.
      return yield* expandListSegments(
        segments,
        parentMeta,
        parentProps,
        hideSet,
        counter,
        owner,
        path,
        indexBase,
        checkedFailures,
        authority,
        returnBody,
      );
    });
  }

  const result: Segment[] = owner ?? [];
  // Read once: `<Loop>` publishes its frame for the nested call that expands
  // its body, so the frame ambient here cannot change while this list runs.
  const loop = yield* ActiveLoop.get();

  for (const [index, segment] of segments.entries()) {
    // A checked failure the document did not authorize ends the work: whatever
    // enclosing boundary printed it, nothing after it in any frame begins.
    if (checkedFailures?.failure !== undefined) {
      break;
    }
    switch (segment.type) {
      case "text": {
        // Heal incomplete markdown constructs at segment boundaries (spec §2.3)
        // Runs synchronously — no yield, no journal entry
        const healed = healSegment(segment.content);
        const protectedEscapes = healed.replaceAll("\\{", ESCAPED_BRACE_PLACEHOLDER);
        const textEvalEnv = yield* env;
        const textProps =
          textEvalEnv !== undefined && "props" in textEvalEnv.values
            ? textEvalEnv.values.props
            : parentProps;
        // Interpolate {meta.key} and {props.key} — runtime, no journal
        const interpolated = interpolate(protectedEscapes, parentMeta, textProps);
        // Interpolate bare {name} refs from eval bindings (spec §6.4/§6.6).
        // Runs after meta/props interpolation so component contract takes
        // precedence. Only runs when a binding environment is in scope.
        const final = textEvalEnv
          ? interpolateEvalBindings(interpolated, textEvalEnv.values)
          : interpolated;
        result.push({
          type: "text",
          content: final.replaceAll(ESCAPED_BRACE_PLACEHOLDER, "{"),
        });
        break;
      }

      case "component": {
        // Every element that expands descendants contributes its own frame,
        // exactly once and here (§5.6). A construct that recurses and a
        // component that expands a body therefore derive identity the same way,
        // and two elements at the same local index under different parents
        // cannot arrive at the same path.
        const elementPath = extendPath(
          path,
          elementFrame(segment.name, elementSite(segment.position, indexBase + index)),
        );

        if (segment.name === "Content") {
          // A `<Content />` the invocation claimed carries its resolved
          // projection; expanding it here runs that content in the
          // invocation's content scope, which stops before the invocation
          // releases anything of its own. Its segments already went through
          // the ambient error mode, so they are appended as they are.
          const projection = yield* ActiveProjection.get();
          if (projection && projection.claims(segment)) {
            yield* projection.expandClaimed(segment, result, elementPath);
            break;
          }
        }

        if (segment.name === "Output") {
          // Definition-owned <Output> is consumed by buildBody before it
          // reaches here. Reaching this branch means a misplaced or
          // dynamically scanned <Output> (e.g. render(markdown) content) —
          // diagnose it defensively per the ambient error mode.
          result.push(
            yield* raise({ type: "error", message: misplacedOutputMessage(), source: "Output" }),
          );
          break;
        }

        if (segment.name === "Return") {
          // A <Return> is the value body's own only where that body's frame is
          // ambient: under its structural directives, and in content its author
          // projected. Without one — a foreign body, dynamically scanned
          // markdown, or a text body — it stays reserved and is diagnosed
          // rather than resolving a component named Return.
          // Claimed before the expression is evaluated, so a second return
          // reaching this body while the first is still resolving evaluates
          // nothing of its own. A carrier this engine did not mint owns no
          // body, so a forged one answers `undefined` here and takes the
          // reserved path below rather than selecting anything.
          // The owning body arrives as a parameter of this expansion, so it is
          // reachable only by the engine that passed it: nothing is published
          // for a document to read, replace, or hand to an exported helper.
          if (returnBody === undefined) {
            result.push(
              yield* raise({
                type: "error",
                message: misplacedReturnMessage(segment),
                source: "Return",
              }),
            );
            break;
          }
          const declared = returnBody.claim();
          // What the value is validated against comes from the engine's own
          // record of this body, never from the carrier the context held.
          returnBody.select(yield* resolveReturnValue(declared.owner, declared.returns, segment));
          break;
        }

        if (segment.name === "Let") {
          // No raise() here: expandLet reports the errors it creates, and
          // its body settled its own (§6.9).
          result.push(
            ...(yield* expandLet(
              segment,
              parentMeta,
              parentProps,
              hideSet,
              counter,
              elementPath,
              checkedFailures,
              authority,
              returnBody,
            )),
          );
          break;
        }

        if (segment.name === "Each") {
          // Same as <Let>: expandEach reports its own errors and hands the
          // body's back untouched (§6.9).
          result.push(
            ...(yield* expandEach(
              segment,
              parentMeta,
              parentProps,
              hideSet,
              counter,
              result,
              elementPath,
              checkedFailures,
              authority,
              returnBody,
            )),
          );
          break;
        }

        if (segment.name === "If") {
          // No raise() here, like the branches above: expandIf reports the
          // errors it creates, and the selected branch settled its own (§6.9).
          // It renders into this expansion's output, so it writes into the owner
          // rather than handing segments back to be appended.
          yield* expandIf(
            segment,
            parentMeta,
            parentProps,
            hideSet,
            counter,
            result,
            elementPath,
            checkedFailures,
            authority,
            returnBody,
          );
          break;
        }

        if (segment.name === "Else") {
          // A well-placed <Else> is consumed by its <If> and never expanded on
          // its own. Reaching this branch means the element sits outside any
          // <If>, so it names no component and is diagnosed rather than
          // resolved from the filesystem.
          result.push(
            yield* raise({
              type: "error",
              message: positioned(strayElseMessage(), segment),
              source: "Else",
            }),
          );
          break;
        }

        if (segment.name === "Loop") {
          // No raise() here, for the same reason as <If>: expandLoop reports
          // the errors it creates, and the body settled its own (§6.9).
          yield* expandLoop(
            segment,
            parentMeta,
            parentProps,
            hideSet,
            counter,
            result,
            elementPath,
            checkedFailures,
            authority,
            returnBody,
          );
          break;
        }

        if (segment.name === "PrintErrors") {
          // No raise() here, like the branches above: expandPrintErrors
          // reports the errors it creates, and the body settled its own (§6.9).
          yield* expandPrintErrors(
            segment,
            parentMeta,
            parentProps,
            hideSet,
            counter,
            result,
            elementPath,
            checkedFailures,
            authority,
            returnBody,
          );
          break;
        }

        if (segment.name === "Answers") {
          // The region renders segments of its own — its body, and each
          // matcher's template children — so it is handed this expansion's
          // recursion to render them with.
          const expandWithin = (inner: Segment[], into?: Segment[], frame?: ExpansionFrame) =>
            expandSegmentsWithin(
              inner,
              parentMeta,
              parentProps,
              hideSet,
              counter,
              into,
              frame === undefined ? elementPath : extendPath(elementPath, frame),
              0,
              checkedFailures,
              authority,
              returnBody,
            );
          // Which placement this is, answered by identity rather than by name:
          // a trusted harness knows which expansions its own declaration scan
          // reached, and a region it never reached is an ordinary one.
          //
          // The site, not the expansion path: a harness reads its children
          // twice, and the second projection of one request derives a path of
          // its own (§5.6), so only where the element was written is the same
          // in both passes.
          const scanner = yield* DeclarationScan.get();
          const site = elementSite(segment.position, indexBase + index);
          const placement = scanner?.declaresAnswers(site);
          if (scanner !== undefined && placement !== undefined) {
            result.push(
              ...(yield* declareChildAnswers(segment, expandWithin, scanner, site, placement)),
            );
            break;
          }
          // No raise() here, like the branches above: expandAnswers reports the
          // errors it creates, and the selected answer settled its own (§6.9).
          result.push(...(yield* expandAnswers(segment, expandWithin, result)));
          break;
        }

        if (segment.name === "Answer") {
          // A well-placed <Answer> is partitioned out by its <Answers> and never
          // expanded on its own. Reaching here means it sits outside one, so it
          // names no component — the same shape as a stray <Else>.
          result.push(yield* raise(strayAnswerError(segment)));
          break;
        }

        if (segment.name === "Switch") {
          // No raise() here, like <If> above: expandSwitch reports the errors
          // it creates, and the selected case settled its own (§6.9).
          yield* expandSwitch(
            segment,
            parentMeta,
            parentProps,
            hideSet,
            counter,
            result,
            elementPath,
            checkedFailures,
            authority,
            returnBody,
          );
          break;
        }

        if (segment.name === "Case") {
          // A well-placed <Case> is consumed by its <Switch> and never expanded
          // on its own. Reaching this branch means the element sits outside any
          // <Switch>, so it names no component and is diagnosed rather than
          // resolved from the filesystem.
          result.push(
            yield* raise({
              type: "error",
              message: positioned(strayCaseMessage(), segment),
              source: "Case",
            }),
          );
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
          result.push(
            yield* raise({
              type: "error",
              message: positioned(strayStructuralMessage(segment.name), segment),
              source: segment.name,
            }),
          );
          break;
        }

        const expanded = yield* expandComponent(
          segment.name,
          segment.props,
          segment.expressions,
          segment.authoredExpressions ?? {},
          segment.children,
          segment.selfClosing,
          hideSet,
          counter,
          segment.projectedEnv,
          segment.position,
          parentMeta,
          parentProps,
          result,
          elementPath,
          checkedFailures,
          authority,
          returnBody,
        );
        // A printed error the callee produced is data, and stays data here: it
        // was decided once, where it was raised, under the error mode governing
        // the region that raised it (§6.9). A rendering invocation wrote it
        // straight into this owner; anything handed back — a binding the callee
        // refused, an error about the invocation itself — is appended as it is.
        result.push(...expanded);
        break;
      }

      case "codeBlock": {
        // Everything a binding annotation can be wrong about is decided here,
        // before the chain is composed and therefore before a process starts.
        const refusal = bindingRefusal(segment);
        if (refusal !== undefined) {
          result.push(yield* raise({ type: "error", message: refusal, source: segment.content }));
          break;
        }
        const bindingName = segment.binding?.ok === true ? segment.binding.value : undefined;

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
          routing: yield* declaredRouting(),
          ...(segment.position === undefined ? {} : { position: segment.position }),
        };

        if (bindingName !== undefined) {
          if (!evalEnv) {
            result.push(
              yield* raise({
                type: "error",
                message: '`as="name"` requires an evaluation environment.',
                source: segment.content,
              }),
            );
            break;
          }
          // A bound command's outcome is data the document decides on: the
          // block renders nothing, displays neither channel, and a nonzero
          // status is a field rather than a failure — including inside
          // `<Output>`, where an ordinary command's would end the run (§3.6).
          //
          // Asked for through a request rather than by handing the block over:
          // middleware composes around this exactly as it does around an
          // ordinary block, and neither the fact that authorizes the chain nor
          // the outcome it settles to passes through its hands. What comes back
          // from the operation is not read at all.
          const issued = issueBoundExec(segment.modifiers, context);
          let thrown: { raised: unknown } | undefined;
          try {
            yield* applyBoundModifiers(segment.modifiers, issued.request);
          } catch (error) {
            thrown = { raised: error };
          }
          const settled = issued.settlement();
          const canonical =
            settled.status === "raised"
              ? { raised: settled.raised }
              : settled.status === "absent" && thrown === undefined
                ? { raised: settled.refusal }
                : undefined;
          const failure = rankBoundFailure(canonical, thrown);
          if (failure !== undefined) {
            const fatal = fatalCause(failure.raised);
            if (fatal !== undefined) {
              throw fatal;
            }
            result.push(
              yield* raise({
                type: "error",
                message:
                  failure.raised instanceof Error ? failure.raised.message : String(failure.raised),
                source: segment.content,
              }),
            );
            break;
          }
          if (settled.status === "produced") {
            evalEnv.values[bindingName] = {
              exitCode: settled.outcome.exitCode,
              stdout: settled.outcome.stdout,
              stderr: settled.outcome.stderr,
            };
          }
          break;
        }

        try {
          const codeResult = yield* applyModifiers(segment.modifiers, context);

          // What the command printed and whether it failed are two separate
          // questions, and the exit code alone answers the second one (#307).
          // The output comes first, because a command that prints before it
          // fails is usually explaining itself, and the printed error that follows
          // is what the ambient error mode then settles.
          if (codeResult.output !== "") {
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

          if (codeResult.exitCode !== 0) {
            result.push(
              yield* checkedCommandFailure(
                {
                  type: "error",
                  // stderr was already displayed on its way past, so the
                  // diagnostic quotes it only when this run retained it — and
                  // what it quotes is what reached this run's boundary (#441).
                  message: codeResult.stderr
                    ? `Command failed (exit ${codeResult.exitCode}): ${codeResult.stderr}`
                    : `Command failed (exit ${codeResult.exitCode})`,
                  source: segment.content,
                },
                checkedFailures,
                authority,
                returnBody,
              ),
            );
          }
          // A successful block that printed nothing adds nothing (e.g., silent)
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
          // the ambient error mode.
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

/**
 * Settle a foreground command's failure, which printing never excuses.
 *
 * A command that exited nonzero is a checked failure: where a printing boundary
 * would ordinarily render the diagnostic and let the next block run, the run
 * fails instead and later executable work does not start. The observation
 * chain is unchanged — the segment passes through `raise` exactly once — and a
 * printing boundary may still be the thing that prints it, exactly as an
 * `<Output>` region's failure is printed today.
 *
 * The ledger is the authority to keep the run, and it is an argument because it
 * has exactly one origin: a `<PrintErrors>` element the document was written
 * with, which hands it to the expansion of its own body and to nothing else.
 * Nothing ambient is consulted. A run's outcome may not be decided by state an
 * enclosing caller can install, and a name is all it takes to install one.
 */
function* checkedCommandFailure(
  segment: ErrorSegment,
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<ErrorSegment> {
  // Written down before it is raised or projected, and before the error mode is
  // consulted at all: the mode decides how this is reported, never whether the
  // run suffered it. An enclosing boundary may still catch what this becomes —
  // a component's own failure, or the `ContentError` its projected content
  // raised — and print or replace it. Those boundaries recover their own
  // failures; a command that exited nonzero is remembered here either way, in
  // the frame that owns it: a contained invocation's own, or the run's.
  if (checkedFailures !== undefined && !checkedFailures.authorized) {
    checkedFailures.failure ??= segment;
  }
  const mode = (yield* ErrorMode.get()) ?? "print";
  // The region that asked to print failures gets to print this one; a root that
  // merely prints by default does not get to call the run a success.
  if (mode !== "print" || checkedFailures?.authorized) {
    return yield* raise(segment);
  }
  return yield* scoped(function* () {
    yield* ErrorMode.set("output");
    return yield* raise(segment);
  });
}

/**
 * Which failure a bound block reports when canonical execution and the
 * middleware around it each produced one.
 *
 * Ranked by kind before position, exactly as an invocation is ranked against
 * its teardown (§6.11): a durability failure says the journal no longer
 * describes this run, and a Files infrastructure failure says the document
 * filesystem never answered. Neither becomes a printed error because a handler
 * raised something afterwards, and neither is outranked by an ordinary failure
 * that happened first.
 *
 * Below those two, canonical execution is the earlier failure and stays
 * authoritative: a handler that catches what canonical execution raised and
 * throws its own does not thereby substitute it. A later ordinary failure is
 * reported only where canonical execution had nothing to report — which
 * includes a handler refusing before canonical execution ever ran.
 */
function rankBoundFailure(
  canonical: { raised: unknown } | undefined,
  later: { raised: unknown } | undefined,
): { raised: unknown } | undefined {
  const durable = durabilityFailure(canonical?.raised) ?? durabilityFailure(later?.raised);
  if (durable !== undefined) {
    return { raised: durable };
  }
  const files = filesFatalFailure(canonical?.raised) ?? filesFatalFailure(later?.raised);
  if (files !== undefined) {
    return { raised: files };
  }
  return canonical ?? later;
}

/**
 * Why this block's `as="name"` annotation binds nothing, if it binds nothing.
 *
 * This is the half of the refusal the source settles by itself: an annotation
 * that never named a binding names nothing here either. Which middleware a
 * bound block may be composed from is not a question about words — a registered
 * modifier may carry any name — so it is decided against the resolved factories
 * where the chain is composed, before either the middleware or a process runs.
 */
function bindingRefusal(segment: ExecutableCodeBlock): string | undefined {
  const binding = segment.binding;
  if (binding === undefined || binding.ok) {
    return undefined;
  }
  return binding.error.message;
}

function letError(message: string): ErrorSegment {
  return { type: "error", message, source: "Let" };
}

/**
 * Bind rendered content or a direct value into `as` (spec §6.5 `<Let>`).
 *
 * Like `<If>`, it is not an observation boundary. Errors it creates itself — a
 * missing or invalid `as`, an unknown prop, a body that is neither source, both
 * sources at once — are reported here, exactly once. Body segments come back
 * from `expandSegments` already reported where they were produced, and are
 * handed on untouched: a failing element inside a rendered body settles once,
 * exactly as it would inline.
 *
 * `<Let>` never swallows an error. When the body produced one, `as` creates no
 * binding and the error segments stand in place of it, so the reader sees the
 * failure instead of a binding holding a printed error as its text.
 *
 * Which source runs is decided from what the author wrote — whether `value` and
 * children are present — before either one runs, so a construct that names both
 * sources evaluates neither.
 */
function* expandLet(
  segment: Extract<Segment, { type: "component" }>,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  path: string,
  /** Whether the enclosing region grants checked-failure recovery (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<ErrorSegment[]> {
  // Every one of these is decided from what the author wrote, so the whole
  // catalog lives in `structural-rules.ts` where validation reads it too. The
  // first is reported and the rest of the construct does not run, which is what
  // a `<Let>` whose declaration is wrong has always done.
  const violations = letViolations(segment);
  const refusal = violations[0];
  if (refusal !== undefined) {
    return [yield* raise(letError(refusal.message))];
  }
  const bindingName = letBindingName(segment)!;
  const hasValue = "value" in segment.props || "value" in segment.expressions;

  if (hasValue) {
    return yield* letValue(segment, bindingName);
  }

  // The region's foreground commands write their stdout into this binding
  // rather than to the reader; stderr stays diagnostic and is displayed (#441).
  const expandedChildren = yield* withRouting({ stdout: "capture", stderr: "forward" }, () =>
    expandSegmentsWithin(
      segment.children,
      parentMeta,
      parentProps,
      hideSet,
      counter,
      undefined,
      path,
      0,
      checkedFailures,
      authority,
      returnBody,
    ),
  );

  // The body reported these where they were created (§6.9). They are returned
  // before rendering or `select` folds them into text, so the binding stays
  // unset and the printed errors reach the document unchanged.
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
    return [yield* raise(letError("<Let> requires an evaluation environment."))];
  }
  bindingEnv.values[bindingName] = captured;
  return [];
}

/**
 * Bind the exact value `value` names, by reference.
 *
 * An expression is evaluated here, at this position in the body, against the
 * same layered environment and failure wrapper an expression prop uses — and
 * nothing more. Component props project through JSON on their way in; this one
 * does not, so a function, a class instance, `undefined` or a cyclic object
 * arrives in the binding as the object the expression produced.
 */
function* letValue(
  segment: Extract<Segment, { type: "component" }>,
  bindingName: string,
): Operation<ErrorSegment[]> {
  let value: unknown;
  if ("value" in segment.props) {
    value = segment.props.value;
  } else {
    try {
      value = yield* evaluateExpression(
        segment.expressions.value,
        "Let",
        "value",
        segment.projectedEnv,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        yield* raise({
          type: "error",
          message: positioned(message, segment),
          source: "Let",
        }),
      ];
    }
  }

  // Read after the source succeeded: a refused or failed source writes nothing.
  const bindingEnv = yield* env;
  if (!bindingEnv) {
    return [yield* raise(letError("<Let> requires an evaluation environment."))];
  }
  bindingEnv.values[bindingName] = value;
  return [];
}

function eachError(message: string): ErrorSegment {
  return { type: "error", message, source: "Each" };
}

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
  /** The region a rendering iteration writes into; a captured one keeps its own. */
  owner: Segment[],
  path: string,
  /** Whether the region that caused this expansion grants recovery (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<Segment[]> {
  // Decided from source alone, so the catalog is shared with validation. A
  // literal `in` is checked here too; an expression is a value the document
  // computes, and its answer is checked below where it arrives.
  const violations = eachViolations(segment);
  const refusal = violations[0];
  if (refusal !== undefined) {
    return [yield* raise(eachError(refusal.message))];
  }
  const name = eachItemBinding(segment)!;
  const asBinding = eachCaptureBinding(segment);

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
  }
  if (!Array.isArray(items)) {
    return [yield* raise(eachError(eachItemsViolation(items)!.message))];
  }

  // Effective caller env honors projection through <Content />, mirroring
  // expandComponent, so a projected <Each> resolves both lexical caller
  // bindings and the current component's bindings.
  const contextEnv = yield* env;
  const callerEnv = layerEnvironments(segment.projectedEnv, contextEnv);
  const parentEvalScope = yield* evalScope;

  const enclosingLoop = yield* ActiveLoop.get();
  // A rendering iteration writes into the caller's region as it goes, so a
  // failure partway leaves the items it already produced behind. A captured one
  // builds a value instead: its buffer is private and never becomes output.
  const out: Segment[] = asBinding === undefined ? owner : [];
  for (const [iteration, item] of items.entries()) {
    yield* expandChildrenScoped(
      segment.children,
      callerEnv ?? undefined,
      { [name]: item },
      parentEvalScope ?? undefined,
      parentMeta,
      parentProps,
      hideSet,
      counter,
      out,
      extendPath(path, { f: "item", i: iteration }),
      checkedFailures,
      authority,
      returnBody,
    );
    // A `<Break>` in the body exits the enclosing `<Loop>`, so the remaining
    // items are part of the work that iteration no longer does.
    if (enclosingLoop?.broken) {
      break;
    }
  }

  if (asBinding === undefined) {
    return [];
  }

  // A capture never swallows an error. The body reported these where they were
  // created (§6.9), so they are returned as they are: the printed errors reach the
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
 * Anchor a printed error to the source location of the element that caused it.
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

/**
 * One shared structural violation as the printed error expansion produces.
 *
 * The violation says which construct it belongs to and, when the check walked
 * past the element it was given, which element it is about — so an `<Else>`
 * mistake inside an `<If>` is still positioned where it was written.
 */
function structuralErrorSegment(
  violation: StructuralViolation,
  fallback: ComponentElement,
): ErrorSegment {
  return {
    type: "error",
    message: positioned(violation.message, violation.element ?? fallback),
    source: violation.source,
  };
}

function ifError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "If" };
}

/**
 * Expand the one branch the condition selects (spec §6.5 `<If>`). The other
 * branch is never expanded, so nothing in it imports a component, runs a code
 * block, creates a binding, or reaches a provider.
 *
 * `<If>` opens no binding scope: the selected branch expands in the enclosing
 * environment, so a `<Let>` it creates behaves like inline content and
 * stays available after `</If>`.
 *
 * It is not an observation boundary either. Errors it creates itself — a
 * missing condition, a condition expression that fails to evaluate, an unknown
 * prop, a malformed `<Else>` — are reported here, exactly once. Everything the
 * selected branch returns was already reported where it was produced and is
 * handed back untouched, so a `<Broken />` inside a selected branch settles
 * once, exactly as it would inline.
 */
function* expandIf(
  segment: ComponentElement,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  /** The region this renders into: the selected branch writes there directly. */
  owner: Segment[],
  path: string,
  /** Whether the enclosing region grants checked-failure recovery (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<void> {
  // Decided from source alone and shared with validation: which props were
  // written, and how the body splits at its `<Else>`.
  const unknownProp = ifPropsViolation(segment);
  if (unknownProp !== undefined) {
    owner.push(yield* raise(ifError(segment, unknownProp.message)));
    return;
  }

  const structure = ifStructure(segment);
  if (structure.violations.length > 0) {
    for (const violation of structure.violations) {
      owner.push(yield* raise(structuralErrorSegment(violation, segment)));
    }
    return;
  }

  let condition: unknown;
  if ("condition" in segment.props) {
    condition = segment.props.condition;
  } else if ("condition" in segment.expressions) {
    try {
      // Evaluated directly rather than through resolveExpressionProps: that
      // helper normalizes its result through JSON, which rejects `undefined`,
      // rewrites `NaN` as `null`, and throws on a BigInt. A condition is
      // decided and discarded rather than passed on or recorded, so it takes
      // any JavaScript value and crosses no serialization boundary.
      condition = yield* evaluateExpression(
        segment.expressions.condition,
        "If",
        "condition",
        segment.projectedEnv,
      );
    } catch (error) {
      owner.push(
        yield* raise(ifError(segment, error instanceof Error ? error.message : String(error))),
      );
      return;
    }
  } else {
    owner.push(yield* raise(ifError(segment, ifConditionViolation(segment)!.message)));
    return;
  }

  const selected = !!condition;

  // The false arm belongs to `<Else>`, which is consumed above, so its frame is
  // added here — otherwise both arms of one `<If>` expand under one path.
  const branchPath =
    selected || structure.elseElement === undefined
      ? path
      : extendPath(
          path,
          elementFrame(
            structure.elseElement.name,
            elementSite(structure.elseElement.position, structure.elseIndex ?? 0),
          ),
        );

  yield* expandSegmentsWithin(
    selected ? structure.whenTrue : structure.whenFalse,
    parentMeta,
    parentProps,
    hideSet,
    counter,
    owner,
    branchPath,
    0,
    checkedFailures,
    authority,
    returnBody,
  );
}

function switchError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "Switch" };
}

function caseError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "Case" };
}

/**
 * The value a `<Switch>` or a `<Case>` compares with, exactly as written.
 *
 * Three spellings reach here, and the reading a structural operand needs is the
 * same for all three: the value the author's own expression produced. The
 * scanner resolves what it can read as JSON into `props` and keeps the authored
 * text beside it, so that text is evaluated in preference to the reading of it
 * — `undefined` stays `undefined`, `NaN` stays `NaN`, and an object stays the
 * object it was rather than a copy that no longer compares equal to itself.
 * A prop the scanner could not read at all is an ordinary expression, and a
 * quoted attribute is the string the author typed.
 */
function* structuralOperand(segment: ComponentElement, construct: string): Operation<unknown> {
  const authored = segment.authoredExpressions?.value;
  if (authored !== undefined) {
    return yield* evaluateExpression(authored, construct, "value", segment.projectedEnv);
  }
  if ("value" in segment.expressions) {
    return yield* evaluateExpression(
      segment.expressions.value,
      construct,
      "value",
      segment.projectedEnv,
    );
  }
  return segment.props.value;
}

/**
 * Expand the one `<Case>` the selector selects (spec §6.5 `<Switch>`). Every
 * other branch is never expanded, so nothing in it imports a component, runs a
 * code block, creates a binding, or reaches a provider — and neither does a
 * matcher written after the one that matched.
 *
 * The whole body's structure is decided from source first, so a malformed
 * branch stops the selector too: a switch that could not be read chooses
 * nothing rather than choosing from part of what was written.
 *
 * The selected case is transparent, exactly as a selected `<If>` branch is. It
 * opens no binding scope, no observation boundary and no loop boundary: a
 * `<Let>` it creates stays available after `</Switch>`, a `<Return>` claims the
 * value body that owns the switch, and a `<Break>` exits the loop that lexically
 * encloses it. Errors the construct creates itself — a broken structure, a
 * selector or matcher that fails to evaluate — are reported here, exactly once.
 */
function* expandSwitch(
  segment: ComponentElement,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  /** The region this renders into: the selected case writes there directly. */
  owner: Segment[],
  path: string,
  /** Whether the enclosing region grants checked-failure recovery (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<void> {
  // Decided from source alone and shared with validation: which props were
  // written, and how the body divides into branches.
  const structure = switchStructure(segment);
  if (structure.violations.length > 0) {
    for (const violation of structure.violations) {
      owner.push(yield* raise(structuralErrorSegment(violation, segment)));
    }
    return;
  }

  let selector: unknown;
  try {
    selector = yield* structuralOperand(segment, "Switch");
  } catch (error) {
    owner.push(
      yield* raise(switchError(segment, error instanceof Error ? error.message : String(error))),
    );
    return;
  }

  let selected: SwitchCase | undefined;
  for (const candidate of structure.matching) {
    let matcher: unknown;
    try {
      matcher = yield* structuralOperand(candidate.element, "Case");
    } catch (error) {
      owner.push(
        yield* raise(
          caseError(candidate.element, error instanceof Error ? error.message : String(error)),
        ),
      );
      return;
    }
    // The `===` operator, and nothing else: `NaN` matches no case including one
    // written `NaN`, `0` and `-0` are the same value, and two objects match only
    // when they are the same object.
    if (selector === matcher) {
      selected = candidate;
      break;
    }
  }

  const chosen = selected ?? structure.fallback;
  if (chosen === undefined) {
    return;
  }

  // The selected `<Case>` is consumed above and never reaches dispatch, so its
  // frame is added here — otherwise corresponding children of two branches
  // would expand under one path (§5.6).
  yield* expandSegmentsWithin(
    chosen.element.children,
    parentMeta,
    parentProps,
    hideSet,
    counter,
    owner,
    extendPath(
      path,
      elementFrame(chosen.element.name, elementSite(chosen.element.position, chosen.index)),
    ),
    0,
    checkedFailures,
    authority,
    returnBody,
  );
}

function loopError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "Loop" };
}

function breakError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "Break" };
}

/**
 * The bound a `<Loop>` runs to, or why the prop rejects it. The caller turns
 * the failure into a positioned printed error, because it is the one that raises.
 */
function* resolveLoopBound(segment: ComponentElement): Operation<Result<number>> {
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
    return Err(new Error(loopMissingBoundMessage(segment)));
  }

  return loopBound(segment, max);
}

/**
 * Expand a bounded repetition (spec §6.5 `<Loop>`). The body expands in
 * document order at most `max` times, and reaching `max` completes the loop
 * normally — exhaustion is not a failure. Whether an exhausted loop means
 * success is the surrounding document's error mode to state.
 *
 * `<Loop>` opens no binding scope. Every iteration expands in the enclosing
 * environment, so an iteration reads what earlier ones bound and the final
 * values stay readable after `</Loop>`.
 *
 * Like `<If>` it is not an observation boundary: it reports the errors it
 * creates itself and hands the body's segments back untouched. It adds no
 * error mode either — under a throwing error mode the first failure ends the
 * loop by propagating out of it, and under a printing one the printed error
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
  /** The region this renders into: each iteration writes there as it runs. */
  owner: Segment[],
  path: string,
  /** Whether the enclosing region grants checked-failure recovery (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<void> {
  const unknownProp = loopPropsViolation(segment);
  if (unknownProp !== undefined) {
    owner.push(yield* raise(loopError(segment, unknownProp.message)));
    return;
  }

  if ("name" in segment.expressions) {
    owner.push(
      yield* raise(loopError(segment, 'Prop "name" on <Loop /> must be a string literal.')),
    );
    return;
  }
  const name = segment.props.name;
  if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
    owner.push(
      yield* raise(loopError(segment, 'Prop "name" on <Loop /> must be a non-empty string.')),
    );
    return;
  }

  const bound = yield* resolveLoopBound(segment);
  if (!bound.ok) {
    owner.push(yield* raise(loopError(segment, bound.error.message)));
    return;
  }

  // Taken from the shared block counter, so every `<Loop>` an execution enters
  // — including each entry into a nested one — has a distinct identity that
  // lands the same way on replay.
  const identity: LoopIdentity = {
    id: counter.next(),
    ...(name === undefined ? {} : { name }),
    ...(segment.position === undefined ? {} : { position: segment.position }),
  };

  const frame: LoopFrame = { broken: false };
  let started = 0;

  try {
    yield* scoped(function* () {
      yield* ActiveLoop.set(frame);
      for (let iteration = 0; iteration < bound.value; iteration++) {
        yield* recordIteration(identity, iteration);
        started = iteration + 1;
        yield* expandSegmentsWithin(
          segment.children,
          parentMeta,
          parentProps,
          hideSet,
          counter,
          owner,
          extendPath(path, { f: "iter", i: iteration }),
          0,
          checkedFailures,
          authority,
          returnBody,
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
 * carries the author's instruction, so the printed error settles under the
 * ambient error mode — aborting under a throwing one, rendering under a printing
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
    violations.unshift(strayBreakMessage());
  }

  const reported: Segment[] = [];
  for (const violation of violations) {
    reported.push(yield* raise(breakError(segment, violation)));
  }
  return reported;
}

function printErrorsPropError(segment: ComponentElement, message: string): ErrorSegment {
  return { type: "error", message: positioned(message, segment), source: "PrintErrors" };
}

/**
 * Continue past ordinary component failures in this region (spec §6.8.1
 * `<PrintErrors>`).
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
function* expandPrintErrors(
  segment: ComponentElement,
  parentMeta: Record<string, unknown>,
  parentProps: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  /** The region this renders into: it writes there rather than returning. */
  owner: Segment[],
  path: string,
  /** The ledger this region grants recovery on top of (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<void> {
  const refusal = printErrorsViolations(segment)[0];
  if (refusal !== undefined) {
    owner.push(yield* raise(printErrorsPropError(segment, refusal.message)));
    return;
  }

  yield* scoped(function* () {
    yield* usePrintErrors();
    // The element the document was written with is the origin of the authority
    // to print a checked command failure and continue. It is handed to this
    // body's expansion by hand, so nothing outside the document can hold it.
    return yield* expandSegmentsWithin(
      segment.children,
      parentMeta,
      parentProps,
      hideSet,
      counter,
      owner,
      path,
      0,
      // The region grants recovery for the work it causes, and a failure it
      // recovers is not one the run suffered.
      recoveringLedger(),
      authority,
      returnBody,
    );
  });
}

function* expandComponent(
  name: string,
  props: Record<string, Json>,
  expressions: Record<string, string>,
  /** Authored text of the props the scanner resolved into `props` (§6.5). */
  authoredExpressions: Record<string, string>,
  children: Segment[],
  selfClosing: boolean,
  hideSet: Set<string>,
  counter: BlockCounter,
  projectedEnv: EvalEnv | undefined,
  position: SourcePosition | undefined,
  /** The invoking frame's meta and props, for content this element projects. */
  callerMeta: Record<string, unknown>,
  callerProps: Record<string, Json>,
  /**
   * The caller's output owner, when this invocation renders into it. An
   * invocation captured with `as` produces a binding rather than output and
   * passes none, so what its body rendered before failing stays out of the
   * document (§6.9).
   */
  owner: Segment[] | undefined,
  path: string,
  /**
   * Whether the element that invoked this sits inside a `<PrintErrors>` region.
   *
   * The recovery travels with the invocation because the element is the
   * region's own text: a component written inside the region is part of what
   * the region asked to print, and its body's commands are covered exactly as a
   * block written there would be.
   */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
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
  // Opened before the ask and settled the moment it answers, however it
  // answered: what canonical resolution selected here is what decides whether
  // this invocation is in one of this execution's identity domains, and nothing
  // on the answer or in the chain carries it (`invocation-identity.ts`).
  const selection = authority?.identities?.beginImport(name);
  let selected: IdentityDomain | undefined;
  let dispatcher: FunctionComponent | undefined;
  /**
   * Whether canonical execution answered this import for a name it closed.
   *
   * The provenance exact source is read from. An open import's answer — the
   * chain's, unverified — never sets it, so nothing a handler writes into a
   * definition can reach the presentation decision below.
   */
  let authorizedCanonically = false;
  try {
    // The public chain answers, and canonical execution decides whether the
    // answer is one it produced. In a closed execution — a workflow holding a
    // component bundle, a generated fragment holding an allowlist — a handler
    // may observe this import, delegate it, and refuse it by throwing; nothing
    // it returns is invoked. Without an authority the answer is whatever the
    // chain produced, exactly as it always was.
    // The offer is open for exactly this ask. Middleware composes inside it and
    // may observe, delegate or refuse the import; what it cannot do is obtain
    // the declaration for an element that did not author it, because the offer
    // is made from the closure the segments being expanded carry, is spent by
    // whatever asks first, and authorizes only the answer it produced itself.
    const offered = authority?.declared?.offer(authority.privates, name);
    let answered: ImportedDefinition;
    try {
      answered = yield* importComponent(name, position);
    } finally {
      offered?.close();
    }
    selected = selection?.settle();
    // A private import is authorized by the ask that made the offer, and by
    // nothing else. Not by the name: a private component runs for the element
    // the declaration that carries it authored, so an answer kept from another
    // import — however exactly it describes the same definition — authorizes
    // nothing here. And a private name written where no offer was made never
    // reaches this at all: selection resolves it to nothing, so what arrives is
    // the ordinary unresolved failure.
    let authorizedPrivate = false;
    if (authority?.declared?.declaresPrivate(name) === true) {
      imported = requirePrivate(offered, name, answered);
      authorizedPrivate = true;
      authority.forms?.select(name, imported);
    } else if (authority?.imports === undefined || !authority.imports.closes(name)) {
      // Closed for this exact name, not for the execution that closed it. A
      // bundled run closes every import; a host that declared exact Markdown
      // closed the names it declared, and an unrelated one is the open import it
      // has always been — the chain's answer, unverified, with no selection
      // recorded against it.
      imported = answered;
    } else {
      imported = authority.imports.authorize(name, answered);
      // This import is canonical execution's own answer for a name this
      // execution closed, which is the only provenance exact source is read
      // from. An open import — one no tier claims — never sets it, however its
      // answer describes itself.
      authorizedCanonically = true;
      // Closed authorization answers with core's retained copy rather than the
      // object the resolver recorded, and the copy is what this expansion
      // invokes — so the selection is recorded against it too. Only here: an
      // open execution's answer travelled through public middleware, and
      // nothing it hands back is canonical resolution's product. The record
      // takes its dispatcher from the copy's own `fn`, identical by retention;
      // a wrapper whose `fn` is no dispatcher records nothing, so a dispatcher
      // an authority recorded explicitly is never displaced.
      authority.forms?.select(name, imported);
    }
    // Whatever tier answered, and whatever this execution declares, an
    // implementation some declaration's private closure built runs only for an
    // import that closure authorized. Neither the name nor the current
    // execution can decide it: an answer kept from a legitimate private import
    // can be returned for any *other* name, in a copy of the definition, and in
    // a later run that declares nothing at all — and a run that has ended
    // authorizes nothing.
    if (!authorizedPrivate) {
      refuseEscapedPrivate(name, imported);
    }
    // Read off the answer rather than from a frame the engine opened: what is
    // recognized is the exact definition canonical resolution produced for this
    // exact name, whenever it produced it.
    dispatcher = authority?.forms?.dispatcherFor(name, imported);
  } catch (error) {
    selection?.settle();
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
      authoredExpressions,
      children,
      selfClosing,
      imported,
      hideSet,
      counter,
      projectedEnv,
      position,
      callerMeta,
      callerProps,
      owner,
      path,
      checkedFailures,
      authority,
      returnBody,
      selected,
      dispatcher,
    );
  }

  const definition = imported;

  // What this definition's own body may write. A declaration carries its
  // private closure here; every other body carries whatever the caller carried,
  // which for an ordinary document is nothing. Decided from the definition
  // canonical resolution retained — the one this expansion is about to invoke,
  // reporting the origin core declared — rather than from the name alone.
  const bodyAuthority = authorityForBody(authority, name, definition);

  const placementError = validateBodyStructure(definition.bodySegments, definition.returns);
  if (placementError) {
    return [yield* raise(placementError)];
  }

  const asExpression = asExpressionViolation(name, expressions);
  if (asExpression !== undefined) {
    return [yield* raise({ type: "error", message: asExpression.message, source: name })];
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
    const refused = asBindingViolation(name, resolvedProps.as);
    if (refused !== undefined) {
      throw new Error(refused.message);
    }
    asBinding = capturedBinding(resolvedProps.as);

    const { slot: _slot, as: _as, ...propsForValidation } = resolvedProps;
    validatedProps = yield* validateProps(name, propsForValidation, definition.props);
  } catch (error) {
    return [yield* raise(schemaValidationErrorSegment(error, name))];
  }

  const missingCapture = returnCaptureViolation(name, definition.returns !== undefined, asBinding);
  if (missingCapture !== undefined) {
    return [yield* raise({ type: "error", message: missingCapture.message, source: name })];
  }

  // Capture the caller's eval environment before creating the component's
  // own env. Children are caller-provided content — expression props like
  // {pr} should resolve against the scope where the JSX was written, not
  // the component that renders <Content />.
  //
  // For multi-level nesting (Root → Provider → Instruction → ReviewBody),
  // the projectedEnv from the outer caller must be merged with the current
  // context env so that ancestor bindings propagate through all levels.
  // The current context env's ordinary bindings take precedence; the shared
  // layering helper keeps a projected caller's props object lexical.
  const contextEnv = yield* env;
  const callerEvalEnv = layerEnvironments(projectedEnv, contextEnv);

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
  const componentEnv: EvalEnv = propsEnvironment(validatedProps);
  liveEnvironment(componentEnv);

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
  // (renderChildren, render, useContent); the buffer records them so an
  // `as=` capture can be refused (§6.5).
  const bodyContentErrors: Segment[] = [];

  // Read before the invocation exists: the eval scope ambient here is the
  // caller's, and it is what `retain()` creates resources in. The loop is read
  // here for the same reason — it is the one the caller's content was written
  // in, and the invocation is about to clear it for the component's own body.
  const siteEvalScope = yield* evalScope;
  const siteLoop = yield* ActiveLoop.get();
  const siteReturn = returnBody;

  const expansion = snapshot(path, name, position);

  // Both bodies run inside one invocation, so a value component owns its
  // resources exactly like a rendered one.
  let claimProjection: ClaimFn = passthroughClaim;

  function* installInvocation(invocation: Invocation): Operation<void> {
    const enclosing = yield* ActiveProjection.get();
    const handle = createProjectionHandle({
      invocation,
      enclosing,
      children,
      caller: {
        env: capturedCallerEnv,
        meta: callerMeta,
        props: callerProps,
        hideSet,
      },
      authored: {
        env: componentEnv,
        meta: definition.meta,
        props: validatedProps,
        hideSet: newHideSet,
      },
      counter,
      callerLoop: siteLoop,
      callerReturn: siteReturn,
      ownPath: path,
      printedErrors: bodyContentErrors,
      checkedFailures,
      authority,
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

    // And from the caller's value body for the same reason: a <Return> written
    // here satisfies this component's own `returns`, never the caller's. A
    // value body installs its own frame below; a rendered one owns none, so a
    // <Return> written in it stays reserved.
    // Published on the body task, so the component's own body and everything it
    // owns read this expansion, and a nested one uncovers it again on the way
    // out (§5.6).
    yield* publishExpansion(expansion);

    // Installed on the invocation's own body task rather than a nested
    // scoped(): anything the body acquires must still be alive when teardown
    // halts the content scope, and it is released by the body's own stage.
    yield* provideEnv(componentEnv);
    yield* provideEvalScope(invocation.evalScope);
    yield* provideRetain(siteEvalScope);

    // Render closures (spec §4.8). Non-serializable, so serializeExports
    // omits them from the journal. The optional error mode is supplied by a
    // persistent evaluation's binding snapshot (§4.3), which knows the error mode of the
    // block that started the projection; an ordinary block leaves it unset and
    // the projection site's error mode applies.
    componentEnv.values.renderChildren = (override?: unknown, mode?: ErrorMode) =>
      handle.projectToString({
        kind: "children",
        override: validateRenderOverride(override),
        mode,
      });
    componentEnv.values.render = (markdown: unknown, mode?: ErrorMode) =>
      handle.projectToString({
        kind: "markdown",
        segments: scanSegments(String(markdown)),
        mode,
      });
    componentEnv.values.useContent = (slot?: unknown, mode?: ErrorMode) =>
      handle.projectToString({
        kind: "slot",
        name: slot === undefined ? undefined : String(slot),
        mode,
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
          path,
          checkedFailures,
          bodyAuthority,
          returnBody,
        );
      });
    } catch (error) {
      // Body fail-fast propagates unchanged; a return-value failure is the
      // component's own printed error and follows the caller's error mode.
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

  const bodyOwner = asBinding === undefined ? owner : undefined;
  // Where this body's own segments start, so what it renders can be told apart
  // from what the caller had already produced into the same array.
  const renderedFrom = bodyOwner?.length ?? 0;
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
      bodyOwner,
      path,
      checkedFailures,
      bodyAuthority,
      returnBody,
    );
  });

  // Exact source is a provenance, and both halves of it are read here from
  // things no answer can write: that canonical execution authorized this import
  // for a name this execution closed, and that the *host's own admitted
  // declaration* for that name states exact source. A definition claiming the
  // disposition, or segments arriving already marked, decide nothing.
  //
  // What a component declared exact renders is exact wherever it renders: the
  // caller's flow, its own returned region, or neither when the invocation
  // binds instead. Recording it here — against the segments this body produced,
  // after it produced them — is what carries the fact to the emission loop,
  // which is outside every scope the invocation owned.
  if (authorizedCanonically && authority?.declared?.declaresExact(name) === true) {
    markExactSource(
      authority?.exact,
      bodyOwner === undefined ? expanded : bodyOwner.slice(renderedFrom),
    );
  }

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

  // A rendering body already wrote into the owner, so there is nothing left to
  // hand back; one that kept its own returns what it rendered.
  return bodyOwner === undefined ? expanded : [];
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
 * Under a throwing error mode the original `DocumentationError` travels as the
 * cause, which is how the boundary restores it by identity when the component
 * does not recover.
 *
 * `rendered` is what the projection produced before it stopped. It travels with
 * the failure because a component that does not recover contributes nothing of
 * its own: the text is the caller's, it was going to render where the element
 * is written, and the invocation boundary is the last place that can hand it
 * over (§6.9 Partial output).
 */
class ContentExpansionFailure extends ContentError {
  readonly rendered: readonly Segment[];

  constructor(
    errors: readonly ErrorSegment[],
    cause?: DocumentationError,
    rendered: readonly Segment[] = [],
  ) {
    super(errors);
    this.cause = cause;
    this.rendered = rendered;
  }
}

function errorSegments(segments: Segment[]): ErrorSegment[] {
  return segments.filter((segment) => segment.type === "error");
}

/**
 * Carries a non-Error value a function component threw. The invocation
 * boundary transports failures as Errors — `withInvocation` wraps anything
 * else with `asError`, which keeps the string but loses the value — so the
 * value rides across in this carrier and the printed error is translated from
 * the exact value the component threw, `undefined` included.
 */
class ThrownValue extends Error {
  constructor(readonly value: unknown) {
    super(String(value));
  }
}

/**
 * Report a printed error built from a failure, keeping that failure reachable
 * underneath whatever settlement produces.
 *
 * The printed error is what the document says, and under a throwing error mode the
 * `DocumentationError` carrying it is what the execution fails with. The failure
 * it was built from is the structural account of how the component got there —
 * a component that recovered from failed content and then reported a failure of
 * its own is the only place the original content failure survives.
 *
 * The link is attributed to the segment before it is raised, so settlement
 * constructs a failure that already carries it: middleware that catches what
 * `raise` throws is an observer like any other, and there is no moment in which
 * this printed error exists without its account. The observation itself is still the
 * single `raise` of the segment.
 */
function* raiseFrom(segment: ErrorSegment, from: unknown): Operation<ErrorSegment> {
  yield* attributeCause(segment, from);
  return yield* raise(segment);
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
  /** Authored text of the props the scanner resolved into `props` (§6.5). */
  authoredExpressions: Record<string, string>,
  children: Segment[],
  selfClosing: boolean,
  definition: FunctionComponentDefinition,
  hideSet: Set<string>,
  counter: BlockCounter,
  projectedEnv: EvalEnv | undefined,
  position: SourcePosition | undefined,
  /** The invoking frame's meta and props, for content this component projects. */
  callerMeta: Record<string, unknown>,
  callerProps: Record<string, Json>,
  /**
   * The caller's output owner, when this invocation renders into it. What the
   * projected content rendered before a failure the component did not recover
   * from goes here, and nowhere else: an invocation captured with `as` produces
   * a binding rather than output and passes none (§6.9).
   */
  callerOwner: Segment[] | undefined,
  path: string,
  /** This work's checked-failure ledger, inherited from the invoking element. */
  inherited: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
  /**
   * The identity domain canonical resolution selected for this invocation.
   *
   * Absent unless this execution built the implementation that resolution
   * chose, which is what puts an invocation in a domain at all
   * (`invocation-identity.ts`).
   */
  selected: IdentityDomain | undefined,
  /**
   * The dispatcher canonical resolution selected for this invocation.
   *
   * Absent unless resolution answered with a form dispatcher this copy of core
   * built, which is what a dispatcher requires before it will enter one of its
   * form-specific bodies (`invocation-identity.ts`).
   */
  dispatcher: FunctionComponent | undefined,
): Operation<Segment[]> {
  // An invocation of core's own `<Test>` keeps its checked failures to itself:
  // they become that invocation's failure, which is how a failing test is the
  // outcome of the test, and the run's own record stays clear so the work after
  // it still runs (§3.6).
  //
  // The definition being expanded, compared with the one this copy of core
  // registered — so containment is granted by canonical core to a construct
  // canonical core owns. A repository `Test`, or a package that registers the
  // name, is selected ahead of core's default: a different definition runs and
  // inherits the ordinary disposition.
  const checkedFailures = definition.fn === CoreTest ? containedLedger(inherited) : inherited;
  const asExpression = asExpressionViolation(name, expressions);
  if (asExpression !== undefined) {
    return [yield* raise({ type: "error", message: asExpression.message, source: name })];
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
    if (!captured.has(key)) {
      openProps[key] = value;
      continue;
    }
    // The scanner resolved this one because its text reads as JSON, but the
    // definition that was selected declares it a capture — so the reading is
    // not what the author asked for. Evaluating the authored text is: it is
    // the same expression, run where the by-reference contract holds, so a
    // value JSON has no shape for reaches the component as itself. A prop
    // written as a quoted attribute has no authored expression and stays the
    // literal string it was.
    const authored = authoredExpressions[key];
    if (authored === undefined) {
      literalCaptures[key] = value;
    } else {
      expressionCaptures[key] = authored;
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
  const asRefused = asBindingViolation(name, resolvedProps.as);
  if (asRefused !== undefined) {
    return [yield* raise({ type: "error", message: asRefused.message, source: name })];
  }
  const asBinding = capturedBinding(resolvedProps.as);
  const owner = asBinding === undefined ? callerOwner : undefined;
  const { slot: _slot, as: _as, ...propsForValidation } = resolvedProps;

  // Validate props
  let validatedProps: Record<string, Json>;
  try {
    validatedProps = yield* validateProps(name, propsForValidation, definition.props);
  } catch (error) {
    return [yield* raise(schemaValidationErrorSegment(error, name))];
  }

  const returns = definition.returns;
  const missingCapture = returnCaptureViolation(name, returns !== undefined, asBinding);
  if (missingCapture !== undefined) {
    return [yield* raise({ type: "error", message: missingCapture.message, source: name })];
  }

  // Read before the invocation exists: the eval scope ambient here is the
  // caller's, and it is what `retain()` creates resources in. The loop is read
  // here for the same reason — see expandComponent.
  const siteEvalScope = yield* evalScope;
  const siteLoop = yield* ActiveLoop.get();
  const siteReturn = returnBody;

  // Resolved once, here: an operand is what the call site meant, not what the
  // component's own body later did to the environment.
  const siteEnv = yield* env;
  const captureEnv = layerEnvironments(projectedEnv, siteEnv)?.values ?? {};

  // The error mode of the region this element is written in, read before the
  // invocation can install one of its own. Content the caller wrote belongs to
  // that region, so a `printErrors(fn)` declaration — the one thing that makes
  // the mode inside an invocation differ from the mode at its site — governs
  // the component and not the text somebody else put inside it (§6.9).
  const siteErrorMode = (yield* ErrorMode.get()) ?? "print";

  const expansion = snapshot(path, name, position);

  let publishedBinding = false;
  const binding: TestHarnessBinding = {
    has(): boolean {
      return asBinding !== undefined;
    },
    *publish(value: unknown): Operation<void> {
      if (publishedBinding) {
        throw new Error(`<${name} /> published its invocation binding more than once.`);
      }
      publishedBinding = true;
      if (asBinding === undefined) {
        return;
      }
      if (siteEnv === undefined) {
        throw new Error(`Prop "as" on <${name} /> requires a parent evaluation environment.`);
      }
      siteEnv.values[asBinding] = value;
    },
  };

  /** The invocation itself, and what a failure of it means. */
  const invoke = function* (): Operation<Segment[]> {
    // Call the function component inside its invocation, with content middleware
    // in scope so it can render its invocation content through `yield* content()`.
    try {
      const output: unknown = yield* withInvocation(function* (invocation) {
        const enclosing = yield* ActiveProjection.get();
        // Minted before the handle, because the handle is what raises it: an
        // invocation names nothing while it is expanding its own content, and
        // that is the whole of how a nested component is reached.
        //
        // The domain is this execution's own, for this authored name, from the
        // state installation built before anything could observe it — never
        // from a definition, a registry answer or a context, all of which a
        // handler may keep from one attachment and hand back inside another.
        // The frame is the one the body is about to run in, so an issuance
        // routed into a concurrent invocation of the same component answers
        // nothing there.
        //
        // The authored shape travels with it, taken from the scan the same way
        // the contextual answer below is. Both report it; only this one is
        // beyond reach of the chain that reports it, which is what a component
        // choosing an effect from it needs.
        const issued = issueInvocation(
          expansion.id,
          name,
          selected,
          yield* useScope(),
          !selfClosing,
          dispatcher,
        );
        const handle = createProjectionHandle({
          invocation,
          projecting: issued.projecting,
          enclosing,
          children,
          caller: {
            env: undefined,
            meta: callerMeta,
            props: callerProps,
            hideSet,
          },
          authored: {
            env: undefined,
            meta: callerMeta,
            props: callerProps,
            hideSet,
          },
          counter,
          callerLoop: siteLoop,
          callerReturn: siteReturn,
          ownPath: path,
          checkedFailures,
          authority,
        });
        invocation.evalScope.scope.set(ActiveProjection, handle);

        yield* ActiveLoop.set(undefined);
        yield* publishExpansion(expansion);
        yield* provideEvalScope(invocation.evalScope);
        yield* provideRetain(siteEvalScope);
        yield* Component.around(
          {
            *content([slotName], _next) {
              // Asked for as an outcome, so a failure arrives with what the
              // projection rendered before it. `content()` still presents the
              // failure at the author's call — the difference is that the text
              // is no longer lost when the component does not recover.
              const outcome = yield* handle.tryProject({
                kind: "slot",
                name: slotName,
                mode: siteErrorMode,
              });
              if (outcome.failure !== undefined) {
                // A throwing error mode already decided this execution fails; the call
                // site still sees the public shape, and the original failure
                // travels as the cause so the boundary can restore it.
                if (outcome.failure instanceof DocumentationError) {
                  throw new ContentExpansionFailure(
                    [outcome.failure.segment],
                    outcome.failure,
                    outcome.segments,
                  );
                }
                throw outcome.failure;
              }
              const errors = errorSegments(outcome.segments);
              if (errors.length > 0) {
                throw new ContentExpansionFailure(errors, undefined, outcome.segments);
              }
              return renderSegments(outcome.segments);
            },
            // The element's shape, not its rendered result: content that renders
            // an empty string is still content.
            // deno-lint-ignore require-yield
            *hasContent(_args, _next) {
              return !selfClosing;
            },
            // The engine's own answer about the engine's own prop: `as` was
            // validated and stripped above, and this reports whether it was
            // there. Nothing else about the binding crosses — not its name, not
            // the environment it will be written to.
            // deno-lint-ignore require-yield
            *hasBinding(_args, _next) {
              return asBinding !== undefined;
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
            // Canonical execution's own answer, built from the frame it is
            // already holding. A program admitted here runs under the site's
            // authority and against the site's bindings, and neither is
            // reachable from the component that asked.
            *expandProgram([program], _next) {
              return yield* expandProgramBody(program, {
                counter,
                callerValues: captureEnv,
                checkedFailures,
                authority: programAuthority(authority),
              });
            },
            // The same authority the program will run under, asked what each
            // name it writes resolves to. The private closure is already gone
            // from it, so a name an enclosing declaration keeps to itself
            // resolves to nothing here exactly as it will there.
            *resolveProgramSite([named], _next) {
              return yield* resolveProgramComponents(named, programAuthority(authority));
            },
            *tryContent([slotName], _next) {
              const outcome = yield* handle.tryProject({
                kind: "slot",
                name: slotName,
                mode: siteErrorMode,
              });
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
        // Projection follows the same ordinary-binding layering as Markdown
        // expansion while retaining the projected caller's props namespace.
        if (projectedEnv) {
          const siteEnv = yield* env;
          const projectedSiteEnv = layerEnvironments(projectedEnv, siteEnv) ?? { values: {} };
          yield* Component.around(
            {
              env: () => projectedSiteEnv,
            },
            { at: "min" },
          );
        }
        try {
          if (TestHarnessComponentDefinition.own(definition.fn)) {
            return yield* definition.fn.invoke(validatedProps, binding);
          }
          // Ended in the same breath the body is: an issuance a wrapper kept
          // from a finished element authorizes nothing when it is routed here.
          try {
            return yield* definition.fn(validatedProps, issued.invocation);
          } finally {
            issued.close();
          }
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
          returns === undefined
            ? output
            : yield* validateReturnValue(name, parseJson(output), returns);
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

      const fatal = fatalCause(error);

      // A refused activation decision is not a failure any boundary may account
      // for. The test never ran, so a handler that printed it, contained it, or
      // recorded it as a result would be describing a test that does not exist —
      // and under a composition with no completion policy, absorbing it is what
      // lets a run that ran no test finish successfully.
      //
      // It therefore travels on exactly as it arrived, before any handler is
      // dispatched, and after the fatal search so that a durability or Files
      // failure underneath still wins. Recognized here, in the copy of core
      // whose own `<Test>` was expanding: the mark is private, so this is the
      // only place that can see it and the only place that needs to.
      if (fatal === undefined && carriesTestActivationDecision(error)) {
        throw error;
      }

      // A component's account of a failure that is not its own. Asked first,
      // because the decision it carries is this failure's *subject* rather than
      // a fatal error discovered beneath it — the same reason a
      // `ContentExpansionFailure` holding one is not fatal here either. Nothing
      // fatal can be the subject: a durability or Files failure is rethrown
      // wherever a segment would otherwise be raised, so it never becomes the
      // decision a region settled.
      const projected = projectedContentFailure(error);
      if (projected !== undefined) {
        // A `throw` decision is final and no boundary may print what left the
        // region, so the decision travels alone (see the same rule below).
        if (!decidedByOutput(projected)) {
          throw projected;
        }
        return [
          yield* handleFailure({
            name,
            ...(expansion.position === undefined ? {} : { position: expansion.position }),
            error: asFailure(error),
            // The sentence is this component's; the failure is the caller's.
            // A declaration the component made about itself passes it outward
            // (§6.8.1), so the region the content was written in settles it.
            origin: "content",
          }),
        ];
      }

      // Not the document's failure to render: a journal that no longer describes
      // this run, or an error mode that has already decided the document fails.
      if (fatal !== undefined) {
        throw fatal;
      }
      // The content the component asked for failed and it did not recover, so the
      // invocation is replaced by what the projection already reported (§6.9) and
      // reporting it again here would double-observe it.
      if (error instanceof ContentExpansionFailure) {
        if (error.cause instanceof DocumentationError) {
          // The component contributed nothing, so what its content rendered
          // before stopping is the caller's own text and belongs where the
          // element is written. A call site that produces a binding rather than
          // document text owns no region and receives none of it (§6.9).
          owner?.push(...error.rendered);
          // A `throw` decision is final: the region is hidden, so no printing
          // boundary may undo it. An `output` decision leaves an ordinary
          // propagating failure — the region already stopped, and printing what
          // left it is what a boundary is for. The region's own failure travels
          // on, not the segments it transported: reporting those again would
          // print an error the region already decided about.
          if (!decidedByOutput(error.cause)) {
            throw error.cause;
          }
          return [
            yield* handleFailure({
              name,
              ...(expansion.position === undefined ? {} : { position: expansion.position }),
              error: error.cause,
              // The caller's content failed, not this component. A boundary the
              // component declared about itself passes this outward; the
              // region's own boundary, if it has one, decides it (§6.8.1).
              origin: "content",
            }),
          ];
        }
        return [...error.errors];
      }
      // A return that failed its schema already names the component and carries
      // its issues; wrapping it would bury both.
      if (error instanceof SchemaValidationError) {
        return [yield* raise(schemaValidationErrorSegment(error, name))];
      }
      // An ordinary failure. Whether the document carries on is the nearest
      // printing boundary's decision, and the default is that it does not.
      const thrown = error instanceof ThrownValue ? error.value : error;
      return [
        yield* handleFailure({
          name,
          ...(expansion.position === undefined ? {} : { position: expansion.position }),
          error: asFailure(thrown),
        }),
      ];
    }
  };

  // The boundary sits outside the whole invocation, so it is still installed
  // while the invocation is being dismantled — middleware a component installs
  // for itself is gone by then. Outside also puts the nested components the
  // component itself reaches inside it, since their scopes descend from this
  // one. Scoped, so a component that prints its own failures does not quietly
  // decide the same for its siblings. Declared by the component, so it speaks
  // for the component's own work and not for the content a caller projected
  // through it — which keeps the mode of the region it is written in and
  // reports a failure past this boundary.
  // What this invocation returns is accepted only if the run's own record came
  // through it clear. A component may catch the `ContentError` its projected
  // content raised and return replacement text; that decides what the component
  // reports, not whether a command that exited nonzero left the run intact
  // (#441).
  //
  // The run's record, not this frame's: a contained invocation keeps its checked
  // failures, which is what makes them that test's failed result rather than the
  // region's. Re-raising one here would hand the enclosing region a failure the
  // containment exists to keep from it (§3.6).
  function* accepted(): Operation<Segment[]> {
    const before = inherited?.failure;
    let printsOwnFailures = false;
    if (!TestHarnessComponentDefinition.own(definition.fn)) {
      printsOwnFailures = printsErrors(definition.fn);
    }
    // Run the invocation here, before the ledger is read again: what the
    // component did to the run's record is the thing being asked about, and a
    // check made against an operation that has not run yet can only ever see
    // the record it started from.
    const produced = yield* printsOwnFailures
      ? scoped(function* () {
          yield* usePrintErrors("component");
          return yield* invoke();
        })
      : invoke();
    const suffered = inherited?.failure;
    if (suffered !== undefined && suffered !== before) {
      return [yield* raise(suffered)];
    }
    return produced;
  }
  return yield* accepted();
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

    // A successful `undefined` is the absence of a value, and absence is
    // written by leaving the prop out (§6.5). It happens here, before
    // validation, so an optional prop stays unset, a declared default is
    // supplied by the schema, and a required one fails as missing — and no
    // prop, event or journal value ever holds `undefined`. `null` is a value
    // the author wrote and crosses the boundary as itself.
    if (typeof result === "undefined") {
      continue;
    }

    if (typeof result === "function") {
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
  const evalEnv = layerEnvironments(explicitEnv, contextEnv);

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
      if (seg.type === "component" && seg.name !== "Content") {
        return {
          ...seg,
          projectedEnv: callerEnv,
          children: project(seg.children),
        };
      }
      // A `<Content />` passing through is a projection the invocation that
      // wrote it already resolved: its content carries that invocation's env,
      // and it is recognized by identity, which a copy would lose.
      return seg;
    });
  };
  return project;
}

/**
 * Replace `<Content />` / `<Content slot="X" />` in a segment list with the
 * caller's children (partitioned by slot). Text interpolation waits until the
 * expansion frame is installed, so a current binding named `props` is used.
 * Slot validation errors are emitted once, at the first projection point,
 * tracked via the shared `state`.
 *
 * A projection point is wherever the body writes one, so this descends through
 * every authored element on the way. Only the body is walked: what a projection
 * resolves to belongs to the caller, and the caller's own body already
 * substituted it.
 */
function substituteSegmentList(
  segments: Segment[],
  slots: SlotMap,
  project: ProjectFn,
  state: SubstitutionState,
  claim: ClaimFn,
): Segment[] {
  return segments.flatMap((segment): Segment[] => {
    if (segment.type !== "component") {
      return [segment];
    }
    if (segment.name === "Content") {
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
      // `slot` names which of this invocation's slots to read, and reading
      // them consumes it (§6.3.5). A resolved projection nested inside another
      // invocation is ordinary content there, so it partitions by position.
      const { slot: _, ...props } = segment.props;
      const element: ComponentElement = {
        ...segment,
        props,
        children: projected,
        selfClosing: false,
      };
      return [...pendingErrors, claim(element)];
    }
    const children = substituteSegmentList(segment.children, slots, project, state, claim);
    const untouched =
      children.length === segment.children.length &&
      children.every((child, index) => child === segment.children[index]);
    return untouched ? [segment] : [{ ...segment, children }];
  });
}

/**
 * Replace `<Content />` and `<Content slot="X" />` invocations with the
 * caller's children, partitioned by slot assignment.
 *
 * When no `slot` props are present anywhere, this behaves identically
 * to the original single-slot substituteContent.
 */
function substituteContent(
  bodySegments: Segment[],
  children: Segment[],
  callerEnv: EvalEnv | undefined,
  claim: ClaimFn,
): Segment[] {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);
  return substituteSegmentList(bodySegments, slots, project, state, claim);
}

interface BodyChunk {
  /** true = a rendered `<Output>` region; false = documentation (executed, not rendered). */
  output: boolean;
  segments: Segment[];
  /**
   * The path this chunk expands under. An `<Output>` region is consumed here and
   * never reaches dispatch, so its frame is added when the chunk is built (§5.6).
   */
  path?: string;
  /** Where this chunk's segments start in the body they were taken from. */
  indexBase?: number;
  /**
   * An error about the region declaration itself rather than about work inside
   * one. The region never opened, so the mode it would have installed has
   * nothing to say about it: the enclosing mode decides, which is how a
   * mistyped `<Output>` stays a printed error in a document that prints.
   */
  declaration?: boolean;
}

/**
 * The body output/return contract, read once in `body-structure.ts`.
 *
 * Re-exported here because expansion is where these have always been reached
 * from; the walk and the catalog now live beside the facts validation reads, so
 * the two callers cannot drift.
 */
export { bodyHasOutput, validateBodyStructure, validateOutputPlacement };

/**
 * Partition a definition body into ordered chunks (spec §6.9). Output error mode
 * is determined by definition provenance — top-level `<Output>` segments in
 * the source, before `<Content />` substitution — so caller-projected
 * `<Output>` can neither activate nor alter it. `<Content />` inside a
 * top-level `<Output>` is substituted one level in; slot errors are emitted
 * once across the whole body via the shared substitution state.
 */
function buildBody(
  bodySegments: Segment[],
  children: Segment[],
  callerEnv: EvalEnv | undefined,
  claim: ClaimFn,
  path: string,
): BodyChunk[] {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);
  const chunks: BodyChunk[] = [];

  for (const [index, segment] of bodySegments.entries()) {
    if (segment.type === "component" && segment.name === "Output") {
      const propsViolation = outputPropsViolation(segment);
      if (propsViolation !== undefined) {
        chunks.push({
          output: true,
          segments: [{ type: "error", message: propsViolation, source: "Output" }],
          declaration: true,
        });
        continue;
      }
      const outputSegments = substituteSegmentList(segment.children, slots, project, state, claim);
      chunks.push({
        output: true,
        segments: outputSegments,
        path: extendPath(path, elementFrame(segment.name, elementSite(segment.position, index))),
      });
      continue;
    }

    const docSegments = substituteSegmentList([segment], slots, project, state, claim);
    chunks.push({ output: false, segments: docSegments, indexBase: index });
  }

  return chunks;
}

/**
 * Expand a definition body (spec §6.9). Without a top-level `<Output>`, the
 * whole body renders (backward compatible). With `<Output>`, only the declared
 * regions render; documentation executes for its side effects under `throw` and
 * its rendered result is discarded; output regions install `output`, so an
 * undecided error in a region fails the run and nothing after it — the rest of
 * the region, later regions, later documentation — begins.
 * Regions and documentation run in document order, so output can depend on
 * bindings computed by preceding documentation.
 *
 * A failing region keeps what it rendered: every region writes into the owner
 * as it goes, so the caller is already holding the prefix when the failure
 * reaches it (§6.9 Partial output).
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
  /**
   * Where this body renders. A body that renders into the document shares its
   * caller's owner, so a region that fails partway has already handed over what
   * it produced; an invocation captured with `as` produces a binding rather
   * than output and passes none.
   */
  owner: Segment[] | undefined,
  path: string,
  /** Whether the invoking element sits inside a `<PrintErrors>` region. */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<Segment[]> {
  if (!bodyHasOutput(bodySegments)) {
    const substituted = substituteContent(bodySegments, children, callerEnv, claim);
    return yield* expandSegmentsWithin(
      substituted,
      meta,
      props,
      hideSet,
      counter,
      owner,
      path,
      0,
      checkedFailures,
      authority,
      returnBody,
    );
  }

  const chunks = buildBody(bodySegments, children, callerEnv, claim, path);
  const output: Segment[] = owner ?? [];

  for (const chunk of chunks) {
    const chunkPath = chunk.path ?? path;
    const chunkBase = chunk.indexBase ?? 0;
    if (chunk.declaration) {
      yield* expandSegmentsWithin(
        chunk.segments,
        meta,
        props,
        hideSet,
        counter,
        output,
        chunkPath,
        0,
        checkedFailures,
        authority,
        returnBody,
      );
    } else if (chunk.output) {
      yield* scoped(function* () {
        yield* ErrorMode.set("output");
        return yield* expandSegmentsWithin(
          chunk.segments,
          meta,
          props,
          hideSet,
          counter,
          output,
          chunkPath,
          0,
          checkedFailures,
          authority,
          returnBody,
        );
      });
    } else {
      // Documentation: execute for side effects, discard rendered output.
      yield* scoped(function* () {
        yield* ErrorMode.set("throw");
        return yield* expandSegmentsWithin(
          chunk.segments,
          meta,
          props,
          hideSet,
          counter,
          undefined,
          chunkPath,
          chunkBase,
          checkedFailures,
          authority,
          returnBody,
        );
      });
    }
  }

  return output;
}

/**
 * Run documentation for its side effects and discard what it renders. The
 * throwing error mode makes the first error stop the body immediately.
 *
 * Set as an error mode value, not as raise middleware: a projection launched from
 * here runs in the invocation's content scope, which inherits the value but
 * would never see middleware installed on this frame.
 */
function runDocumentation(
  segments: Segment[],
  meta: Record<string, unknown>,
  props: Record<string, Json>,
  hideSet: Set<string>,
  counter: BlockCounter,
  path: string,
  indexBase: number,
  /** Whether the region that caused this expansion grants recovery (§3.6). */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* ErrorMode.set("throw");
    return yield* expandSegmentsWithin(
      segments,
      meta,
      props,
      hideSet,
      counter,
      undefined,
      path,
      indexBase,
      checkedFailures,
      authority,
      returnBody,
    );
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
  return yield* validateReturnValue(componentName, raw, returns);
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
  path: string,
  /** Whether the invoking element sits inside a `<PrintErrors>` region. */
  checkedFailures: CheckedFailures | undefined,
  authority: ExpansionAuthority | undefined,
  returnBody: ReturnBody | undefined,
): Operation<Json> {
  const slots = partitionBySlot(children);
  const state: SubstitutionState = { errorsEmitted: false };
  const project = makeProjectFn(callerEnv);

  // This body's own frame, published for the whole body rather than consulted
  // per top-level segment: a `<Return>` under `<If>` or inside a `<Loop>` is
  // reached by ordinary expansion, and finds this frame because those
  // directives keep the ambient one.
  // This body's own, held as a local for the whole expansion and handed to the
  // segments it expands. Nothing else can reach it.
  const ownBody = createReturnBody(componentName, returns);

  for (const [index, segment] of bodySegments.entries()) {
    const docSegments = substituteSegmentList([segment], slots, project, state, claim);
    yield* runDocumentation(
      docSegments,
      meta,
      props,
      hideSet,
      counter,
      path,
      index,
      checkedFailures,
      authority,
      ownBody,
    );
  }

  // Read after the body finished, so a return anywhere in it — including one a
  // projection reached — has been executed by now. Settled from the body this
  // expansion created and has held as a local ever since.
  const selected = ownBody.settle();
  if (!selected) {
    throw new Error(missingReturnMessage(componentName));
  }
  return selected.value;
}

/**
 * What the site contributes to a program's expansion.
 *
 * Every member is read from the frame canonical execution is already holding
 * when it answers `expandProgram`, so none of it is anything a document, a
 * component or middleware supplied.
 */
interface ProgramSite {
  counter: BlockCounter;
  /** The bindings the evaluation site can see, copied so nothing escapes. */
  callerValues: Record<string, unknown>;
  checkedFailures: CheckedFailures | undefined;
  authority: ExpansionAuthority | undefined;
}

/**
 * The three names a Markdown body publishes for its own projections.
 *
 * They close over the invocation that installed them, so carrying them into a
 * program would hand it the enclosing component's content. A program has
 * content of its own — none — and reaches nobody else's.
 */
const PROJECTION_BINDINGS: readonly string[] = ["renderChildren", "render", "useContent"];

/**
 * The environment a program's body runs in.
 *
 * Ordinary caller bindings are visible, because a program evaluated where they
 * are in scope is written to read them. They are visible *read-only* in the
 * only way that matters: this is a copy, so a binding the program creates or
 * overwrites lands here and reaches no caller.
 *
 * `props` is the program's own, never the caller's — an ambient root props
 * object is not something a program silently inherits.
 */
function programEnvironment(
  callerValues: Record<string, unknown>,
  props: Record<string, Json>,
): EvalEnv {
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(callerValues)) {
    if (!PROJECTION_BINDINGS.includes(name)) {
      values[name] = value;
    }
  }
  values.props = props;
  const environment: EvalEnv = { values };
  liveEnvironment(environment);
  return environment;
}

/**
 * Expand a complete XMD program where `<Evaluate>` admitted it (spec §5.7).
 *
 * A root's own structure applies here exactly as it does at the top of a
 * document: `<Output>` selects what renders, a `returns` declaration makes the
 * body a value body whose `<Return>` answers, and a text root is fail-capable
 * while a value root is not.
 *
 * The body is not this program's caller's, so it carries no children, no slot
 * substitution and an empty hide set. What it does carry is the site's own
 * authority and block counter — the program's durable work belongs to the run
 * that evaluated it.
 */
export function* expandProgramBody(
  program: ProgramBody,
  site: ProgramSite,
): Operation<ProgramOutcome> {
  // Before the first program effect, and settled here rather than by whoever
  // called: the resolver is canonical execution's and reaches this expansion on
  // the authority, so a handler that answered the admission's own resolution
  // dishonestly is caught by the answer it cannot reach.
  const current = yield* resolveProgramComponents(program.named, site.authority);
  if (current.some((entry) => entry.unidentified)) {
    throw new ProgramEvaluationError(UNIDENTIFIED);
  }
  if (!sameComponents(program.named, current)) {
    throw new ProgramEvaluationError(INCOMPATIBLE);
  }
  // The answers that passed the comparison are the answers the program
  // invokes. Asking the chain again and running whatever came back is the gap
  // this closes: a provider could answer one way while the site was being
  // checked and another way while the program ran.
  const settled = new ProgramImports(current);
  // Closed over the answers that passed, so a handler outside this expansion
  // that replaces one is refused where it would be invoked rather than
  // silently preferred.
  const authority: ExpansionAuthority | undefined =
    site.authority === undefined ? { imports: settled } : { ...site.authority, imports: settled };
  return yield* scoped(function* () {
    yield* provideEnv(programEnvironment(site.callerValues, program.props));
    if (program.returns !== undefined) {
      // A value root has no rendered result to fall back on, so an undecided
      // error is the evaluation's failure rather than text in the document.
      yield* ErrorMode.set("throw");
      const value = yield* expandValueBody(
        program.name,
        program.returns,
        program.bodySegments,
        [],
        program.meta,
        program.props,
        new Set(),
        site.counter,
        undefined,
        passthroughClaim,
        program.path,
        site.checkedFailures,
        authority,
        undefined,
      );
      return { kind: "value", value };
    }
    yield* ErrorMode.set("output");
    const expanded = yield* expandBody(
      program.bodySegments,
      [],
      program.meta,
      program.props,
      new Set(),
      site.counter,
      undefined,
      passthroughClaim,
      undefined,
      program.path,
      site.checkedFailures,
      authority,
      undefined,
    );
    return { kind: "text", output: renderSegments(expanded) };
  });
}

/**
 * The authority a program evaluated at this site runs under.
 *
 * Everything the site holds crosses — the imports a closed execution closes,
 * the identity domains it minted, the exact-source record — except the private
 * closure. A private component belongs to the declaration whose exact bytes
 * authored it, and a program is somebody else's text however it got here, so a
 * private name written in one resolves to nothing.
 */
function programAuthority(
  authority: ExpansionAuthority | undefined,
): ExpansionAuthority | undefined {
  if (authority === undefined) {
    return undefined;
  }
  const { privates: _privates, ...rest } = authority;
  return rest;
}

/**
 * What each name a program writes resolves to at this site.
 *
 * Canonical execution's own answer, taken from the resolver the execution put
 * on the authority rather than from anything the composable chain could
 * produce. An expansion built without one — a fragment evaluator's, which
 * resolves through its own closed table — reports every name unresolved, and
 * the comparison it feeds then rests on names and forms alone.
 */
export function* resolveProgramComponents(
  named: readonly ProgramComponentRef[],
  authority: ExpansionAuthority | undefined,
): Operation<readonly ResolvedProgramComponent[]> {
  const resolve = authority?.resolve;
  const resolved: ResolvedProgramComponent[] = [];
  for (const entry of named) {
    if (resolve === undefined) {
      resolved.push({
        name: entry.name,
        form: entry.form,
        identity: UNRESOLVED,
        definition: undefined,
        unidentified: false,
      });
      continue;
    }
    const settled = yield* resolve(entry.name);
    resolved.push({ ...settled, name: entry.name, form: entry.form });
  }
  return resolved;
}
