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
 * knows it; and a value carried on something that crosses public middleware is
 * only as private as that middleware chooses to leave it — a handler may
 * structurally copy what it delegates, and a copy of an object is not the
 * object. What was handed to a call chain is reachable by that call chain
 * alone, so the binding travels as a required argument, and the type checker
 * asks every expansion site to say which side of the caller/authored boundary
 * it is on rather than letting one default quietly.
 *
 * A code block is the one read that leaves canonical expansion: the block runs
 * through the public `Component.applyModifiers` chain. It reaches the built-in
 * terminal by closure instead of by transport — the execution that owns the
 * modifier registry supplies a `ModifierInvocation`, which keeps this binding
 * where no handler can see it and hands it to the built-in terminal directly,
 * whatever the chain did to the modifiers and the block context on the way.
 */

import { derivedEnvironment } from "./live-env.ts";
import type { Operation } from "effection";
import type { CodeBlockContext, CodeBlockResult, EvalEnv, Modifier } from "./types.ts";

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
 * How canonical expansion runs one code block.
 *
 * Supplied by the execution that owns the modifier registry, because composing
 * a chain is that execution's to do and the registry is not expansion's to
 * hold. What expansion adds is the third argument: the projection active where
 * the block is written, which the runner retains by closure for the built-in
 * terminal and hands to nothing else.
 *
 * Public `Component.applyModifiers` middleware composes around the invocation
 * exactly as it always has — it may observe, transform what it delegates,
 * refuse by throwing, or answer without delegating at all — and none of that
 * decides which terminal is privileged or what it reads.
 */
export type ModifierInvocation = (
  modifiers: Modifier[],
  context: CodeBlockContext,
  projection: ProjectionBinding | undefined,
) => Operation<CodeBlockResult>;
