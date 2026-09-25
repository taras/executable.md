/**
 * A pause gate built entirely from middleware around an XMD-owned Api.
 *
 * The gate is installed by decorating `Execution` on **one** scope — the target
 * execution scope — with `Scope.around()`. Effection stores that decoration in a
 * context on that scope, so every descendant resolves the decorated handle and
 * every independent sibling resolves the undecorated core. Inheritance and
 * absence are therefore not properties this module maintains; they are how the
 * decoration is looked up.
 *
 * Two things are deliberately *not* here. There is no registry a component can
 * find, and no `pausePoint()` for fixture code to call: a continuation is held
 * only because the middleware that wraps its Api invocation suspends. And the
 * gate's own state lives in the scope that acquired it, which is outside the
 * subtree it holds, so the controller stays live while the target does not.
 *
 * The state a pause settles into is **structural, and fails closed.** `paused`
 * is reported only when every live descendant scope — enumerated from
 * `api.Scope` creation and destruction, which is execution ownership and
 * nothing else — is one the gate is holding. A descendant that progresses
 * without invoking the Api is live and unheld, so it can never be mistaken for
 * a suspended one; `pausing` simply never settles, and `inspect()` names it.
 */

import { action, createSignal, resource, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { api } from "effection/experimental";

import { Execution } from "./execution.ts";
import type { Journal } from "./journal.ts";

export type PauseState = "running" | "pausing" | "paused";

interface Park {
  readonly at: string;
  released: number;
  release(): void;
}

export interface Inspection {
  readonly state: PauseState;
  /** Every live descendant scope of the target, by execution ownership. */
  readonly live: readonly string[];
  /** The descendants the gate is holding, and where each is held. */
  readonly held: readonly string[];
  /** Live descendants the gate does not hold — why `pausing` has not settled. */
  readonly unaccounted: readonly string[];
  /**
   * Descendants whose Api invocations have actually dispatched through this
   * middleware. This is the inheritance claim read at the boundary itself: a
   * scope appears here only because the decoration installed on the target was
   * the handle *its* invocation resolved.
   */
  readonly mediated: readonly string[];
  /**
   * Scopes outside the target subtree that dispatched through this middleware.
   * Always empty: a decoration installed on one scope is unreachable from an
   * independent sibling, so a name here would mean the gate had leaked.
   */
  readonly strangers: readonly string[];
  /** The target subtree's own history position. */
  readonly targetHead: number;
}

export interface PauseReport {
  readonly held: readonly string[];
  readonly targetHead: number;
}

export interface Gate {
  readonly state: PauseState;
  /** Enter `pausing`. Returns at once; nothing is held yet. */
  request(): void;
  /**
   * Settle once every live descendant is held at the middleware boundary, and
   * only then enter `paused`.
   */
  reached(): Operation<PauseReport>;
  /**
   * Continue. Releases the same held continuations, exactly once each. Called
   * before `paused` is reached, it abandons the request instead.
   */
  release(): void;
  inspect(): Inspection;
  /** How many held continuations the gate has resolved. */
  readonly releases: number;
  /** A continuation resolved more than once would be counted here. */
  readonly doubleReleases: number;
}

export interface GateOptions {
  /** The scope that owns the target execution. Middleware is installed here. */
  readonly target: Scope;
  readonly journal: Journal;
  /** The journal owner the target execution itself appends under. */
  readonly rootOwner: string;
}

export function useGate(options: GateOptions): Operation<Gate> {
  const { target, journal, rootOwner } = options;

  return resource(function* (provide) {
    let state: PauseState = "running";
    let releases = 0;
    let doubleReleases = 0;
    let counter = 0;

    const parks = new Map<Scope, Park>();
    const children = new Map<Scope, Set<Scope>>([[target, new Set()]]);
    const parents = new Map<Scope, Scope>();
    const ids = new Map<Scope, string>();
    const labels = new Map<Scope, string>();
    const owners = new Set<string>([rootOwner]);
    const mediations = new Map<Scope, number>();
    /**
     * Every scope ever created under the target, kept after it is destroyed.
     * Membership has to outlive the scope, or a settled descendant would look
     * like a foreign one the moment it exited.
     */
    const known = new Set<Scope>();

    /** Anything that changes the live set or the held set wakes `reached()`. */
    const changes = createSignal<string>();

    function describe(scope: Scope): string {
      const id = ids.get(scope) ?? "s?";
      const label = labels.get(scope);
      const park = parks.get(scope);
      const name = label ? `${id}(${label})` : id;
      return park ? `${name}@${park.at}` : name;
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
      return descendants().filter((scope) => !parks.has(scope));
    }

    function targetHead(): number {
      return journal.snapshot().filter((record) => owners.has(record.owner)).length;
    }

    /**
     * Record that `scope`'s invocation dispatched through this middleware, then
     * hold it if a pause is in effect.
     */
    function* mediate(at: string): Operation<void> {
      const scope = yield* useScope();
      mediations.set(scope, (mediations.get(scope) ?? 0) + 1);
      yield* checkpoint(scope, at);
    }

    function* checkpoint(scope: Scope, at: string): Operation<void> {
      if (state === "running") {
        return;
      }
      yield* action<void>((resolve) => {
        const park: Park = {
          at,
          released: 0,
          release() {
            park.released += 1;
            if (park.released === 1) {
              releases += 1;
              resolve();
            } else {
              doubleReleases += 1;
            }
          },
        };
        parks.set(scope, park);
        changes.send(`held ${describe(scope)}`);
        return () => {
          parks.delete(scope);
          changes.send(`freed ${describe(scope)}`);
        };
      }, `xmd.pause.checkpoint(${at})`);
    }

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
        known.add(child);
        changes.send(`created ${describe(child)}`);
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
          const gone = describe(scope);
          parents.delete(scope);
          children.delete(scope);
          labels.delete(scope);
          changes.send(`destroyed ${gone}`);
        }
      },
    });

    target.around(Execution, {
      *step(args, next) {
        yield* mediate(`step:${args[0]}`);
        const head = yield* next(...args);
        yield* mediate(`stepped:${args[0]}`);
        return head;
      },
      *fork(args, next) {
        const [label, body] = args;
        yield* mediate(`fork:${label}`);
        return yield* next(label, function* () {
          const scope = yield* useScope();
          labels.set(scope, label);
          owners.add(label);
          yield* mediate(`entry:${label}`);
          yield* body();
        });
      },
      *external(args, next) {
        yield* mediate(`external:${args[0]}`);
        const value = yield* next(...args);
        yield* mediate(`returned:${args[0]}`);
        return value;
      },
    });

    const gate: Gate = {
      get state() {
        return state;
      },
      get releases() {
        return releases;
      },
      get doubleReleases() {
        return doubleReleases;
      },
      request() {
        if (state === "running") {
          state = "pausing";
          changes.send("requested");
        }
      },
      *reached() {
        const arriving = yield* changes;
        while (true) {
          if (unaccounted().length === 0) {
            state = "paused";
            return {
              held: descendants().map(describe),
              targetHead: targetHead(),
            };
          }
          yield* arriving.next();
        }
      },
      release() {
        state = "running";
        // The copy is load-bearing. `resolve()` reaches the held routine's
        // `resume()`, which runs the action's discard synchronously, and that
        // discard deletes the park — so releasing straight from `parks.values()`
        // would mutate the map it is iterating.
        for (const park of [...parks.values()]) {
          park.release();
        }
        changes.send("released");
      },
      inspect() {
        const live = descendants();
        return {
          state,
          live: live.map(describe),
          held: live.filter((scope) => parks.has(scope)).map(describe),
          unaccounted: unaccounted().map(describe),
          mediated: live.filter((scope) => mediations.has(scope)).map(describe),
          strangers: [...mediations.keys()].filter((scope) => !known.has(scope)).map(describe),
          targetHead: targetHead(),
        };
      },
    };

    yield* provide(gate);
  });
}
