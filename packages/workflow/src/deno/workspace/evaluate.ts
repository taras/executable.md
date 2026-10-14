/**
 * What a workflow run lets a generated fragment do
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * An Agent proposes an observation by returning a fragment of Executable
 * Markdown, and an authored workflow writes `<Evaluate>` where it wants that
 * fragment admitted and performed. The component is canonical core's — public,
 * protected, and the same in every execution. What this file states is the
 * *ceiling*, which is the only part a host owns.
 *
 * ## Every ceiling is captured before a document exists
 *
 * This is built once, when the workflow attachment assembles the execution, and
 * canonical execution captures it by value there. Nothing a document, a prop, a
 * binding, a context, a contextual API answer, middleware or a generated name
 * does reaches back into it.
 *
 * - the read table is core's read-only `<File />`; `<Fetch />` joins it only
 *   where this host also states the exact requests it may perform;
 * - the write table is core's paired `<File>`, the directory entry this host
 *   captured — or the one released builds retained, when it captured none —
 *   and core's self-closing `<File.Delete />`;
 * - any further read or write comes from the captured host option; and
 * - the Workspace basis is answered per invocation by the private operation
 *   below, because a run's own progress legitimately advances it: every
 *   committed mutation retains another immutable root. A continuation holds the
 *   admission's roots by membership, so later publications and an advanced
 *   current root change nothing the admission was granted under.
 *
 * ## `allow` narrows; it never grants
 *
 * `allow` names an effect *class*, and the class resolves to the table stated
 * here. Omitting it asks for `read`. Asking for `write` reaches core's paired
 * `<File>`, the directory entry this host captured — `<Dir>` is canonical
 * core's own component now, and what a host supplies is the entry admitting it
 * — and core's self-closing `<File.Delete>`, and nothing else — no Git, no Git host, no Issue, no process, no credential — and
 * a host that installed no write table refuses the selection before the
 * candidate is parsed.
 *
 * A deletion is admitted on the same terms as the other two, and accounted for
 * the same way: it invokes the ordinary component, crosses the run's existing
 * effect transaction, and is retained by the `workspace_file` effect that
 * transaction publishes. Nothing about it reaches the value `<Evaluate>`
 * returns.
 *
 * ## The operations are the run's own, not this file's
 *
 * This states names, forms, identities and ceilings, and no operation at all.
 * An admitted entry runs canonical core's own component, which performs its
 * work through contextual `API.Files` and `API.Fetch` — in a workflow run,
 * the transaction-bound provider `workspace/host.ts` installed and the
 * transport the workflow host installed. So an admitted write is the same
 * durable effect an authored one is, published by the same transaction,
 * observed by the same middleware and decided by the same effective
 * `Permissions`. A fragment's relative paths resolve against the run's own
 * contextual working directory, which is the Workspace root as narrowed by the
 * run's own `<Dir>`, `<Repository>` and `<Worktree>` — never the directory the
 * caller invoked `xmd` from.
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
   * Empty admits `<Fetch>` not at all — the pinned identity is simply not on
   * the allowlist, which is a different thing from admitting it and refusing
   * every request.
   */
  readonly requests?: readonly GeneratedRequest[];
  /** Further read components this host admits beside core's pinned ones. */
  readonly reads?: readonly FragmentEntry[];
  /** Further mutation components this host admits beside the standard profile's. */
  readonly writes?: readonly FragmentEntry[];
  /**
   * The directory component this host admits, between core's write and delete.
   *
   * Its own member rather than one of the additive entries above, because it is
   * not an addition: it occupies the position the standard profile has always
   * had a directory entry in, and a continuation compares that table position
   * by position.
   *
   * Optional, and absence grants nothing. `<Dir>` belongs to
   * `@executablemd/git`, and this package states no entry for it: a host that
   * supplies none is a Workflow host without a directory capability, which is
   * a thing a generic host is entitled to be. The XMD workflow profile supplies
   * Git's.
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
