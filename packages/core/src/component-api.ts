/**
 * Component Api — contextual operations for component expansion.
 *
 * One public Api replaces the former dependency container (ExpansionContext)
 * and raw Effection context keys. Context-dependent behavior is installed as
 * scope-local middleware via `Component.around(...)`:
 *
 * - Runtime implementations (document import, modifier execution, component
 *   state) install at `{ at: "min" }`. Middleware installed in a nested scope
 *   runs before inherited middleware, so a component that installs its own
 *   `env` shadows its ancestors without leaking into siblings — install
 *   inside `scoped()` for automatic removal.
 * - Caller instrumentation and overrides wrap at the default `"max"`.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import type { Operation, Result, Stream } from "effection";
import type { EvalScope } from "@effectionx/scope-eval";
import { settle } from "./errors.ts";
import { ComponentExpansionProtocolError } from "./component-expansion.ts";
import type { BoundExecRequest } from "./bound-exec.ts";
import type { Expansion } from "./expansion.ts";
import type {
  CodeBlockContext,
  CodeBlockResult,
  ComponentDefinition,
  ComponentFailure,
  ComponentRegistry,
  PartialContent,
  ErrorSegment,
  EvalEnv,
  FunctionComponentDefinition,
  Modifier,
  SourcePosition,
} from "./types.ts";

/**
 * Where one executable element has reached, as its observers are told.
 *
 * `enter` before anything is resolved, `active` where accepted work starts,
 * `exit` where that work ends and its owned cleanup begins, and exactly one
 * terminal observation — `complete` once canonical acceptance has reconciled
 * the outcome, or `cancelled` where the element unwound cleanly instead.
 *
 * `complete` carries `Result<void>` and nothing else: what the element
 * produced, what it bound and which error identity canonical execution is
 * holding stay private, so an observation says what happened and decides
 * nothing about it.
 */
export type ComponentExpansionPhase =
  | { readonly phase: "enter" }
  | { readonly phase: "active" }
  | { readonly phase: "exit"; readonly reason: "returned" | "failed" | "cancelled" }
  | { readonly phase: "complete"; readonly result: Result<void> }
  | { readonly phase: "cancelled" };

/**
 * One executable element's complete expansion, offered to whoever is watching.
 *
 * Issued by canonical execution before resolution, props validation or any
 * body runs. It is an offer to surround the work, not a way to do it: the
 * request is branded, it delegates once, and nothing on it reaches what the
 * element produced.
 */
export interface ComponentExpansionRequest {
  /**
   * Core's detached description of the element this surrounds.
   *
   * Presentation information only. It names a logical source element, not a
   * process call or a capability, and grants nothing.
   */
  readonly expansion: Expansion;
  /**
   * The latest phase, then each change in order, per subscription.
   *
   * Independent and scope-owned: every subscriber gets its own, ending after
   * the one terminal observation. Reading or cancelling a subscription neither
   * starts nor cancels the element, and a reader that is slow or absent delays
   * nothing.
   */
  readonly phases: Stream<ComponentExpansionPhase, void>;
}

