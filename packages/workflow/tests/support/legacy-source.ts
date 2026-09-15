/**
 * The legacy source reader a test host installs when it executes a v1 run.
 *
 * A version-1 definition names a Git object and a path inside it, so the bytes
 * behind it come from a repository the retained lifecycle does not reach. A
 * host that executes one supplies this capability directly; these suites are
 * such hosts, and this is the smallest honest one.
 *
 * It answers about whatever descriptor it is asked, deriving the root's blob
 * identity from the bytes it returns — which is what Workflow recomputes on the
 * way in. A declared component is answered with content whose identity really
 * is the one the descriptor names, so a fixture that pins component hashes must
 * register the bytes behind them.
 */

import { Ok, type Operation, type Result } from "effection";
import { gitBlobIdentity } from "../../deno.ts";
import type { LegacyWorkflowSourceReader, RetainedDefinitionSources } from "../../deno.ts";
import type { GitWorkflowDefinitionV1 } from "../../mod.ts";

/** The document a reader answers with when a fixture names no other. */
export const LEGACY_ROOT_DOCUMENT = "# Release\n\nthis document is the run's retained source\n";

/** The bytes one fixture wants behind a declared component, by its blob id. */
export type LegacyComponentSources = ReadonlyMap<string, string>;

/**
 * A reader that returns this run's source, derived from its own descriptor.
 *
 * `components` maps a declared `sourceHash` to the bytes behind it. A fixture
 * whose definition declares no components needs none: the root is the whole
 * closure, and its identity is computed from the content returned rather than
 * pinned by the descriptor.
 */
export function legacySourceReader(
  root: string = LEGACY_ROOT_DOCUMENT,
  components: LegacyComponentSources = new Map(),
): LegacyWorkflowSourceReader {
  // deno-lint-ignore require-yield
  return function* (
    definition: GitWorkflowDefinitionV1,
  ): Operation<Result<RetainedDefinitionSources>> {
    return Ok({
      definitionVersion: 1,
      definition,
      closure: {
        root: {
          objectFormat: definition.objectFormat,
          pinnedCommit: definition.objectId,
          rootDocumentPath: definition.rootDocumentPath,
          ...(definition.targetPath === undefined ? {} : { targetPath: definition.targetPath }),
          blobId: gitBlobIdentity(root, definition.objectFormat),
          content: root,
        },
        components: (definition.components ?? []).map((component) => {
          const content = components.get(component.sourceHash);
          if (content === undefined) {
            throw new Error(
              `this fixture declares the component "${component.name}" and registered no bytes ` +
                "for the object id it pins, so no closure can satisfy it",
            );
          }
          return {
            name: component.name,
            path: component.path,
            blobId: component.sourceHash,
            content,
          };
        }),
      },
    });
  };
}
