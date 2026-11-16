import { createDurableOperation } from "@executablemd/durable-streams";
import type { LiveDurableOperationCoordinator } from "@executablemd/durable-streams";
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
  coordinator?: LiveDurableOperationCoordinator,
): Operation<T> {
  const stored: unknown = yield createDurableOperation(
    { type: "delivery_review_observation", name },
    function* () {
      return z.json().parse(yield* observe());
    },
    { coordinator },
  );
  return schema.parse(stored);
}

// Only a settled verdict is replayable. An observation failure still reaches
// the caller with its original identity, outside the durable error codec.
const verdictPublication: LiveDurableOperationCoordinator = {
  *run(observe, publish) {
    const value = yield* observe();
    const result = { status: "ok", value } satisfies import("@executablemd/durable-streams").Result;
    yield* publish(result);
    return result;
  },
};

export function retainedVerdict<T>(
  name: string,
  schema: z.ZodType<T>,
  observe: () => Operation<T>,
): Operation<T> {
  return retained(name, schema, observe, verdictPublication);
}
