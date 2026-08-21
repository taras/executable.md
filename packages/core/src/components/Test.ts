/**
 * `<Test>` — the construct whose invocation contains a checked failure (§3.6).
 *
 * This function is the whole of core's claim. It is private to this module in
 * every sense that matters: it is never registered by another package, never
 * handed to an installation, never named in an option, and never reachable
 * through the public surface. `expandFunctionComponent` grants containment to
 * the definition it is expanding when that definition is this one, so what may
 * contain a checked command failure is decided by canonical core and by
 * nothing else.
 *
 * It is an ordinary **default**, like every other component in the core
 * registry: a repository `Test.md` or `Test.ts` is chosen ahead of it, and so
 * is any package that registers the name. When one of those is selected this
 * definition was not, so it is not this function that runs and no containment
 * is granted — which is the point of deciding by definition rather than by
 * name (specs/testing-spec.md).
 *
 * What a test *does* is not here. That arrives through `TestBehavior`. Whether
 * it may run at all is decided before that, through `TestActivation`: the
 * behavior surface is ordinary public middleware, so a handler there must not
 * be able to answer for a decision that precedes it.
 *
 * What this function does own, beside the containment grant, is the authority a
 * nested execution is run under. It is minted here, in this invocation's frame,
 * for the same reason containment is decided here: an invocation of *this*
 * definition is the only thing that may hold it. It is handed to whoever the
 * trusted host attached and to nobody else — there is no reader for it
 * (`test-harness.ts`).
 */

import type { Operation } from "effection";
import { requireTestActivation } from "../test-activation.ts";
import { TestBehavior } from "../test-behavior.ts";
import { installTestHarness } from "../test-harness.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: { name: { type: "string" }, timeout: { type: "string" } },
  additionalProperties: false,
};

export default function* Test(props: Record<string, Json>): Operation<Json> {
  // First, and outside the behavior chain. Whether this test may run at all is
  // not something a handler composed around what a test *does* may answer, and
  // a handler that answered without delegating would otherwise decide it by
  // never letting the question be asked (`test-activation.ts`).
  yield* requireTestActivation();
  // Delivered before the behavior runs and expired when this frame unwinds, so
  // the harness exists for exactly the body this invocation expands — and only
  // for whoever the trusted host attached to receive it.
  yield* installTestHarness();
  return yield* TestBehavior.operations.test(props);
}
