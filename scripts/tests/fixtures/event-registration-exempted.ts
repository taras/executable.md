/* oxlint-disable local/require-scope-bound-event-registration */
/** A file-wide directive states an invariant for nothing, and is rejected. */
import type { Operation } from "effection";
import { EventEmitter } from "node:events";

const handle = () => {};

export function* twoSubscriptions(): Operation<void> {
  const emitter = new EventEmitter();

  emitter.on("ready", handle);
  emitter.on("failed", handle);
}
