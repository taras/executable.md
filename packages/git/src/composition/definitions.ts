/**
 * This boundary's origin, and the `<Dir>` entry a workflow run admits.
 *
 * The component is canonical core's
 * (`core/src/components/fixed-filesystem.ts`), and so is what admitting it
 * grants: core's own declaration states the identity and the effect its paired
 * form runs as (specs/workflow-workspace-spec.md §8.4). What stays here is the
 * host's decision to admit the name at all — a workflow run has a `<Dir>` and
 * an ordinary run has none.
 */

import { directoryEntry } from "@executablemd/core/host";
import type { FragmentEntry } from "@executablemd/core/host";

export const COMPOSITION_ORIGIN = "@executablemd/workflow/composition";

/**
 * `<Dir>`'s entry in a workflow run's generated-XMD write table.
 *
 * A host assembling the generated-evaluation profile asks for this rather than
 * writing the admission out again. Core supplies the body behind it and the
 * identity it is admitted under, so this names no definition and no grant of
 * its own: what it admits is the one `<Dir>` every authored element reaches.
 */
export function gitDirectoryEntry(): FragmentEntry {
  return directoryEntry("Dir");
}
