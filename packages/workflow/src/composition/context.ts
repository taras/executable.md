/**
 * The contextual Repository a lexical `<Repository>` installs for its content.
 *
 * A stable, namespaced contextual value holding a parsed record and no
 * authority. `<Worktree>` reads it to learn which Repository it belongs to; the
 * provider decides separately whether anything may be done to that Repository,
 * so a replaced context can misname a Repository but cannot grant access to
 * one.
 *
 * Installed with `{ at: "min" }` wherever it is installed, so the nearest
 * enclosing Repository answers and the outer one is restored when that scope
 * ends. Nesting one Repository inside another therefore means what it reads as.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { RepositoryRecord } from "./records.ts";

export interface RepositoryContextApi {
  readonly current: RepositoryRecord | undefined;
}

export const RepositoryContext: Api<RepositoryContextApi> = createApi<RepositoryContextApi>(
  "executablemd.workflow.composition.context",
  { current: undefined },
);

/** The currently enclosing Repository, or `undefined` when there is none. */
export function currentRepository(): Operation<RepositoryRecord | undefined> {
  return RepositoryContext.operations.current;
}
