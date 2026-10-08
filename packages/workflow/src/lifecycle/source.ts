/**
 * The Markdown a retained definition names.
 *
 * A run's definition is identity; its source is content. A definition keeps
 * both, so its content comes out of the run's own store and nothing has to be
 * fetched to execute it. No host supplies a source capability, because there is
 * no definition whose bytes live anywhere but in the run that retained them.
 *
 * The retained lifecycle reads that store and holds what it finds to the
 * descriptor it asked about, which is what makes "these are the bytes this run
 * is a run of" a checkable claim rather than an assertion by whoever did the
 * reading.
 */

import type { WorkflowDefinition } from "../storage/source-bundle.ts";

/** One retained source: its logical path and its exact bytes. */
export interface RetainedSource {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * A run's authenticated source, in the descriptor's canonical order.
 *
 * The bytes are the store's own, read back after they were committed rather
 * than the buffers a caller offered — so what executes is what the run
 * retained, not what somebody still holds a reference to.
 */
export interface RetainedDefinitionSources {
  readonly definition: WorkflowDefinition;
  readonly sources: readonly RetainedSource[];
}
