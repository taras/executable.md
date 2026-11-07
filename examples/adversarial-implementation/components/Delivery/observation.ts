import { createDurableOperation } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { z } from "zod";

/**
 * Record what a live operation observed, so continuation restores the
 * observation instead of reading provider middleware state that a replayed
 * operation never sets, or files that later steps have since written.
 */
export function* retained<T>(
  name: string,
  schema: z.ZodType<T>,
  observe: () => Operation<unknown>,
): Operation<T> {
  const stored: unknown = yield createDurableOperation(
    { type: "delivery_review_observation", name },
    function* () {
      return z.json().parse(yield* observe());
    },
  );
  return schema.parse(stored);
}
