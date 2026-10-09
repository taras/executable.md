/**
 * What this process is doing right now, element by element.
 *
 * Core says where one expansion has reached; this is where the session keeps
 * what it was told, for as long as the entry that caused it is open. It is a
 * reading, not a record: nothing here reaches the Journal, a cold process
 * reconstructs none of it, and an entry that goes takes its observations with
 * it.
 *
 * ## One call, not one name
 *
 * An expansion id names a logical element. A document that writes the same
 * element twice, or writes one inside a `<Loop>`, produces several *calls* of
 * it, and a reader watching the second must not be shown the first. Each
 * actual call is given an occurrence key of this entry's own, and the
 * enclosing key is bound around the delegation, so the calls under one element
 * are its children and a repeated id never overwrites anything.
 *
 * The lineage is presentation and only presentation. It is bound in a context
 * a descendant can rebind, which is exactly why nothing that must be
 * authoritative reads it: a generated fragment inherits where it is being
 * shown while its capability environment stays as narrow as it was.
 *
 * ## Consumers are siblings of the dispatch, never children
 *
 * Core publishes an element's terminal phase after the whole middleware
 * dispatch has unwound. A consumer spawned on the handler's own frame is torn
 * down before that, so it never learns the element finished — and one the
 * handler *joined* would wait for a phase that cannot arrive until the handler
 * returns. Consumers therefore run on the entry's own owner, started before
 * the delegation and outliving it.
 */

import { createSignal, each, ensure, useScope } from "effection";
import type { Operation, Scope, Stream } from "effection";
import { Component } from "@executablemd/core/api";
import type { ComponentExpansionPhase, ComponentExpansionRequest } from "@executablemd/core/api";
import { createContext } from "effection";
import type { Context } from "effection";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { SourcePosition } from "@executablemd/core";

/** Where one call of one element has reached, as a reader sees it. */
export type ReplLifecyclePhase = "enter" | "active" | "exit" | "settled" | "failed" | "cancelled";

/** One actual call of one authored element. */
export interface ReplOccurrence {
  /** This entry's own key for this call. Never a logical id. */
  readonly key: string;
  /** The logical element this is a call of. */
  readonly expansion: string;
  readonly name: string;
  /** The call this one was reached through, or none at the top. */
  readonly parent: string | undefined;
  readonly position: Readonly<SourcePosition> | undefined;
  readonly phase: ReplLifecyclePhase;
  /** Why an element that has not settled is waiting, if it is. */
  readonly waiting: readonly ReplWaitReason[];
}

/** What an element is waiting on, counted rather than guessed. */
export type ReplWaitReason = "question" | "permission" | "expansion";

/**
 * Counting one reason an element is waiting, for whoever actually waits.
 *
 * The narrow half of the lifecycle, handed to a provider so it can say "this
 * element is waiting on me" without being able to read, change or end anything
 * else. A provider given none counts nothing, which is what an execution with
 * no session reading behaves like.
 */
export interface ReplWaits {
  hold(reason: ReplWaitReason): Operation<() => void>;
}

/** Everything this entry is doing, detached and immutable. */
export interface ReplLifecycleReading {
  /** The entry these observations belong to, or none between entries. */
  readonly entry: string | undefined;
  /** Every call, in the order it was first observed. */
  readonly occurrences: readonly ReplOccurrence[];
}

/** Nothing observed. What a reading is between entries, and after one closes. */
export const NO_LIFECYCLE: ReplLifecycleReading = Object.freeze({
  entry: undefined,
  occurrences: Object.freeze([]),
});

export interface ReplLifecycle {
  /** Installed into one execution, carrying this session's observation. */
  readonly installation: ExecutionInstallation;
  /** Begin this entry's generation. Updates from an older one are refused. */
  open(entry: string): void;
  /** End it, and drop what it was holding. */
  close(entry: string): void;
  /** What this entry is doing now. Detached: the caller may keep it. */
  reading(): ReplLifecycleReading;
  /**
   * Count one reason the element being expanded is waiting, until released.
   *
   * An operation, because the call it belongs to is read from the lineage
   * where the wait is taken: two concurrent questions are two waits on two
   * elements rather than one session that is "busy". Releasing is idempotent,
   * and a wait taken outside any element releases nothing.
   */
  hold(reason: ReplWaitReason): Operation<() => void>;
  /** Announced whenever the reading changed. */
  readonly changes: Stream<ReplLifecycleReading, never>;
}

