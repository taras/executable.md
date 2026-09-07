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

import { API, timeoutFetch } from "@executablemd/runtime";
import type { Operation } from "effection";
import {
  detachHeaders,
  detachStatus,
  directoryEntry,
  fetchEntry,
  fileDeleteEntry,
  fileReadEntry,
  fileWriteEntry,
} from "@executablemd/core/host";
import type {
  FetchResponseRecord,
  FragmentEntry,
  FragmentEvaluationInput,
  FragmentFetchAccess,
  FragmentFileAccess,
  FragmentWorkspaceAccess,
  GeneratedRequest,
} from "@executablemd/core/host";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { COMPOSITION_ORIGIN } from "../../composition/definitions.ts";
import { workflowFilesHandler } from "./files.ts";
import { WORKSPACE_ROOT } from "./logical-path.ts";
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
 * The exact filesystem operations an admitted fragment performs in this run.
 *
 * This run's own transaction-bound handler, built here and handed to the
 * profile, so an admitted effect still crosses the run's effect transaction and
 * is still retained by the `workspace_file` effect that transaction publishes.
 * What changed is where the handler comes from: a fragment no longer resolves
 * `API.Files` when it runs, so the provider a document, a repository component
 * or middleware installed nearer is not between a fragment and the Workspace.
 *
 * Five operations, not seven. The handler also globs and makes temporary
 * directories; an admitted fragment does neither.
 */
function workspaceFiles(database: WorkflowRunDatabase): FragmentFileAccess {
  const handler = workflowFilesHandler(database);
  return {
    checkFilePath: (input) => handler.checkFilePath(input),
    readTextFile: (input) => handler.readTextFile(input),
    writeTextFile: (input) => handler.writeTextFile(input),
    deleteFile: (input) => handler.deleteFile(input),
    ensureDirectory: (input) => handler.ensureDirectory(input),
    // The Workspace root, and a logical path rather than a host one — the same
    // root the run's documents resolve against. Nothing an admitted fragment
    // writes reaches the directory the caller invoked `xmd` from.
    // deno-lint-ignore require-yield
    *workingDirectory(): Operation<string> {
      return WORKSPACE_ROOT;
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
  // The transport, read once here rather than by a fragment when it runs. It is
  // the run's own `API.Fetch` as this assembly sees it — which is the provider
  // the workflow host installed, not whichever one a document later composes
  // around itself.
  const transport = yield* fetchAccess();
  // Built from the same definition the ordinary registration owns, so the two
  // cannot drift. Versioned in its revision because what the entry authorizes
  // changed: the former `Dir` authorized placement that created nothing, and
  // `<Dir>` now recursively creates the directory it names. A continuation
  // granted under the earlier revision must not silently receive the wider
  // authority, and the retained comparison refuses it before generated
  // execution.
  const timeout = yield* timeoutFetch;
  return {
    read: [
      fileReadEntry(),
      ...(requests.length === 0 ? [] : [fetchEntry(requests)]),
      ...(options.reads ?? []),
    ],
    write: [
      fileWriteEntry(),
      // Revision 3: the grant is the workflow's, so the identity names this
      // package. What changed from revision 2 is the authority behind it — the
      // body is now closed over the `ensureDirectory` this profile handed over
      // rather than resolving a Files provider when it runs — so a continuation
      // granted under the older, composable one is refused rather than
      // re-granted.
      //
      // The version-1 alias is the exact string released builds retained for
      // this entry, written out rather than assembled: that is what those
      // journals hold, and nothing derives it. The pre-`dir-v2` spelling is
      // deliberately absent — it named the placement-only `<Dir>`, which
      // created nothing, so answering for it here would hand a narrower grant
      // the wider one.
      directoryEntry({ origin: COMPOSITION_ORIGIN, key: "Dir", revision: "3" }, "Dir", [
        "@executablemd/workflow/composition/dir-v2#Dir",
      ]),
      fileDeleteEntry(),
      ...(options.writes ?? []),
    ],
    files: workspaceFiles(database),
    ...(requests.length === 0 ? {} : { fetch: transport }),
    workspace: workspaceAccess(database),
    deprecatedSourceAlias: true,
    ...(timeout === undefined ? {} : { fetchTimeout: timeout }),
  };
}

/**
 * The transport an admitted `<Fetch />` performs its request through.
 *
 * Resolved at assembly, so the operation the profile holds is the one this host
 * installed. A fragment reaches this bound function and never `API.Fetch`, so a
 * handler composed around the contextual chain while the document runs neither
 * sees the request nor answers it.
 */
// deno-lint-ignore require-yield
function* fetchAccess(): Operation<FragmentFetchAccess> {
  // Read here, at assembly, and closed over. `API.Fetch.operations` resolves
  // against whatever chain is current when it is *called*, so reading it inside
  // the fragment's own body would be the dynamic lookup this exists to remove.
  const perform = API.Fetch.operations.fetch;
  return {
    *fetch(request): Operation<FetchResponseRecord> {
      const response = yield* perform(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
      });
      // Detached before the body is read, because a provider may invalidate its
      // own header collection once the body has been consumed. A `HEAD` never
      // asks for a body: there is none, and asking would fail against a
      // provider that says so.
      const status = detachStatus(response.status);
      const headers = detachHeaders(response.headers);
      const body = request.method === "HEAD" ? "" : yield* response.text();
      return { status, headers, body };
    },
  };
}
