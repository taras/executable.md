/**
 * The two canonical mutations, given a body when a host journals them.
 *
 * Nothing here claims a name. `<File>` and `<File.Delete>` keep the definitions
 * core already registers, and resolution decides what those names mean exactly
 * as before: a repository component, a declaration and a registration shadow
 * them on their own terms, and a shadow is a different function object, so the
 * body below is never reached for it.
 *
 * What this adds is an association from core's own definition — this loaded
 * copy's exact function — to a body built for one execution from the claimant
 * that execution minted. A copied definition, a wrapper around it and a
 * same-named answer are other objects and reach nothing.
 *
 * With no handlers there is nothing to associate, so the list is empty and both
 * components are exactly what they were.
 */

import { fileMutationBody as writeBody } from "./File.ts";
import { fileMutationBody as deleteBody } from "./FileDelete.ts";
import { CORE_ORIGIN, coreComponentDefinition } from "./registry.ts";
import type { AdoptedDeclaration } from "../invocation-identity.ts";
import type { FileMutationHandlers } from "../file-mutations.ts";
import type { FragmentMutationAdoption } from "../fragment-capabilities.ts";
import type { FunctionComponent } from "../types.ts";

/** The canonical names whose mutations a host may be handed. */
const FILE = "File";
const FILE_DELETE = "File.Delete";

/**
 * What this execution adopts for its file mutations.
 *
 * A definition core cannot find is not an error to raise here: the registry is
 * core's own and the names are core's own, so an absent one would mean this
 * copy of core has no such component, and a host that supplied handlers for it
 * simply has nothing to be handed.
 */
export function fileMutationComponents(
  handlers: FileMutationHandlers | undefined,
  generated: readonly FragmentMutationAdoption[] = [],
): readonly AdoptedDeclaration[] {
  if (handlers === undefined) {
    return [];
  }
  const adopted: AdoptedDeclaration[] = [];
  // The definitions this execution's profile built over its captured
  // capabilities. They share their names with the authored components — a
  // fragment writes `<File>` too — and they are different definitions with
  // different owners, which is why an adoption belongs to an implementation
  // rather than to a name.
  for (const adoption of generated) {
    adopted.push({
      name: adoption.name,
      origin: CORE_ORIGIN,
      fn: adoption.fn,
      build: (claim) => adoption.build(claim, handlers),
    });
  }
  const write = implementation(FILE);
  if (write !== undefined) {
    adopted.push({
      name: FILE,
      origin: CORE_ORIGIN,
      fn: write,
      build: (claim) => writeBody(claim, handlers),
    });
  }
  const remove = implementation(FILE_DELETE);
  if (remove !== undefined) {
    adopted.push({
      name: FILE_DELETE,
      origin: CORE_ORIGIN,
      fn: remove,
      build: (claim) => deleteBody(claim, handlers),
    });
  }
  return Object.freeze(adopted);
}

/**
 * The function canonical core registers for this name.
 *
 * A registration can also carry a test harness rather than a component, which
 * is not something a file mutation is ever routed through, so the shape is read
 * rather than assumed.
 */
function implementation(name: string): FunctionComponent | undefined {
  const fn = coreComponentDefinition(name)?.fn;
  return typeof fn === "function" ? fn : undefined;
}