/**
 * The call a descendant was reached through.
 *
 * Presentation lineage, nothing else. It is an ordinary context, so a
 * descendant may rebind it for its own descendants — which is why no
 * authority, identity or durable decision reads it.
 */
const CurrentOccurrence: Context<string | undefined> = createContext<string | undefined>(
  "repl.lifecycle.occurrence",
  undefined,
);

interface Observed {
  key: string;
  expansion: string;
  name: string;
  parent: string | undefined;
  position: Readonly<SourcePosition> | undefined;
  phase: ReplLifecyclePhase;
  waiting: ReplWaitReason[];
}

export function useReplLifecycle(): Operation<ReplLifecycle> {
  return {
    *[Symbol.iterator]() {
      // The owner every consumer runs under: the session's own scope, which
      // outlives any one element's dispatch.
      const owner: Scope = yield* useScope();
      const changes = createSignal<ReplLifecycleReading, never>();
      let generation: string | undefined;
      let sequence = 0;
      const observed = new Map<string, Observed>();

      const announce = (): void => {
        changes.send(reading());
      };
      const reading = (): ReplLifecycleReading =>
        Object.freeze({
          entry: generation,
          occurrences: Object.freeze(
            [...observed.values()].map((one) =>
              Object.freeze({
                key: one.key,
                expansion: one.expansion,
                name: one.name,
                parent: one.parent,
                position: one.position,
                phase: one.phase,
                waiting: Object.freeze([...one.waiting]),
              }),
            ),
          ),
        });

      const settle = (key: string, phase: ComponentExpansionPhase): void => {
        const one = observed.get(key);
        if (one === undefined) {
          return;
        }
        if (phase.phase === "complete") {
          one.phase = phase.result.ok ? "settled" : "failed";
        } else if (phase.phase === "cancelled") {
          one.phase = "cancelled";
        } else if (phase.phase === "exit") {
          one.phase = "exit";
        } else {
          one.phase = phase.phase;
        }
        announce();
      };

      const lifecycle: ReplLifecycle = {
        installation: {
          *install(): Operation<void> {
            yield* Component.around({
              *expand([request]: [ComponentExpansionRequest], next) {
                const entry = generation;
                if (entry === undefined) {
                  // Nothing is open to attribute this to. Observation is never
                  // a reason to change what executes, so it is delegated as it
                  // is and nothing is recorded.
                  yield* next(request);
                  return;
                }
                sequence += 1;
                const key = `${entry}#${sequence}`;
                const parent = yield* CurrentOccurrence.get();
                observed.set(key, {
                  key,
                  expansion: request.expansion.id,
                  name: request.expansion.name,
                  parent,
                  position: request.expansion.position,
                  phase: "enter",
                  waiting: [],
                });
                announce();
                // Started before the delegation and owned by the session, so
                // it is still there when the terminal phase is published after
                // this handler has unwound.
                owner.run(function* () {
                  for (const phase of yield* each(request.phases)) {
                    if (generation === entry) {
                      settle(key, phase);
                    }
                    yield* each.next();
                  }
                });
                // Bound *around* the delegation rather than set on this
                // frame, which is what makes it the enclosing key for
                // everything the call reaches — generated descendants
                // included — and for nothing beside it.
                yield* CurrentOccurrence.with(key, () => next(request));
              },
            });
          },
        },
        open(entry: string): void {
          generation = entry;
          sequence = 0;
          observed.clear();
          announce();
        },
        close(entry: string): void {
          if (generation !== entry) {
            return;
          }
          generation = undefined;
          observed.clear();
          announce();
        },
        reading,
        *hold(reason: ReplWaitReason): Operation<() => void> {
          // The call that is waiting is the one this wait was taken inside.
          const key = yield* CurrentOccurrence.get();
          const one = key === undefined ? undefined : observed.get(key);
          if (one === undefined) {
            return () => {};
          }
          one.waiting.push(reason);
          announce();
          let released = false;
          return () => {
            if (released) {
              return;
            }
            released = true;
            const at = one.waiting.indexOf(reason);
            if (at >= 0) {
              one.waiting.splice(at, 1);
            }
            announce();
          };
        },
        changes,
      };

      yield* ensure(() => {
        generation = undefined;
        observed.clear();
      });
      return lifecycle;
    },
  };
}
