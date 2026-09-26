/**
 * A REPL controller that pauses **XMD expansion**, not Effection.
 *
 * Effection is the runtime. It keeps running: tasks stay live, timers fire,
 * subprocesses finish, and background work records what it produced. What this
 * controller stops is the expansion of the selected XMD execution subtree, and
 * the completeness question is therefore about *expansion walks* — never about
 * whether some descendant Effection scope happens to be suspended.
 *
 * ## What an expansion walk is
 *
 * XMD expansion is bracketed. Four existing operations delimit one walk:
 * `Execution.document` (the root document), `Component.content` and
 * `Component.tryContent` (content a component projects), and the REPL profile's
 * own `expand` handler (structural syntax this REPL declared). Each entry starts
 * a walk; each return settles it.
 *
 * Everything else the middleware wraps is a **step gate** *inside* a walk:
 * `importComponent`, `applyModifiers`, `applyBoundModifiers`, `codeBlock`,
 * `retain`, `capture`, `raise`, `handleFailure`, `DocumentOutput.output`, and the
 * REPL's own per-region checkpoint. A step gate is a place a walk can be held,
 * not a walk of its own.
 *
 * That distinction is what stops one walk being counted as several. A walk
 * publishes its identity on a REPL-owned context for the duration of the bracket
 * (`Context.with`, so the previous identity is restored on the way out), and
 * every gate crossed underneath — in whatever scope the engine happens to
 * dispatch from — attributes to *that* walk. So the root document's fourteen step
 * gates are one obligation, not fourteen.
 *
 * ## How `paused` is computed
 *
 *     paused  ⟺  at least one walk is active
 *                and every active walk is holding at least one continuation
 *
 * A walk that returns from its bracket has settled and is no longer an
 * obligation. A walk that is delegating — suspended inside `next()` while a
 * nested walk or a core operation runs — is satisfied by the hold underneath it,
 * because its own continuation is a single `yield* next()` that cannot advance
 * until that hold is released. Nothing is inferred about opaque runtime state:
 * both sides of that relationship are middleware this REPL wrote.
 *
 * ## What is deliberately not an obligation
 *
 * Ordinary Effection scopes and tasks. A component body that spawns a child, a
 * provider that sleeps, a subprocess being awaited — none of these expand XMD, so
 * none of them can prevent `paused`. `api.Scope` observation is kept below purely
 * as a **diagnostic**: `inspect()` reports it and it decides nothing.
 *
 * ## What `paused` does not mean
 *
 * Not that the runtime is quiescent, not that external systems are frozen, and
 * **not that the durable Journal head is stationary** — already-running work that
 * produces a durable outcome records it normally while expansion is paused. The
 * expansion pause point is fixed; the History head may advance past it.
 */

