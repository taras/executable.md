/**
 * A pause controller the REPL owns, built only from surfaces that already exist.
 *
 * Slice 1 asked whether middleware around an Api could hold a subtree and found
 * that it holds exactly the work that re-enters a mediated operation. Slice 2
 * asks the question that matters for XMD: are the *existing* execution and
 * expansion surfaces enough, without inventing a core pause protocol?
 *
 * Three kinds of surface are used here, and they are not interchangeable:
 *
 * - **`Component.around(...)` and `Execution.around(...)`** are real contextual
 *   Api middleware. Installed in the scope that will own the execution, before
 *   it starts, they are inherited by every descendant and absent from siblings.
 *   These can *hold* a continuation, because middleware is an operation.
 * - **The REPL's own `expand` handler** is a captured function on the profile
 *   this REPL assembles. Decorating it is decorating a handler the REPL owns —
 *   not Api middleware — and it can hold, because the REPL wrote the call.
 * - **Effection's stable `api.Scope`** observes scope creation and destruction.
 *   It is used here for *accounting only*. It cannot suspend an already-running
 *   continuation, and nothing below treats it as though it could.
 *
 * The state a pause settles into is decided by that separation. `paused` is
 * reported only when every live descendant scope of the execution is one this
 * controller is holding — and a scope that advances without re-entering a
 * controlled surface is live and unheld, so it can never be mistaken for a
 * suspended one. The controller stays in `pausing` and names it.
 *
 * Nothing here is journaled. The controller and its retained continuations are
 * ordinary generator state in the scope that acquired the gate, which is outside
 * the subtree it holds.
 */

