/**
 * The Markdown a retained definition names, and how a host that has it supplies
 * it.
 *
 * A run's definition is identity; its source is content. Version 2 keeps both,
 * so its content comes out of the run's own store. Version 1 keeps only
 * identity — an object id and a path inside a commit — so its content has to be
 * fetched, and fetching it means reaching a repository.
 *
 * The retained lifecycle does neither. It receives a closure and holds it to
 * the descriptor it asked about, which is what makes "these are the bytes this
 * run is a run of" a checkable claim rather than an assertion by whoever did
 * the reading.
 *
 * ## The legacy reader is a closure, never a name
 *
 * `LegacyWorkflowSourceReader` is captured by the trusted host before document
 * code exists. It is reachable through no Context, contextual Api, component,
 * Plugin installation result or authored value: a source capability something
 * in the process could reach by name is a way to decide what a run executes.
 */

import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { GitWorkflowDefinitionV1 } from "../storage/definition.ts";
import type { SourceBundleWorkflowDefinitionV2 } from "../storage/source-bundle.ts";

/**
 * The root document a version-1 definition names, and the bytes behind it.
 *
 * The descriptor members repeat what the definition already pins so the closure
 * can be checked against it: a closure whose Markdown belongs to a different
 * commit than the definition names is not a closure of that definition.
 */
export interface GitDefinitionSourceRootV1 {
  readonly objectFormat: "sha1" | "sha256";
  /** The commit the definition pins, as the definition's own object id. */
  readonly pinnedCommit: string;
  readonly rootDocumentPath: string;
  /** One exact canonical document target, when the definition selects one. */
  readonly targetPath?: string;
  /** The Git blob identity of `content`, under `objectFormat`. */
  readonly blobId: string;
  readonly content: string;
}

/** One declared component of a version-1 definition, including an unexpanded one. */
export interface GitDefinitionSourceComponentV1 {
  readonly name: string;
  readonly path: string;
  /** The Git blob identity of `content`, under the root's `objectFormat`. */
  readonly blobId: string;
  readonly content: string;
}

/** Everything a version-1 definition is closed over, without its repository. */
export interface GitDefinitionSourceClosureV1 {
  readonly root: GitDefinitionSourceRootV1;
  readonly components: readonly GitDefinitionSourceComponentV1[];
}

/** One retained version-2 source: its logical path and its exact bytes. */
export interface SourceBundleRetainedSourceV2 {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** A version-1 run's authenticated source, with the definition it was checked against. */
export interface GitRetainedDefinitionSourcesV1 {
  readonly definitionVersion: 1;
  readonly definition: GitWorkflowDefinitionV1;
  readonly closure: GitDefinitionSourceClosureV1;
}

/**
 * A version-2 run's authenticated source, in the descriptor's canonical order.
 *
 * The bytes are the store's own, read back after they were committed rather
 * than the buffers a caller offered — so what executes is what the run
 * retained, not what somebody still holds a reference to.
 */
export interface SourceBundleRetainedDefinitionSourcesV2 {
  readonly definitionVersion: 2;
  readonly definition: SourceBundleWorkflowDefinitionV2;
  readonly sources: readonly SourceBundleRetainedSourceV2[];
}

/** The complete verified source closure one run executes. */
export type RetainedDefinitionSources =
  | GitRetainedDefinitionSourcesV1
  | SourceBundleRetainedDefinitionSourcesV2;

/**
 * How a trusted host turns a retained version-1 definition back into Markdown.
 *
 * Supplied to the workflow host as a direct dependency and captured in its
 * closure. It receives only the parsed descriptor and the run's replaceable
 * retrieval metadata; whatever it does to reach a repository is the host's
 * business. Workflow — not the adapter — decides whether what came back
 * describes the definition it asked about.
 */
export type LegacyWorkflowSourceReader = (
  definition: GitWorkflowDefinitionV1,
  retrieval: Json | undefined,
) => Operation<Result<RetainedDefinitionSources>>;