export interface ComponentApi {
  /**
   * Surround one executable element's complete expansion (spec §5.7).
   *
   * Core issues the request before resolution or validation; delegate the
   * exact request once with `next(request)`. Whatever a handler returns is
   * ignored, catching a canonical failure does not rescue it, and completion
   * includes owned teardown and final result acceptance. A handler may refuse
   * the work by throwing or by returning without delegating.
   */
  expand(request: ComponentExpansionRequest): Operation<void>;
  /**
   * `"__root__"` imports the root document.
   *
   * `position` is where the element that asked was written. It reaches the
   * journal beside the import's identity and takes no part in it: the durable
   * record of an authored import says where the element came from, and a
   * document scanned from a string carries none.
   */
  importComponent(
    name: string,
    position?: Readonly<SourcePosition>,
  ): Operation<ComponentDefinition | FunctionComponentDefinition>;
  applyModifiers(modifiers: Modifier[], block: CodeBlockContext): Operation<CodeBlockResult>;
  /**
   * Run one `exec as="name"` block (spec §3.6).
   *
   * Bound execution is its own operation because a bound block is authorized
   * differently: its chain may hold only the built-in exec terminal and the
   * built-in `timeout`, and what it binds must be what that terminal obtained
   * from the settled process. A handler may observe the request, refuse it by
   * throwing, and delegate it. It returns nothing, and nothing it returns is
   * read — the outcome goes to the expansion that issued the request.
   */
  applyBoundModifiers(modifiers: Modifier[], block: BoundExecRequest): Operation<void>;
  /**
   * Report an ErrorSegment under the ambient error mode (spec §6.9).
   *
   * The middleware chain is the observation chain — a segment passes through it
   * once, where it is created. The default implementation settles it under
   * `ErrorMode`: printed for rendering, or thrown inside
   * suppressed documentation.
   *
   * Whoever creates an ErrorSegment calls this. A segment that reaches the
   * document without it never passes the chain, so
   * middleware that counts, logs, or forwards failures never sees it.
   */
  raise(error: ErrorSegment): Operation<ErrorSegment>;
  env: EvalEnv | undefined;
  evalScope: EvalScope | undefined;
  /** Whether the invocation wrote this capture prop at all. */
  hasCapture(name: string): Operation<boolean>;
  /**
   * Evaluate a capture prop now, against the caller's bindings (spec §6.5).
   *
   * Nothing is evaluated during prop resolution, so a capture the component
   * never asks for never runs — and an expression that throws throws here, into
   * the component that asked, rather than becoming an engine prop error.
   */
  capture(name: string): Operation<unknown>;
  codeBlock(): Operation<CodeBlockContext>;
  /** Whether the current block runs with persistent resource lifetime. */
  persistent: boolean;
  /**
   * Render the content the invoking component was written with — the default
   * content, or a named slot (spec §5.1.2). This is the canonical operation for
   * a function component; `useContent(slot?)` is a compatibility alias for it.
   *
   * Each call is a failure boundary. Requested content that expands cleanly
   * comes back as its rendered string. Requested content that produces
   * ErrorSegments throws `ContentError` carrying those original segments, so
   * normal continuation stops at the `yield* content()` expression: the
   * component's return is not processed and no `as` binding is made. Left
   * uncaught, the invocation is replaced by the original errors under a
   * printing error mode, or the original `DocumentationError` is restored under a
   * throwing one.
   *
   * Catching `ContentError` around the call is explicit recovery — the
   * component chooses what to render instead, and its consumer never sees the
   * failure. Only content the component asks for is expanded.
   */
  content(slot?: string): Operation<string>;
  /** Whether the invoking element was written with content rather than self-closed. */
  hasContent(): Operation<boolean>;
  /**
   * Whether this invocation has an engine-owned result binding — whether the
   * element was written with `as` (spec §6.10).
   *
   * A boolean and nothing more. `as` stays the engine's: it is validated and
   * stripped before a component is called, the binding name is never handed
   * over, and a component that asks this learns only whether what it returns
   * will be captured. `<Fetch>` is what needs it — a captured response makes
   * every status data, and an uncaptured one makes a failing status a failure —
   * and answering it by parsing source again would be a second, disagreeing
   * reading of the same prop.
   */
  hasBinding(): Operation<boolean>;
  /**
   * Create a resource owned by the scope that invoked this component
   * (spec §4.4).
   *
   * The factory runs in an isolated child of the invocation-site eval scope,
   * so what it acquires lives as long as that scope does — staying alive after
   * the component returns and released when the site succeeds, fails, or is
   * cancelled — while context and middleware it installs stay inside the
   * child. Only the provided value crosses back, and neither scope is handed
   * out: retention is a lifetime, not control over the caller.
   *
   * This is an operation of TypeScript component execution. Eval blocks are
   * durable — a replay restores a block's exported values without running its
   * executor — so retaining from one would leave a restored value pointing at
   * a resource that was never re-established. Eval execution installs a
   * provider that rejects the call rather than letting it succeed.
   */
  retain<T>(resource: () => Operation<T>): Operation<T>;
  /**
   * Render the invoking component's content, reporting a failure instead of
   * replacing the invocation with it.
   *
   * `content()` is the failure boundary and stays the ordinary way to ask. This
   * is for a component that renders something *in place of* the failure — a
   * test report — and so needs both what rendered before the stop and why it
   * stopped. It hands back text and a reason, never segments: there is no
   * recursion here and no reaching into the caller.
   */
  tryContent(slot?: string): Operation<PartialContent>;
  /**
   * Decide what an ordinary function-component failure means (spec §6.9).
   *
   * Called only after `withInvocation()` has dismantled the invocation, so the
   * failure it is handed accounts for the body and its teardown together. The
   * default fails the operation, which is what an ordinary Effection failure
   * does; a printing boundary answers with a printed error instead.
   *
   * Distinct from `raise`: this handles an operation failure, while `raise`
   * observes an `ErrorSegment`. A printing boundary uses both — it converts,
   * then observes exactly once.
   */
  handleFailure(failure: ComponentFailure): Operation<ErrorSegment>;
  /**
   * Components made resolvable by name for this scope (spec §5.3).
   *
   * Install with `registerComponents()` rather than by hand: each accepted
   * batch adds one immutable layer that merges over what it inherited, so a
   * nested registration shadows an outer one without changing it.
   *
   * Core's own components are not here. They are the terminal of
   * `selectComponent()`, which both execution and inspection resolve through,
   * so what this holds is only what a host or package added.
   */
  registry: ComponentRegistry;
}

