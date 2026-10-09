/**
 * What a workflow run is a run *of*.
 *
 * The definition descriptor is the run's immutable identity: the exact bytes of
 * every document in the closure, named by logical path. It is supplied by the
 * host, stored once, and compared on every compatible reuse of a run id.
 *
 * Retrieval is deliberately not part of it. Where the bytes came from, and
 * where they happen to sit on this machine, change without changing which
 * document ran — so a locator is replaceable metadata rather than identity, and
 * a run stays the same run when it moves between hosts.
 *
 * The descriptor carries no version. One shape is the only shape, so there is
 * no arm to choose between and nothing for a reader to dispatch on; this module
 * is the storage-facing name for it, and `source-bundle.ts` is its shape,
 * parser and content addressing.
 */

import type { Json } from "@executablemd/durable-streams";
import {
  parseSourceBundleDefinition,
  sourceBundleComponents,
  sourceBundleDefinitionToJson,
} from "./source-bundle.ts";
import type { Result } from "effection";
import type { SourceBundleComponent, WorkflowDefinition } from "./source-bundle.ts";

export type { SourceBundleComponent, WorkflowDefinition };

/**
 * The workflow definition a value describes.
 *
 * Parsed rather than asserted: a descriptor reaches storage from a host, and a
 * host that builds one by hand — or reads one from a file — can build one that
 * type-checks and does not describe a definition. The parser is closed, so a
 * value carrying any member this shape does not declare is refused rather than
 * read loosely. A record retained under an older format carried a `version`
 * member, and is therefore refused here rather than guessed at.
 */
export function parseWorkflowDefinition(value: unknown): Result<WorkflowDefinition> {
  return parseSourceBundleDefinition(value);
}

/**
 * The descriptor as a plain JSON value.
 *
 * An interface has no index signature, so a descriptor is not a `Json` until
 * it is written out member by member. Doing that in one place is also what
 * keeps the stored shape and the parsed shape one decision.
 */
export function definitionToJson(definition: WorkflowDefinition): Json {
  return sourceBundleDefinitionToJson(definition);
}

/** The component mapping this definition declares, empty when it declares none. */
export function definitionComponents(
  definition: WorkflowDefinition,
): readonly SourceBundleComponent[] {
  return sourceBundleComponents(definition);
}

/** The exact document target this definition names, when it names one. */
export function definitionTargetPath(definition: WorkflowDefinition): string | undefined {
  return definition.targetPath;
}
