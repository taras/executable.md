import { createDurableOperation } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  EffectDescription,
  Json,
  LiveDurableOperationCoordinator,
  Result as ProtocolResult,
} from "@executablemd/durable-streams";
import type { Operation } from "effection";

export function* savedRequest<T>(
  description: EffectDescription,
  produce: () => Json,
  readback: (stored: unknown) => T,
): Operation<T> {
  const stored: unknown = yield createDurableOperation<Json>(
    description,
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      const payload = produce();
      readback(payload);
      return payload;
    },
    { coordinator: requestCoordinator },
  );
  return readback(stored);
}

// A request failure cannot become a saved outcome: reconciliation needs a
// complete request, and must run only after the append is acknowledged.
const requestCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: ProtocolResult) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
  ): Operation<ProtocolResult> {
    let value: T;
    try {
      value = yield* execute();
    } catch (error) {
      throw activateFailure(error);
    }
    const result: ProtocolResult = { status: "ok", value };
    yield* publish(result);
    return result;
  },
};
