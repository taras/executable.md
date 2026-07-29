import { createContext } from "effection";
import type { Context } from "effection";

/**
 * The loop a `<Break>` exits (spec §6.5 `<Loop>`).
 *
 * `<Loop>` publishes a frame for the body it expands, and `<Break>` marks it.
 * Expansion checks the mark after every segment, so the rest of the iteration
 * is never reached and the loop stops before its next one. The mark is the
 * whole state: iteration identity lives in the block counter, which already
 * advances monotonically across iterations.
 *
 * A nested `<Loop>` publishes its own frame, so a `<Break>` beneath it marks
 * the inner loop and leaves the outer one running.
 *
 * A component invocation publishes `undefined`, which makes the loop boundary
 * lexical: a component invoked from a loop body — and the content projected
 * through it — cannot break the loop it was invoked from. How often a
 * component renders `<Content />`, if at all, is the component's decision, so
 * a `<Break>` written there has no defined relationship to the loop.
 */
export interface LoopFrame {
  broken: boolean;
}

export const ActiveLoop: Context<LoopFrame | undefined> = createContext<LoopFrame | undefined>(
  "expand.loop",
  undefined,
);
