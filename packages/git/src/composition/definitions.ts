/**
 * Where a composition component's definition comes from, for everyone who needs
 * one.
 *
 * `<Dir>` has two consumers. It is an ordinary registered default, and it is
 * the pinned lexical identity the generated-XMD write table admits
 * (specs/workflow-workspace-spec.md §8.4). A pinned identity built from a
 * second copy of the implementation or a second copy of the schema would be a
 * component nothing else in this package runs, and the drift would be invisible
 * until a generated fragment behaved differently from an authored one. So both
 * read this, and the generated evaluator never consults the registration.
 */

import { formDispatcher } from "@executablemd/core";
import { directoryEntry } from "@executablemd/core/host";
import type { FragmentEntry } from "@executablemd/core/host";
import type { FunctionComponentDefinition } from "@executablemd/core";
import { form as dirForm, props as dirProps } from "./components/Dir.ts";

export const COMPOSITION_ORIGIN = "@executablemd/workflow/composition";

/**
 * The dispatcher both consumers share, built once.
 *
 * `<Dir>` is paired-only, so its definition is an engine-owned dispatcher
 * rather than the body itself, and canonical core builds it from the
 * declaration the component exports. Built once here for the same reason the
 * schema is read once: the registration and the pinned identity must be the
 * same definition, and two dispatchers would be two components.
 */
const fn = formDispatcher(dirForm);

export function dirDefinition(): FunctionComponentDefinition {
  return { kind: "function", name: "Dir", props: dirProps, fn };
}

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
 * Stated here, beside the definition the ordinary registration uses, because
 * both describe the same component and a second copy of either would drift.
 * A host assembling the generated-evaluation profile asks for this rather than
 * writing the identity out again.
 */
export function gitDirectoryEntry(): FragmentEntry {
  return directoryEntry({ origin: RETAINED_DIRECTORY_ORIGIN, key: "Dir", revision: "3" }, "Dir", [
    "@executablemd/workflow/composition/dir-v2#Dir",
  ]);
}
