/**
 * Replacing a file's whole content, or none of it.
 *
 * A control sidecar is read by another process while this one writes it, so a
 * partial write would be read as a partial fact — a descriptor naming an owner
 * whose generation had not arrived yet. Writing beside the target and renaming
 * over it makes the change one filesystem operation: a reader sees the previous
 * content or the next one, and never half of either.
 *
 * The temporary name carries a random suffix so two writers cannot collide on
 * it, and it is removed if the rename never happens.
 */

import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { until } from "effection";
import type { Operation } from "effection";

export function* writeAtomically(path: string, content: string): Operation<void> {
  const staged = `${path}.${randomUUID()}.tmp`;
  yield* writeTextFile(staged, content);
  try {
    // `@effectionx/fs` has no rename, and the whole point is that this is one
    // operation rather than a truncate followed by a write.
    yield* until(rename(staged, path));
  } catch (error) {
    if (yield* exists(staged)) {
      yield* rm(staged);
    }
    throw error;
  }
}
