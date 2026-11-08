import { createContext } from "effection";
import type { Operation } from "effection";
import type { TestLifecycle } from "./test-api.ts";

export const LifecyclePublisher = createContext<(event: TestLifecycle) => void>(
  "executablemd.testing.lifecycle-publisher",
);

export function* publishLifecycle(event: TestLifecycle): Operation<void> {
  const publish = yield* LifecyclePublisher.get();
  publish?.(event);
}
