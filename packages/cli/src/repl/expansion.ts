/**
 * Pausing one execution's *expansion*, without cancelling anything.
 *
 * This is the distinction the whole module rests on. Effection is the runtime
 * and keeps running: tasks stay alive, work already started settles, and the
 * Journal head may advance while a pause is in effect. What stops is the
 * expansion walk — the engine reaching the next element, the next code block,
 * the next emission of output. So the mode is *expansion paused*, and the
 * expansion position is a different thing from the Journal head and from the
 * history position a reader has selected.
 *
 * Nothing here is a new core primitive. Everything is ordinary middleware over
 * operations expansion already performs, so what can be held is exactly what a
 * real document already crosses.
 *
 * ## Walks and gates
 *
 * A **walk** is one bracketed expansion. Three existing operations open one:
 * `Execution.document` for the run, and `Component.content` / `Component.tryContent`
 * for the content a function component asks for. A host that declares structural
 * syntax opens a fourth around its own `expand` handler; this REPL declares
 * none, and `bracketWalk` is what such a host would use.
 *
 * Everything else wrapped here is a **gate**: a step inside a walk where the
 * walk can be held before it performs the operation.
 *
 * Completeness is a property of walks, not of Effection scopes:
 *
 * ```text
 * satisfied(walk) ⟺ (holding a continuation OR having active children)
 *                   AND every active child satisfied
 * paused          ⟺ at least one active walk AND all of them satisfied
 * ```
 *
 * Both clauses matter. Without the delegation clause a parent sitting inside
 * `next()` never reports satisfied and the controller hangs in `pausing`;
 * without "every child" a parent held at its own gate reports paused while a
 * concurrent child is still expanding.
 *
 * ## Holds
 *
 * A hold is a suspended `action()`. Teardown unwinds *through* it — its discard
 * runs and no continuation is released — so interruption, document failure and
 * host shutdown release nothing after its owner has gone, and the release count
 * of a torn-down controller is zero. Continue resolves each current hold once;
 * it re-runs nothing, so it cannot replay work by construction.
 */

import { action, createContext, createSignal } from "effection";
import type { Operation, Stream } from "effection";
import { Component, DocumentOutput, Execution } from "@executablemd/core";

/** What expansion is doing. `pausing` is asked-but-not-yet-stopped. */
export type ExpansionState = "playing" | "pausing" | "paused";

/**
 * What this controller does with every member of every Api it wraps.
 *
 * One partition per Api — walks, gates, and the members that are neither —
 * because the standing risk is not a boundary that changes but one that is
 * *added*. A member core introduces later belongs to none of these lists, and
 * the inventory test says so rather than leaving an expansion path nothing
 * controls. Pause is sound only while every path crosses something here.
 */
export interface BoundaryPartition {
  /** Operations that bracket one expansion walk. */
  readonly walks: readonly string[];
  /** Steps inside a walk where the walk can be held. */
  readonly gates: readonly string[];
  /** Members that are neither, and the reason is in the comment below. */
  readonly unheld: readonly string[];
}

/**
 * `Component`, partitioned.
 *
 * `env`, `evalScope`, `persistent` and `registry` are values rather than steps —
 * there is no continuation at them to hold. `hasCapture`, `hasContent` and
 * `hasBinding` answer a question about an invocation the walk has already
 * reached; holding one would stop the same walk the gate before it already
 * stops, one question later.
 */
export const COMPONENT_BOUNDARIES: BoundaryPartition = {
  walks: ["content", "tryContent"],
  gates: [
    "importComponent",
    "applyModifiers",
    "applyBoundModifiers",
    "codeBlock",
    "capture",
    "retain",
    "raise",
    "handleFailure",
  ],
  unheld: ["env", "evalScope", "persistent", "registry", "hasCapture", "hasContent", "hasBinding"],
};

/**
 * `Execution`, partitioned.
 *
 * `document` is the run's own walk: it opens before the first element and never
 * exits until the run is over, which makes it the right anchor for *which*
 * expansion is being paused and a useless place to rest.
 *
 * `execute` is not an expansion boundary. It is the request-policy seam, asked
 * once before a document exists, and canonical core dispatches it through a
 * private instance — so holding it would delay building the run rather than
 * stopping its expansion, and would not reliably be reached at all.
 */
export const EXECUTION_BOUNDARIES: BoundaryPartition = {
  walks: ["document"],
  gates: [],
  unheld: ["execute"],
};

/**
 * `DocumentOutput`, partitioned.
 *
 * This is the gate that covers prose. Headings, paragraphs and core structural
 * syntax invoke no `Component` operation at all, so without it "expansion has
 * stopped" would still let text keep arriving.
 */
export const OUTPUT_BOUNDARIES: BoundaryPartition = {
  walks: [],
  gates: ["output"],
  unheld: [],
};

/**
 * The fourth walk: a host's own structural-syntax expansion.
 *
 * An installation that declares structural syntax brackets its `expand` handler
 * with `bracketWalk`, so what it expands is one walk rather than work nothing
 * accounts for. This REPL declares no structural syntax, so the reference
 * document never crosses it.
 */
export const HOST_WALK = "expand";

/** One bracketed expansion, and what it is waiting on. */
interface Walk {
  readonly id: number;
  readonly parent: Walk | undefined;
  readonly children: Set<Walk>;
  readonly holds: Map<number, () => void>;
  active: boolean;
}

/**
 * Which walk the running code belongs to.
 *
 * A context rather than a lookup, because a walk's gates run in coroutines the
 * controller never sees created: the root walk of a real document crosses gates
 * in nineteen of them, and they are one obligation rather than nineteen.
 */
