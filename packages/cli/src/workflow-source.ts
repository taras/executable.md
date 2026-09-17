/**
 * This host's legacy version-1 source reader.
 *
 * The one place the CLI turns a retained version-1 definition back into
 * Markdown. It is handed to the Workflow lifecycle as a direct dependency and
 * captured in its closure, so the only way to reach it is to be that provider —
 * a request cannot carry a closure, and no contextual name resolves to one.
 *
 * Version 2 never comes here. A source bundle's content is in the run's own
 * store, so a host reaching a repository for it would be a second answer to a
 * question storage has already answered.
 *
 * What this does is fetch. Whether what came back describes the definition it
 * was asked about is Workflow's decision, not this adapter's: it recomputes
 * every blob identity from the bytes returned and compares the root's own terms
 * with the descriptor. An adapter that judged its own answer would be the only
 * thing checking it.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import { gitBlobIdentity } from "@executablemd/workflow/deno";
import type { RetainedDefinitionSources } from "@executablemd/workflow/deno";
import type { GitWorkflowDefinitionV1 } from "@executablemd/workflow";
import { LegacyWorkflowSourceUnavailableError } from "@executablemd/workflow";
import type { Json } from "@executablemd/durable-streams";
import { loadRetainedDefinition } from "./workflow-definition.ts";

export function* readLegacyDefinitionSource(
  definition: GitWorkflowDefinitionV1,
  retrieval: Json | undefined,
): Operation<Result<RetainedDefinitionSources>> {
  const sources = yield* loadRetainedDefinition(definition, retrieval);
  if (!sources.ok) {
    // Mapped into the categorical failure Workflow declares for it: this host
    // could not obtain the retained object, which is a different fact from the
    // answer disagreeing with the descriptor.
    return Err(new LegacyWorkflowSourceUnavailableError(sources.error.message));
  }
  return Ok({
    definitionVersion: 1,
    definition,
    closure: {
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
    },
  });
}
