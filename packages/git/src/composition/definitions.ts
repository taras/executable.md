/**
 * This boundary's origin, and the `<Dir>` spelling a workflow run offers.
 *
 * The component is canonical core's
 * (`core/src/components/fixed-filesystem.ts`), and so is what offering it
 * grants: core's own declaration states the identity and the effect its paired
 * form runs as (specs/workflow-workspace-spec.md §8.4). What stays here is the
 * host's decision to offer the name at all — a workflow run has a `<Dir>` and
 * an ordinary run has none.
 */

import type { InvocationForm } from "@executablemd/core";

export const COMPOSITION_ORIGIN = "@executablemd/workflow/composition";

/**
 * `<Dir>` in a workflow run's generated selection.
 *
 * A host composing the selection asks for this rather than writing the name and
 * the form out again. It is a name and a spelling: core supplies the body
 * behind it and the identity it runs under, so this states no definition and no
 * grant of its own.
 */
export function gitDirectorySelection(): Readonly<Record<string, readonly InvocationForm[]>> {
  return { Dir: ["paired"] };
}