import { action, createContext, createSignal, resource, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { api } from "effection/experimental";

import { Component } from "../../packages/core/src/component-api.ts";
import { DocumentOutput } from "../../packages/core/src/api.ts";
import { Execution } from "../../packages/core/src/execute.ts";
import type { ExpansionRequest } from "../../packages/core/host.ts";

export type ExpansionState = "playing" | "pausing" | "paused";

/**
 * Which expansion walk the current operation belongs to.
 *
 * REPL-owned, established before execution begins, and scoped to each bracket
 * with `Context.with` so a nested walk does not leak its identity into whatever
 * the enclosing walk does next.
 */
const ActiveWalk = createContext<string>("repl.pause.expansion-walk");

interface Hold {
  readonly walk: string;
  readonly at: string;
  released: number;
  release(): void;
}

interface Walk {
  readonly id: string;
  readonly kind: string;
  readonly detail: string;
  /** The walk this one was started from, if any. */
  readonly parent: string | undefined;
  /** Scopes currently held on this walk's behalf. */
  readonly holds: Set<Scope>;
}

/** One boundary crossing, for the inventory and the trace. */
export interface Crossing {
  readonly surface: string;
  readonly detail: string;
  readonly walk: string;
  readonly kind: "walk" | "step";
  readonly phase: "enter" | "exit";
  /** Which coroutine scope crossed it, so concurrency within a walk is visible. */
  readonly scope: string;
}

export interface ExpansionInspection {
  readonly state: ExpansionState;
  /** Active expansion walks, and where each is held. */
  readonly walks: readonly string[];
  /** Active walks holding nothing — why `pausing` has not settled. */
  readonly advancing: readonly string[];
  /** Every held continuation, by the walk it belongs to. */
  readonly held: readonly string[];
  /**
   * Live descendant Effection scopes of the execution.
   *
   * **Diagnostic only.** Ordinary runtime activity is not a pause obligation, so
   * this decides nothing; it is reported because knowing the runtime is still
   * busy while expansion is paused is the point.
   */
  readonly liveScopes: number;
}

export interface ReplGate {
  readonly state: ExpansionState;
  /** Enter `pausing`. Returns at once; nothing is held yet. */
  request(): void;
  /** Settle once every active expansion walk is held or settled. */
  reached(): Operation<ExpansionInspection>;
  /** Continue. Releases the same held continuations, exactly once each. */
  release(): void;
  inspect(): ExpansionInspection;
  readonly crossings: readonly Crossing[];
  readonly releases: number;
  readonly doubleReleases: number;
  /**
   * Install the middleware for this execution, before it starts.
   *
   * Never installed when Pause is pressed: the decoration is what makes a later
   * Pause possible, so it has to predate the work it will hold.
   */
  installBoundaries(): Operation<void>;
  /**
   * Wrap the REPL's own expansion handler.
   *
   * `ExecutionInstallation.expand` is a function this REPL holds while assembling
   * its profile, so what comes back is still the REPL's handler. It is not Api
   * middleware.
   */
  decorateExpand(
    handler: (request: ExpansionRequest) => Operation<void>,
  ): (request: ExpansionRequest) => Operation<void>;
  /** A pause point inside the REPL's own region loop. */
  checkpoint(label: string): Operation<void>;
  /**
   * Bracket one expansion walk around REPL-owned expansion code.
   *
   * The REPL's expansion handler drives its own region loop, so a region is an
   * expansion unit this REPL delimits itself. Bracketing each one makes two
   * regions expanded concurrently two concurrent walks, both of which must be
   * held or settled before `paused`.
   */
  walk<T>(kind: string, detail: string, body: () => Operation<T>): Operation<T>;
}

export interface ReplGateOptions {
  /** The scope that will own the REPL's execution. */
  readonly target: Scope;
}

export function useReplGate(options: ReplGateOptions): Operation<ReplGate> {
  const { target } = options;

  return resource(function* (provide) {
    let state: ExpansionState = "playing";
    let releases = 0;
    let doubleReleases = 0;
    let walkCounter = 0;

    const walks = new Map<string, Walk>();
    const holds = new Map<Scope, Hold>();
    const crossings: Crossing[] = [];

    /** Diagnostic scope tree. Decides nothing. */
    const liveScopes = new Set<Scope>();
    /** Stable names for scopes, so a trace can show who crossed what. */
    const scopeNames = new Map<Scope, string>();
    let scopeCounter = 0;

    function nameOf(scope: Scope): string {
      const existing = scopeNames.get(scope);
      if (existing !== undefined) {
        return existing;
      }
      scopeCounter += 1;
      const name = `c${scopeCounter}`;
      scopeNames.set(scope, name);
      return name;
    }

    /** Anything that changes the walk set or the held set wakes `reached()`. */
    const changes = createSignal<string>();

    function describeWalk(walk: Walk): string {
      const where = [...walk.holds].map((scope) => holds.get(scope)?.at ?? "?").join(",");
      const name = `${walk.id}:${walk.kind}(${walk.detail})`;
      if (where !== "") {
        return `${name} held@${where}`;
      }
      const children = childrenOf(walk.id);
      return children.length === 0
        ? `${name} advancing`
        : `${name} delegating->${children.map((child) => child.id).join("+")}`;
    }

    function childrenOf(id: string): Walk[] {
      return [...walks.values()].filter((walk) => walk.parent === id);
    }

    /**
     * Whether one walk can no longer advance expansion.
     *
     * A walk is satisfied when it is holding a continuation of its own, or when
     * it is delegating to child walks — and, either way, only when every active
     * child is satisfied too. Both halves are needed. Without the delegation
     * clause a parent suspended inside `next()` while its children are held would
     * block `paused` forever; without the "and every child" clause a parent held
     * at its own gate would report `paused` while a concurrent child walk was
     * still expanding.
     */
    function satisfied(walk: Walk): boolean {
      const children = childrenOf(walk.id);
      if (walk.holds.size === 0 && children.length === 0) {
        return false;
      }
      return children.every(satisfied);
    }

    function advancingWalks(): Walk[] {
      return [...walks.values()].filter((walk) => !satisfied(walk));
    }

    /** The corrected completeness rule: expansion walks, and nothing else. */
    function expansionSettled(): boolean {
      return walks.size > 0 && advancingWalks().length === 0;
    }

    /** Park the current continuation until Continue, if a pause is in effect. */
    function* hold(walkId: string, at: string): Operation<void> {
      if (state === "playing") {
        return;
      }
      const walk = walks.get(walkId);
      if (walk === undefined) {
        return;
      }
      const scope = yield* useScope();
      yield* action<void>((resolve) => {
        const parked: Hold = {
          walk: walkId,
          at,
          released: 0,
          release() {
            parked.released += 1;
            if (parked.released === 1) {
              releases += 1;
              resolve();
            } else {
              doubleReleases += 1;
            }
          },
        };
        holds.set(scope, parked);
        walk.holds.add(scope);
        changes.send(`held ${walkId}@${at}`);
        return () => {
          holds.delete(scope);
          walk.holds.delete(scope);
          changes.send(`freed ${walkId}@${at}`);
        };
      }, `repl.expansion.hold(${at})`);
    }

    /** A step gate inside a walk: a place that walk can be held. */
    function* step(surface: string, detail: string): Operation<void> {
      const walk = (yield* ActiveWalk.get()) ?? "w0";
      const scope = yield* useScope();
      crossings.push({
        surface,
        detail,
        walk,
        kind: "step",
        phase: "enter",
        scope: nameOf(scope),
      });
      yield* hold(walk, `${surface}:${detail}`);
    }

    /**
     * Bracket one expansion walk around `body`.
     *
     * The identity is published for the duration and restored afterwards, so a
     * gate crossed after a nested walk returns attributes to the enclosing walk
     * again rather than to the one that just settled.
     */
    function bracket<T>(kind: string, detail: string, body: () => Operation<T>): Operation<T> {
      walkCounter += 1;
      const id = `w${walkCounter}`;
      return (function* () {
        // Read before publishing this walk's own identity, so the enclosing walk
        // becomes this one's parent and delegation is a fact the REPL recorded
        // rather than something inferred later.
        const parent = yield* ActiveWalk.get();
        const own = nameOf(yield* useScope());
        return yield* ActiveWalk.with(id, function* () {
          const walk: Walk = { id, kind, detail, parent, holds: new Set() };
          walks.set(id, walk);
          crossings.push({
            surface: kind,
            detail,
            walk: id,
            kind: "walk",
            phase: "enter",
            scope: own,
          });
          changes.send(`walk ${id} started`);
          try {
            yield* hold(id, `${kind}:enter`);
            const result = yield* body();
            yield* hold(id, `${kind}:exit`);
            return result;
          } finally {
            walks.delete(id);
            crossings.push({
              surface: kind,
              detail,
              walk: id,
              kind: "walk",
              phase: "exit",
              scope: own,
            });
            changes.send(`walk ${id} settled`);
          }
        });
      })();
    }

    // Diagnostic only: ordinary runtime activity is not a pause obligation.
    target.around(api.Scope, {
      create: (args, next) => {
        const made = next(...args);
        liveScopes.add(made[0]);
        return made;
      },
      *destroy(args, next) {
        try {
          return yield* next(...args);
        } finally {
          liveScopes.delete(args[0]);
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
        // Ordinary instrumentation wraps at the default `max`; `min` is the
        // implementation slot the runtime providers occupy.
        yield* Component.around({
          // Walk brackets: content a component projects is its own expansion.
          *content(args, next) {
            return yield* bracket("content", args[0] ?? "(default)", () => next(...args));
          },
          *tryContent(args, next) {
            return yield* bracket("tryContent", args[0] ?? "(default)", () => next(...args));
          },

          // Step gates, inside whichever walk is current.
          *importComponent(args, next) {
            yield* step("importComponent", String(args[0]));
            return yield* next(...args);
          },
          *applyModifiers(args, next) {
            yield* step("applyModifiers", args[0].map((modifier) => modifier.name).join(","));
            return yield* next(...args);
          },
          *applyBoundModifiers(args, next) {
            yield* step("applyBoundModifiers", args[1].blockId);
            yield* next(...args);
          },
          *codeBlock(args, next) {
            yield* step("codeBlock", "");
            return yield* next(...args);
          },
          *retain(args, next) {
            yield* step("retain", "");
            return yield* next(...args);
          },
          *capture(args, next) {
            yield* step("capture", args[0]);
            return yield* next(...args);
          },
          *raise(args, next) {
            yield* step("raise", args[0].source ?? "");
            return yield* next(...args);
          },
          *handleFailure(args, next) {
            yield* step("handleFailure", "");
            return yield* next(...args);
          },
        });

        // Output is expansion reaching the reader, so it is gated too. This is
        // what makes "the next element or output does not appear until Continue" a
        // claim about output rather than only about elements.
        yield* DocumentOutput.around({
          *output(args, next) {
            yield* step("output", String(args[0]).slice(0, 24).replace(/\n/g, "\\n"));
            return yield* next(...args);
          },
        });

        // The root document expansion: the outermost walk.
        yield* Execution.around({
          *document(args, next) {
            return yield* bracket("document", "root", () => next(...args));
          },
        });
      },

      decorateExpand(handler) {
        return function* replExpand(request: ExpansionRequest): Operation<void> {
          yield* bracket("expand", request.name, () => handler(request));
        };
      },

      *checkpoint(label) {
        yield* step("replCheckpoint", label);
      },

      walk(kind, detail, body) {
        return bracket(kind, detail, body);
      },

      request() {
        if (state === "playing") {
          state = "pausing";
          changes.send("requested");
        }
      },

      *reached(): Operation<ExpansionInspection> {
        const arriving = yield* changes;
        while (true) {
          if (expansionSettled()) {
            state = "paused";
            return gate.inspect();
          }
          yield* arriving.next();
        }
      },

      release() {
        state = "playing";
        // Copied first: `resolve()` reaches the held routine's `resume()`, which
        // runs the action's discard synchronously, and that discard deletes the
        // hold — so releasing straight from `holds.values()` would mutate the map
        // it is iterating.
        for (const parked of [...holds.values()]) {
          parked.release();
        }
        changes.send("released");
      },

      inspect(): ExpansionInspection {
        return {
          state,
          walks: [...walks.values()].map(describeWalk),
          advancing: advancingWalks().map(describeWalk),
          held: [...holds.values()].map((parked) => `${parked.walk}@${parked.at}`),
          liveScopes: liveScopes.size,
        };
      },
    };

    yield* provide(gate);
  });
}
