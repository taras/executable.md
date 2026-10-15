/**
 * State the host ceiling for canonical core's Evaluate component
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * The workflow attachment assembles the profile once; canonical execution captures
 * it by value before document code. Props, bindings, Context, middleware and
 * generated names cannot widen it. Read includes core's self-closing File, Fetch
 * only with exact permitted requests, and captured host additions. Write includes
 * paired File, an optional host-supplied directory entry, self-closing File.Delete
 * and captured additions, in that order. No directory entry means no directory
 * grant. `allow` selects classes, defaulting to read, and never supplies permission.
 *
 * The private per-invocation Workspace snapshot reports retained roots and current
 * root. Continuation requires admission roots by membership, allowing legitimate
 * new roots and frontier advancement without changing the grant.
 *
 * Entries run ordinary canonical components through contextual API.Files/API.Fetch,
 * existing middleware, effective Permissions and the run's effect transaction.
 * Deletion remains a workspace_file effect. Relative paths use the run's contextual
 * cwd, including Dir/Repository/Worktree placement, never the invocation host cwd.
 * This profile supplies admitted names, forms and ceilings rather than
 * operations: which identity and effect each admitted spelling runs under comes
 * from the declaration that owns its implementation.
 */

import { timeoutFetch } from "@executablemd/runtime";
import type { Operation } from "effection";
import {
  fetchEntry,
  fileDeleteEntry,
  fileReadEntry,
  fileWriteEntry,
} from "@executablemd/core/host";
import type {
  FragmentEntry,
  FragmentEvaluationInput,
  FragmentWorkspaceAccess,
  GeneratedRequest,
} from "@executablemd/core/host";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { workspaceRootSelection } from "./effect.ts";

/**
 * What a host may configure about generated evaluation.
 *
 * Adapter-private values, supplied before the document runs. Every one of them
 * is additive: production may supply none, which is the standard profile above
 * and nothing else. A document prop supplies none of them.
 */
export interface GeneratedEvaluationOptions {
  /**
   * The exact HTTP reads an admitted fragment may perform.
   *
   * Empty admits `<Fetch>` not at all — the pinned entry is simply not on the
   * allowlist, which is a different thing from admitting it and refusing every
   * request.
   */
  readonly requests?: readonly GeneratedRequest[];
  /** Further read components this host admits beside core's pinned ones. */
  readonly reads?: readonly FragmentEntry[];
  /** Further mutation components this host admits beside the standard profile's. */
  readonly writes?: readonly FragmentEntry[];
  /**
   * Optional directory admission, between File write and File.Delete.
   * Canonical core owns Dir; the host supplies its admitted entry. Omission grants
   * no directory capability. Keep this position: continuation compares the retained
   * table entry by entry.
   */
  readonly directory?: FragmentEntry;
}

/**
 * The run's retained Workspace basis, answered per invocation.
 *
 * A private operation closed over this run's own storage rather than the
 * storage itself: the profile canonical execution captures carries the answer
 * an invocation needs and no way to reach the database that produced it.
 */
function workspaceAccess(database: WorkflowRunDatabase): FragmentWorkspaceAccess {
  return {
    *snapshot() {
      const selection = yield* workspaceRootSelection(database);
      return { roots: selection.roots, current: selection.current };
    },
  };
}

/**
 * The ceiling a workflow run's generated fragments are admitted under.
 *
 * An operation, because the effective Fetch timeout is resolved here — once,
 * by the host, at assembly. A ceiling compared across a suspension cannot
 * depend on where the comparison happened, so preflight and execution normalize
 * against this value rather than reading the context again.
 */
export function* evaluationProfile(
  database: WorkflowRunDatabase,
  options: GeneratedEvaluationOptions = {},
): Operation<FragmentEvaluationInput> {
  const requests = [...(options.requests ?? [])];
  const timeout = yield* timeoutFetch;
  return {
    read: [
      fileReadEntry(),
      ...(requests.length === 0 ? [] : [fetchEntry(requests)]),
      ...(options.reads ?? []),
    ],
    write: [
      fileWriteEntry(),
      // The directory entry is the host's to supply, and a host that supplies
      // none grants none. Canonical core owns `<Dir>` itself, so what a host
      // states here is the admission rather than the component: a generic
      // Workflow host composing this profile without it is not withholding an
      // implementation so much as never having admitted the name.
      //
      // Its position is the contract. A released journal holds this table
      // position by position, so the entry a host does supply occupies the
      // slot between the file write and the file delete, exactly where every
      // retained continuation expects to find it.
      ...(options.directory === undefined ? [] : [options.directory]),
      fileDeleteEntry(),
      ...(options.writes ?? []),
    ],
    workspace: workspaceAccess(database),
    ...(timeout === undefined ? {} : { fetchTimeout: timeout }),
  };
}