const CurrentWalk = createContext<Walk>("executablemd.repl.expansion-walk");

/** Pausing and continuing one live execution's expansion. */
export interface ExpansionController {
  /** What expansion is doing right now. */
  readonly state: ExpansionState;
  /** Every state this controller has reached, as it reaches it. */
  readonly states: Stream<ExpansionState, never>;
  /** How many held continuations this controller has released, ever. */
  readonly released: number;
  /** Every boundary crossed, in order, with how many times. */
  readonly crossings: ReadonlyMap<string, number>;
  /** Ask expansion to stop at its next boundary. Cancels nothing. */
  pause(): void;
  /** The Continue action: release each current hold once, and play on. */
  resume(): void;
  /**
   * Bracket one expansion walk of the caller's own.
   *
   * A host that declares structural syntax wraps its `expand` handler in this,
   * so the syntax it expands is one walk rather than work nothing accounts for.
   */
  bracketWalk<T>(body: () => Operation<T>): Operation<T>;
}

/**
 * Install the controller on the calling scope.
 *
 * On the calling scope rather than in a resource, because middleware installs
 * where the install runs: a controller installed inside a resource body would
 * be invisible to the execution the caller is about to start.
 */
export function* useExpansionController(): Operation<ExpansionController> {
  const walks = new Set<Walk>();
  const states = createSignal<ExpansionState, never>();
  const crossings = new Map<string, number>();
  let mode: "playing" | "pausing" = "playing";
  let state: ExpansionState = "playing";
  let released = 0;
  let nextWalk = 0;
  let nextHold = 0;

  function satisfied(walk: Walk): boolean {
    const children = [...walk.children].filter((child) => child.active);
    if (walk.holds.size === 0 && children.length === 0) {
      return false;
    }
    return children.every(satisfied);
  }

  function settle(): void {
    const active = [...walks].filter((walk) => walk.active);
    const next: ExpansionState =
      mode === "playing"
        ? "playing"
        : active.length > 0 && active.every(satisfied)
          ? "paused"
          : "pausing";
    if (next === state) {
      return;
    }
    state = next;
    states.send(next);
  }

  function open(parent: Walk | undefined): Walk {
    const walk: Walk = {
      id: nextWalk++,
      parent,
      children: new Set(),
      holds: new Map(),
      active: true,
    };
    walks.add(walk);
    parent?.children.add(walk);
    return walk;
  }

  function close(walk: Walk): void {
    walk.active = false;
    walks.delete(walk);
    walk.parent?.children.delete(walk);
    settle();
  }

  function hold(walk: Walk): Operation<void> {
    return action<void>(function (resolve) {
      const id = nextHold++;
      walk.holds.set(id, resolve);
      settle();
      return () => {
        walk.holds.delete(id);
        settle();
      };
    });
  }

  function* gate(boundary: string): Operation<void> {
    crossings.set(boundary, (crossings.get(boundary) ?? 0) + 1);
    if (mode === "playing") {
      return;
    }
    const walk = yield* CurrentWalk.get();
    if (walk === undefined) {
      return;
    }
    yield* hold(walk);
  }

  function* bracket<T>(boundary: string, body: () => Operation<T>): Operation<T> {
    crossings.set(boundary, (crossings.get(boundary) ?? 0) + 1);
    // Read before publishing this one, so the parent link is what the enclosing
    // walk actually was rather than whatever happens to be current later.
    const walk = open(yield* CurrentWalk.get());
    try {
      return yield* CurrentWalk.with(walk, () => body());
    } finally {
      close(walk);
    }
  }

  yield* Execution.around({
    document([request], next) {
      return bracket("document", () => next(request));
    },
  });

  yield* Component.around({
    content([slot], next) {
      return bracket("content", () => next(slot));
    },
    tryContent([slot], next) {
      return bracket("tryContent", () => next(slot));
    },
    *importComponent([name, position], next) {
      yield* gate("importComponent");
      return yield* next(name, position);
    },
    *applyModifiers([modifiers, block], next) {
      yield* gate("applyModifiers");
      return yield* next(modifiers, block);
    },
    *applyBoundModifiers([modifiers, block], next) {
      yield* gate("applyBoundModifiers");
      return yield* next(modifiers, block);
    },
    *codeBlock([], next) {
      yield* gate("codeBlock");
      return yield* next();
    },
    *capture([name], next) {
      yield* gate("capture");
      return yield* next(name);
    },
    *retain([resource], next) {
      yield* gate("retain");
      return yield* next(resource);
    },
    *raise([error], next) {
      yield* gate("raise");
      return yield* next(error);
    },
    *handleFailure([failure], next) {
      yield* gate("handleFailure");
      return yield* next(failure);
    },
  });

  yield* DocumentOutput.around({
    *output([text, exact], next) {
      yield* gate("output");
      return yield* next(text, exact);
    },
  });

  return {
    get state() {
      return state;
    },
    states,
    get released() {
      return released;
    },
    get crossings() {
      return new Map(crossings);
    },
    pause() {
      mode = "pausing";
      settle();
    },
    resume() {
      mode = "playing";
      // Copied and cleared before any of them runs: resolving a held routine
      // runs its discard synchronously, and that discard deletes from the very
      // map this would otherwise still be iterating.
      const holding: (() => void)[] = [];
      for (const walk of walks) {
        holding.push(...walk.holds.values());
        walk.holds.clear();
      }
      settle();
      for (const release of holding) {
        released++;
        release();
      }
    },
    bracketWalk<T>(body: () => Operation<T>): Operation<T> {
      return bracket(HOST_WALK, body);
    },
  };
}