/**
 * The mark an empty public terminal puts on what it raises: a namespaced,
 * non-enumerable own property carrying the name that was asked for.
 *
 * A property rather than a class, because the readers are in a different copy of
 * this module than the writer as often as not. A component loaded from disk with
 * `--include`, and a middleware package holding its own copy of core, each build
 * their own `Component` descriptor with their own empty terminal and their own
 * error class — and an execution has to recognize "nothing answered this" across
 * exactly that seam, which `instanceof` cannot do. The name is namespaced so it
 * collides with nothing, and non-enumerable so it does not travel into whatever
 * a reporter serializes.
 *
 * It conveys one fact — *this call reached an empty public terminal, asking for
 * this name* — and no authority. Anything may put it on anything; all it can
 * cause is the ordinary resolution an unanswered import gets anyway.
 */
const MISSING_IMPORT_PROVIDER = "@executablemd/core/missing-import-provider";

/**
 * What the public descriptor's own terminal raises when nothing answered.
 *
 * An execution's provider delegates to `next` first and performs its ordinary
 * resolution only for this, so a descriptor that supplied a terminal of its own
 * is answered by that terminal and never resolved twice. Exported for core,
 * published from no package entry point, and carrying nothing but the name that
 * was asked.
 */
export class MissingImportProvider extends Error {
  override name = "MissingImportProvider";
  constructor(asked: string) {
    super(
      `Component.importComponent("${asked}") has no provider. Install one with ` +
        `Component.around({ importComponent }, { at: "min" }) before expansion.`,
    );
    Object.defineProperty(this, MISSING_IMPORT_PROVIDER, {
      value: { asked },
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/**
 * Whether `error` is an empty public terminal reporting that nothing answered an
 * import of exactly `asked`.
 *
 * The whole mark is parsed rather than trusted: an own, non-enumerable property
 * under the namespaced name, holding an object whose complete own-key set is one
 * member, `asked`, whose value is the name this call asked for. Nothing is cast;
 * a payload carrying anything besides that member, however hidden, is not the
 * mark; and a mark that names another component — a foreign terminal's report
 * about a *different* import, arriving here on some other failure — is not this
 * call's.
 */
export function isMissingImportProvider(error: unknown, asked: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const mark = Object.getOwnPropertyDescriptor(error, MISSING_IMPORT_PROVIDER);
  if (mark === undefined || mark.enumerable) {
    return false;
  }
  const value: unknown = mark.value;
  // The complete own-key set, so "one member" means one: `Object.keys()` would
  // report a payload carrying hidden extras — a non-enumerable member, a symbol —
  // as the single-member mark it is not.
  if (typeof value !== "object" || value === null || Reflect.ownKeys(value).length !== 1) {
    return false;
  }
  return Object.getOwnPropertyDescriptor(value, "asked")?.value === asked;
}

/**
 * Every default but the registry, which each descriptor is given its own of:
 * a `Map` living at module scope would be one table shared by every run in the
 * process, and the lint rule that says so is right.
 */
const COMPONENT_DEFAULTS: Omit<ComponentApi, "registry"> = {
  /**
   * Nothing issued this, so there is nothing to surround.
   *
   * The public descriptor's own terminal is reached only by a caller that
   * built a request itself or kept one from an expansion that has gone. Either
   * way no canonical work is behind it, and running a body for it is the one
   * thing this seam must never do.
   */
  // deno-lint-ignore require-yield
  *expand(_request: ComponentExpansionRequest): Operation<void> {
    throw new Error(
      "Component.expand() has no canonical expansion to surround: only core issues a request, " +
        "and only the expansion that issued one can run it.",
    );
  },
  // deno-lint-ignore require-yield
  *importComponent(
    name: string,
    _position?: Readonly<SourcePosition>,
  ): Operation<ComponentDefinition | FunctionComponentDefinition> {
    throw new MissingImportProvider(name);
  },
  // deno-lint-ignore require-yield
  *applyModifiers(_modifiers: Modifier[], block: CodeBlockContext): Operation<CodeBlockResult> {
    throw new Error(
      `Component.applyModifiers() has no provider for block "${block.blockId}". Install one ` +
        `with Component.around({ applyModifiers }, { at: "min" }) before expansion.`,
    );
  },
  // deno-lint-ignore require-yield
  *applyBoundModifiers(_modifiers: Modifier[], block: BoundExecRequest): Operation<void> {
    throw new Error(
      `Component.applyBoundModifiers() has no provider for block "${block.blockId}". Install ` +
        `one with Component.around({ applyBoundModifiers }, { at: "min" }) before expansion.`,
    );
  },
  *raise(error: ErrorSegment): Operation<ErrorSegment> {
    return yield* settle(error);
  },
  env: undefined,
  evalScope: undefined,
  // deno-lint-ignore require-yield
  *hasCapture(_name: string): Operation<boolean> {
    return false;
  },
  // deno-lint-ignore require-yield
  *capture(name: string): Operation<unknown> {
    throw new Error(
      `Component.capture("${name}") has no provider: not inside a function component invocation.`,
    );
  },
  // deno-lint-ignore require-yield
  *codeBlock(): Operation<CodeBlockContext> {
    throw new Error(
      "Component.codeBlock() has no provider: no code block is executing in this scope.",
    );
  },
  persistent: false,
  /**
   * Calling for content outside an invocation is a mistake in the caller, not a
   * content failure, so this is an ordinary Error: a component's
   * `catch (error) { if (error instanceof ContentError) … }` does not absorb it.
   */
  // deno-lint-ignore require-yield
  *content(_slot?: string): Operation<string> {
    throw new Error(
      "Component.content() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *hasContent(): Operation<boolean> {
    throw new Error(
      "Component.hasContent() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *hasBinding(): Operation<boolean> {
    throw new Error(
      "Component.hasBinding() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *retain<T>(_resource: () => Operation<T>): Operation<T> {
    throw new Error("Component.retain() has no provider: not inside a component invocation.");
  },
  // deno-lint-ignore require-yield
  *tryContent(_slot?: string): Operation<PartialContent> {
    throw new Error(
      "Component.tryContent() has no provider: not inside a function component invocation.",
    );
  },
  // deno-lint-ignore require-yield
  *handleFailure(failure: ComponentFailure): Operation<ErrorSegment> {
    throw failure.error;
  },
};

export const Component: Api<ComponentApi> = createApi<ComponentApi>("Component", {
  ...COMPONENT_DEFAULTS,
  registry: new Map(),
});

/**
 * Ask one import through a descriptor whose terminal belongs to that import.
 *
 * The name is what shares middleware: a descriptor created with the stable
 * `Component` name receives every handler installed anywhere, in the order they
 * were installed, exactly as the public descriptor does. What a name does not
 * share is the default handler — each `createApi()` instance owns its own — so
 * the chain composed here terminates in the continuation this caller passed and
 * in nothing a handler can reach, replace or reorder.
 *
 * That is the whole of the correlation. A middleware may delegate `next` through
 * any descendant Effection scope and still arrive here; two imports asking at
 * the same time have two descriptors and two terminals; and a counterfeit
 * descriptor built with the same name changes only the calls made through it.
 */
export function importThroughTerminal(
  name: string,
  position: Readonly<SourcePosition> | undefined,
  terminal: (
    asked: string,
    at: Readonly<SourcePosition> | undefined,
  ) => Operation<ComponentDefinition | FunctionComponentDefinition>,
): Operation<ComponentDefinition | FunctionComponentDefinition> {
  const owned = createApi<ComponentApi>("Component", {
    ...COMPONENT_DEFAULTS,
    // Its own, and empty: what a registration installed is middleware, which
    // this descriptor shares by name, so a registry asked through it is answered
    // there exactly as it is through the public one.
    registry: new Map(),
    *importComponent(
      asked: string,
      at?: Readonly<SourcePosition>,
    ): Operation<ComponentDefinition | FunctionComponentDefinition> {
      return yield* terminal(asked, at);
    },
  });
  return owned.operations.importComponent(name, position);
}

/**
 * Surround one expansion through a descriptor whose terminal belongs to it.
 *
 * The same correlation `importThroughTerminal` makes, for the same reason: the
 * name shares every installed handler, and the default each `createApi()`
 * instance owns is this one element's continuation. Two elements expanding at
 * once have two descriptors and two terminals, and a counterfeit descriptor
 * built with the same name changes only the calls made through it.
 */
export function expandThroughTerminal(
  request: ComponentExpansionRequest,
  terminal: (delegated: ComponentExpansionRequest) => Operation<void>,
): Operation<void> {
  const owned = createApi<ComponentApi>("Component", {
    ...COMPONENT_DEFAULTS,
    registry: new Map(),
    *expand(delegated: ComponentExpansionRequest): Operation<void> {
      // This terminal is one element's continuation, so the only request it
      // may carry is the one that element issued. An authentic request from
      // *another* live invocation would otherwise reach the claim below and
      // consume somebody else's work while running this body — refusing after
      // the body has run is too late, because the effect has happened.
      //
      // Identity, not shape: a request that merely looks like this one was
      // issued for different work.
      if (delegated !== request) {
        throw new ComponentExpansionProtocolError(
          "delegated an expansion this invocation did not issue",
        );
      }
      yield* terminal(delegated);
    },
  });
  return owned.operations.expand(request);
}

export const expand: Operations<ComponentApi>["expand"] = Component.operations.expand;
export const importComponent: Operations<ComponentApi>["importComponent"] =
  Component.operations.importComponent;
export const applyModifiers: Operations<ComponentApi>["applyModifiers"] =
  Component.operations.applyModifiers;
export const applyBoundModifiers: Operations<ComponentApi>["applyBoundModifiers"] =
  Component.operations.applyBoundModifiers;
export const raise: Operations<ComponentApi>["raise"] = Component.operations.raise;
export const env: Operations<ComponentApi>["env"] = Component.operations.env;
export const evalScope: Operations<ComponentApi>["evalScope"] = Component.operations.evalScope;
export const codeBlock: Operations<ComponentApi>["codeBlock"] = Component.operations.codeBlock;
export const persistent: Operations<ComponentApi>["persistent"] = Component.operations.persistent;
export const content: Operations<ComponentApi>["content"] = Component.operations.content;
export const hasContent: Operations<ComponentApi>["hasContent"] = Component.operations.hasContent;
export const hasBinding: Operations<ComponentApi>["hasBinding"] = Component.operations.hasBinding;
export const retain: Operations<ComponentApi>["retain"] = Component.operations.retain;
export const registry: Operations<ComponentApi>["registry"] = Component.operations.registry;
export const tryContent: Operations<ComponentApi>["tryContent"] = Component.operations.tryContent;
export const hasCapture: Operations<ComponentApi>["hasCapture"] = Component.operations.hasCapture;
export const capture: Operations<ComponentApi>["capture"] = Component.operations.capture;
export const handleFailure: Operations<ComponentApi>["handleFailure"] =
  Component.operations.handleFailure;
