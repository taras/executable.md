/** A narrow directive covers one line, and one only. */
import type { Operation } from "effection";
import { EventEmitter } from "node:events";

const handle = () => {};

export function* twoSubscriptions(): Operation<void> {
  const emitter = new EventEmitter();

  // The stated invariant this directive stands on would go here.
  // oxlint-disable-next-line local/require-scope-bound-event-registration
  emitter.on("ready", handle);
  emitter.on("failed", handle);
}
