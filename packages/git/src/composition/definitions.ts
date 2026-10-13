/**
 * This boundary's origin, and the generated-XMD identity it pins for `<Dir>`.
 *
 * The component itself is canonical core's
 * (`core/src/components/fixed-filesystem.ts`). What stays here is the *identity*
 * a workflow run's generated-XMD write table admits it under
 * (specs/workflow-workspace-spec.md §8.4): a host states which grant a fragment
 * is being given, and this host's grant is a string released builds already
 * wrote into their journals.
 */

import { directoryEntry } from "@executablemd/core/host";
import type { FragmentEntry } from "@executablemd/core/host";

export const COMPOSITION_ORIGIN = "@executablemd/workflow/composition";

/**
 * The origin released builds retained for `<Dir>`'s generated-XMD entry.
 *
 * Written out rather than derived from this package's own name. It identifies
 * *retained history*: every journal a released build wrote holds this string,
 * and a continuation compares the write table position by position. The
 * component moved packages; what a run already recorded did not.
 */
export const RETAINED_DIRECTORY_ORIGIN = "@executablemd/workflow/composition";

/**
 * `<Dir>`'s entry in a workflow run's generated-XMD write table.
 *
 * A host assembling the generated-evaluation profile asks for this rather than
 * writing the identity out again. Core supplies the body behind it, so this
 * names no definition of its own: what the grant admits is the one `<Dir>` every
 * authored element reaches.
 */
export function gitDirectoryEntry(): FragmentEntry {
  return directoryEntry({ origin: RETAINED_DIRECTORY_ORIGIN, key: "Dir", revision: "3" }, "Dir", [
    "@executablemd/workflow/composition/dir-v2#Dir",
  ]);
}
