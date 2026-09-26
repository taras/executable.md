/**
 * Taking a fork, which is the one moment a fork needs its parent.
 *
 * `inherit()` projects the parent at the source marker and writes what it
 * finds into a single `entry.inherited` record. After that record exists the
 * parent is only a name: reconstructing the fork reads the fork's own
 * Journal, and the parent's presence decides nothing but whether the
 * provenance link can be followed.
 *
 * The environment is read from the projection *at the marker*, never from the
 * parent's head and never transcribed by hand. Copying it by hand is how a
 * fixture comes to agree with itself and with nothing else, and taking it
 * from the head is how a fork silently inherits work done after it was taken.
 *
 * It is one record on purpose. Spread across a run of ordinary publications
 * the environment could be read half-copied — a prefix ending in the middle
 * would hydrate into an environment that never existed anywhere — and a
 * reader cannot tell a partial copy from a complete one. One record cannot be
 * half-read.
 */

import { Ok } from "effection";
import type { Result } from "effection";

import type { SemanticEvent } from "./journal.ts";
import { projectPrefix } from "./project.ts";

export interface Inheritance {
  /** The execution being forked from. */
  readonly parent: string;
  /** The marker in that execution to fork at. */
  readonly source: string;
  /** The synthetic entry the fork begins with. */
  readonly entry: string;
  readonly title: string;
  /** The record's own durable identity in the fork's Journal. */
  readonly id: string;
}

/**
 * The fork's first record, built from the parent as it stood at `source`.
 *
 * A marker the parent never minted, or a parent whose records describe a run
 * that cannot have happened, is a refusal: there is no environment to
 * inherit, and inventing an empty one would make a fork of nothing look like
 * a fork of something.
 */
export function inherit(events: readonly SemanticEvent[], at: Inheritance): Result<unknown> {
  const parent = projectPrefix(at.parent, events, at.source);
  if (!parent.ok) {
    return parent;
  }
  return Ok({
    id: at.id,
    seq: 1,
    at: 0,
    kind: "entry.inherited",
    entry: at.entry,
    title: at.title,
    parent: at.parent,
    source: at.source,
    bindings: parent.value.bindings.map((binding) => ({
      name: binding.name,
      value: binding.value,
    })),
  });
}
