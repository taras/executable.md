/**
 * The root data one execution computed, handed back to the host that owns it
 * (spec §4.5, `specs/repl-spec.md`).
 *
 * Bindings are a byproduct of running the document. `<Let>`, an ordinary
 * component capture, a root `<Each as>` aggregate and a bound command all
 * assign the execution's own root environment, and by the time the document
 * settles that environment already holds everything a later run could start
 * from. Nothing needs to be journaled per name to discover it: the execution
 * reads its own root and hands the eligible data to its owner, and the ordinary
 * document result carries the same data so a settled run can be read back
 * without being executed again.
 *
 * The owner is private to canonical invocation. It is given the actual root
 * environment once, when document expansion creates it, so what it reports is
 * that object's own data rather than something found through a name, a path, a
 * coroutine, a Context or an assignment hook. It holds data, never resources:
 * no reference here extends a task, a Session or a provider's lifetime.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";

import { isJsonObject, parseJson } from "./json.ts";
import { validateBindingName } from "./live-env.ts";
import type { EvalEnv, Json, JsonObject } from "./types.ts";

/** The root namespace an execution's own validated props owns, and keeps. */
const ROOT_PROPS_BINDING = "props";

/**
 * How this execution discloses computed data to a reader.
 *
 * Supplied where the execution establishes its own secret policy, and captured
 * by value: a reader asking the handle later must not be able to install a
 * same-name Context and be answered by it instead. A refusal comes back as
 * `Err` and carries no map and no matched text.
 */
export type BindingsDisclosure = (data: JsonObject) => Operation<Result<JsonObject>>;

/** One execution's own computed root data, as its host reads it. */
export interface ComputedBindings {
  /**
   * Take this execution's own disclosure policy.
   *
   * Called once, where the execution establishes that policy — before its root
   * import, and therefore before it has computed anything. Until then a read
   * refuses rather than answering from no policy at all.
   */
  adopt(disclose: BindingsDisclosure): void;
  /**
   * Hand over the actual root environment this execution expands against.
   *
   * Called once, by the expansion that created it. Before it the execution has
   * computed no root data of its own, which is a different answer from having
   * computed none.
   */
  attach(root: EvalEnv): void;
  /**
   * Keep the data an accepted ordinary result carries, live or restored.
   *
   * After this the owner answers from the result rather than from a live
   * environment, which is what lets a completed run be read without being
   * executed again.
   */
  settle(data: JsonObject | undefined): void;
  /** Drop every live reference this owner holds, during its owner's teardown. */
  release(): void;
  /** The eligible data a settling result carries, or nothing before a root. */
  computed(): JsonObject | undefined;
  /** What a host reads: eligible data, or why it cannot be disclosed. */
  read(): Operation<Result<JsonObject>>;
}

/**
 * What a live read answers when the execution ended without an accepted result.
 *
 * A halted or fatally failed run retained nothing, so there is no result to
 * read and no live environment left to read instead. Answering with the map it
 * happened to hold would report data no later run can start from.
 */
/** What a read answers before this execution has established its own policy. */
export const NO_DISCLOSURE_POLICY =
  "this execution has not established its disclosure policy yet, so it discloses nothing.";

export const NO_ACCEPTED_RESULT =
  "this execution ended without an accepted result, so it has no computed root data to read.";

/**
 * Build one execution's owner.
 *
 * Created before the execution establishes its secret policy, so it starts
 * without one and takes it where that decision is made. A run that discloses
 * nothing special still reads through a policy, so there is one path and not
 * two.
 */
export function createComputedBindings(): ComputedBindings {
  let disclose: BindingsDisclosure | undefined;
  let root: EvalEnv | undefined;
  let held: JsonObject | undefined;
  let accepted = false;
  let ended = false;
  return {
    adopt(policy: BindingsDisclosure): void {
      disclose = policy;
    },
    attach(given: EvalEnv): void {
      root = given;
    },
    settle(data: JsonObject | undefined): void {
      held = data;
      accepted = true;
      root = undefined;
    },
    release(): void {
      root = undefined;
      ended = true;
    },
    computed(): JsonObject | undefined {
      return root === undefined ? undefined : eligibleRootBindings(root);
    },
    *read(): Operation<Result<JsonObject>> {
      const policy = disclose;
      if (policy === undefined) {
        return Err(new Error(NO_DISCLOSURE_POLICY));
      }
      if (accepted) {
        return yield* policy(held ?? {});
      }
      const live = root;
      if (live !== undefined) {
        return yield* policy(eligibleRootBindings(live));
      }
      // No root yet is an empty answer; a root that is gone without an accepted
      // result is a refusal. The two are told apart by whether this owner's
      // teardown has run, so a read before the document starts does not look
      // like a read after it was halted.
      return ended ? Err(new Error(NO_ACCEPTED_RESULT)) : Ok({});
    },
  };
}

/**
 * The eligible own data of one root environment, copied.
 *
 * Every own name the language bound, whichever construct bound it — a
 * whitelist of capture producers would omit the ones nobody thought of. What
 * is left out is what the receiving boundary cannot take: `props`, which each
 * execution validates for itself; a name no binding could have; and any value
 * outside the strict JSON domain, omitted whole rather than coerced or
 * partially serialized. The live overlay is not here at all — it hangs off a
 * private symbol rather than off `values`.
 *
 * Copied through the same walk an initial root binding is copied through, so
 * what a reader holds is its own graph and a later mutation of the operand
 * changes nothing it already handed over.
 */
export function eligibleRootBindings(root: EvalEnv): JsonObject {
  const eligible: JsonObject = {};
  for (const name of Object.keys(root.values)) {
    if (name === ROOT_PROPS_BINDING) {
      continue;
    }
    const binding = validateBindingName(name);
    if (!binding.ok || binding.value !== name) {
      continue;
    }
    const copied = attemptJson(root.values[name]);
    if (copied === undefined) {
      continue;
    }
    // Defined rather than assigned, for the reason the root's own initial
    // bindings are defined: `values["__proto__"] = …` reaches
    // `Object.prototype`'s inherited setter, and what that does depends on the
    // engine.
    Object.defineProperty(eligible, name, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return eligible;
}

/** One candidate's detached JSON copy, or nothing because it is not JSON. */
function attemptJson(value: unknown): Json | undefined {
  try {
    return parseJson(value);
  } catch {
    return undefined;
  }
}

/**
 * The optional computed data an ordinary document result carries, read whole.
 *
 * Absent says this result supplied no binding byproduct — an older result, or
 * one from a run that never created a root. Present and unreadable is a result
 * this version cannot read at all, rather than one to drop the member from:
 * silently discarding it would hand a later entry a smaller environment than
 * the record describes.
 */
export function parseComputedBindings(carried: unknown): JsonObject | undefined {
  if (carried === undefined) {
    return undefined;
  }
  const parsed = parseJson(carried);
  if (!isJsonObject(parsed)) {
    throw new Error("A document result records its computed bindings as an object.");
  }
  for (const name of Object.keys(parsed)) {
    if (name === ROOT_PROPS_BINDING) {
      throw new Error(
        "A document result's computed bindings do not include `props`: each execution's props " +
          "namespace is the one its own root validated.",
      );
    }
    const binding = validateBindingName(name);
    if (!binding.ok || binding.value !== name) {
      throw new Error(
        "A document result's computed bindings are recorded under names a binding can have.",
      );
    }
  }
  return parsed;
}
