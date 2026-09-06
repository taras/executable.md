/**
 * The lifetime of a protected body's one projection of its own content.
 *
 * Canonical dispatch hands a protected body a callback that renders that
 * element's content once. The callback is authority — it projects the
 * document's own children under a reference the body chose — so how long it
 * lives and how many times it answers are not details. This module owns exactly
 * that question, and nothing else: what to project, under which authority, in
 * which scope and with which error mode all stay in `expand.ts`, which already
 * holds them. What arrives here is one already-bound operation.
 *
 * ## Why it is its own module
 *
 * Because the state machine is the part worth testing directly. Every guard
 * below is unreachable from a document — only canonical `<Evaluate>` consumes a
 * projector, and it consumes one once — so a black-box test cannot make a
 * second call, cannot retain a callback past a body, and cannot race two. A
 * test that could would need a protected component of its own, which is a hole
 * in the tier this exists to protect. Splitting the machine out is what lets the
 * guards be proved without opening one.
 *
 * It is package-internal on purpose. `expand.ts` imports it by relative path and
 * so does its own unit test; it appears in no barrel, no `host.ts`, no package
 * export, no Context, no `Component` api and no test-support surface. There is
 * nothing here for a document, a repository component, middleware or a second
 * loaded copy to reach.
 *
 * ## Three states, not two flags
 *
 * `open` → `spent` when a projection is consumed, and either → `closed` when
 * the body returns. Two booleans would admit a fourth combination nobody means,
 * and would leave "already projected" and "the body has finished" reporting the
 * same thing when they are different facts about different mistakes.
 *
 * Consumption happens *before* the underlying operation can suspend. A machine
 * that marked itself spent on completion would let two calls overlap while the
 * first was still running, which is the concurrent case rather than a
 * theoretical one: a body that spawns is ordinary Effection.
 */

import type { Operation } from "effection";

import { ComponentInvocationError } from "./invocation-identity.ts";
import type { ProjectProtectedContent } from "./invocation-identity.ts";
import type { SyntaxReference } from "./syntax-reference.ts";

/** What a protected body holds, and what canonical dispatch closes. */
export interface ProtectedContentLease {
  /** The callback the body may call once, while it is running. */
  readonly project: ProjectProtectedContent;
  /**
   * End it.
   *
   * Called from the same `finally` that closes the invocation's issued
   * authority, so a callback a body retained — in a closure, on an object it
   * returned, in something it spawned — refuses rather than projecting content
   * of an element that has finished.
   */
  close(): void;
}

/** Where one lease is in its life. */
type LeaseState = "open" | "spent" | "closed";

/**
 * One lease over one already-bound projection.
 *
 * `perform` is called at most once, and only from the `open` state. Everything
 * this adds is the refusal: the operation itself is `expand.ts`'s, closed over
 * the projection state, the authority and the scope that element actually has.
 */
export function protectedContentLease(
  name: string,
  perform: ProjectProtectedContent,
): ProtectedContentLease {
  let state: LeaseState = "open";
  return {
    *project(syntax: SyntaxReference): Operation<string> {
      // Read and moved before anything can suspend. A second call that arrived
      // while the first was still running would otherwise find `open` and
      // project the same content again, under a reference the first call did
      // not choose.
      if (state !== "open") {
        throw new ComponentInvocationError(refusal(name, state));
      }
      state = "spent";
      return yield* perform(syntax);
    },
    close(): void {
      state = "closed";
    },
  };
}

/**
 * What a refused call says, chosen by which mistake it was.
 *
 * A second call inside a running body and a call from a callback that outlived
 * the body are different errors with different fixes, and reporting them
 * identically would tell an author to look in the wrong place.
 */
function refusal(name: string, state: LeaseState): string {
  return state === "spent"
    ? `<${name}> renders its own content once, and this invocation has already rendered it.`
    : `<${name}> renders its own content while its body is running, and this invocation has ` +
        "finished.";
}
