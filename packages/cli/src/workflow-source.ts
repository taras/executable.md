/**
 * Reading a retained definition's Markdown back, for an export to seal.
 *
 * The one place this host turns retrieval metadata into bytes. It is installed
 * into the lifecycle provider and captured there, so the only way to reach it
 * is to be the provider — a request cannot carry a closure and no contextual
 * name resolves to one.
 *
 * Authentication is `loadRetainedDefinition()`'s and is not repeated here: it
 * reads the exact object the definition pins, never the working tree, and
 * verifies every component against the hash the definition holds. What is added
 * is the root's own blob identity, which a definition does not retain — a
 * definition pins a commit and a path, so the identity of the document at that
 * path is derived from the bytes that came back and compared with them again by
 * the container.
 */

import { Ok, type Operation, type Result } from "effection";
import { gitBlobIdentity } from "@executablemd/workflow/deno";
import type { XmdArtifactDefinitionClosure } from "@executablemd/workflow/deno";
import type { WorkflowDefinition } from "@executablemd/workflow";
import type { Json } from "@executablemd/durable-streams";
import { loadRetainedDefinition } from "./workflow-definition.ts";

export function* readDefinitionSource(
  definition: WorkflowDefinition,
  retrieval: Json | undefined,
): Operation<Result<XmdArtifactDefinitionClosure>> {
  const sources = yield* loadRetainedDefinition(definition, retrieval);
  if (!sources.ok) {
    return sources;
  }
  return Ok({
    root: {
      objectFormat: definition.objectFormat,
      pinnedCommit: definition.objectId,
      rootDocumentPath: definition.rootDocumentPath,
      ...(definition.targetPath === undefined ? {} : { targetPath: definition.targetPath }),
      blobId: gitBlobIdentity(sources.value.source, definition.objectFormat),
      content: sources.value.source,
    },
    components: sources.value.components.map((component) => ({
      name: component.name,
      path: component.path,
      blobId: component.sourceHash,
      content: component.content,
    })),
  });
}
