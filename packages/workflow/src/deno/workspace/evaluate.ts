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
 * - the write table is core's paired `<File>`, workflow's own lexical `<Dir>`
 *   built from the same definition the ordinary registration owns, and core's
 *   self-closing `<File.Delete />`;
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
 * `<File>`, workflow's `<Dir>` and core's self-closing `<File.Delete>` and
 * nothing else — no Git, no Git host, no Issue, no process, no credential — and
 * a host that installed no write table refuses the selection before the
 * candidate is parsed.
 *
 * A deletion is admitted on the same terms as the other two, and accounted for
 * the same way: it invokes the ordinary component, crosses the run's existing
 * effect transaction, and is retained by the `workspace_file` effect that
 * transaction publishes. Nothing about it reaches the value `<Evaluate>`
 * returns.
 *
 * ## The `source` spelling
 *
 * Workflow documents were written against `source` before `text` existed, so
 * this profile admits it and canonical `<Evaluate>` accepts it here without
 * complaint. The ordinary run profile does not: it never shipped that spelling,
 * and there is no document written against it to keep working.
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
import { COMPOSITION_ORIGIN, dirDefinition } from "../../composition/definitions.ts";
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
  // Built from the same definition the ordinary registration owns, so the two
  // cannot drift. Versioned in its revision because what the entry authorizes
  // changed: the former `Dir` authorized placement that created nothing, and
  // `<Dir>` now recursively creates the directory it names. A continuation
  // granted under the earlier revision must not silently receive the wider
  // authority, and the retained comparison refuses it before generated
  // execution.
  const dir = dirDefinition();
  const timeout = yield* timeoutFetch;
  return {
    read: [
      fileReadEntry(),
      ...(requests.length === 0 ? [] : [fetchEntry(requests)]),
      ...(options.reads ?? []),
    ],
    write: [
      fileWriteEntry(),
      {
        name: dir.name,
        identity: { origin: COMPOSITION_ORIGIN, key: "Dir", revision: "2" },
        forms: ["paired"],
        props: dir.props,
        definition: dir,
      },
      fileDeleteEntry(),
      ...(options.writes ?? []),
    ],
    workspace: workspaceAccess(database),
    deprecatedSourceAlias: true,
    ...(timeout === undefined ? {} : { fetchTimeout: timeout }),
  };
}