import { action, createSignal, resource, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { api } from "effection/experimental";

import { Component } from "../../packages/core/src/component-api.ts";
import { Execution } from "../../packages/core/src/execute.ts";
import type { ExpansionRequest } from "../../packages/core/host.ts";

export type ReplState = "playing" | "pausing" | "paused";

interface Hold {
  readonly at: string;
  released: number;
  release(): void;
}

/** One boundary crossing, for the coverage inventory and the trace. */
export interface Crossing {
  readonly surface: string;
  readonly detail: string;
  readonly scope: string;
  readonly phase: "enter" | "exit";
}

export interface ReplInspection {
  readonly state: ReplState;
  /** Every live descendant scope of the execution, by ownership. */
  readonly live: readonly string[];
  /** Those this controller is holding, and where. */
  readonly held: readonly string[];
  /**
   * Live descendants the controller does not hold.
   *
   * While `pausing` this is the reason it has not settled. It is computed from
   * scope ownership rather than from which scopes happened to cross a boundary,
   * because a branch that never re-enters a controlled surface would otherwise
   * be invisible — and a controller that reported `paused` with one of these
   * outstanding would be reporting a live subtree as suspended.
   */
  readonly unaccounted: readonly string[];
  /** Scopes that have crossed a controlled boundary at least once. */
  readonly crossed: readonly string[];
  /** Boundary crossings still inside their operation — entered, not exited. */
  readonly inFlight: readonly string[];
}

export interface ReplGate {
  readonly state: ReplState;
  /** Enter `pausing`. Returns at once; nothing is held yet. */
  request(): void;
  /** Settle once every live descendant is held, and only then enter `paused`. */
  reached(): Operation<ReplInspection>;
  /** Continue. Releases the same held continuations, exactly once each. */
  release(): void;
  inspect(): ReplInspection;
  /** Every boundary crossing observed, in order. */
  readonly crossings: readonly Crossing[];
  readonly releases: number;
  readonly doubleReleases: number;
  /**
   * Install the Api middleware for this execution.
   *
   * Yielded in the scope that will own the execution, **before** it starts. It
   * is never installed when Pause is pressed: the decoration is what makes a
   * later Pause possible, so it has to predate the work it will hold.
   */
  installBoundaries(): Operation<void>;
  /**
   * Wrap the REPL's own expansion handler.
   *
   * This is a function the REPL holds while assembling its profile, so what
   * comes back is still the REPL's handler. It is not Api middleware and is not
   * described as such anywhere in the evidence.
   */
  decorateExpand(
    handler: (request: ExpansionRequest) => Operation<void>,
  ): (request: ExpansionRequest) => Operation<void>;
  /**
   * A pause point inside the REPL's own code.
   *
   * The REPL's expansion handler drives its own region loop, so a hold between
   * two chunks is the REPL placing a boundary in a call it wrote. This is not a
   * checkpoint a component author has to remember, and it is reachable only from
   * code the REPL assembled — it is not published to the document, to core, or
   * to any component.
   */
  checkpoint(label: string): Operation<void>;
}

export interface ReplGateOptions {
  /** The scope that will own the REPL's execution. */
  readonly target: Scope;
}

export function useReplGate(options: ReplGateOptions): Operation<ReplGate> {
  const { target } = options;

  return resource(function* (provide) {
    let state: ReplState = "playing";
    let releases = 0;
    let doubleReleases = 0;
    let counter = 0;

    const holds = new Map<Scope, Hold>();
    const children = new Map<Scope, Set<Scope>>([[target, new Set()]]);
    const parents = new Map<Scope, Scope>();
    const ids = new Map<Scope, string>();
    const crossed = new Set<Scope>();
    const inFlight = new Map<Scope, string>();
    const crossings: Crossing[] = [];

    /** Anything that changes the live set or the held set wakes `reached()`. */
    const changes = createSignal<string>();

    function idOf(scope: Scope): string {
      return ids.get(scope) ?? "s?";
    }

    function describe(scope: Scope): string {
      const hold = holds.get(scope);
      return hold === undefined ? idOf(scope) : `${idOf(scope)}@${hold.at}`;
    }

    function descendants(): Scope[] {
      const found: Scope[] = [];
      const walk = (at: Scope) => {
        for (const child of children.get(at) ?? []) {
          found.push(child);
          walk(child);
        }
      };
      walk(target);
      return found;
    }

    function unaccounted(): Scope[] {
      return descendants().filter((scope) => !holds.has(scope));
    }

    /**
     * Account for one boundary crossing, and hold it if a pause is in effect.
     *
     * Accounting happens in `playing` too. That is what lets a Pause requested
     * while a call is already inside a controlled operation know that the call
     * exists and is still owed an exit.
     */
    function* boundary(surface: string, detail: string, phase: "enter" | "exit"): Operation<void> {
      const scope = yield* useScope();
      crossed.add(scope);
      crossings.push({ surface, detail, scope: idOf(scope), phase });
      if (phase === "enter") {
        inFlight.set(scope, `${surface}(${detail})`);
      } else {
        inFlight.delete(scope);
      }
      changes.send(`${phase} ${surface} ${idOf(scope)}`);

      if (state === "playing") {
        return;
      }
      yield* action<void>((resolve) => {
        const hold: Hold = {
          at: `${phase}:${surface}:${detail}`,
          released: 0,
          release() {
            hold.released += 1;
            if (hold.released === 1) {
              releases += 1;
              resolve();
            } else {
              doubleReleases += 1;
            }
          },
        };
        holds.set(scope, hold);
        changes.send(`held ${describe(scope)}`);
        return () => {
          holds.delete(scope);
          changes.send(`freed ${idOf(scope)}`);
        };
      }, `repl.pause(${surface})`);
    }

    // Accounting only. `create` is synchronous middleware returning a tuple, so
    // nothing here could suspend a continuation even if it wanted to — which is
    // exactly why the held set is kept separately, by the operations above.
    target.around(api.Scope, {
      create: (args, next) => {
        const made = next(...args);
        const [child] = made;
        const [parent] = args;
        counter += 1;
        ids.set(child, `s${counter}`);
        parents.set(child, parent);
        children.set(child, new Set());
        children.get(parent)?.add(child);
        changes.send(`created ${idOf(child)}`);
        return made;
      },
      *destroy(args, next) {
        const [scope] = args;
        try {
          return yield* next(...args);
        } finally {
          const parent = parents.get(scope);
          if (parent) {
            children.get(parent)?.delete(scope);
          }
          const gone = idOf(scope);
          parents.delete(scope);
          children.delete(scope);
          inFlight.delete(scope);
          changes.send(`settled ${gone}`);
        }
      },
    });

    const gate: ReplGate = {
      get state() {
        return state;
      },
      get crossings() {
        return crossings;
      },
      get releases() {
        return releases;
      },
      get doubleReleases() {
        return doubleReleases;
      },

      *installBoundaries(): Operation<void> {
        // Ordinary instrumentation wraps at the default `max`. `min` is the
        // implementation slot the runtime providers occupy, and a pause that
        // installed there would shadow the provider it is trying to observe.
        yield* Component.around({
          *importComponent(args, next) {
            yield* boundary("importComponent", String(args[0]), "enter");
            const definition = yield* next(...args);
            yield* boundary("importComponent", String(args[0]), "exit");
            return definition;
          },
          *applyModifiers(args, next) {
            const names = args[0].map((modifier) => modifier.name).join(",");
            yield* boundary("applyModifiers", names, "enter");
            const result = yield* next(...args);
            yield* boundary("applyModifiers", names, "exit");
            return result;
          },
          *applyBoundModifiers(args, next) {
            const id = args[1].blockId;
            yield* boundary("applyBoundModifiers", id, "enter");
            yield* next(...args);
            yield* boundary("applyBoundModifiers", id, "exit");
          },
          *content(args, next) {
            const slot = args[0] ?? "(default)";
            yield* boundary("content", slot, "enter");
            const text = yield* next(...args);
            yield* boundary("content", slot, "exit");
            return text;
          },
          *tryContent(args, next) {
            const slot = args[0] ?? "(default)";
            yield* boundary("tryContent", slot, "enter");
            const partial = yield* next(...args);
            yield* boundary("tryContent", slot, "exit");
            return partial;
          },
          *capture(args, next) {
            yield* boundary("capture", args[0], "enter");
            const value = yield* next(...args);
            yield* boundary("capture", args[0], "exit");
            return value;
          },
          *codeBlock(args, next) {
            yield* boundary("codeBlock", "", "enter");
            const block = yield* next(...args);
            yield* boundary("codeBlock", "", "exit");
            return block;
          },
          *retain(args, next) {
            yield* boundary("retain", "", "enter");
            const held = yield* next(...args);
            yield* boundary("retain", "", "exit");
            return held;
          },
          *raise(args, next) {
            yield* boundary("raise", args[0].source ?? "", "enter");
            const segment = yield* next(...args);
            yield* boundary("raise", args[0].source ?? "", "exit");
            return segment;
          },
          *handleFailure(args, next) {
            yield* boundary("handleFailure", "", "enter");
            const segment = yield* next(...args);
            yield* boundary("handleFailure", "", "exit");
            return segment;
          },
        });

        // The execution's own lifetime. A layer here wraps the whole document
        // while the durable stream is still live, which is what makes it the
        // anchor for "this is the subtree the REPL is pausing".
        yield* Execution.around({
          *document(args, next) {
            // Read before the work it guards: a cleanup that suspends in
            // `finally` is not guaranteed to run when the operation is halted.
            const scope = yield* useScope();
            yield* boundary("document", "root", "enter");
            try {
              return yield* next(...args);
            } finally {
              inFlight.delete(scope);
            }
          },
        });
      },

      decorateExpand(handler) {
        return function* replExpand(request: ExpansionRequest): Operation<void> {
          yield* boundary("expand", request.name, "enter");
          yield* handler(request);
          yield* boundary("expand", request.name, "exit");
        };
      },

      checkpoint(label) {
        return boundary("replCheckpoint", label, "enter");
      },

      request() {
        if (state === "playing") {
          state = "pausing";
          changes.send("requested");
        }
      },

      *reached(): Operation<ReplInspection> {
        const arriving = yield* changes;
        while (true) {
          if (unaccounted().length === 0) {
            state = "paused";
            return gate.inspect();
          }
          yield* arriving.next();
        }
      },

      release() {
        state = "playing";
        // Copied first: resolving reaches the held routine's `resume()`, which
        // runs the action's discard synchronously, and that discard deletes the
        // hold — so releasing straight from `holds.values()` would mutate the
        // map it is iterating.
        for (const hold of [...holds.values()]) {
          hold.release();
        }
        changes.send("released");
      },

      inspect(): ReplInspection {
        const live = descendants();
        return {
          state,
          live: live.map(describe),
          held: live.filter((scope) => holds.has(scope)).map(describe),
          unaccounted: unaccounted().map(describe),
          crossed: live.filter((scope) => crossed.has(scope)).map(idOf),
          inFlight: [...inFlight.entries()].map(([scope, where]) => `${idOf(scope)}:${where}`),
        };
      },
    };

    yield* provide(gate);
  });
}
