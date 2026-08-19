/**
 * What one authorized invocation published, and how the content it projects
 * reads it (spec §6.3, specs/testing-spec.md).
 *
 * A construct whose body is *about* its own outcome — `<Execution as="run">`,
 * the nested-execution harness — has to make that outcome readable to the
 * assertions written inside it, before the invocation returns and therefore
 * before the engine binds anything. Publishing it into the binding environment
 * does not work: `Component.env` is public middleware, an outermost handler
 * that does not delegate answers ahead of every engine provider however deeply
 * nested, and a handler answering with a *fresh* environment on every read
 * makes publication land in a throwaway while the assertions read the fresh
 * one. A trusted host returning `Err` and the test passing anyway is the exact
 * failure this exists to stop.
 *
 * So the value never enters an environment. Canonical core keeps it here, in an
 * object it owns outright, and lays it over whatever ordinary composition
 * produced at each point where a read actually happens. Ordinary composition is
 * untouched: an unrelated name still resolves however middleware decided, and a
 * write or an eval export under any name still lands where it always did. The
 * overlay is reapplied per read rather than defended as a slot, so a same-name
 * write cannot replace it while the projection is active and cannot survive it
 * either.
 *
 * ## Why a parameter, and not a channel
 *
 * Every channel is somebody else's to replace. A Context is keyed by name, so a
 * value planted under the same name is indistinguishable from the engine's; an
 * Api is a public surface by construction; a name is reachable by anything that
 * knows it. What was handed to a call chain is reachable by that call chain
 * alone — so the binding travels as a required argument, and the type checker
 * asks every expansion site to say which side of the caller/authored boundary
 * it is on rather than letting one default quietly.
 */

import { derivedEnvironment } from "./live-env.ts";
import type { CodeBlockContext, EvalEnv, SourcePosition } from "./types.ts";
import type { ForegroundRouting } from "./foreground.ts";

/**
 * One authorized invocation's published outcome.
 *
 * Not exported beyond this package, never structural, and never handed to the
 * component that published through it or to any middleware: what crosses out of
 * here is a composed environment, never the name and never the box.
 */
export class ProjectionBinding {
  readonly #name: string;
  #published = false;
  #value: unknown;

  constructor(name: string) {
    this.#name = name;
  }

  /**
   * Take the value, once.
   *
   * A second publication is a defect in whoever holds the invocation rather
   * than a later opinion about what the child did, so it is refused instead of
   * accepted.
   */
  publish(value: unknown): void {
    if (this.#published) {
      throw new Error("an invocation published its projection binding more than once.");
    }
    this.#published = true;
    this.#value = value;
  }

  /**
   * The environment a read sees: what ordinary composition produced, with this
   * one name laid over it.
   *
   * A view, not a mutation. The composed environment is left exactly as it was
   * — the caller may still be writing to it — and an unpublished binding
   * overlays nothing at all, which is what keeps an unbound `<Execution>` on
   * the ordinary path.
   */
  read(composed: EvalEnv | undefined): EvalEnv | undefined {
    if (!this.#published) {
      return composed;
    }
    if (composed === undefined) {
      return { values: { [this.#name]: this.#value } };
    }
    return derivedEnvironment(composed, { ...composed.values, [this.#name]: this.#value });
  }
}

/**
 * The read view for one read, or the composed environment unchanged.
 *
 * Every binding read in canonical expansion goes through here, after ordinary
 * environment composition and before anything looks a name up.
 */
export function readThrough(
  composed: EvalEnv | undefined,
  binding: ProjectionBinding | undefined,
): EvalEnv | undefined {
  return binding === undefined ? composed : binding.read(composed);
}

/**
 * The block context canonical core expands a code block with while a projection
 * binding is active.
 *
 * An ordinary `CodeBlockContext` to everything that handles one — the same
 * members, in the same shape, so instrumentation and `Component.applyModifiers`
 * middleware compose around it exactly as they always did. The binding rides in
 * a private field, so the only thing that can read it back is the module that
 * put it there: the built-in `eval` terminal, which is canonical core's.
 *
 * The alternative was a public member on the context or a parameter on a public
 * modifier operation, and either one would hand the value to every handler in
 * the chain — which is the thing this whole mechanism exists to avoid.
 *
 * What this does not defend: a handler that answers `codeBlock()` with a
 * context of its own has replaced the block canonical core issued, and the
 * built-in terminal then runs against a context carrying no binding. That is
 * the pre-existing `applyModifiers` boundary — a handler there may already
 * refuse a block outright or answer with a result of its own — and not
 * something an overlay can restore.
 */
class ProjectedBlockContext implements CodeBlockContext {
  readonly #binding: ProjectionBinding;
  readonly language: string;
  readonly content: string;
  readonly blockId: string;
  readonly componentName?: string;
  readonly routing?: ForegroundRouting;
  readonly position?: Readonly<SourcePosition>;

  constructor(context: CodeBlockContext, binding: ProjectionBinding) {
    this.#binding = binding;
    this.language = context.language;
    this.content = context.content;
    this.blockId = context.blockId;
    if (context.componentName !== undefined) {
      this.componentName = context.componentName;
    }
    if (context.routing !== undefined) {
      this.routing = context.routing;
    }
    if (context.position !== undefined) {
      this.position = context.position;
    }
  }

  /** The binding `value` carries, if this class is what built it. */
  static of(value: unknown): ProjectionBinding | undefined {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    try {
      return #binding in value ? value.#binding : undefined;
    } catch {
      // A revoked proxy, or one whose `has` trap refuses. Not one of ours.
      return undefined;
    }
  }
}

/**
 * The context to expand this block with: the plain one when no projection is
 * active, and the carrier when one is.
 *
 * A block expanded outside an assertion body allocates exactly what it always
 * did, so the ordinary path is unchanged down to the object identity.
 */
export function blockContext(
  context: CodeBlockContext,
  binding: ProjectionBinding | undefined,
): CodeBlockContext {
  return binding === undefined ? context : new ProjectedBlockContext(context, binding);
}

/** The projection binding this block was issued with, for the built-in terminal. */
export function blockBinding(context: CodeBlockContext): ProjectionBinding | undefined {
  return ProjectedBlockContext.of(context);
}
